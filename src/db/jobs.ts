/**
 * JobStorage (`src/db/jobs.ts`) — SQLite repository for `jobs`, `branch_lineage`, and `job_files`.
 *
 * All database operations are strictly synchronous over `SchemaSqlStorage` and wrapped in
 * `withSqlErrorMapping` so `SQLITE_FULL` maps to `StorageFullError` and `ArtifactGuardError`
 * passes through untouched.
 */

import { ROW_GUARD_BYTES } from "../constants.ts";
import {
  assertBranchSnapshotSize,
  assertFileUploadSize,
  chunkRowsForBindLimit,
  clampPageLimit,
  guardBytes,
  measureByteLength,
} from "../lib/guards.ts";
import {
  withSqlErrorMapping,
  type BranchLineageRow,
  type JobFileRow,
  type JobRow,
  type SchemaSqlStorage,
  type SqlPrimitiveValue,
} from "./schema";

const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/**
 * Shared UTF-8 decoder helper for `ArrayBuffer` and `Uint8Array` BLOB columns.
 */
export function decodeBlobToUtf8(blob: ArrayBuffer | Uint8Array): string {
  return utf8Decoder.decode(blob);
}

/**
 * Validates the 1,500,000-byte row guard on a `jobs` row before writing.
 */
function assertJobRowSize(
  row: Pick<
    JobRow,
    | "job_id"
    | "title"
    | "model"
    | "judge_config_json"
    | "warnings_json"
    | "usage_summary_json"
    | "last_error_detail"
  >,
  context = "jobs.row_bytes"
): void {
  const totalBytes =
    measureByteLength(row.job_id) +
    measureByteLength(row.title) +
    measureByteLength(row.model) +
    measureByteLength(row.judge_config_json) +
    measureByteLength(row.warnings_json) +
    measureByteLength(row.usage_summary_json) +
    measureByteLength(row.last_error_detail);
  guardBytes(totalBytes, ROW_GUARD_BYTES, "row_bytes", context);
}

/**
 * Inserts a new `jobs` record inside `withSqlErrorMapping` and returns the stored row.
 */
