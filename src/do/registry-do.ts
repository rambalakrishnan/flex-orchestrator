/**
 * RegistryDO (`src/do/registry-do.ts`) — global job index, file catalogue, uploads, retention.
 *
 * The global registry owns four SQLite tables (`job_index`, `file_catalogue`,
 * `upload_intents`, and `job_file_refs`) and is reached through the `REGISTRY_DO`
 * binding using the singleton name `REGISTRY_DO_NAME`. It never stores source file
 * bytes, never writes job execution state, and never uploads without a durable
 * upload intent.
 *
 * Every SQLite operation is synchronous over `SchemaSqlStorage` and wrapped in
 * `withSqlErrorMapping`, so `SQLITE_FULL` maps to `StorageFullError` and
 * `ArtifactGuardError` is never swallowed. `transactionSync` closures contain no
 * `await` and no external I/O; provider Files API calls happen outside them.
 */

import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_FILE_RETENTION_SECONDS,
  ROW_GUARD_BYTES,
  TURN_INDEX_MIN,
} from "../constants.ts";
import {
  migrateRegistryDoSchema,
  withSqlErrorMapping,
  type FileCatalogueRow,
  type JobIndexRow,
  type SchemaSqlStorage,
  type SchemaTransactionalStorage,
  type SqlPrimitiveValue,
  type UploadIntentRow,
} from "../db/schema.ts";
import {
  earliestDeadline,
  ensureAlarmNotLaterThan,
  isAlarmWallTimeBudgetExceeded,
  runWithAlarmSafety,
} from "../lib/alarm.ts";
import { now } from "../lib/clock.ts";
import {
  assertFileUploadSize,
  clampPageLimit,
  guardBytes,
  measureByteLength,
} from "../lib/guards.ts";
import { deleteProviderFile, resolveEnvSecret } from "../lib/openai.ts";
import type {
  CursorPage,
  CursorPageRequest,
  FileCatalogueRecord,
  FileId,
  FileUploadIntentRecord,
  JobId,
  JobStatus,
  JobSummaryItem,
} from "../types.ts";

// ============================================================================
// BLOB-Free Column Projections (registry tables are metadata-only)
// ============================================================================

const JOB_INDEX_COLUMNS =
  "job_id, title, status, model, parent_job_id, is_terminal, revision, current_turn_index, accepted_turn_count, created_at, updated_at";

const FILE_CATALOGUE_COLUMNS =
  "file_id, sha256, filename, mime_type, byte_size, purpose, status, active_job_refs, retention_eligible_at_ms, created_at_ms, deleted_at_ms, created_at, updated_at";

const UPLOAD_INTENT_COLUMNS =
  "intent_id, sha256, filename, mime_type, byte_size, status, file_id, expires_at_ms, created_at, updated_at";

/**
 * Eligibility predicate shared by the retention sweep, its completion-due query,
 * and the per-file "mark deleting" fence. A file may be swept only when it is
 * unreferenced (`active_job_refs = 0`) and no non-terminal `job_index` row still
 * references it through `job_file_refs`.
 */
const RETENTION_ELIGIBILITY_SQL = `
  f.status IN ('live', 'deleting')
  AND f.active_job_refs = 0
  AND f.retention_eligible_at_ms IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM job_file_refs AS r
    INNER JOIN job_index AS j ON j.job_id = r.job_id
    WHERE r.file_id = f.file_id
      AND r.is_non_terminal = 1
      AND j.is_terminal = 0
  )`;

/** Retention pages are primary-key cursor pages clamped to the 1–100 range. */
const RETENTION_PAGE_LIMIT = 100;

/** Static terminality table derived solely from the shared `JobStatus` vocabulary. */
const TERMINAL_JOB_STATUS: Record<JobStatus, boolean> = {
  created: false,
  ready: false,
  running: false,
  paused_review: false,
  paused_dispatch: false,
  paused_storage: false,
  completed: true,
  failed: true,
  cancelled: true,
  superseded: true,
};

// ============================================================================
// Row Shapes and Mapping Helpers
// ============================================================================

interface FileIdRow extends Record<string, SqlPrimitiveValue> {
  file_id: string;
}

interface RevisionRow extends Record<string, SqlPrimitiveValue> {
  revision: number;
}

interface CatalogueStatusRow extends Record<string, SqlPrimitiveValue> {
  status: FileCatalogueRow["status"];
}

interface DeadlineRow extends Record<string, SqlPrimitiveValue> {
  next_due: number | null;
}

interface CountRow extends Record<string, SqlPrimitiveValue> {
  total: number;
}

/** Outcome of the synchronous part of `completeUploadIntent`. */
type CompleteUploadIntentOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "conflict" }
  | { readonly kind: "expired" }
  | { readonly kind: "not_pending"; readonly status: UploadIntentRow["status"] };

