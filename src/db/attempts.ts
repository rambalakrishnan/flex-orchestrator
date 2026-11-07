/**
 * Generation attempts, response artifacts, judge calls, durable work, and export high-water marks
 * (`src/db/attempts.ts`).
 *
 * Operates synchronously over `SchemaSqlStorage` inside `withSqlErrorMapping` and enforces
 * 1,500,000-byte artifact and resulting-row guards on all retained BLOBs and metadata.
 */

import {
  GENERATION_ATTEMPTS_SUMMARY_COLUMNS,
  JUDGE_CALLS_SUMMARY_COLUMNS,
  assertArtifactAndRowSize,
  clampPageLimit,
  measureByteLength,
  toGuardedBlob,
  withSqlErrorMapping,
  type AttemptResponseArtifactRow,
  type AttemptResponseArtifactSummaryRow,
  type DurableWorkRow,
  type GenerationAttemptRow,
  type GenerationAttemptSummaryRow,
  type JudgeCallRow,
  type JudgeCallSummaryRow,
  type SchemaSqlStorage,
  type SqlPrimitiveValue,
} from "./schema";
import type { ExportHighWaterMarks } from "../types";

export const ATTEMPT_RESPONSE_ARTIFACTS_SUMMARY_COLUMNS =
  "attempt_id, turn_index, provider_response_id, response_bytes, row_bytes, created_at";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