export function insertJob(sql: SchemaSqlStorage, row: JobRow): JobRow {
  return withSqlErrorMapping(() => {
    assertJobRowSize(row, "jobs.insert");

    sql.exec(
      `INSERT INTO jobs (
        job_id,
        title,
        status,
        model,
        reasoning_effort,
        max_output_tokens,
        cache_ttl,
        web_search,
        judge_config_json,
        continuation_budget,
        continuations_used,
        auto_retry_budget,
        auto_retries_used,
        manual_retries_used,
        current_turn_index,
        total_turns,
        accepted_turn_index,
        active_attempt_id,
        last_accepted_response_id,
        last_judge_response_id,
        parent_job_id,
        fork_turn_index,
        revision,
        last_error_code,
        last_error_detail,
        warnings_json,
        usage_summary_json,
        created_at,
        updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
      row.job_id,
      row.title,
      row.status,
      row.model,
      row.reasoning_effort,
      row.max_output_tokens,
      row.cache_ttl,
      row.web_search,
      row.judge_config_json,
      row.continuation_budget,
      row.continuations_used,
      row.auto_retry_budget,
      row.auto_retries_used,
      row.manual_retries_used,
      row.current_turn_index,
      row.total_turns,
      row.accepted_turn_index,
      row.active_attempt_id,
      row.last_accepted_response_id,
      row.last_judge_response_id,
      row.parent_job_id,
      row.fork_turn_index,
      row.revision,
      row.last_error_code,
      row.last_error_detail,
      row.warnings_json,
      row.usage_summary_json,
      row.created_at,
      row.updated_at
    );

    return requireJob(sql, row.job_id);
  });
}

/**
 * Fetches the job row by `job_id`, or fetches the single job row in `JobDO` when `jobId` is omitted.
 */
export function getJob(sql: SchemaSqlStorage, jobId?: string): JobRow | null {
  return withSqlErrorMapping(() => {
    const rows =
      jobId !== undefined
        ? sql
            .exec<JobRow>("SELECT * FROM jobs WHERE job_id = ? LIMIT 1", jobId)
            .toArray()
        : sql.exec<JobRow>("SELECT * FROM jobs ORDER BY job_id ASC LIMIT 1").toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

/**
 * Fetches the job row or throws `Error("Job record not found")`.
 */
export function requireJob(sql: SchemaSqlStorage, jobId?: string): JobRow {
  const job = getJob(sql, jobId);
  if (job === null) {
    throw new Error("Job record not found");
  }
  return job;
}

export interface UpdateJobStatusAndRevisionParams {
  jobId: string;
  status: JobRow["status"];
  activeAttemptId?: string | null;
  currentTurnIndex?: number;
  acceptedTurnIndex?: number;
  continuationsUsed?: number;
  autoRetriesUsed?: number;
  manualRetriesUsed?: number;
  lastAcceptedResponseId?: string | null;
  lastJudgeResponseId?: string | null;
  lastErrorCode?: string | null;
  lastErrorDetail?: string | null;
  warningsJson?: string;
  usageSummaryJson?: string;
  updatedAt: string;
}

/**
 * Atomically updates provided fields on `jobs`, increments `revision = revision + 1`,
 * and returns the updated `JobRow`.
 */
export function updateJobStatusAndRevision(
  sql: SchemaSqlStorage,
  params: {
    jobId: string;
    status: JobRow["status"];
    activeAttemptId?: string | null;
    currentTurnIndex?: number;
    acceptedTurnIndex?: number;
    continuationsUsed?: number;
    autoRetriesUsed?: number;
    manualRetriesUsed?: number;
    lastAcceptedResponseId?: string | null;
    lastJudgeResponseId?: string | null;
    lastErrorCode?: string | null;
    lastErrorDetail?: string | null;
    warningsJson?: string;
    usageSummaryJson?: string;
    updatedAt: string;
  }
): JobRow {
  return withSqlErrorMapping(() => {
    const current = requireJob(sql, params.jobId);

    const nextWarningsJson =
      params.warningsJson !== undefined ? params.warningsJson : current.warnings_json;
    const nextUsageSummaryJson =
      params.usageSummaryJson !== undefined ? params.usageSummaryJson : current.usage_summary_json;
    const nextLastErrorDetail =
      params.lastErrorDetail !== undefined ? params.lastErrorDetail : current.last_error_detail;

    assertJobRowSize(
      {
        job_id: current.job_id,
        title: current.title,
        model: current.model,
        judge_config_json: current.judge_config_json,
        warnings_json: nextWarningsJson,
        usage_summary_json: nextUsageSummaryJson,
        last_error_detail: nextLastErrorDetail,
      },
      "jobs.update"
    );

    const assignments: string[] = ["status = ?", "revision = revision + 1", "updated_at = ?"];
    const bindings: SqlPrimitiveValue[] = [params.status, params.updatedAt];

    if (params.activeAttemptId !== undefined) {
      assignments.push("active_attempt_id = ?");
      bindings.push(params.activeAttemptId);
    }
    if (params.currentTurnIndex !== undefined) {
      assignments.push("current_turn_index = ?");
      bindings.push(params.currentTurnIndex);
    }
    if (params.acceptedTurnIndex !== undefined) {
      assignments.push("accepted_turn_index = ?");
      bindings.push(params.acceptedTurnIndex);
    }
    if (params.continuationsUsed !== undefined) {
      assignments.push("continuations_used = ?");
      bindings.push(params.continuationsUsed);
    }
    if (params.autoRetriesUsed !== undefined) {
      assignments.push("auto_retries_used = ?");
      bindings.push(params.autoRetriesUsed);
    }
    if (params.manualRetriesUsed !== undefined) {
      assignments.push("manual_retries_used = ?");
      bindings.push(params.manualRetriesUsed);
    }
    if (params.lastAcceptedResponseId !== undefined) {
      assignments.push("last_accepted_response_id = ?");
      bindings.push(params.lastAcceptedResponseId);
    }
    if (params.lastJudgeResponseId !== undefined) {
      assignments.push("last_judge_response_id = ?");
      bindings.push(params.lastJudgeResponseId);
    }
    if (params.lastErrorCode !== undefined) {
      assignments.push("last_error_code = ?");
      bindings.push(params.lastErrorCode);
    }
    if (params.lastErrorDetail !== undefined) {
      assignments.push("last_error_detail = ?");
      bindings.push(params.lastErrorDetail);
    }
    if (params.warningsJson !== undefined) {
      assignments.push("warnings_json = ?");
      bindings.push(params.warningsJson);
    }
    if (params.usageSummaryJson !== undefined) {
      assignments.push("usage_summary_json = ?");
      bindings.push(params.usageSummaryJson);
    }

    bindings.push(params.jobId);

    sql.exec(
      `UPDATE jobs SET ${assignments.join(", ")} WHERE job_id = ?`,
      ...bindings
    );

    return requireJob(sql, params.jobId);
  });
}

/**
 * Increments `revision = revision + 1` on `jobs` and returns the new revision number.
 */
export function bumpJobRevision(
  sql: SchemaSqlStorage,
  jobId: string,
  updatedAt: string
): number {
  return withSqlErrorMapping(() => {
    requireJob(sql, jobId);
    sql.exec(
      "UPDATE jobs SET revision = revision + 1, updated_at = ? WHERE job_id = ?",
      updatedAt,
      jobId
    );
    const updated = requireJob(sql, jobId);
    return updated.revision;
  });
}

/**
 * Validates `assertBranchSnapshotSize(row.snapshot_bytes)` and inserts into `branch_lineage`.
 */
export function insertBranchLineage(
  sql: SchemaSqlStorage,
  row: BranchLineageRow
): BranchLineageRow {
  return withSqlErrorMapping(() => {
    assertBranchSnapshotSize(row.snapshot_bytes, "branch_lineage.snapshot_bytes");

    sql.exec(
      `INSERT INTO branch_lineage (
        job_id,
        parent_job_id,
        parent_revision,
        fork_turn_index,
        snapshot_bytes,
        snapshot_sha256,
        files_protected,
        parent_superseded,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.job_id,
      row.parent_job_id,
      row.parent_revision,
      row.fork_turn_index,
      row.snapshot_bytes,
      row.snapshot_sha256,
      row.files_protected,
      row.parent_superseded,
      row.created_at
    );

    const inserted = getBranchLineage(sql, row.job_id);
    if (inserted === null) {
      throw new Error("Branch lineage record not found after insert");
    }
    return inserted;
  });
}

/**
 * Reads `branch_lineage` by `job_id`.
 */
export function getBranchLineage(
  sql: SchemaSqlStorage,
  jobId: string
): BranchLineageRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<BranchLineageRow>(
        "SELECT * FROM branch_lineage WHERE job_id = ? LIMIT 1",
        jobId
      )
      .toArray();
    return rows.length > 0 ? rows[0]! : null;
  });
}

