/**
 * TurnStore (`src/db/turns.ts`) — Turn records, turn candidates, and atomic candidate acceptance.
 *
 * Implements synchronous SQLite operations against `turns` and `turn_candidates`
 * in `JobDO`, enforcing the 1,500,000-byte artifact and row guards, primary-key
 * cursor pagination without BLOB columns, the §7 non-empty deliverable rule on
 * valid candidates, and atomic turn acceptance inside `storage.transactionSync`.
 */

import {
  assertArtifactAndRowSize,
  clampPageLimit,
  measureByteLength,
  toGuardedBlob,
} from "../lib/guards.ts";
import {
  TURNS_SUMMARY_COLUMNS,
  TURN_CANDIDATES_SUMMARY_COLUMNS,
  withSqlErrorMapping,
  type CandidateStructuralStatus,
  type SchemaSqlStorage,
  type SchemaTransactionalStorage,
  type SqlPrimitiveValue,
  type TurnCandidateRow,
  type TurnCandidateSummaryRow,
  type TurnRow,
  type TurnSummaryRow,
} from "./schema";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

export interface InsertTurnInput {
  readonly turnIndex: number;
  readonly prompt: string | Uint8Array | ArrayBuffer;
  readonly attachmentFileIdsJson?: string;
  readonly status?: TurnRow["status"];
  readonly marginalInputTokens?: number | null;
  readonly nowIso: string;
}

export interface ListTurnSummariesOptions {
  readonly afterTurnIndex?: number | null;
  readonly maxTurnIndex?: number | null;
  readonly statuses?: readonly TurnRow["status"][];
  readonly limit?: number;
}

export interface InsertTurnCandidateInput {
  readonly candidateId: string;
  readonly turnIndex: number;
  readonly attemptId: string;
  readonly structuralStatus: CandidateStructuralStatus;
  readonly parsedTagIndex: number | null;
  readonly deliverable: string | Uint8Array | ArrayBuffer | null;
  readonly accepted?: boolean;
  readonly warningJson?: string;
  readonly createdAt: string;
}

export interface ListTurnCandidateSummariesOptions {
  readonly turnIndex?: number;
  readonly afterCandidateId?: string | null;
  readonly limit?: number;
}

export interface AcceptTurnCandidateParams {
  readonly jobId: string;
  readonly turnIndex: number;
  readonly candidateId: string;
  readonly attemptId: string;
  readonly responseId: string;
  readonly acceptedWithWarning: boolean;
  readonly warningJson?: string;
  readonly marginalInputTokens?: number | null;
  readonly nowIso: string;
}

/**
 * Inserts a turn into `turns` with 1,500,000-byte artifact and row guards on `prompt_blob`
 * and returns the BLOB-free `TurnSummaryRow`.
 */
export function insertTurn(
  sql: SchemaSqlStorage,
  input: InsertTurnInput
): TurnSummaryRow {
  return withSqlErrorMapping(() => {
    const attachmentFileIdsJson = input.attachmentFileIdsJson ?? "[]";
    const status: TurnRow["status"] = input.status ?? "pending";
    const marginalInputTokens =
      input.marginalInputTokens === undefined ? null : input.marginalInputTokens;

    const { blob: promptBlob, byteLength: promptBytes } = toGuardedBlob(
      input.prompt,
      "turns.prompt_blob"
    );
    const metadataBytes = measureByteLength(attachmentFileIdsJson);
    const { rowBytes } = assertArtifactAndRowSize(
      promptBytes,
      metadataBytes,
      "turns.row_bytes"
    );

    sql.exec(
      `INSERT INTO turns (
        turn_index,
        status,
        prompt_blob,
        prompt_bytes,
        row_bytes,
        attachment_file_ids_json,
        accepted_candidate_id,
        accepted_attempt_id,
        accepted_response_id,
        accepted_with_warning,
        marginal_input_tokens,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?)`,
      input.turnIndex,
      status,
      promptBlob,
      promptBytes,
      rowBytes,
      attachmentFileIdsJson,
      marginalInputTokens,
      input.nowIso,
      input.nowIso
    );

    return {
      turn_index: input.turnIndex,
      status,
      prompt_bytes: promptBytes,
      row_bytes: rowBytes,
      attachment_file_ids_json: attachmentFileIdsJson,
      accepted_candidate_id: null,
      accepted_attempt_id: null,
      accepted_response_id: null,
      accepted_with_warning: 0,
      marginal_input_tokens: marginalInputTokens,
      created_at: input.nowIso,
      updated_at: input.nowIso,
    };
  });
}