function toUint8Array(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

/**
 * Ensures canonical request payloads and diagnostics never persist an Authorization header.
 */
function assertNoAuthorizationHeader(textOrBlob: string | Uint8Array, context: string): void {
  const text = typeof textOrBlob === "string" ? textOrBlob : utf8Decoder.decode(textOrBlob);
  if (/["']authorization["']\s*:/i.test(text) || /\bAuthorization\s*:\s*Bearer\b/i.test(text)) {
    throw new Error(`Credential leak guard: Authorization header must never be stored in ${context}`);
  }
}

// ============================================================================
// 1. Generation Attempts (`generation_attempts`)
// ============================================================================

export function insertGenerationAttempt(
  sql: SchemaSqlStorage,
  input: {
    attemptId: string;
    turnIndex: number;
    attemptNumber: number;
    continuationIndex: number;
    kind: GenerationAttemptRow["kind"];
    status?: GenerationAttemptRow["status"];
    idempotencyKey: string;
    parentResponseId: string | null;
    requestBody: string | Uint8Array | ArrayBuffer;
    diagnosticsJson?: string;
    nowIso: string;
  }
): GenerationAttemptSummaryRow {
  return withSqlErrorMapping(() => {
    const status: GenerationAttemptRow["status"] = input.status ?? "prepared";
    const diagnosticsJson = input.diagnosticsJson ?? "{}";

    const { blob, byteLength: requestBytes } = toGuardedBlob(
      input.requestBody,
      "generation_attempts.request_blob"
    );
    if (requestBytes <= 0) {
      throw new Error("generation_attempts.request_blob must be non-empty");
    }

    assertNoAuthorizationHeader(blob, "generation_attempts.request_blob");
    assertNoAuthorizationHeader(diagnosticsJson, "generation_attempts.diagnostics_json");

    const metadataBytes =
      measureByteLength(input.attemptId) +
      measureByteLength(input.idempotencyKey) +
      measureByteLength(diagnosticsJson);

    const { rowBytes } = assertArtifactAndRowSize(
      requestBytes,
      metadataBytes,
      "generation_attempts.row_bytes"
    );

    sql.exec(
      `INSERT INTO generation_attempts (
        attempt_id,
        turn_index,
        attempt_number,
        continuation_index,
        kind,
        status,
        idempotency_key,
        provider_response_id,
        parent_response_id,
        capacity_sends,
        next_backoff_at_ms,
        poll_probes,
        next_poll_at_ms,
        request_blob,
        request_bytes,
        row_bytes,
        usage_json,
        diagnostics_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, 0, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
      input.attemptId,
      input.turnIndex,
      input.attemptNumber,
      input.continuationIndex,
      input.kind,
      status,
      input.idempotencyKey,
      input.parentResponseId,
      blob,
      requestBytes,
      rowBytes,
      diagnosticsJson,
      input.nowIso,
      input.nowIso
    );

    return {
      attempt_id: input.attemptId,
      turn_index: input.turnIndex,
      attempt_number: input.attemptNumber,
      continuation_index: input.continuationIndex,
      kind: input.kind,
      status,
      idempotency_key: input.idempotencyKey,
      provider_response_id: null,
      parent_response_id: input.parentResponseId,
      capacity_sends: 0,
      next_backoff_at_ms: null,
      poll_probes: 0,
      next_poll_at_ms: null,
      request_bytes: requestBytes,
      row_bytes: rowBytes,
      usage_json: null,
      diagnostics_json: diagnosticsJson,
      created_at: input.nowIso,
      updated_at: input.nowIso,
    };
  });
}

export function getGenerationAttemptSummary(
  sql: SchemaSqlStorage,
  attemptId: string
): GenerationAttemptSummaryRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<GenerationAttemptSummaryRow>(
        `SELECT ${GENERATION_ATTEMPTS_SUMMARY_COLUMNS}
         FROM generation_attempts
         WHERE attempt_id = ?`,
        attemptId
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

export function getGenerationAttemptRequestBlob(
  sql: SchemaSqlStorage,
  attemptId: string
): Uint8Array | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<{ request_blob: GenerationAttemptRow["request_blob"] }>(
        "SELECT request_blob FROM generation_attempts WHERE attempt_id = ?",
        attemptId
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    return toUint8Array(rows[0]!.request_blob);
  });
}

export function listGenerationAttemptSummaries(
  sql: SchemaSqlStorage,
  options?: {
    turnIndex?: number;
    afterAttemptId?: string | null;
    upToAttemptId?: string | null;
    limit?: number;
  }
): GenerationAttemptSummaryRow[] {
  return withSqlErrorMapping(() => {
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (options?.turnIndex !== undefined) {
      conditions.push("turn_index = ?");
      bindings.push(options.turnIndex);
    }
    if (options?.afterAttemptId !== undefined && options.afterAttemptId !== null) {
      conditions.push("attempt_id > ?");
      bindings.push(options.afterAttemptId);
    }
    if (options?.upToAttemptId !== undefined && options.upToAttemptId !== null) {
      conditions.push("attempt_id <= ?");
      bindings.push(options.upToAttemptId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = clampPageLimit(options?.limit);
    bindings.push(limit);

    return sql
      .exec<GenerationAttemptSummaryRow>(
        `SELECT ${GENERATION_ATTEMPTS_SUMMARY_COLUMNS}
         FROM generation_attempts
         ${whereClause}
         ORDER BY attempt_id ASC
         LIMIT ?`,
        ...bindings
      )
      .toArray();
  });
}

export function updateGenerationAttemptState(
  sql: SchemaSqlStorage,
  params: {
    attemptId: string;
    status: GenerationAttemptRow["status"];
    providerResponseId?: string | null;
    capacitySends?: number;
    nextBackoffAtMs?: number | null;
    pollProbes?: number;
    nextPollAtMs?: number | null;
    usageJson?: string | null;
    diagnosticsJson?: string;
    nowIso: string;
  }
): void {
  withSqlErrorMapping(() => {
    const current = getGenerationAttemptSummary(sql, params.attemptId);
    if (!current) {
      throw new Error(`Generation attempt not found: ${params.attemptId}`);
    }

    const providerResponseId =
      params.providerResponseId !== undefined
        ? params.providerResponseId
        : current.provider_response_id;
    const capacitySends =
      params.capacitySends !== undefined ? params.capacitySends : current.capacity_sends;
    const nextBackoffAtMs =
      params.nextBackoffAtMs !== undefined ? params.nextBackoffAtMs : current.next_backoff_at_ms;
    const pollProbes =
      params.pollProbes !== undefined ? params.pollProbes : current.poll_probes;
    const nextPollAtMs =
      params.nextPollAtMs !== undefined ? params.nextPollAtMs : current.next_poll_at_ms;
    const usageJson = params.usageJson !== undefined ? params.usageJson : current.usage_json;
    const diagnosticsJson =
      params.diagnosticsJson !== undefined ? params.diagnosticsJson : current.diagnostics_json;

    assertNoAuthorizationHeader(diagnosticsJson, "generation_attempts.diagnostics_json");

    const metadataBytes =
      measureByteLength(current.attempt_id) +
      measureByteLength(current.idempotency_key) +
      measureByteLength(providerResponseId) +
      measureByteLength(usageJson) +
      measureByteLength(diagnosticsJson);

    const { rowBytes } = assertArtifactAndRowSize(
      current.request_bytes,
      metadataBytes,
      "generation_attempts.row_bytes"
    );

    sql.exec(
      `UPDATE generation_attempts
       SET status = ?,
           provider_response_id = ?,
           capacity_sends = ?,
           next_backoff_at_ms = ?,
           poll_probes = ?,
           next_poll_at_ms = ?,
           row_bytes = ?,
           usage_json = ?,
           diagnostics_json = ?,
           updated_at = ?
       WHERE attempt_id = ?`,
      params.status,
      providerResponseId,
      capacitySends,
      nextBackoffAtMs,
      pollProbes,
      nextPollAtMs,
      rowBytes,
      usageJson,
      diagnosticsJson,
      params.nowIso,
      params.attemptId
    );
  });
}

// ============================================================================
// 2. Attempt Response Artifacts (`attempt_response_artifacts`)
// ============================================================================

export function putAttemptResponseArtifact(
  sql: SchemaSqlStorage,
  input: {
    attemptId: string;
    turnIndex: number;
    providerResponseId: string;
    responseBody: string | Uint8Array | ArrayBuffer;
    createdAt: string;
  }
): AttemptResponseArtifactSummaryRow {
  return withSqlErrorMapping(() => {
    const { blob, byteLength: responseBytes } = toGuardedBlob(
      input.responseBody,
      "attempt_response_artifacts.response_blob"
    );
    if (responseBytes <= 0) {
      throw new Error("attempt_response_artifacts.response_blob must be non-empty");
    }

    const metadataBytes =
      measureByteLength(input.attemptId) + measureByteLength(input.providerResponseId);

    const { rowBytes } = assertArtifactAndRowSize(
      responseBytes,
      metadataBytes,
      "attempt_response_artifacts.row_bytes"
    );

    sql.exec(
      `INSERT INTO attempt_response_artifacts (
        attempt_id,
        turn_index,
        provider_response_id,
        response_blob,
        response_bytes,
        row_bytes,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(attempt_id) DO UPDATE SET
        turn_index = excluded.turn_index,
        provider_response_id = excluded.provider_response_id,
        response_blob = excluded.response_blob,
        response_bytes = excluded.response_bytes,
        row_bytes = excluded.row_bytes,
        created_at = excluded.created_at`,
      input.attemptId,
      input.turnIndex,
      input.providerResponseId,
      blob,
      responseBytes,
      rowBytes,
      input.createdAt
    );

    return {
      attempt_id: input.attemptId,
      turn_index: input.turnIndex,
      provider_response_id: input.providerResponseId,
      response_bytes: responseBytes,
      row_bytes: rowBytes,
      created_at: input.createdAt,
    };
  });
}

export function getAttemptResponseArtifactSummary(
  sql: SchemaSqlStorage,
  attemptId: string
): AttemptResponseArtifactSummaryRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<AttemptResponseArtifactSummaryRow>(
        `SELECT ${ATTEMPT_RESPONSE_ARTIFACTS_SUMMARY_COLUMNS}
         FROM attempt_response_artifacts
         WHERE attempt_id = ?`,
        attemptId
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

export function getAttemptResponseArtifactBlob(
  sql: SchemaSqlStorage,
  attemptId: string
): Uint8Array | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<{ response_blob: AttemptResponseArtifactRow["response_blob"] }>(
        "SELECT response_blob FROM attempt_response_artifacts WHERE attempt_id = ?",
        attemptId
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    return toUint8Array(rows[0]!.response_blob);
  });
}

// ============================================================================
// 3. Judge Calls (`judge_calls`)
// ============================================================================

export function insertJudgeCall(
  sql: SchemaSqlStorage,
  input: {
    judgeCallId: string;
    turnIndex: number;
    candidateId: string;
    attemptId: string;
    transport: JudgeCallRow["transport"];
    historyMode: JudgeCallRow["history_mode"];
    fileDeliveryMode: JudgeCallRow["file_delivery_mode"];
    model: string;
    previousJudgeResponseId: string | null;
    manifestJson: string;
    requestBody: string | Uint8Array | ArrayBuffer;
    diagnosticsJson?: string;
    nowIso: string;
  }
): JudgeCallSummaryRow {
  return withSqlErrorMapping(() => {
    const diagnosticsJson = input.diagnosticsJson ?? "{}";

    const { blob, byteLength: requestBytes } = toGuardedBlob(
      input.requestBody,
      "judge_calls.request_blob"
    );
    if (requestBytes <= 0) {
      throw new Error("judge_calls.request_blob must be non-empty");
    }

    assertNoAuthorizationHeader(blob, "judge_calls.request_blob");
    assertNoAuthorizationHeader(diagnosticsJson, "judge_calls.diagnostics_json");

    const metadataBytes =
      measureByteLength(input.judgeCallId) +
      measureByteLength(input.candidateId) +
      measureByteLength(input.attemptId) +
      measureByteLength(input.model) +
      measureByteLength(input.manifestJson) +
      measureByteLength(diagnosticsJson);

    const { rowBytes } = assertArtifactAndRowSize(
      requestBytes,
      metadataBytes,
      "judge_calls.row_bytes"
    );

    sql.exec(
      `INSERT INTO judge_calls (
        judge_call_id,
        turn_index,
        candidate_id,
        attempt_id,
        transport,
        history_mode,
        file_delivery_mode,
        model,
        provider_response_id,
        previous_judge_response_id,
        status,
        verdict,
        grade,
        comment,
        tag_agreement,
        file_visibility,
        manifest_json,
        request_blob,
        request_bytes,
        row_bytes,
        usage_json,
        diagnostics_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      input.judgeCallId,
      input.turnIndex,
      input.candidateId,
      input.attemptId,
      input.transport,
      input.historyMode,
      input.fileDeliveryMode,
      input.model,
      input.previousJudgeResponseId,
      input.manifestJson,
      blob,
      requestBytes,
      rowBytes,
      diagnosticsJson,
      input.nowIso,
      input.nowIso
    );

    return {
      judge_call_id: input.judgeCallId,
      turn_index: input.turnIndex,
      candidate_id: input.candidateId,
      attempt_id: input.attemptId,
      transport: input.transport,
      history_mode: input.historyMode,
      file_delivery_mode: input.fileDeliveryMode,
      model: input.model,
      provider_response_id: null,
      previous_judge_response_id: input.previousJudgeResponseId,
      status: "pending",
      verdict: null,
      grade: null,
      comment: null,
      tag_agreement: null,
      file_visibility: null,
      manifest_json: input.manifestJson,
      request_bytes: requestBytes,
      row_bytes: rowBytes,
      usage_json: null,
      diagnostics_json: diagnosticsJson,
      created_at: input.nowIso,
      updated_at: input.nowIso,
    };
  });
}

export function completeJudgeCall(
  sql: SchemaSqlStorage,
  params: {
    judgeCallId: string;
    status: "completed" | "unknown" | "failed";
    providerResponseId?: string | null;
    verdict: "PASS" | "FAIL" | "UNKNOWN";
    grade?: number | null;
    comment?: string | null;
    tagAgreement?: boolean | null;
    fileVisibility?: boolean | null;
    usageJson?: string | null;
    diagnosticsJson?: string;
    nowIso: string;
  }
): void {
  withSqlErrorMapping(() => {
    const current = getJudgeCallSummary(sql, params.judgeCallId);
    if (!current) {
      throw new Error(`Judge call not found: ${params.judgeCallId}`);
    }

    let verdict: "PASS" | "FAIL" | "UNKNOWN";
    let grade: number | null;
    let comment: string | null;
    let tagAgreementInt: number | null;
    let fileVisibilityInt: number | null;

    if (params.status === "completed") {
      if (params.verdict !== "PASS" && params.verdict !== "FAIL") {
        throw new Error(
          `Completed judge call requires verdict 'PASS' or 'FAIL', received '${params.verdict}'`
        );
      }
      if (
        typeof params.grade !== "number" ||
        !Number.isInteger(params.grade) ||
        params.grade < 0 ||
        params.grade > 100
      ) {
        throw new Error(
          `Completed judge call requires integer grade in [0, 100], received ${String(params.grade)}`
        );
      }
      if (typeof params.comment !== "string") {
        throw new Error("Completed judge call requires non-null comment string");
      }
      if (typeof params.tagAgreement !== "boolean" || typeof params.fileVisibility !== "boolean") {
        throw new Error(
          "Completed judge call requires boolean tagAgreement and fileVisibility values"
        );
      }
      verdict = params.verdict;
      grade = params.grade;
      comment = params.comment;
      tagAgreementInt = params.tagAgreement ? 1 : 0;
      fileVisibilityInt = params.fileVisibility ? 1 : 0;
    } else {
      if (params.verdict !== "UNKNOWN") {
        throw new Error(
          `Non-completed judge call (${params.status}) requires verdict 'UNKNOWN', received '${params.verdict}'`
        );
      }
      verdict = "UNKNOWN";
      grade = params.grade ?? null;
      comment = params.comment ?? null;
      tagAgreementInt =
        params.tagAgreement === undefined || params.tagAgreement === null
          ? null
          : params.tagAgreement
            ? 1
            : 0;
      fileVisibilityInt =
        params.fileVisibility === undefined || params.fileVisibility === null
          ? null
          : params.fileVisibility
            ? 1
            : 0;
    }

    const providerResponseId =
      params.providerResponseId !== undefined
        ? params.providerResponseId
        : current.provider_response_id;
    const usageJson = params.usageJson !== undefined ? params.usageJson : current.usage_json;
    const diagnosticsJson =
      params.diagnosticsJson !== undefined ? params.diagnosticsJson : current.diagnostics_json;

    assertNoAuthorizationHeader(diagnosticsJson, "judge_calls.diagnostics_json");

    const metadataBytes =
      measureByteLength(current.judge_call_id) +
      measureByteLength(current.candidate_id) +
      measureByteLength(current.attempt_id) +
      measureByteLength(current.model) +
      measureByteLength(comment) +
      measureByteLength(current.manifest_json) +
      measureByteLength(usageJson) +
      measureByteLength(diagnosticsJson);

    const { rowBytes } = assertArtifactAndRowSize(
      current.request_bytes,
      metadataBytes,
      "judge_calls.row_bytes"
    );

    sql.exec(
      `UPDATE judge_calls
       SET status = ?,
           provider_response_id = ?,
           verdict = ?,
           grade = ?,
           comment = ?,
           tag_agreement = ?,
           file_visibility = ?,
           row_bytes = ?,
           usage_json = ?,
           diagnostics_json = ?,
           updated_at = ?
       WHERE judge_call_id = ?`,
      params.status,
      providerResponseId,
      verdict,
      grade,
      comment,
      tagAgreementInt,
      fileVisibilityInt,
      rowBytes,
      usageJson,
      diagnosticsJson,
      params.nowIso,
      params.judgeCallId
    );
  });
}

export function getJudgeCallSummary(
  sql: SchemaSqlStorage,
  judgeCallId: string
): JudgeCallSummaryRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<JudgeCallSummaryRow>(
        `SELECT ${JUDGE_CALLS_SUMMARY_COLUMNS}
         FROM judge_calls
         WHERE judge_call_id = ?`,
        judgeCallId
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

export function getJudgeCallRequestBlob(
  sql: SchemaSqlStorage,
  judgeCallId: string
): Uint8Array | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<{ request_blob: JudgeCallRow["request_blob"] }>(
        "SELECT request_blob FROM judge_calls WHERE judge_call_id = ?",
        judgeCallId
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    return toUint8Array(rows[0]!.request_blob);
  });
}

export function listJudgeCallSummaries(
  sql: SchemaSqlStorage,
  options?: {
    turnIndex?: number;
    afterJudgeCallId?: string | null;
    upToJudgeCallId?: string | null;
    limit?: number;
  }
): JudgeCallSummaryRow[] {
  return withSqlErrorMapping(() => {
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (options?.turnIndex !== undefined) {
      conditions.push("turn_index = ?");
      bindings.push(options.turnIndex);
    }
    if (options?.afterJudgeCallId !== undefined && options.afterJudgeCallId !== null) {
      conditions.push("judge_call_id > ?");
      bindings.push(options.afterJudgeCallId);
    }
    if (options?.upToJudgeCallId !== undefined && options.upToJudgeCallId !== null) {
      conditions.push("judge_call_id <= ?");
      bindings.push(options.upToJudgeCallId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = clampPageLimit(options?.limit);
    bindings.push(limit);

    return sql
      .exec<JudgeCallSummaryRow>(
        `SELECT ${JUDGE_CALLS_SUMMARY_COLUMNS}
         FROM judge_calls
         ${whereClause}
         ORDER BY judge_call_id ASC
         LIMIT ?`,
        ...bindings
      )
      .toArray();
  });
}

// ============================================================================
// 4. Durable Work Obligations (`durable_work`)
// ============================================================================

export function upsertDurableWork(sql: SchemaSqlStorage, row: DurableWorkRow): void {
  withSqlErrorMapping(() => {
    const payloadBytes = measureByteLength(row.payload_json);
    const workIdBytes = measureByteLength(row.work_id);
    assertArtifactAndRowSize(payloadBytes, workIdBytes, "durable_work.row_bytes");

    sql.exec(
      `INSERT INTO durable_work (
        work_id,
        kind,
        attempt_id,
        turn_index,
        due_at_ms,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET
        kind = excluded.kind,
        attempt_id = excluded.attempt_id,
        turn_index = excluded.turn_index,
        due_at_ms = excluded.due_at_ms,
        payload_json = excluded.payload_json,
        created_at = excluded.created_at`,
      row.work_id,
      row.kind,
      row.attempt_id,
      row.turn_index,
      row.due_at_ms,
      row.payload_json,
      row.created_at
    );
  });
}

export function listDueDurableWork(
  sql: SchemaSqlStorage,
  nowMs: number,
  limit?: number
): DurableWorkRow[] {
  return withSqlErrorMapping(() => {
    const clampedLimit = clampPageLimit(limit);
    return sql
      .exec<DurableWorkRow>(
        `SELECT work_id, kind, attempt_id, turn_index, due_at_ms, payload_json, created_at
         FROM durable_work
         WHERE due_at_ms <= ?
         ORDER BY due_at_ms ASC, work_id ASC
         LIMIT ?`,
        nowMs,
        clampedLimit
      )
      .toArray();
  });
}

export function getEarliestDurableWorkDueAtMs(sql: SchemaSqlStorage): number | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<{ earliest: number | null }>(
        "SELECT MIN(due_at_ms) AS earliest FROM durable_work"
      )
      .toArray();
    if (rows.length === 0 || rows[0]!.earliest === null) {
      return null;
    }
    return Number(rows[0]!.earliest);
  });
}

export function deleteDurableWork(sql: SchemaSqlStorage, workId: string): void {
  withSqlErrorMapping(() => {
    sql.exec("DELETE FROM durable_work WHERE work_id = ?", workId);
  });
}

// ============================================================================
// 5. Export High-Water Marks (`captureExportHighWaterMarks`)
// ============================================================================

export function captureExportHighWaterMarks(sql: SchemaSqlStorage): ExportHighWaterMarks {
  return withSqlErrorMapping(() => {
    const jobRows = sql
      .exec<{ revision: number }>("SELECT revision FROM jobs LIMIT 1")
      .toArray();
    const startingRevision = jobRows.length > 0 ? Number(jobRows[0]!.revision) : 1;

    const turnRows = sql
      .exec<{ max_turn: number | null }>(
        "SELECT COALESCE(MAX(turn_index), 0) AS max_turn FROM turns"
      )
      .toArray();
    const maxTurnIndex =
      turnRows.length > 0 && turnRows[0]!.max_turn !== null ? Number(turnRows[0]!.max_turn) : 0;

    const attemptRows = sql
      .exec<{ max_attempt_id: string | null }>(
        "SELECT MAX(attempt_id) AS max_attempt_id FROM generation_attempts"
      )
      .toArray();
    const maxAttemptId = attemptRows.length > 0 ? attemptRows[0]!.max_attempt_id : null;

    const judgeRows = sql
      .exec<{ max_judge_call_id: string | null }>(
        "SELECT MAX(judge_call_id) AS max_judge_call_id FROM judge_calls"
      )
      .toArray();
    const maxJudgeCallId = judgeRows.length > 0 ? judgeRows[0]!.max_judge_call_id : null;

    return {
      startingRevision,
      maxTurnIndex,
      maxAttemptId,
      maxJudgeCallId,
      capturedAtMs: Date.now(),
    };
  });
}