/** Counts returned by `runRetentionSweep` and by the alarm-driven sweep. */
interface RetentionSweepResult {
  readonly deleted: number;
  readonly retained: number;
  readonly failed: number;
}

/**
 * Enforces the 1,500,000-byte resulting-row guard over the metadata fields that
 * mirror the per-table SQL `CHECK (length(...) <= ...)` constraints. The byte
 * measure is stricter than SQLite's character `length()`, so a row that passes
 * here can never be rejected for size by the table constraint.
 */
function assertRegistryRowSize(parts: readonly (string | null)[], context: string): void {
  let totalBytes = 0;
  for (const part of parts) {
    totalBytes += measureByteLength(part);
  }
  guardBytes(totalBytes, ROW_GUARD_BYTES, "row_bytes", context);
}

/** Validates a non-empty identifier supplied across an RPC boundary. */
function requireNonEmptyIdentifier(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

/** Validates an epoch-millisecond value supplied across an RPC boundary. */
function requireEpochMs(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Formats an epoch-millisecond value as the canonical ISO-8601 TEXT timestamp. */
function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** Parses a stored ISO-8601 TEXT timestamp and rejects corrupted values. */
function epochMsFromIso(value: string, context: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ISO-8601 timestamp in ${context}: ${String(value)}`);
  }
  return ms;
}

/** Normalizes an optional opaque primary-key cursor. */
function normalizeCursor(cursor: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null) {
    return null;
  }
  if (typeof cursor !== "string") {
    throw new TypeError("cursor must be a string or null");
  }
  return cursor.length === 0 ? null : cursor;
}



/**
 * Resolves `FILE_RETENTION_SECONDS` into a millisecond window. Missing, empty,
 * non-integer, non-positive, or unsafe values fall back to the documented
 * seven-day default instead of silently disabling retention.
 */
function resolveRetentionWindowMs(rawSeconds: string | undefined): number {
  const seconds =
    typeof rawSeconds === "string" ? Number.parseInt(rawSeconds.trim(), 10) : Number.NaN;
  if (!Number.isInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000)) {
    return DEFAULT_FILE_RETENTION_SECONDS * 1000;
  }
  return seconds * 1000;
}

/** Maps a stored `file_catalogue` row onto the catalogue wire record. */
function toFileCatalogueRecord(row: FileCatalogueRow): FileCatalogueRecord {
  return {
    fileId: row.file_id,
    sha256Hex: row.sha256,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    activeJobRefCount: row.active_job_refs,
    uploadedAtMs: row.created_at_ms,
    lastReferencedAtMs: epochMsFromIso(row.updated_at, "file_catalogue.updated_at"),
    deletedFromProviderAtMs: row.deleted_at_ms,
  };
}

/** Maps a stored intent status onto the shared `FileUploadIntentStatus` vocabulary. */
function toFileUploadIntentStatus(
  status: UploadIntentRow["status"],
): FileUploadIntentRecord["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "uploaded":
      return "completed";
    case "cleaned":
      return "cleaned_up";
    case "ambiguous":
    case "failed":
      return "failed";
  }
}

/** Maps a stored `upload_intents` row onto the intent wire record. */
function toFileUploadIntentRecord(row: UploadIntentRow): FileUploadIntentRecord {
  return {
    intentId: row.intent_id,
    sha256Hex: row.sha256,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    status: toFileUploadIntentStatus(row.status),
    fileId: row.file_id,
    createdAtMs: epochMsFromIso(row.created_at, "upload_intents.created_at"),
    updatedAtMs: epochMsFromIso(row.updated_at, "upload_intents.updated_at"),
  };
}

/**
 * Projects a `job_index` row onto the shared listing item.
 *
 * `job_index` stores the registration-time summary projection (identity, status,
 * model, revision, and timestamps). Per-job turn counters and cost aggregates are
 * owned by `JobDO` and are never written to the global index, so the listing
 * reports the values a job is registered with (first turn, no acceptances, no
 * known total cost). Lifecycle transitions change only status, terminality, and
 * revision through `updateJobIndexStatus`.
 */
function requireTurnIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < TURN_INDEX_MIN) {
    throw new RangeError(`${label} must be an integer >= ${TURN_INDEX_MIN}`);
  }
  return value;
}

function requireAcceptedTurnCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("acceptedTurnCount must be a non-negative safe integer");
  }
  return value;
}

function toJobSummaryItem(row: JobIndexRow): JobSummaryItem {
  return {
    jobId: row.job_id,
    title: row.title,
    status: row.status,
    model: row.model,
    currentTurnIndex: row.current_turn_index,
    acceptedTurnCount: row.accepted_turn_count,
    totalEstimatedCostUsd: null,
    createdAtMs: epochMsFromIso(row.created_at, "job_index.created_at"),
    updatedAtMs: epochMsFromIso(row.updated_at, "job_index.updated_at"),
  };
}

// ============================================================================
// Upload-Intent Expiry and Retention Scheduling Helpers
// ============================================================================

/**
 * Marks expired `pending` intents `ambiguous` and retires `ambiguous` intents
 * that have outlived a full retention window (`cleaned`). Expired intents never
 * create catalogue rows; they only remain recoverable/cleanable records.
 */
function expireUploadIntents(
  storage: SchemaTransactionalStorage,
  nowMs: number,
  retentionWindowMs: number,
): void {
  withSqlErrorMapping(() => {
    const nowIso = isoFromMs(nowMs);
    storage.transactionSync(() => {
      const sql = storage.sql;
      sql.exec(
        `UPDATE upload_intents
         SET status = 'ambiguous', updated_at = ?
         WHERE status = 'pending' AND expires_at_ms <= ?`,
        nowIso,
        nowMs,
      );
      sql.exec(
        `UPDATE upload_intents
         SET status = 'cleaned', updated_at = ?
         WHERE status = 'ambiguous' AND expires_at_ms + ? <= ?`,
        nowIso,
        retentionWindowMs,
        nowMs,
      );
    });
  });
}

/** Earliest persisted upload-intent obligation (expiry or ambiguity cleanup). */
function nextUploadIntentDueAtMs(sql: SchemaSqlStorage, retentionWindowMs: number): number | null {
  return withSqlErrorMapping(() => {
    const row = sql
      .exec<DeadlineRow>(
        `SELECT MIN(
           CASE WHEN status = 'ambiguous' THEN expires_at_ms + ? ELSE expires_at_ms END
         ) AS next_due
         FROM upload_intents
         WHERE status IN ('pending', 'ambiguous')`,
        retentionWindowMs,
      )
      .toArray()[0];
    return row?.next_due ?? null;
  });
}

/**
 * Earliest retention obligation. Interrupted `deleting` rows are treated as due
 * immediately so a crashed sweep is completed by the next alarm.
 */
function nextRetentionDueAtMs(sql: SchemaSqlStorage, nowMs: number): number | null {
  return withSqlErrorMapping(() => {
    const row = sql
      .exec<DeadlineRow>(
        `SELECT MIN(
           CASE WHEN f.status = 'deleting' THEN ? ELSE f.retention_eligible_at_ms END
         ) AS next_due
         FROM file_catalogue AS f
         WHERE ${RETENTION_ELIGIBILITY_SQL}`,
        nowMs,
      )
      .toArray()[0];
    return row?.next_due ?? null;
  });
}

// ============================================================================
// Retention Sweep
// ============================================================================

/**
 * Deletes retention-eligible, unreferenced catalogue files through the Files API.
 *
 * Sweeps are incremental: eligible rows are read in primary-key cursor pages of
 * at most 100, and new deletions stop once the alarm wall-time budget is reached,
 * leaving the remainder for the next alarm. Each row is marked `deleting` with a
 * conditional update that re-checks the eligibility fence before the provider
 * call, then settled to `deleted` (including provider 404) or `failed`.
 */
async function sweepRetentionFiles(
  sql: SchemaSqlStorage,
  env: Env,
  startedAtMs: number,
): Promise<RetentionSweepResult> {
  const eligibilityCutoffMs = now();
  const pageLimit = clampPageLimit(RETENTION_PAGE_LIMIT);
  let deleted = 0;
  let failed = 0;
  let cursor: string | null = null;
  let apiKey: string | null = null;

  while (true) {
    const page = withSqlErrorMapping(() =>
      sql
        .exec<FileIdRow>(
          `SELECT f.file_id
           FROM file_catalogue AS f
           WHERE ${RETENTION_ELIGIBILITY_SQL}
             AND f.retention_eligible_at_ms <= ?
             AND f.file_id > ?
           ORDER BY f.file_id ASC
           LIMIT ?`,
          eligibilityCutoffMs,
          cursor ?? "",
          pageLimit,
        )
        .toArray(),
    );
    if (page.length === 0) {
      break;
    }

    let budgetExceeded = false;
    for (const candidate of page) {
      if (isAlarmWallTimeBudgetExceeded(startedAtMs)) {
        budgetExceeded = true;
        break;
      }

      const fileId = candidate.file_id;
      if (apiKey === null) {
        apiKey = resolveEnvSecret(env, "OPENAI_API_KEY");
      }
      const markedDeleting = withSqlErrorMapping(
        () =>
          sql.exec(
            `UPDATE file_catalogue
             SET status = 'deleting', updated_at = ?
             WHERE file_id = ?
               AND status IN ('live', 'deleting')
               AND active_job_refs = 0
               AND retention_eligible_at_ms IS NOT NULL
               AND retention_eligible_at_ms <= ?
               AND NOT EXISTS (
                 SELECT 1
                 FROM job_file_refs AS r
                 INNER JOIN job_index AS j ON j.job_id = r.job_id
                 WHERE r.file_id = file_catalogue.file_id
                   AND r.is_non_terminal = 1
                   AND j.is_terminal = 0
               )`,
            isoFromMs(now()),
            fileId,
            eligibilityCutoffMs,
          ).rowsWritten > 0,
      );
      if (!markedDeleting) {
        continue;
      }

      let providerDeleted: boolean;
      try {
        providerDeleted = (await deleteProviderFile({ apiKey, fileId })).deleted;
      } catch {
        // Provider transport/HTTP failure: settle the durable record as failed.
        withSqlErrorMapping(() => {
          sql.exec(
            `UPDATE file_catalogue
             SET status = 'failed', updated_at = ?
             WHERE file_id = ? AND status = 'deleting'`,
            isoFromMs(now()),
            fileId,
          );
        });
        failed += 1;
        continue;
      }

      const completedAtMs = now();
      const completedIso = isoFromMs(completedAtMs);
      if (providerDeleted) {
        withSqlErrorMapping(() => {
          sql.exec(
            `UPDATE file_catalogue
             SET status = 'deleted', deleted_at_ms = ?, updated_at = ?
             WHERE file_id = ? AND status = 'deleting'`,
            completedAtMs,
            completedIso,
            fileId,
          );
        });
        deleted += 1;
      } else {
        withSqlErrorMapping(() => {
          sql.exec(
            `UPDATE file_catalogue
             SET status = 'failed', updated_at = ?
             WHERE file_id = ? AND status = 'deleting'`,
            completedIso,
            fileId,
          );
        });
        failed += 1;
      }
    }

    if (budgetExceeded) {
      break;
    }
    const last = page[page.length - 1];
    if (last === undefined) {
      break;
    }
    cursor = last.file_id;
  }

  const retained = withSqlErrorMapping(
    () =>
      sql
        .exec<CountRow>(`SELECT COUNT(*) AS total FROM file_catalogue WHERE status = 'live'`)
        .one().total,
  );

  return { deleted, retained, failed };
}

// ============================================================================
// RegistryDO
// ============================================================================

export class RegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Workers-types widens SqlStorage bindings; the schema adapter accepts the same values at runtime.
    const storage = ctx.storage as unknown as SchemaTransactionalStorage;
    migrateRegistryDoSchema(storage);
  }

  // --------------------------------------------------------------------------
  // Job index
  // --------------------------------------------------------------------------

  /**
   * Registers one global job-index row. Idempotent per `jobId`: an existing row
   * is never reset or overwritten, so an advanced revision always survives a
   * repeated registration.
   */
  async registerJob(summary: JobSummaryItem): Promise<void> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const jobId = requireNonEmptyIdentifier(summary.jobId, "jobId");
    const model = requireNonEmptyIdentifier(summary.model, "model");
    const title = typeof summary.title === "string" ? summary.title : "";
    const createdAtMs = requireEpochMs(summary.createdAtMs, "createdAtMs");
    const updatedAtMs = requireEpochMs(summary.updatedAtMs, "updatedAtMs");

    withSqlErrorMapping(() => {
      assertRegistryRowSize([jobId, title, model], "job_index.row_bytes");
      storage.sql.exec(
        `INSERT INTO job_index (
           job_id, title, status, model, parent_job_id, is_terminal, revision,
           current_turn_index, accepted_turn_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO NOTHING`,
        jobId,
        title,
        summary.status,
        model,
        TERMINAL_JOB_STATUS[summary.status] ? 1 : 0,
        requireTurnIndex(summary.currentTurnIndex, "currentTurnIndex"),
        requireAcceptedTurnCount(summary.acceptedTurnCount),
        isoFromMs(createdAtMs),
        isoFromMs(updatedAtMs),
      );
    });
  }

  /**
   * Revision-fenced index update. A status supplied with an older revision than
   * the stored row is ignored rather than overwriting a newer status; only
   * status, terminality, revision, and `updated_at` change.
   */
  async updateJobIndexStatus(
    jobId: JobId,
    status: JobStatus,
    revision: number,
    currentTurnIndex: number,
    acceptedTurnCount: number,
  ): Promise<void> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const indexJobId = requireNonEmptyIdentifier(jobId, "jobId");
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new RangeError("revision must be a positive safe integer");
    }
    const turnIndex = requireTurnIndex(currentTurnIndex, "currentTurnIndex");
    const acceptedTurns = requireAcceptedTurnCount(acceptedTurnCount);

    withSqlErrorMapping(() => {
      storage.transactionSync(() => {
        const sql = storage.sql;
        const existing = sql
          .exec<RevisionRow>(`SELECT revision FROM job_index WHERE job_id = ?`, indexJobId)
          .toArray()[0];
        if (existing === undefined) {
          throw new Error(`Job index not found: ${indexJobId}`);
        }
        if (revision < existing.revision) {
          return;
        }
        sql.exec(
          `UPDATE job_index
           SET status = ?, is_terminal = ?, revision = ?,
               current_turn_index = ?, accepted_turn_count = ?, updated_at = ?
           WHERE job_id = ?`,
          status,
          TERMINAL_JOB_STATUS[status] ? 1 : 0,
          revision,
          turnIndex,
          acceptedTurns,
          isoFromMs(now()),
          indexJobId,
        );
      });
    });
  }

  /** Primary-key cursor page over the global job index, ordered by `job_id`. */
  async listJobs(request: CursorPageRequest): Promise<CursorPage<JobSummaryItem>> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const limit = clampPageLimit(request.limit);
    const cursor = normalizeCursor(request.cursor);

    const rows = withSqlErrorMapping(() =>
      storage.sql
        .exec<JobIndexRow>(
          `SELECT ${JOB_INDEX_COLUMNS}
           FROM job_index
           WHERE job_id > ?
           ORDER BY job_id ASC
           LIMIT ?`,
          cursor ?? "",
          limit + 1,
        )
        .toArray(),
    );

    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toJobSummaryItem),
      nextCursor: hasMore && lastRow !== undefined ? lastRow.job_id : null,
      hasMore,
    };
  }

  // --------------------------------------------------------------------------
  // File catalogue and uploads
  // --------------------------------------------------------------------------

  /** Returns only a live (`status = 'live'`) catalogue row for the exact hash. */
  async findFileByHash(sha256: string): Promise<FileCatalogueRecord | null> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const row = withSqlErrorMapping(
      () =>
        storage.sql
          .exec<FileCatalogueRow>(
            `SELECT ${FILE_CATALOGUE_COLUMNS}
             FROM file_catalogue
             WHERE sha256 = ? AND status = 'live'
             ORDER BY created_at_ms ASC, file_id ASC
             LIMIT 1`,
            sha256,
          )
          .toArray()[0],
    );
    return row === undefined ? null : toFileCatalogueRecord(row);
  }

  /**
   * Records a durable `pending` upload intent before the external upload.
   * Idempotent for the same `intentId` and identical content; reusing an intent
   * id for different content is rejected.
   */
  async beginUploadIntent(input: {
    intentId: string;
    sha256: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    expiresAtMs: number;
  }): Promise<FileUploadIntentRecord> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const intentId = requireNonEmptyIdentifier(input.intentId, "intentId");
    const sha256 = requireNonEmptyIdentifier(input.sha256, "sha256");
    const filename = requireNonEmptyIdentifier(input.filename, "filename");
    const mimeType = requireNonEmptyIdentifier(input.mimeType, "mimeType");
    const expiresAtMs = requireEpochMs(input.expiresAtMs, "expiresAtMs");
    const startedAtMs = now();
    const startedIso = isoFromMs(startedAtMs);

    const record = withSqlErrorMapping(() => {
      const byteSize = assertFileUploadSize(input.byteSize, "upload_intents.byte_size");
      assertRegistryRowSize(
        [intentId, sha256, filename, mimeType],
        "upload_intents.row_bytes",
      );

      return storage.transactionSync(() => {
        const sql = storage.sql;
        const existing = sql
          .exec<UploadIntentRow>(
            `SELECT ${UPLOAD_INTENT_COLUMNS} FROM upload_intents WHERE intent_id = ?`,
            intentId,
          )
          .toArray()[0];
        if (existing !== undefined) {
          if (existing.sha256 !== sha256 || existing.byte_size !== byteSize) {
            throw new Error(
              `Upload intent ${intentId} was already begun with different content`,
            );
          }
          return toFileUploadIntentRecord(existing);
        }

        sql.exec(
          `INSERT INTO upload_intents (
             intent_id, sha256, filename, mime_type, byte_size, status, file_id,
             expires_at_ms, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)`,
          intentId,
          sha256,
          filename,
          mimeType,
          byteSize,
          expiresAtMs,
          startedIso,
          startedIso,
        );

        const inserted = sql
          .exec<UploadIntentRow>(
            `SELECT ${UPLOAD_INTENT_COLUMNS} FROM upload_intents WHERE intent_id = ?`,
            intentId,
          )
          .toArray()[0];
        if (inserted === undefined) {
          throw new Error(`Upload intent ${intentId} was not persisted`);
        }
        return toFileUploadIntentRecord(inserted);
      });
    });

    if (record.status === "pending") {
      await ensureAlarmNotLaterThan(this.ctx.storage, expiresAtMs);
    }
    return record;
  }

  /**
   * Links the provider-issued `fileId` and marks the intent `uploaded`. An
   * expired intent becomes `ambiguous` (recoverable for cleanup) and is rejected
   * rather than authorizing a late completion.
   */
  async completeUploadIntent(intentId: string, fileId: FileId): Promise<void> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const id = requireNonEmptyIdentifier(intentId, "intentId");
    const providerFileId = requireNonEmptyIdentifier(fileId, "fileId");
    const completedAtMs = now();
    const completedIso = isoFromMs(completedAtMs);

    const outcome = withSqlErrorMapping(() =>
      storage.transactionSync((): CompleteUploadIntentOutcome => {
        const sql = storage.sql;
        const existing = sql
          .exec<UploadIntentRow>(
            `SELECT ${UPLOAD_INTENT_COLUMNS} FROM upload_intents WHERE intent_id = ?`,
            id,
          )
          .toArray()[0];
        if (existing === undefined) {
          return { kind: "missing" };
        }
        if (existing.status === "uploaded") {
          return existing.file_id === providerFileId ? { kind: "ok" } : { kind: "conflict" };
        }
        if (existing.status !== "pending") {
          return { kind: "not_pending", status: existing.status };
        }
        if (completedAtMs >= existing.expires_at_ms) {
          sql.exec(
            `UPDATE upload_intents
             SET status = 'ambiguous', updated_at = ?
             WHERE intent_id = ? AND status = 'pending'`,
            completedIso,
            id,
          );
          return { kind: "expired" };
        }
        sql.exec(
          `UPDATE upload_intents
           SET status = 'uploaded', file_id = ?, updated_at = ?
           WHERE intent_id = ? AND status = 'pending'`,
          providerFileId,
          completedIso,
          id,
        );
        return { kind: "ok" };
      }),
    );

    if (outcome.kind === "missing") {
      throw new Error(`Upload intent not found: ${id}`);
    }
    if (outcome.kind === "conflict") {
      throw new Error(`Upload intent ${id} was already completed with a different file id`);
    }
    if (outcome.kind === "expired") {
      throw new Error(`Upload intent ${id} expired before completion`);
    }
    if (outcome.kind === "not_pending") {
      throw new Error(`Upload intent ${id} is ${outcome.status} and cannot be completed`);
    }
  }

  /**
   * Records provider-issued catalogue metadata. Content-hash dedupe keeps at most
   * one live row per hash: if a live row already exists it is returned instead of
   * inserting a second row. File bytes are never stored here.
   */
  async recordFileUpload(input: {
    fileId: FileId;
    sha256: string;
    filename: string;
    mimeType: string;
    byteSize: number;
  }): Promise<FileCatalogueRecord> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const fileId = requireNonEmptyIdentifier(input.fileId, "fileId");
    const sha256 = requireNonEmptyIdentifier(input.sha256, "sha256");
    const filename = requireNonEmptyIdentifier(input.filename, "filename");
    const mimeType = requireNonEmptyIdentifier(input.mimeType, "mimeType");
    const retentionWindowMs = resolveRetentionWindowMs(this.env.FILE_RETENTION_SECONDS);
    const recordedAtMs = now();
    const recordedIso = isoFromMs(recordedAtMs);
    const retentionEligibleAtMs = recordedAtMs + retentionWindowMs;
    if (!Number.isSafeInteger(retentionEligibleAtMs)) {
      throw new RangeError("Retention eligibility timestamp exceeds the safe integer range");
    }

    const result = withSqlErrorMapping(() => {
      const byteSize = assertFileUploadSize(input.byteSize, "file_catalogue.byte_size");
      assertRegistryRowSize(
        [fileId, sha256, filename, mimeType],
        "file_catalogue.row_bytes",
      );

      return storage.transactionSync((): {
        readonly record: FileCatalogueRecord;
        readonly inserted: boolean;
      } => {
        const sql = storage.sql;
        const live = sql
          .exec<FileCatalogueRow>(
            `SELECT ${FILE_CATALOGUE_COLUMNS}
             FROM file_catalogue
             WHERE sha256 = ? AND status = 'live'
             ORDER BY created_at_ms ASC, file_id ASC
             LIMIT 1`,
            sha256,
          )
          .toArray()[0];
        if (live !== undefined) {
          return { record: toFileCatalogueRecord(live), inserted: false };
        }

        const existingFileId = sql
          .exec<FileIdRow>(`SELECT file_id FROM file_catalogue WHERE file_id = ?`, fileId)
          .toArray()[0];
        if (existingFileId !== undefined) {
          throw new Error(
            `File id ${fileId} is already catalogued with different content or is no longer live`,
          );
        }

        sql.exec(
          `INSERT INTO file_catalogue (
             file_id, sha256, filename, mime_type, byte_size, purpose, status,
             active_job_refs, retention_eligible_at_ms, created_at_ms, deleted_at_ms,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'user_data', 'live', 0, ?, ?, NULL, ?, ?)`,
          fileId,
          sha256,
          filename,
          mimeType,
          byteSize,
          retentionEligibleAtMs,
          recordedAtMs,
          recordedIso,
          recordedIso,
        );

        const inserted = sql
          .exec<FileCatalogueRow>(
            `SELECT ${FILE_CATALOGUE_COLUMNS} FROM file_catalogue WHERE file_id = ?`,
            fileId,
          )
          .toArray()[0];
        if (inserted === undefined) {
          throw new Error(`Catalogue record ${fileId} was not persisted`);
        }
        return { record: toFileCatalogueRecord(inserted), inserted: true };
      });
    });

    if (result.inserted) {
      await ensureAlarmNotLaterThan(this.ctx.storage, retentionEligibleAtMs);
    }
    return result.record;
  }

  /** Reads one catalogue record, including its recorded lifecycle status. */
  async getFile(fileId: FileId): Promise<FileCatalogueRecord | null> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const id = requireNonEmptyIdentifier(fileId, "fileId");
    const row = withSqlErrorMapping(
      () =>
        storage.sql
          .exec<FileCatalogueRow>(
            `SELECT ${FILE_CATALOGUE_COLUMNS} FROM file_catalogue WHERE file_id = ?`,
            id,
          )
          .toArray()[0],
    );
    return row === undefined ? null : toFileCatalogueRecord(row);
  }

  /** Primary-key cursor page over the catalogue, ordered by `file_id`. */
  async listFiles(request: CursorPageRequest): Promise<CursorPage<FileCatalogueRecord>> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const limit = clampPageLimit(request.limit);
    const cursor = normalizeCursor(request.cursor);

    const rows = withSqlErrorMapping(() =>
      storage.sql
        .exec<FileCatalogueRow>(
          `SELECT ${FILE_CATALOGUE_COLUMNS}
           FROM file_catalogue
           WHERE file_id > ?
           ORDER BY file_id ASC
           LIMIT ?`,
          cursor ?? "",
          limit + 1,
        )
        .toArray(),
    );

    const pageRows = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];
    return {
      items: pageRows.map(toFileCatalogueRecord),
      nextCursor: hasMore && lastRow !== undefined ? lastRow.file_id : null,
      hasMore,
    };
  }

  // --------------------------------------------------------------------------
  // Non-terminal file references
  // --------------------------------------------------------------------------

  /**
   * Protects every `(jobId, fileId)` pair before a job becomes ready. Repeated
   * protection is idempotent: `active_job_refs` increments only when a reference
   * is newly created or reactivated from a terminal state.
   */
  async protectJobFileRefs(jobId: JobId, fileIds: readonly FileId[]): Promise<void> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const job = requireNonEmptyIdentifier(jobId, "jobId");
    if (!Array.isArray(fileIds)) {
      throw new TypeError("fileIds must be an array of file ids");
    }

    const uniqueFileIds: string[] = [];
    const seen = new Set<string>();
    for (const candidate of fileIds) {
      const fileId = requireNonEmptyIdentifier(candidate, "fileId");
      if (!seen.has(fileId)) {
        seen.add(fileId);
        uniqueFileIds.push(fileId);
      }
    }
    if (uniqueFileIds.length === 0) {
      return;
    }

    const protectedAtMs = now();
    const protectedIso = isoFromMs(protectedAtMs);

    withSqlErrorMapping(() => {
      storage.transactionSync(() => {
        const sql = storage.sql;
        for (const fileId of uniqueFileIds) {
          const reference = sql
            .exec<Record<string, SqlPrimitiveValue>>(
              `SELECT job_id, file_id, is_non_terminal, created_at, updated_at
               FROM job_file_refs
               WHERE job_id = ? AND file_id = ?`,
              job,
              fileId,
            )
            .toArray()[0];

          if (reference !== undefined && reference.is_non_terminal === 1) {
            continue;
          }

          const catalogue = sql
            .exec<CatalogueStatusRow>(
              `SELECT status FROM file_catalogue WHERE file_id = ?`,
              fileId,
            )
            .toArray()[0];
          if (catalogue === undefined) {
            throw new Error(`Cannot protect unknown catalogue file: ${fileId}`);
          }
          if (catalogue.status !== "live") {
            throw new Error(
              `Cannot protect catalogue file ${fileId} with status ${catalogue.status}`,
            );
          }

          if (reference === undefined) {
            sql.exec(
              `INSERT INTO job_file_refs (job_id, file_id, is_non_terminal, created_at, updated_at)
               VALUES (?, ?, 1, ?, ?)`,
              job,
              fileId,
              protectedIso,
              protectedIso,
            );
          } else {
            sql.exec(
              `UPDATE job_file_refs
               SET is_non_terminal = 1, updated_at = ?
               WHERE job_id = ? AND file_id = ?`,
              protectedIso,
              job,
              fileId,
            );
          }

          sql.exec(
            `UPDATE file_catalogue
             SET active_job_refs = active_job_refs + 1, updated_at = ?
             WHERE file_id = ?`,
            protectedIso,
            fileId,
          );
        }
      });
    });
  }

  /**
   * Marks a job's references terminal and decrements each file exactly once.
   * Files whose last active reference is released become retention-eligible one
   * retention window from the release; the alarm is advanced only if earlier.
   */
  async releaseJobFileRefs(jobId: JobId): Promise<void> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const job = requireNonEmptyIdentifier(jobId, "jobId");
    const releasedAtMs = now();
    const releasedIso = isoFromMs(releasedAtMs);
    const retentionWindowMs = resolveRetentionWindowMs(this.env.FILE_RETENTION_SECONDS);
    const retentionEligibleAtMs = releasedAtMs + retentionWindowMs;
    if (!Number.isSafeInteger(retentionEligibleAtMs)) {
      throw new RangeError("Retention eligibility timestamp exceeds the safe integer range");
    }

    const releasedFileIds = withSqlErrorMapping(() =>
      storage.transactionSync((): string[] => {
        const sql = storage.sql;
        const activeFileIds = sql
          .exec<FileIdRow>(
            `SELECT file_id
             FROM job_file_refs
             WHERE job_id = ? AND is_non_terminal = 1
             ORDER BY file_id ASC`,
            job,
          )
          .toArray()
          .map((row) => row.file_id);
        if (activeFileIds.length === 0) {
          return [];
        }

        sql.exec(
          `UPDATE job_file_refs
           SET is_non_terminal = 0, updated_at = ?
           WHERE job_id = ? AND is_non_terminal = 1`,
          releasedIso,
          job,
        );

        for (const fileId of activeFileIds) {
          sql.exec(
            `UPDATE file_catalogue
             SET active_job_refs = MAX(active_job_refs - 1, 0),
                 retention_eligible_at_ms = CASE
                   WHEN active_job_refs = 1 THEN ?
                   ELSE retention_eligible_at_ms
                 END,
                 updated_at = ?
             WHERE file_id = ?`,
            retentionEligibleAtMs,
            releasedIso,
            fileId,
          );
        }
        return activeFileIds;
      }),
    );

    if (releasedFileIds.length > 0) {
      await ensureAlarmNotLaterThan(this.ctx.storage, retentionEligibleAtMs);
    }
  }

  // --------------------------------------------------------------------------
  // Retention sweep and alarm
  // --------------------------------------------------------------------------

  /**
   * Runs one budgeted retention sweep and advances the next retention alarm.
   * Only retention-eligible files with zero active references and no non-terminal
   * job reference are deleted; provider 404 counts as already deleted.
   */
  async runRetentionSweep(): Promise<{ deleted: number; retained: number; failed: number }> {
    const storage = this.ctx.storage as unknown as SchemaTransactionalStorage;
    const startedAtMs = now();
    const retentionWindowMs = resolveRetentionWindowMs(this.env.FILE_RETENTION_SECONDS);
    expireUploadIntents(storage, startedAtMs, retentionWindowMs);
    const result = await sweepRetentionFiles(storage.sql, this.env, startedAtMs);
    const nextDueAtMs = earliestDeadline([
      nextRetentionDueAtMs(storage.sql, now()),
      nextUploadIntentDueAtMs(storage.sql, retentionWindowMs),
    ]);
    if (nextDueAtMs !== null) {
      await ensureAlarmNotLaterThan(this.ctx.storage, nextDueAtMs);
    }
    return result;
  }

  /**
   * Single alarm for the global registry. Expires upload intents, sweeps eligible
   * files within the alarm wall-time budget, and reschedules against the earliest
   * persisted obligation (intent expiry/ambiguity cleanup or retention due time).
   */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const runtimeStorage = this.ctx.storage;
    const storage = runtimeStorage as unknown as SchemaTransactionalStorage;
    const env = this.env;

    await runWithAlarmSafety(runtimeStorage, alarmInfo, async () => {
      const startedAtMs = now();
      const retentionWindowMs = resolveRetentionWindowMs(env.FILE_RETENTION_SECONDS);
      expireUploadIntents(storage, startedAtMs, retentionWindowMs);
      await sweepRetentionFiles(storage.sql, env, startedAtMs);

      return earliestDeadline([
        nextUploadIntentDueAtMs(storage.sql, retentionWindowMs),
        nextRetentionDueAtMs(storage.sql, now()),
      ]);
    });
  }
}