/**
 * Fetches a single turn summary row (excluding `prompt_blob`) by `turn_index`.
 */
export function getTurnSummary(
  sql: SchemaSqlStorage,
  turnIndex: number
): TurnSummaryRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<TurnSummaryRow>(
        `SELECT ${TURNS_SUMMARY_COLUMNS} FROM turns WHERE turn_index = ?`,
        turnIndex
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

/**
 * Fetches only `prompt_blob` for a single turn so callers stream or inspect one artifact at a time.
 */
export function getTurnPromptBlob(
  sql: SchemaSqlStorage,
  turnIndex: number
): Uint8Array | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<Pick<TurnRow, "prompt_blob">>(
        "SELECT prompt_blob FROM turns WHERE turn_index = ?",
        turnIndex
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    const raw = rows[0]!.prompt_blob;
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  });
}

/**
 * Decodes `prompt_blob` for a single turn as UTF-8 text.
 */
export function getTurnPromptText(
  sql: SchemaSqlStorage,
  turnIndex: number
): string | null {
  const blob = getTurnPromptBlob(sql, turnIndex);
  return blob === null ? null : utf8Decoder.decode(blob);
}

/**
 * Lists turn summaries ordered by `turn_index ASC` using primary-key cursor pagination
 * (`turn_index > afterTurnIndex`), optional high-water mark (`turn_index <= maxTurnIndex`),
 * optional status filter, and clamped page size (`1..100`). Never selects `prompt_blob`.
 */
