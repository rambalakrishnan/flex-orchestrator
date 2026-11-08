/**
 * Schema (`src/db/schema.ts`) — SQLite schemas, migrations, and SQL error classification.
 *
 * Defines strict SQLite tables, manual `_sql_schema_migrations` version tracking
 * (since `PRAGMA user_version` is unsupported in Cloudflare Durable Object SQLite),
 * and `SQLITE_FULL` / artifact-guard error classification. Every numeric limit is
 * sourced from `src/constants.ts`; pure byte guards live in `src/lib/guards.ts`.
 */

import {
  ARTIFACT_ROW_GUARD_BYTES,
  MAX_BRANCH_SNAPSHOT_BYTES,
  MAX_FILE_UPLOAD_BYTES,
  ROW_GUARD_BYTES,
  TURN_INDEX_MIN,
} from "../constants.ts";
import { ArtifactGuardError } from "../lib/guards.ts";

/** Current schema version for `JobDO`, `RouterDO`, and `RegistryDO`. */
export const CURRENT_SCHEMA_VERSION = 1;

// ============================================================================
// Minimal Structural SQL Interfaces (Compatible with Cloudflare SqlStorage)
// ============================================================================

/** Valid column value types supported by Durable Object SQLite storage. */
export type SqlPrimitiveValue = ArrayBuffer | Uint8Array | string | number | null;