/**
 * Updates `files_protected` and/or `parent_superseded` (0/1) on `branch_lineage`.
 */
export function markBranchActivationFlags(
  sql: SchemaSqlStorage,
  jobId: string,
  flags: { filesProtected?: boolean; parentSuperseded?: boolean }
): void {
  withSqlErrorMapping(() => {
    const assignments: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (flags.filesProtected !== undefined) {
      assignments.push("files_protected = ?");
      bindings.push(flags.filesProtected ? 1 : 0);
    }
    if (flags.parentSuperseded !== undefined) {
      assignments.push("parent_superseded = ?");
      bindings.push(flags.parentSuperseded ? 1 : 0);
    }

    if (assignments.length === 0) {
      return;
    }

    bindings.push(jobId);
    sql.exec(
      `UPDATE branch_lineage SET ${assignments.join(", ")} WHERE job_id = ?`,
      ...bindings
    );
  });
}

/**
 * Validates `assertFileUploadSize(f.byte_size)` for each row and inserts/updates
 * `job_files` in chunks via `chunkRowsForBindLimit(files, 8)` to respect the 100 bound-parameter limit.
 */
export function upsertJobFiles(
  sql: SchemaSqlStorage,
  files: readonly JobFileRow[]
): void {
  withSqlErrorMapping(() => {
    if (files.length === 0) {
      return;
    }

    for (const file of files) {
      assertFileUploadSize(file.byte_size, `job_files.${file.file_id}`);
    }

    const chunks = chunkRowsForBindLimit(files, 8);
    for (const chunk of chunks) {
      const valuePlaceholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const bindings: SqlPrimitiveValue[] = [];
      for (const file of chunk) {
        bindings.push(
          file.file_id,
          file.turn_index,
          file.filename,
          file.mime_type,
          file.byte_size,
          file.sha256,
          file.introduced_in_judge_call_id,
          file.created_at
        );
      }

      sql.exec(
        `INSERT INTO job_files (
          file_id,
          turn_index,
          filename,
          mime_type,
          byte_size,
          sha256,
          introduced_in_judge_call_id,
          created_at
        ) VALUES ${valuePlaceholders}
        ON CONFLICT (turn_index, file_id) DO UPDATE SET
          filename = excluded.filename,
          mime_type = excluded.mime_type,
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          introduced_in_judge_call_id = COALESCE(job_files.introduced_in_judge_call_id, excluded.introduced_in_judge_call_id),
          created_at = excluded.created_at`,
        ...bindings
      );
    }
  });
}