export function listTurnSummaries(
  sql: SchemaSqlStorage,
  options?: ListTurnSummariesOptions
): TurnSummaryRow[] {
  return withSqlErrorMapping(() => {
    if (options?.statuses !== undefined && options.statuses.length === 0) {
      return [];
    }

    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (options?.afterTurnIndex !== undefined && options.afterTurnIndex !== null) {
      conditions.push("turn_index > ?");
      bindings.push(options.afterTurnIndex);
    }

    if (options?.maxTurnIndex !== undefined && options.maxTurnIndex !== null) {
      conditions.push("turn_index <= ?");
      bindings.push(options.maxTurnIndex);
    }

    if (options?.statuses !== undefined && options.statuses.length > 0) {
      const placeholders = options.statuses.map(() => "?").join(", ");
      conditions.push(`status IN (${placeholders})`);
      for (const status of options.statuses) {
        bindings.push(status);
      }
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = clampPageLimit(options?.limit);
    bindings.push(limit);

    return sql
      .exec<TurnSummaryRow>(
        `SELECT ${TURNS_SUMMARY_COLUMNS} FROM turns ${whereClause} ORDER BY turn_index ASC LIMIT ?`,
        ...bindings
      )
      .toArray();
  });
}

/**
 * Updates a turn's `status`, optional `marginal_input_tokens`, and `updated_at` timestamp.
 */
export function updateTurnStatus(
  sql: SchemaSqlStorage,
  turnIndex: number,
  status: TurnRow["status"],
  nowIso: string,
  marginalInputTokens?: number | null
): void {
  withSqlErrorMapping(() => {
    if (marginalInputTokens === undefined) {
      sql.exec(
        "UPDATE turns SET status = ?, updated_at = ? WHERE turn_index = ?",
        status,
        nowIso,
        turnIndex
      );
    } else {
      sql.exec(
        "UPDATE turns SET status = ?, marginal_input_tokens = ?, updated_at = ? WHERE turn_index = ?",
        status,
        marginalInputTokens,
        nowIso,
        turnIndex
      );
    }
  });
}

/**
 * Inserts a candidate row into `turn_candidates`.
 *
 * Enforces the §7 invariant that `structuralStatus === "valid"` requires non-null,
 * non-empty deliverable bytes (`byteLength > 0`), and enforces the 1,500,000-byte
 * artifact and row guards on `deliverable_blob` and row metadata.
 */
export function insertTurnCandidate(
  sql: SchemaSqlStorage,
  input: InsertTurnCandidateInput
): TurnCandidateSummaryRow {
  return withSqlErrorMapping(() => {
    const warningJson = input.warningJson ?? "[]";
    const acceptedInt = input.accepted ? 1 : 0;

    let deliverableBlob: Uint8Array | null = null;
    let deliverableBytes = 0;

    if (input.deliverable !== null) {
      const guarded = toGuardedBlob(
        input.deliverable,
        "turn_candidates.deliverable_blob"
      );
      deliverableBlob = guarded.blob;
      deliverableBytes = guarded.byteLength;
    }

    if (input.structuralStatus === "valid" && deliverableBytes <= 0) {
      throw new Error(
        "Cannot insert a 'valid' turn candidate with empty deliverable text (§7 empty_output rule)"
      );
    }

    const metadataBytes =
      measureByteLength(input.candidateId) +
      measureByteLength(input.attemptId) +
      measureByteLength(input.structuralStatus) +
      measureByteLength(warningJson);

    const { rowBytes } = assertArtifactAndRowSize(
      deliverableBytes,
      metadataBytes,
      "turn_candidates.row_bytes"
    );

    sql.exec(
      `INSERT INTO turn_candidates (
        candidate_id,
        turn_index,
        attempt_id,
        structural_status,
        parsed_tag_index,
        deliverable_blob,
        deliverable_bytes,
        row_bytes,
        accepted,
        warning_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.candidateId,
      input.turnIndex,
      input.attemptId,
      input.structuralStatus,
      input.parsedTagIndex,
      deliverableBlob,
      deliverableBytes,
      rowBytes,
      acceptedInt,
      warningJson,
      input.createdAt
    );

    return {
      candidate_id: input.candidateId,
      turn_index: input.turnIndex,
      attempt_id: input.attemptId,
      structural_status: input.structuralStatus,
      parsed_tag_index: input.parsedTagIndex,
      deliverable_bytes: deliverableBytes,
      row_bytes: rowBytes,
      accepted: acceptedInt,
      warning_json: warningJson,
      created_at: input.createdAt,
    };
  });
}

/**
 * Fetches a single turn candidate summary row (excluding `deliverable_blob`) by `candidate_id`.
 */
export function getTurnCandidateSummary(
  sql: SchemaSqlStorage,
  candidateId: string
): TurnCandidateSummaryRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<TurnCandidateSummaryRow>(
        `SELECT ${TURN_CANDIDATES_SUMMARY_COLUMNS} FROM turn_candidates WHERE candidate_id = ?`,
        candidateId
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

/**
 * Fetches only `deliverable_blob` for one candidate at a time.
 */
export function getTurnCandidateDeliverableBlob(
  sql: SchemaSqlStorage,
  candidateId: string
): Uint8Array | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<Pick<TurnCandidateRow, "deliverable_blob">>(
        "SELECT deliverable_blob FROM turn_candidates WHERE candidate_id = ?",
        candidateId
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    const raw = rows[0]!.deliverable_blob;
    if (raw === null) {
      return null;
    }
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  });
}

/**
 * Decodes `deliverable_blob` for a single candidate as UTF-8 text.
 */
export function getTurnCandidateDeliverableText(
  sql: SchemaSqlStorage,
  candidateId: string
): string | null {
  const blob = getTurnCandidateDeliverableBlob(sql, candidateId);
  return blob === null ? null : utf8Decoder.decode(blob);
}

/**
 * Lists turn candidate summaries using primary-key cursor pagination (`candidate_id > ?`),
 * optional `turn_index` filter, and limit clamped to `1..100`. Never selects `deliverable_blob`.
 */
export function listTurnCandidateSummaries(
  sql: SchemaSqlStorage,
  options?: ListTurnCandidateSummariesOptions
): TurnCandidateSummaryRow[] {
  return withSqlErrorMapping(() => {
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (options?.turnIndex !== undefined) {
      conditions.push("turn_index = ?");
      bindings.push(options.turnIndex);
    }

    if (options?.afterCandidateId !== undefined && options.afterCandidateId !== null) {
      conditions.push("candidate_id > ?");
      bindings.push(options.afterCandidateId);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = clampPageLimit(options?.limit);
    bindings.push(limit);

    return sql
      .exec<TurnCandidateSummaryRow>(
        `SELECT ${TURN_CANDIDATES_SUMMARY_COLUMNS} FROM turn_candidates ${whereClause} ORDER BY candidate_id ASC LIMIT ?`,
        ...bindings
      )
      .toArray();
  });
}

/**
 * Atomically accepts a turn candidate inside `storage.transactionSync`:
 * 1. Verifies the candidate exists for `(candidateId, turnIndex)`, has `structural_status === "valid"`,
 *    and has `deliverable_bytes > 0`.
 * 2. Verifies the resulting `turns` and `trust/candidate` row byte guards.
 * 3. Marks `accepted = 1` (and updates `warning_json` if provided) on `turn_candidates`.
 * 4. Marks `turns` as `status = 'accepted'` with the accepted candidate/attempt/response anchors
 *    and freezes the provider-reported `marginal_input_tokens` supplied by the caller.
 * 5. Updates `jobs` (`accepted_turn_index = MAX(accepted_turn_index, ?)`, `last_accepted_response_id = ?`,
 *    `revision = revision + 1`, `updated_at = ?`).
 */
export function acceptTurnCandidate(
  storage: SchemaTransactionalStorage,
  params: AcceptTurnCandidateParams
): void {
  withSqlErrorMapping(() => {
    const sql = storage.sql;
    storage.transactionSync(() => {
      const candidateRows = sql
        .exec<TurnCandidateSummaryRow>(
          `SELECT ${TURN_CANDIDATES_SUMMARY_COLUMNS} FROM turn_candidates WHERE candidate_id = ?`,
          params.candidateId
        )
        .toArray();

      if (candidateRows.length === 0) {
        throw new Error(`Turn candidate not found: ${params.candidateId}`);
      }

      const candidate = candidateRows[0]!;
      if (candidate.turn_index !== params.turnIndex) {
        throw new Error(
          `Turn candidate ${params.candidateId} belongs to turn ${candidate.turn_index}, expected ${params.turnIndex}`
        );
      }
      if (candidate.attempt_id !== params.attemptId) {
        throw new Error(
          `Turn candidate ${params.candidateId} belongs to attempt ${candidate.attempt_id}, expected ${params.attemptId}`
        );
      }
      if (candidate.structural_status !== "valid" || candidate.deliverable_bytes <= 0) {
        throw new Error(
          `Turn candidate ${params.candidateId} cannot be accepted: structural_status=${candidate.structural_status}, deliverable_bytes=${candidate.deliverable_bytes}`
        );
      }

      const turnRows = sql
        .exec<TurnSummaryRow>(
          `SELECT ${TURNS_SUMMARY_COLUMNS} FROM turns WHERE turn_index = ?`,
          params.turnIndex
        )
        .toArray();

      if (turnRows.length === 0) {
        throw new Error(`Turn not found: ${params.turnIndex}`);
      }

      const turn = turnRows[0]!;
      const updatedTurnMetadataBytes =
        measureByteLength(turn.attachment_file_ids_json) +
        measureByteLength(params.candidateId) +
        measureByteLength(params.attemptId) +
        measureByteLength(params.responseId);
      const { rowBytes: updatedTurnRowBytes } = assertArtifactAndRowSize(
        turn.prompt_bytes,
        updatedTurnMetadataBytes,
        "turns.row_bytes"
      );

      const nextWarningJson =
        params.warningJson !== undefined ? params.warningJson : candidate.warning_json;
      const updatedCandidateMetadataBytes =
        measureByteLength(candidate.candidate_id) +
        measureByteLength(candidate.attempt_id) +
        measureByteLength(candidate.structural_status) +
        measureByteLength(nextWarningJson);
      const { rowBytes: updatedCandidateRowBytes } = assertArtifactAndRowSize(
        candidate.deliverable_bytes,
        updatedCandidateMetadataBytes,
        "turn_candidates.row_bytes"
      );

      sql.exec(
        "UPDATE turn_candidates SET accepted = 0 WHERE turn_index = ? AND candidate_id != ?",
        params.turnIndex,
        params.candidateId
      );

      sql.exec(
        "UPDATE turn_candidates SET accepted = 1, warning_json = ?, row_bytes = ? WHERE candidate_id = ?",
        nextWarningJson,
        updatedCandidateRowBytes,
        params.candidateId
      );

      sql.exec(
        `UPDATE turns
         SET status = 'accepted',
             accepted_candidate_id = ?,
             accepted_attempt_id = ?,
             accepted_response_id = ?,
             accepted_with_warning = ?,
             marginal_input_tokens = ?,
             row_bytes = ?,
             updated_at = ?
         WHERE turn_index = ?`,
        params.candidateId,
        params.attemptId,
        params.responseId,
        params.acceptedWithWarning ? 1 : 0,
        params.marginalInputTokens ?? null,
        updatedTurnRowBytes,
        params.nowIso,
        params.turnIndex
      );

      const jobUpdate = sql.exec(
        `UPDATE jobs
         SET accepted_turn_index = MAX(accepted_turn_index, ?),
             last_accepted_response_id = ?,
             revision = revision + 1,
             updated_at = ?
         WHERE job_id = ?`,
        params.turnIndex,
        params.responseId,
        params.nowIso,
        params.jobId
      );

      if (jobUpdate.rowsWritten === 0) {
        throw new Error(`Job record not found when accepting turn candidate: ${params.jobId}`);
      }
    });
  });
}