/** Minimal synchronous cursor interface matching `SqlStorageCursor`. */
export interface SchemaSqlCursor<T extends Record<string, SqlPrimitiveValue> = Record<string, SqlPrimitiveValue>>
  extends Iterable<T> {
  toArray(): T[];
  one(): T;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** Minimal synchronous SQL executor matching `ctx.storage.sql`. */
export interface SchemaSqlStorage {
  exec<T extends Record<string, SqlPrimitiveValue> = Record<string, SqlPrimitiveValue>>(
    query: string,
    ...bindings: SqlPrimitiveValue[]
  ): SchemaSqlCursor<T>;
  readonly databaseSize?: number;
}

/** Minimal synchronous transaction host matching `ctx.storage`. */
export interface SchemaTransactionalStorage {
  readonly sql: SchemaSqlStorage;
  transactionSync<T>(closure: () => T): T;
  deleteAll?(): Promise<void>;
  deleteAlarm?(): Promise<void>;
}

// ============================================================================
// Explicit Errors (No Truncation, Distinct SQLITE_FULL)
// ============================================================================

/**
 * Raised when a SQLite-backed Durable Object reaches its storage ceiling (`SQLITE_FULL`).
 */
export class StorageFullError extends Error {
  readonly code = "SQLITE_FULL" as const;
  override readonly cause: unknown;

  constructor(message = "Durable Object SQLite storage is full (SQLITE_FULL)", cause?: unknown) {
    super(message);
    this.name = "StorageFullError";
    this.cause = cause;
  }
}

/**
 * Raised when a schema migration fails inside `blockConcurrencyWhile`.
 */
export class SchemaMigrationError extends Error {
  readonly code = "SCHEMA_MIGRATION_FAILED" as const;
  readonly targetName: string;
  readonly version: number;
  override readonly cause: unknown;

  constructor(targetName: string, version: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Schema migration failed for ${targetName} at version ${version}: ${detail}`);
    this.name = "SchemaMigrationError";
    this.targetName = targetName;
    this.version = version;
    this.cause = cause;
  }
}

// ============================================================================
// SQL Error Classification (`SQLITE_FULL` Mapping)
// ============================================================================

/**
 * Inspects an unknown error and returns `true` when it represents `SQLITE_FULL`.
 */
export function isSqliteFullError(error: unknown): boolean {
  if (error instanceof StorageFullError) {
    return true;
  }
  if (error instanceof Error) {
    return (
      error.message.includes("SQLITE_FULL") ||
      error.message.includes("database or disk is full")
    );
  }
  if (typeof error === "string") {
    return error.includes("SQLITE_FULL") || error.includes("database or disk is full");
  }
  return false;
}

/**
 * Wraps synchronous SQL execution so `SQLITE_FULL` is rethrown as a distinct,
 * catchable `StorageFullError` and `ArtifactGuardError` passes through untouched.
 */
export function withSqlErrorMapping<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof ArtifactGuardError || error instanceof StorageFullError) {
      throw error;
    }
    if (isSqliteFullError(error)) {
      throw new StorageFullError(
        error instanceof Error ? error.message : "database or disk is full: SQLITE_FULL",
        error
      );
    }
    throw error;
  }
}

// ============================================================================
// Migration Tracking Table (`_sql_schema_migrations` — NEVER `PRAGMA user_version`)
// ============================================================================

export const CREATE_SCHEMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;
`.trim();

export interface SchemaMigrationRow extends Record<string, SqlPrimitiveValue> {
  id: number;
  applied_at: string;
}

// ============================================================================
// JobDO Schema (Strict Tables + 1.5 MB Artifact & Row Guards)
// ============================================================================

/**
 * `jobs` — Single-row (or job- keyed) definition, status, revision, and counters for `JobDO`.
 */
export const CREATE_JOBS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN (
      'created',
      'ready',
      'running',
      'paused_review',
      'paused_dispatch',
      'paused_storage',
      'completed',
      'failed',
      'cancelled',
      'superseded'
    )
  ),
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL,
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  cache_ttl TEXT NOT NULL CHECK (cache_ttl IN ('30m', '12h', '24h', 'nocache')),
  web_search INTEGER NOT NULL DEFAULT 0 CHECK (web_search IN (0, 1)),
  judge_config_json TEXT NOT NULL CHECK (json_valid(judge_config_json)),
  developer_prompt TEXT NOT NULL DEFAULT '',
  developer_file_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(developer_file_ids_json)),
  continuation_budget INTEGER NOT NULL DEFAULT 3 CHECK (continuation_budget = 3),
  continuations_used INTEGER NOT NULL DEFAULT 0 CHECK (continuations_used >= 0 AND continuations_used <= 3),
  auto_retry_budget INTEGER NOT NULL DEFAULT 1 CHECK (auto_retry_budget = 1),
  auto_retries_used INTEGER NOT NULL DEFAULT 0 CHECK (auto_retries_used >= 0 AND auto_retries_used <= 1),
  manual_retries_used INTEGER NOT NULL DEFAULT 0 CHECK (manual_retries_used >= 0),
  current_turn_index INTEGER NOT NULL DEFAULT ${TURN_INDEX_MIN} CHECK (current_turn_index >= ${TURN_INDEX_MIN}),
  total_turns INTEGER NOT NULL CHECK (total_turns >= 1),
  accepted_turn_index INTEGER NOT NULL DEFAULT 0 CHECK (accepted_turn_index >= 0),
  active_attempt_id TEXT,
  last_accepted_response_id TEXT,
  last_judge_response_id TEXT,
  parent_job_id TEXT,
  fork_turn_index INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_error_code TEXT,
  last_error_detail TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings_json)),
  usage_summary_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(usage_summary_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(job_id) +
    length(title) +
    length(model) +
    length(judge_config_json) +
    length(developer_prompt) +
    length(developer_file_ids_json) +
    length(warnings_json) +
    length(usage_summary_json) +
    COALESCE(length(last_error_detail), 0) <= ${ARTIFACT_ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

/**
 * `branch_lineage` — Branch provenance and snapshot metadata (bounded to 8,000,000 encoded bytes).
 */
export const CREATE_BRANCH_LINEAGE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS branch_lineage (
  job_id TEXT PRIMARY KEY,
  parent_job_id TEXT NOT NULL,
  parent_revision INTEGER NOT NULL CHECK (parent_revision >= 1),
  fork_turn_index INTEGER NOT NULL CHECK (fork_turn_index >= 0),
  snapshot_bytes INTEGER NOT NULL CHECK (snapshot_bytes >= 0 AND snapshot_bytes <= ${MAX_BRANCH_SNAPSHOT_BYTES}),
  snapshot_sha256 TEXT NOT NULL,
  files_protected INTEGER NOT NULL DEFAULT 0 CHECK (files_protected IN (0, 1)),
  parent_superseded INTEGER NOT NULL DEFAULT 0 CHECK (parent_superseded IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;
`.trim();

/**
 * `job_files` — File references attached to a job/turn (catalogue `file_id` references only; no source file bytes).
 */
export const CREATE_JOB_FILES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS job_files (
  file_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= ${MAX_FILE_UPLOAD_BYTES}),
  sha256 TEXT NOT NULL,
  introduced_in_judge_call_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (turn_index, file_id)
) STRICT;
`.trim();

/**
 * `turns` — Sequential turns within a job.
 * Prompt text is stored as a guarded BLOB (`prompt_blob`) with independent artifact and row 1.5 MB guards.
 */
export const CREATE_TURNS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS turns (
  turn_index INTEGER PRIMARY KEY CHECK (turn_index >= ${TURN_INDEX_MIN}),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'running',
      'awaiting_judge',
      'paused_review',
      'accepted',
      'accepted_with_warning',
      'failed',
      'cancelled'
    )
  ),
  prompt_blob BLOB NOT NULL CHECK (length(prompt_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  prompt_bytes INTEGER NOT NULL CHECK (
    prompt_bytes >= 0 AND
    prompt_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(prompt_blob) = prompt_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= prompt_bytes AND
    row_bytes <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  attachment_file_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachment_file_ids_json)),
  accepted_candidate_id TEXT,
  accepted_attempt_id TEXT,
  accepted_response_id TEXT,
  accepted_with_warning INTEGER NOT NULL DEFAULT 0 CHECK (accepted_with_warning IN (0, 1)),
  marginal_input_tokens INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(prompt_blob) +
    length(attachment_file_ids_json) +
    COALESCE(length(accepted_candidate_id), 0) +
    COALESCE(length(accepted_attempt_id), 0) +
    COALESCE(length(accepted_response_id), 0) <= ${ARTIFACT_ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

/**
 * `turn_candidates` — Normalized deliverable text for a turn candidate.
 * Each artifact occupies one BLOB in its owning row (`deliverable_blob`) with 1.5 MB guards.
 */
export const CREATE_TURN_CANDIDATES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS turn_candidates (
  candidate_id TEXT PRIMARY KEY,
  turn_index INTEGER NOT NULL CHECK (turn_index >= ${TURN_INDEX_MIN}),
  attempt_id TEXT NOT NULL,
  structural_status TEXT NOT NULL CHECK (
    structural_status IN (
      'valid',
      'trailing_content',
      'missing_tag',
      'malformed_tag',
      'wrong_index',
      'empty_output',
      'refusal',
      'incomplete',
      'provider_failed',
      'cancelled'
    )
  ),
  parsed_tag_index INTEGER,
  deliverable_blob BLOB CHECK (deliverable_blob IS NULL OR length(deliverable_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  deliverable_bytes INTEGER NOT NULL CHECK (
    deliverable_bytes >= 0 AND
    deliverable_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    COALESCE(length(deliverable_blob), 0) = deliverable_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= deliverable_bytes AND
    row_bytes <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
   accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1)),
  warning_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warning_json)),
  created_at TEXT NOT NULL,
  CHECK (
    COALESCE(length(deliverable_blob), 0) +
    length(candidate_id) +
    length(attempt_id) +
    length(structural_status) +
    length(warning_json) <= ${ARTIFACT_ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

/**
 * `generation_attempts` — Exact canonical UTF-8 generation request body BLOB and execution metadata.
 * Authorization headers are never stored.
 */
export const CREATE_GENERATION_ATTEMPTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS generation_attempts (
  attempt_id TEXT PRIMARY KEY,
  turn_index INTEGER NOT NULL CHECK (turn_index >= ${TURN_INDEX_MIN}),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  continuation_index INTEGER NOT NULL DEFAULT 0 CHECK (continuation_index >= 0 AND continuation_index <= 3),
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'continuation', 'auto_retry', 'manual_retry')),
  status TEXT NOT NULL CHECK (
    status IN (
      'prepared',
      'dispatching',
      'dispatched',
      'capacity_backoff',
      'ambiguous_dispatch',
      'completed',
      'failed',
      'cancelled',
      'refused',
      'incomplete',
      'capacity_exhausted'
    )
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_response_id TEXT,
  parent_response_id TEXT,
  capacity_sends INTEGER NOT NULL DEFAULT 0 CHECK (capacity_sends >= 0 AND capacity_sends <= 5),
  next_backoff_at_ms INTEGER,
  poll_probes INTEGER NOT NULL DEFAULT 0 CHECK (poll_probes >= 0 AND poll_probes <= 24),
  next_poll_at_ms INTEGER,
  request_blob BLOB NOT NULL CHECK (length(request_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  request_bytes INTEGER NOT NULL CHECK (
    request_bytes > 0 AND
    request_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(request_blob) = request_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= request_bytes AND
    row_bytes <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  diagnostics_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(diagnostics_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(request_blob) +
    length(attempt_id) +
    length(idempotency_key) +
    COALESCE(length(provider_response_id), 0) +
    COALESCE(length(usage_json), 0) +
    length(diagnostics_json) <= ${ARTIFACT_ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

/**
 * `attempt_response_artifacts` — Retained provider response payload BLOB for a generation attempt.
 * Kept in its own one-BLOB-per-row table so `generation_attempts` holds `request_blob` and this holds `response_blob`.
 */
export const CREATE_ATTEMPT_RESPONSE_ARTIFACTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS attempt_response_artifacts (
  attempt_id TEXT PRIMARY KEY,
  turn_index INTEGER NOT NULL CHECK (turn_index >= ${TURN_INDEX_MIN}),
  provider_response_id TEXT NOT NULL,
  response_blob BLOB NOT NULL CHECK (length(response_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  response_bytes INTEGER NOT NULL CHECK (
    response_bytes > 0 AND
    response_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(response_blob) = response_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= response_bytes AND
    row_bytes <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  created_at TEXT NOT NULL,
  CHECK (
    length(response_blob) +
    length(attempt_id) +
    length(provider_response_id) <= ${ARTIFACT_ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

/**
 * `judge_calls` — Canonical judge request BLOB (including encoded inline file bytes when inline delivery is used)
 * and the validated five-field judge result (`verdict`, `grade`, `comment`, `tag_agreement`, `file_visibility`).
 */
export const CREATE_JUDGE_CALLS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS judge_calls (
  judge_call_id TEXT PRIMARY KEY,
  turn_index INTEGER NOT NULL CHECK (turn_index >= ${TURN_INDEX_MIN}),
  candidate_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('responses', 'chat_completions')),
  history_mode TEXT NOT NULL CHECK (history_mode IN ('chained', 'stateless')),
  file_delivery_mode TEXT NOT NULL CHECK (file_delivery_mode IN ('passthrough', 'inline')),
  model TEXT NOT NULL,
  provider_response_id TEXT,
  previous_judge_response_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'unknown', 'failed')),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS', 'FAIL', 'UNKNOWN')),
  grade INTEGER CHECK (grade IS NULL OR (grade >= 0 AND grade <= 100)),
  comment TEXT,
  tag_agreement INTEGER CHECK (tag_agreement IS NULL OR tag_agreement IN (0, 1)),
  file_visibility INTEGER CHECK (file_visibility IS NULL OR file_visibility IN (0, 1)),
  manifest_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(manifest_json)),
  request_blob BLOB NOT NULL CHECK (length(request_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  request_bytes INTEGER NOT NULL CHECK (
    request_bytes > 0 AND
    request_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(request_blob) = request_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= request_bytes AND
    row_bytes <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  diagnostics_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(diagnostics_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(request_blob) +
    length(judge_call_id) +
    length(candidate_id) +
    length(attempt_id) +
    length(model) +
    COALESCE(length(comment), 0) +
    length(manifest_json) +
    COALESCE(length(usage_json), 0) +
    length(diagnostics_json) <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  CHECK (
    status <> 'completed' OR (
      verdict IS NOT NULL AND
      verdict IN ('PASS', 'FAIL') AND
      grade IS NOT NULL AND
      comment IS NOT NULL AND
      tag_agreement IS NOT NULL AND
      file_visibility IS NOT NULL
    )
  )
) STRICT;
`.trim();

/**
 * `durable_work` — Scheduled obligations and deadlines driving the single per-DO alarm in `JobDO`.
 */
export const CREATE_DURABLE_WORK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS durable_work (
  work_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'capacity_backoff',
      'fallback_poll',
      'webhook_process',
      'judge_dispatch',
      'cleanup'
    )
  ),
  attempt_id TEXT,
  turn_index INTEGER,
  due_at_ms INTEGER NOT NULL CHECK (due_at_ms >= 0),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  CHECK (length(work_id) + length(payload_json) <= ${ARTIFACT_ROW_GUARD_BYTES})
) STRICT;
`.trim();

export const JOB_DO_INDEX_SQL_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_turn_candidates_turn ON turn_candidates (turn_index, candidate_id);",
  "CREATE INDEX IF NOT EXISTS idx_generation_attempts_turn ON generation_attempts (turn_index, attempt_number);",
  "CREATE INDEX IF NOT EXISTS idx_generation_attempts_response ON generation_attempts (provider_response_id);",
  "CREATE INDEX IF NOT EXISTS idx_judge_calls_turn ON judge_calls (turn_index, judge_call_id);",
  "CREATE INDEX IF NOT EXISTS idx_durable_work_due ON durable_work (due_at_ms, work_id);",
];

// ============================================================================
// RouterDO Schema (Response Routing & Durable Webhook Inbox)
// ============================================================================

/**
 * `response_routes` — Maps OpenAI `response_id` to its owning `job_id` and `attempt_id`.
 */
export const CREATE_RESPONSE_ROUTES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS response_routes (
  response_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL CHECK (turn_index >= ${TURN_INDEX_MIN}),
  status TEXT NOT NULL CHECK (status IN ('registered', 'delivered', 'settled')),
  registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms >= 0),
  delivered_at_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(response_id) + length(job_id) + length(attempt_id) <= ${ARTIFACT_ROW_GUARD_BYTES})
) STRICT;
`.trim();

/**
 * `webhook_inbox` — Durable inbox of signature-verified OpenAI webhook deliveries.
 * Stores the exact raw verified payload in `raw_body_blob` with 1.5 MB artifact and row guards.
 */
export const CREATE_WEBHOOK_INBOX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS webhook_inbox (
  webhook_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'response.completed',
      'response.cancelled',
      'response.failed',
      'response.incomplete'
    )
  ),
  response_id TEXT NOT NULL,
  job_id TEXT,
  delivery_timestamp_sec INTEGER NOT NULL CHECK (delivery_timestamp_sec >= 0),
  received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'unmatched', 'delivered', 'duplicate', 'failed')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  next_attempt_at_ms INTEGER,
  raw_body_blob BLOB NOT NULL CHECK (length(raw_body_blob) <= ${ARTIFACT_ROW_GUARD_BYTES}),
  raw_body_bytes INTEGER NOT NULL CHECK (
    raw_body_bytes > 0 AND
    raw_body_bytes <= ${ARTIFACT_ROW_GUARD_BYTES} AND
    length(raw_body_blob) = raw_body_bytes
  ),
  row_bytes INTEGER NOT NULL CHECK (
    row_bytes >= raw_body_bytes AND
    row_bytes <= ${ARTIFACT_ROW_GUARD_BYTES}
  ),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    length(raw_body_blob) +
    length(webhook_id) +
    length(event_type) +
    length(response_id) +
    COALESCE(length(job_id), 0) +
    COALESCE(length(last_error), 0) <= ${ARTIFACT_ROW_GUARD_BYTES}
  )
) STRICT;
`.trim();

export const ROUTER_DO_INDEX_SQL_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_response_routes_job ON response_routes (job_id, response_id);",
  "CREATE INDEX IF NOT EXISTS idx_webhook_inbox_response ON webhook_inbox (response_id, webhook_id);",
  "CREATE INDEX IF NOT EXISTS idx_webhook_inbox_due ON webhook_inbox (status, next_attempt_at_ms, webhook_id);",
];

// ============================================================================
// RegistryDO Schema (Global Job Index, File Catalogue, Upload Intents & Retention)
// ============================================================================

/**
 * `job_index` — Global job directory in `RegistryDO` (lists use primary-key cursors, no BLOBs).
 */
export const CREATE_JOB_INDEX_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS job_index (
  job_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (
    status IN (
      'created',
      'ready',
      'running',
      'paused_review',
      'paused_dispatch',
      'paused_storage',
      'completed',
      'failed',
      'cancelled',
      'superseded'
    )
  ),
  model TEXT NOT NULL,
  parent_job_id TEXT,
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  current_turn_index INTEGER NOT NULL DEFAULT ${TURN_INDEX_MIN} CHECK (current_turn_index >= ${TURN_INDEX_MIN}),
  accepted_turn_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_turn_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(job_id) + length(title) + length(model) <= ${ARTIFACT_ROW_GUARD_BYTES})
) STRICT;
`.trim();

/**
 * `file_catalogue` — Global OpenAI Files (`purpose: "user_data"`) metadata and live SHA-256 deduplication.
 * Never stores source file bytes. Enforces the 16,000,000-byte upload limit on `byte_size`.
 */
export const CREATE_FILE_CATALOGUE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS file_catalogue (
  file_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= ${MAX_FILE_UPLOAD_BYTES}),
  purpose TEXT NOT NULL DEFAULT 'user_data' CHECK (purpose = 'user_data'),
  status TEXT NOT NULL CHECK (status IN ('live', 'deleting', 'deleted', 'failed')),
  active_job_refs INTEGER NOT NULL DEFAULT 0 CHECK (active_job_refs >= 0),
  retention_eligible_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  deleted_at_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(file_id) + length(sha256) + length(filename) + length(mime_type) <= ${ARTIFACT_ROW_GUARD_BYTES})
) STRICT;
`.trim();

/**
 * `upload_intents` — Tracks in-flight and ambiguous uploads for deduplication and recovery cleanup.
 */
export const CREATE_UPLOAD_INTENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS upload_intents (
  intent_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0 AND byte_size <= ${MAX_FILE_UPLOAD_BYTES}),
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded', 'ambiguous', 'cleaned', 'failed')),
  file_id TEXT,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(intent_id) + length(sha256) + length(filename) + length(mime_type) <= ${ARTIFACT_ROW_GUARD_BYTES})
) STRICT;
`.trim();

/**
 * `job_file_refs` — Tracks which jobs reference which catalogued files so non-terminal jobs protect files from retention cleanup.
 */
export const CREATE_JOB_FILE_REFS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS job_file_refs (
  job_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  is_non_terminal INTEGER NOT NULL DEFAULT 1 CHECK (is_non_terminal IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, file_id)
) STRICT;
`.trim();

export const REGISTRY_DO_INDEX_SQL_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_file_catalogue_sha256_live ON file_catalogue (sha256, status);",
  "CREATE INDEX IF NOT EXISTS idx_file_catalogue_retention ON file_catalogue (status, active_job_refs, retention_eligible_at_ms);",
  "CREATE INDEX IF NOT EXISTS idx_upload_intents_expiry ON upload_intents (status, expires_at_ms);",
  "CREATE INDEX IF NOT EXISTS idx_job_file_refs_file ON job_file_refs (file_id, is_non_terminal);",
];

// ============================================================================
// Grouped DDL Collections
// ============================================================================

export const JOB_DO_TABLE_DDL: readonly string[] = [
  CREATE_JOBS_TABLE_SQL,
  CREATE_BRANCH_LINEAGE_TABLE_SQL,
  CREATE_JOB_FILES_TABLE_SQL,
  CREATE_TURNS_TABLE_SQL,
  CREATE_TURN_CANDIDATES_TABLE_SQL,
  CREATE_GENERATION_ATTEMPTS_TABLE_SQL,
  CREATE_ATTEMPT_RESPONSE_ARTIFACTS_TABLE_SQL,
  CREATE_JUDGE_CALLS_TABLE_SQL,
  CREATE_DURABLE_WORK_TABLE_SQL,
];

export const ROUTER_DO_TABLE_DDL: readonly string[] = [
  CREATE_RESPONSE_ROUTES_TABLE_SQL,
  CREATE_WEBHOOK_INBOX_TABLE_SQL,
];

export const REGISTRY_DO_TABLE_DDL: readonly string[] = [
  CREATE_JOB_INDEX_TABLE_SQL,
  CREATE_FILE_CATALOGUE_TABLE_SQL,
  CREATE_UPLOAD_INTENTS_TABLE_SQL,
  CREATE_JOB_FILE_REFS_TABLE_SQL,
];

export const ALL_SCHEMA_TABLE_DDL: readonly string[] = [
  CREATE_SCHEMA_MIGRATIONS_TABLE_SQL,
  ...JOB_DO_TABLE_DDL,
  ...ROUTER_DO_TABLE_DDL,
  ...REGISTRY_DO_TABLE_DDL,
];

// ============================================================================
// Typed Row Interfaces (Mirroring STRICT SQLite Columns)
// ============================================================================

export type JobStatus =
  | "created"
  | "ready"
  | "running"
  | "paused_review"
  | "paused_dispatch"
  | "paused_storage"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type CacheTtlOption = "30m" | "12h" | "24h" | "nocache";

export interface JobRow extends Record<string, SqlPrimitiveValue> {
  job_id: string;
  title: string;
  status: JobStatus;
  model: string;
  reasoning_effort: string;
  max_output_tokens: number;
  cache_ttl: CacheTtlOption;
  web_search: number;
  judge_config_json: string;
  developer_prompt: string;
  developer_file_ids_json: string;
  continuation_budget: number;
  continuations_used: number;
  auto_retry_budget: number;
  auto_retries_used: number;
  manual_retries_used: number;
  current_turn_index: number;
  total_turns: number;
  accepted_turn_index: number;
  active_attempt_id: string | null;
  last_accepted_response_id: string | null;
  last_judge_response_id: string | null;
  parent_job_id: string | null;
  fork_turn_index: number | null;
  revision: number;
  last_error_code: string | null;
  last_error_detail: string | null;
  warnings_json: string;
  usage_summary_json: string;
  created_at: string;
  updated_at: string;
}

export interface BranchLineageRow extends Record<string, SqlPrimitiveValue> {
  job_id: string;
  parent_job_id: string;
  parent_revision: number;
  fork_turn_index: number;
  snapshot_bytes: number;
  snapshot_sha256: string;
  files_protected: number;
  parent_superseded: number;
  created_at: string;
}

export interface JobFileRow extends Record<string, SqlPrimitiveValue> {
  file_id: string;
  turn_index: number;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  introduced_in_judge_call_id: string | null;
  created_at: string;
}

/** `turns` summary row omitting `prompt_blob` for list queries. */
export interface TurnSummaryRow extends Record<string, SqlPrimitiveValue> {
  turn_index: number;
  status:
    | "pending"
    | "running"
    | "awaiting_judge"
    | "paused_review"
    | "accepted"
    | "accepted_with_warning"
    | "failed"
    | "cancelled";
  prompt_bytes: number;
  row_bytes: number;
  attachment_file_ids_json: string;
  accepted_candidate_id: string | null;
  accepted_attempt_id: string | null;
  accepted_response_id: string | null;
  accepted_with_warning: number;
  marginal_input_tokens: number | null;
  created_at: string;
  updated_at: string;
}

/** `turns` row including `prompt_blob`. Omit `prompt_blob` in list queries (`TurnSummaryRow`). */
export interface TurnRow extends TurnSummaryRow {
  prompt_blob: ArrayBuffer | Uint8Array;
}

export type CandidateStructuralStatus =
  | "valid"
  | "trailing_content"
  | "missing_tag"
  | "malformed_tag"
  | "wrong_index"
  | "empty_output"
  | "refusal"
  | "incomplete"
  | "provider_failed"
  | "cancelled";

export interface TurnCandidateSummaryRow extends Record<string, SqlPrimitiveValue> {
  candidate_id: string;
  turn_index: number;
  attempt_id: string;
  structural_status: CandidateStructuralStatus;
  parsed_tag_index: number | null;
  deliverable_bytes: number;
  row_bytes: number;
  accepted: number;
  warning_json: string;
  created_at: string;
}

export interface TurnCandidateRow extends TurnCandidateSummaryRow {
  deliverable_blob: ArrayBuffer | Uint8Array | null;
}

export interface GenerationAttemptSummaryRow extends Record<string, SqlPrimitiveValue> {
  attempt_id: string;
  turn_index: number;
  attempt_number: number;
  continuation_index: number;
  kind: "initial" | "continuation" | "auto_retry" | "manual_retry";
  status:
    | "prepared"
    | "dispatching"
    | "dispatched"
    | "capacity_backoff"
    | "ambiguous_dispatch"
    | "completed"
    | "failed"
    | "cancelled"
    | "refused"
    | "incomplete"
    | "capacity_exhausted";
  idempotency_key: string;
  provider_response_id: string | null;
  parent_response_id: string | null;
  capacity_sends: number;
  next_backoff_at_ms: number | null;
  poll_probes: number;
  next_poll_at_ms: number | null;
  request_bytes: number;
  row_bytes: number;
  usage_json: string | null;
  diagnostics_json: string;
  created_at: string;
  updated_at: string;
}

export interface GenerationAttemptRow extends GenerationAttemptSummaryRow {
  request_blob: ArrayBuffer | Uint8Array;
}

export interface AttemptResponseArtifactSummaryRow extends Record<string, SqlPrimitiveValue> {
  attempt_id: string;
  turn_index: number;
  provider_response_id: string;
  response_bytes: number;
  row_bytes: number;
  created_at: string;
}

export interface AttemptResponseArtifactRow extends AttemptResponseArtifactSummaryRow {
  response_blob: ArrayBuffer | Uint8Array;
}

export interface JudgeCallSummaryRow extends Record<string, SqlPrimitiveValue> {
  judge_call_id: string;
  turn_index: number;
  candidate_id: string;
  attempt_id: string;
  transport: "responses" | "chat_completions";
  history_mode: "chained" | "stateless";
  file_delivery_mode: "passthrough" | "inline";
  model: string;
  provider_response_id: string | null;
  previous_judge_response_id: string | null;
  status: "pending" | "completed" | "unknown" | "failed";
  verdict: "PASS" | "FAIL" | "UNKNOWN" | null;
  grade: number | null;
  comment: string | null;
  tag_agreement: number | null;
  file_visibility: number | null;
  manifest_json: string;
  request_bytes: number;
  row_bytes: number;
  usage_json: string | null;
  diagnostics_json: string;
  created_at: string;
  updated_at: string;
}

export interface JudgeCallRow extends JudgeCallSummaryRow {
  request_blob: ArrayBuffer | Uint8Array;
}

export interface DurableWorkRow extends Record<string, SqlPrimitiveValue> {
  work_id: string;
  kind: "capacity_backoff" | "fallback_poll" | "webhook_process" | "judge_dispatch" | "cleanup";
  attempt_id: string | null;
  turn_index: number | null;
  due_at_ms: number;
  payload_json: string;
  created_at: string;
}

export interface ResponseRouteRow extends Record<string, SqlPrimitiveValue> {
  response_id: string;
  job_id: string;
  attempt_id: string;
  turn_index: number;
  status: "registered" | "delivered" | "settled";
  registered_at_ms: number;
  delivered_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookInboxSummaryRow extends Record<string, SqlPrimitiveValue> {
  webhook_id: string;
  event_type:
    | "response.completed"
    | "response.cancelled"
    | "response.failed"
    | "response.incomplete";
  response_id: string;
  job_id: string | null;
  delivery_timestamp_sec: number;
  received_at_ms: number;
  status: "pending" | "unmatched" | "delivered" | "duplicate" | "failed";
  delivery_attempts: number;
  next_attempt_at_ms: number | null;
  raw_body_bytes: number;
  row_bytes: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookInboxRow extends WebhookInboxSummaryRow {
  raw_body_blob: ArrayBuffer | Uint8Array;
}

export interface JobIndexRow extends Record<string, SqlPrimitiveValue> {
  job_id: string;
  title: string;
  status: JobStatus;
  model: string;
  parent_job_id: string | null;
  is_terminal: number;
  revision: number;
  current_turn_index: number;
  accepted_turn_count: number;
  created_at: string;
  updated_at: string;
}

export interface FileCatalogueRow extends Record<string, SqlPrimitiveValue> {
  file_id: string;
  sha256: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  purpose: "user_data";
  status: "live" | "deleting" | "deleted" | "failed";
  active_job_refs: number;
  retention_eligible_at_ms: number | null;
  created_at_ms: number;
  deleted_at_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface UploadIntentRow extends Record<string, SqlPrimitiveValue> {
  intent_id: string;
  sha256: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  status: "pending" | "uploaded" | "ambiguous" | "cleaned" | "failed";
  file_id: string | null;
  expires_at_ms: number;
  created_at: string;
  updated_at: string;
}

export interface JobFileRefRow extends Record<string, SqlPrimitiveValue> {
  job_id: string;
  file_id: string;
  is_non_terminal: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// BLOB-Free Column Projections for List Queries
// ============================================================================

export const TURNS_SUMMARY_COLUMNS =
  "turn_index, status, prompt_bytes, row_bytes, attachment_file_ids_json, accepted_candidate_id, accepted_attempt_id, accepted_response_id, accepted_with_warning, marginal_input_tokens, created_at, updated_at";

export const TURN_CANDIDATES_SUMMARY_COLUMNS =
  "candidate_id, turn_index, attempt_id, structural_status, parsed_tag_index, deliverable_bytes, row_bytes, accepted, warning_json, created_at";

export const GENERATION_ATTEMPTS_SUMMARY_COLUMNS =
  "attempt_id, turn_index, attempt_number, continuation_index, kind, status, idempotency_key, provider_response_id, parent_response_id, capacity_sends, next_backoff_at_ms, poll_probes, next_poll_at_ms, request_bytes, row_bytes, usage_json, diagnostics_json, created_at, updated_at";

export const JUDGE_CALLS_SUMMARY_COLUMNS =
  "judge_call_id, turn_index, candidate_id, attempt_id, transport, history_mode, file_delivery_mode, model, provider_response_id, previous_judge_response_id, status, verdict, grade, comment, tag_agreement, file_visibility, manifest_json, request_bytes, row_bytes, usage_json, diagnostics_json, created_at, updated_at";

export const WEBHOOK_INBOX_SUMMARY_COLUMNS =
  "webhook_id, event_type, response_id, job_id, delivery_timestamp_sec, received_at_ms, status, delivery_attempts, next_attempt_at_ms, raw_body_bytes, row_bytes, last_error, created_at, updated_at";

// ============================================================================
// Migration Runner & Schema Introspection Helpers
// ============================================================================

export interface SchemaMigrationStep {
  readonly version: number;
  readonly statements: readonly string[];
  readonly indexStatements?: readonly string[];
}

export const JOB_DO_MIGRATIONS: readonly SchemaMigrationStep[] = [
  {
    version: 1,
    statements: JOB_DO_TABLE_DDL,
    indexStatements: JOB_DO_INDEX_SQL_STATEMENTS,
  },
];

export const ROUTER_DO_MIGRATIONS: readonly SchemaMigrationStep[] = [
  {
    version: 1,
    statements: ROUTER_DO_TABLE_DDL,
    indexStatements: ROUTER_DO_INDEX_SQL_STATEMENTS,
  },
];

export const REGISTRY_DO_MIGRATIONS: readonly SchemaMigrationStep[] = [
  {
    version: 1,
    statements: REGISTRY_DO_TABLE_DDL,
    indexStatements: REGISTRY_DO_INDEX_SQL_STATEMENTS,
  },
];

/**
 * Reads the current schema version from `_sql_schema_migrations` (`COALESCE(MAX(id), 0)`).
 * Never caches version state in memory across Durable Object evictions or resets.
 */
export function getCurrentSchemaVersion(sql: SchemaSqlStorage): number {
  sql.exec(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL);
  const row = sql
    .exec<{ version: number }>(
      "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations"
    )
    .one();
  return typeof row.version === "number" ? row.version : Number(row.version);
}

/**
 * Checks whether a column already exists on `tableName` using `PRAGMA table_info`.
 * Used to guard `ALTER TABLE ... ADD COLUMN` idempotently since SQLite lacks `ADD COLUMN IF NOT EXISTS`.
 */
export function hasTableColumn(
  sql: SchemaSqlStorage,
  tableName: string,
  columnName: string
): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid SQLite identifier: ${tableName}`);
  }
  const columns = sql
    .exec<{ name: string }>(`PRAGMA table_info(${tableName})`)
    .toArray();
  return columns.some((c) => c.name === columnName);
}

/**
 * Checks whether a table exists using `PRAGMA table_list`.
 */
export function hasTable(sql: SchemaSqlStorage, tableName: string): boolean {
  const tables = sql.exec<{ name: string }>("PRAGMA table_list").toArray();
  return tables.some((t) => t.name === tableName);
}

/**
 * Runs a set of versioned migrations synchronously inside `storage.transactionSync`.
 *
 * - Never uses `PRAGMA user_version`.
 * - Executes one SQL statement per `sql.exec(...)` call inside `transactionSync`.
 * - Records each version in `_sql_schema_migrations` only after all statements for that version succeed.
 * - Runs `PRAGMA optimize` after index-creating versions.
 * - Re-reads `_sql_schema_migrations` on every invocation (no module-level in-memory cache).
 */
export function runSchemaMigrations(
  storage: SchemaTransactionalStorage,
  targetName: string,
  steps: readonly SchemaMigrationStep[]
): { readonly version: number; readonly appliedVersions: readonly number[] } {
  return withSqlErrorMapping(() => {
    const sql = storage.sql;
    const currentVersion = getCurrentSchemaVersion(sql);
    const appliedVersions: number[] = [];

    for (const step of steps) {
      if (step.version <= currentVersion) {
        continue;
      }

      let createdIndexes = false;
      try {
        storage.transactionSync(() => {
          for (const stmt of step.statements) {
            sql.exec(stmt);
          }
          if (step.indexStatements && step.indexStatements.length > 0) {
            for (const indexStmt of step.indexStatements) {
              sql.exec(indexStmt);
            }
            createdIndexes = true;
          }
          sql.exec(
            "INSERT INTO _sql_schema_migrations (id) VALUES (?)",
            step.version
          );
        });
      } catch (error: unknown) {
        if (isSqliteFullError(error)) {
          throw new StorageFullError(
            error instanceof Error ? error.message : "database or disk is full: SQLITE_FULL",
            error
          );
        }
        throw new SchemaMigrationError(targetName, step.version, error);
      }

      if (createdIndexes) {
        sql.exec("PRAGMA optimize");
      }
      appliedVersions.push(step.version);
    }

    const finalVersion =
      appliedVersions.length > 0
        ? appliedVersions[appliedVersions.length - 1]!
        : currentVersion;

    return { version: finalVersion, appliedVersions };
  });
}

/** Convenience migration entrypoint for `JobDO` constructor `blockConcurrencyWhile`. */
export function migrateJobDoSchema(storage: SchemaTransactionalStorage): {
  readonly version: number;
  readonly appliedVersions: readonly number[];
} {
  return runSchemaMigrations(storage, "JobDO", JOB_DO_MIGRATIONS);
}

/** Convenience migration entrypoint for `RouterDO` constructor `blockConcurrencyWhile`. */
export function migrateRouterDoSchema(storage: SchemaTransactionalStorage): {
  readonly version: number;
  readonly appliedVersions: readonly number[];
} {
  return runSchemaMigrations(storage, "RouterDO", ROUTER_DO_MIGRATIONS);
}

/** Convenience migration entrypoint for `RegistryDO` constructor `blockConcurrencyWhile`. */
export function migrateRegistryDoSchema(storage: SchemaTransactionalStorage): {
  readonly version: number;
  readonly appliedVersions: readonly number[];
} {
  return runSchemaMigrations(storage, "RegistryDO", REGISTRY_DO_MIGRATIONS);
}

// ============================================================================
// Diagnostics & Storage Reset Helpers
// ============================================================================

export interface DatabaseDiagnostics {
  readonly schemaVersion: number;
  readonly databaseSizeBytes: number;
  readonly artifactByteLimit: number;
  readonly rowByteLimit: number;
}

/**
 * Surfaces current schema version and `sql.databaseSize` for diagnostics endpoints.
 */
export function getDatabaseDiagnostics(sql: SchemaSqlStorage): DatabaseDiagnostics {
  const schemaVersion = getCurrentSchemaVersion(sql);
  const databaseSizeBytes = typeof sql.databaseSize === "number" ? sql.databaseSize : 0;
  return {
    schemaVersion,
    databaseSizeBytes,
    artifactByteLimit: ARTIFACT_ROW_GUARD_BYTES,
    rowByteLimit: ROW_GUARD_BYTES,
  };
}

/**
 * Resets a Durable Object's storage and explicitly deletes any scheduled alarm
 * so older compatibility configurations cannot leave an orphan alarm behind.
 */
export async function resetDurableObjectStorage(
  storage: SchemaTransactionalStorage
): Promise<void> {
  if (typeof storage.deleteAlarm === "function") {
    await storage.deleteAlarm();
  }
  if (typeof storage.deleteAll === "function") {
    await storage.deleteAll();
  }
}