/**
 * Lists `job_files` with primary-key cursor pagination (`file_id > ?` ordered by
 * `turn_index ASC, file_id ASC`), clamped to `1..100` via `clampPageLimit`.
 */
export function listJobFiles(
  sql: SchemaSqlStorage,
  options?: { turnIndex?: number; afterFileId?: string | null; limit?: number }
): JobFileRow[] {
  return withSqlErrorMapping(() => {
    const limit = clampPageLimit(options?.limit);
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (options?.turnIndex !== undefined) {
      conditions.push("turn_index = ?");
      bindings.push(options.turnIndex);
    }
    if (options?.afterFileId !== undefined && options.afterFileId !== null && options.afterFileId !== "") {
      conditions.push("file_id > ?");
      bindings.push(options.afterFileId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    bindings.push(limit);

    return sql
      .exec<JobFileRow>(
        `SELECT
          file_id,
          turn_index,
          filename,
          mime_type,
          byte_size,
          sha256,
          introduced_in_judge_call_id,
          created_at
        FROM job_files
        ${whereClause}
        ORDER BY turn_index ASC, file_id ASC
        LIMIT ?`,
        ...bindings
      )
      .toArray();
  });
}

/**
 * Sets `introduced_in_judge_call_id = COALESCE(introduced_in_judge_call_id, ?)` on `job_files`
 * for stateful judge attachment inheritance tracking.
 */
export function markFileIntroducedInJudgeCall(
  sql: SchemaSqlStorage,
  turnIndex: number,
  fileId: string,
  judgeCallId: string
): void {
  withSqlErrorMapping(() => {
    sql.exec(
      `UPDATE job_files
       SET introduced_in_judge_call_id = COALESCE(introduced_in_judge_call_id, ?)
       WHERE turn_index = ? AND file_id = ?`,
      judgeCallId,
      turnIndex,
      fileId
    );
  });
}
