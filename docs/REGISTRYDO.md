## RegistryDO — `src/do/registry-do.ts`

### Purpose and owned state

Implement the global registry through the `env.REGISTRY_DO` binding (`class_name = "RegistryDO"`) and the singleton name `REGISTRY_DO_NAME` (`"global-registry"`) from `src/constants.ts`. It owns four SQLite tables and runs `migrateRegistryDoSchema` in the constructor:

- `job_index` — global job summaries (`JobIndexRow`) used for job listings and terminality checks.
- `file_catalogue` — source attachment records (`FileCatalogueRow`), never file bytes.
- `upload_intents` — in-flight upload tracking for recovery and cleanup (`UploadIntentRow`).
- `job_file_refs` — non-terminal job-to-file references (`JobFileRefRow`).

RegistryDO never writes job execution state, never holds source file bytes, and never uploads on behalf of a job without a durable intent.

### Public surface

RegistryDO RPC (binding RPC; all methods async). Do not add another public method or HTTP route; private helpers are allowed.

```ts
- registerJob(summary: JobSummaryItem): Promise<void>
- updateJobIndexStatus(jobId: JobId, status: JobStatus, revision: number, currentTurnIndex: number, acceptedTurnCount: number): Promise<void>
- findFileByHash(sha256: string): Promise<FileCatalogueRecord | null>
- beginUploadIntent(input: { intentId: string; sha256: string; filename: string; mimeType: string; byteSize: number; expiresAtMs: number }): Promise<FileUploadIntentRecord>
- completeUploadIntent(intentId: string, fileId: FileId): Promise<void>
- recordFileUpload(input: { fileId: FileId; sha256: string; filename: string; mimeType: string; byteSize: number }): Promise<FileCatalogueRecord>
- listFiles(request: CursorPageRequest): Promise<CursorPage<FileCatalogueRecord>>
- listJobs(request: CursorPageRequest): Promise<CursorPage<JobSummaryItem>>
- getFile(fileId: FileId): Promise<FileCatalogueRecord | null>
- protectJobFileRefs(jobId: JobId, fileIds: readonly FileId[]): Promise<void>
- releaseJobFileRefs(jobId: JobId): Promise<void>
- runRetentionSweep(): Promise<{ deleted: number; retained: number; failed: number }>
```

`alarm()` is the only additional platform handler. Implementations MUST NOT invent interfaces: operate on the exact row types and `withSqlErrorMapping` in `src/db/schema.ts` (`SchemaSqlStorage`, `SchemaTransactionalStorage`), and call `assertFileUploadSize` / `clampPageLimit` from `src/lib/guards.ts` and `deleteProviderFile` / `resolveEnvSecret` from `src/lib/openai.ts` directly; never reimplement guards, hashing, or persistence helpers.

### Invariants

**Single global index.** Register each job once with `registerJob(summary)`, which stores `current_turn_index`, `accepted_turn_count`, status, and revision; update status, terminality, revision, and both counters through `updateJobIndexStatus`. `listJobs` projects the stored counters into `JobSummaryItem`. Derive `is_terminal` from `JobStatus` (`completed`, `failed`, `cancelled`, `superseded` are terminal); a stale `revision` never overwrites a newer index row. Never store job state beyond `JobSummaryItem`.

**Content-hash dedupe.** README §Files and Limits: "Live content hashes deduplicate source uploads." `findFileByHash` returns only a live (`status = "live"`) catalogue record; hashes are the lowercase SHA-256 hex computed over the exact uploaded bytes by `src/handlers/files.ts`. Never dedupe by filename, size, or a client-supplied hash.

**16,000,000-byte upload bound.** Enforce `MAX_FILE_UPLOAD_BYTES` with `assertFileUploadSize(byteSize)` on `beginUploadIntent` and `recordFileUpload`; reject larger sizes explicitly, never clamp or truncate. ARCHITECTURE §11: "The upload limit is **16,000,000 file bytes**."

**Upload intents drive recovery.** README §Files and Limits: "Upload intents support recovery and cleanup of ambiguous or redundant uploads." `beginUploadIntent` inserts a `pending` intent keyed by `intentId` (idempotent for the same id); `completeUploadIntent` links the provider `fileId` and marks it `uploaded`. An intent that never completes remains recoverable until `expires_at_ms`, then becomes eligible for cleanup (`ambiguous` / `cleaned`); do not invent a separate failure RPC. Expired intents never create catalogue rows.

**Catalogue rows carry metadata only.** ARCHITECTURE §11: "Source file bytes are not stored in a separate SQLite file store or file-preparation cache." `recordFileUpload` writes `file_id`, hash, filename, MIME type, size, `purpose: "user_data"`, `active_job_refs = 0`, and timestamps. Return the stored `FileCatalogueRecord`.

**Protect references before ready.** README §Files and Limits: "Non-terminal file references are protected before a job becomes ready." `protectJobFileRefs` inserts `job_file_refs` rows with `is_non_terminal = 1` and increments `active_job_refs` once per `(jobId, fileId)` pair; repeated protection is idempotent. `releaseJobFileRefs` marks a job's references terminal and decrements counts exactly once. A job whose `job_index` row is non-terminal must never have an unprotected attachment.

**Retention only deletes eligible, unreferenced files.** README §Files and Limits: "RegistryDO periodically deletes retention-eligible files unreferenced by non-terminal jobs." A sweep may delete only rows whose retention window (`FILE_RETENTION_SECONDS`) has elapsed, whose `active_job_refs = 0`, and which no non-terminal `job_index` row references through `job_file_refs`. Mark `deleting` before the provider call, call `deleteProviderFile` (treat 404 as already deleted), then mark `deleted`; on provider error mark `failed` and count it. Return `{ deleted, retained, failed }`. Never delete a file that is referenced or still within its window.

**One alarm at the earliest obligation.** TESTING §24: "Each Durable Object uses one alarm scheduled against its earliest obligation or deadline." Take the earliest of the next retention eligibility time and the earliest upload-intent expiry, schedule with `earliestDeadline` + `ensureAlarmNotLaterThan`, and run `alarm()` through `runWithAlarmSafety`; reschedule with `scheduleNextObligationFromAlarm`. Never call `setAlarm()` unconditionally in the constructor (docs/ALARMTIMING.md trap 6.2).

**File IDs are provider-issued.** `recordFileUpload` accepts only a `fileId` returned by the Files API (`uploadUserDataFile`); never synthesize, guess, or reuse an ID from another provider. Provider `404` during deletion means already deleted, not a new deletion.

**Sweeps are incremental and budgeted.** Process eligible catalogue rows in primary-key cursor pages clamped to 1–100 and stop starting new deletions when the alarm wall-time budget is reached; leave the rest for the next alarm. Never load the whole catalogue into memory.

**Index updates are revision-fenced.** Apply `updateJobIndexStatus` only when the supplied revision is not older than the stored one; stale updates are ignored rather than overwriting newer status. `registerJob` is idempotent for the same `jobId` and never resets an advanced revision.

**Transactions and guards.** All SQLite work is synchronous over `SchemaSqlStorage` inside `withSqlErrorMapping`; never `await` inside `transactionSync`; never swallow `SQLITE_FULL` (it maps to `StorageFullError`) or `ArtifactGuardError`.

**Credentials.** Resolve `OPENAI_API_KEY` with `resolveEnvSecret(env, "OPENAI_API_KEY")` at call time only; never persist or log secrets.

### Platform traps

- Storage per SQLite-backed object is 10 GB (1 GB on Free); `SQLITE_FULL` rejects writes, including `sql.exec()` inserts/updates, but `SELECT` and `DELETE` continue to work for reclamation.
- SQL limits are 2 MB per string/BLOB/row, 100 KB per statement, 100 bound parameters per query, 100 columns per table, and 50 bytes for `LIKE`/`GLOB` patterns.
- `sql.exec()` can run multiple statements, but bindings and the returned cursor apply only to the last statement; very large `int64` values lose precision when read as JavaScript numbers.
- Run schema migrations inside `ctx.blockConcurrencyWhile()`; the callback is capped at 30 seconds, blocks all other events, and terminates/resets the object if it throws.
- Each object has one alarm: `setAlarm()` overwrites, alarms do not recur, `getAlarm()` reads `null` inside the handler unless reset, and alarm retries are limited to 6 with 2-second exponential backoff and a 15-minute wall-time cap.
- Outbound `fetch()` bodies from a Durable Object are limited to 100 MiB per request and can fail with `413 Payload Too Large`; streaming, chunked encoding, and `multipart/form-data` do not bypass the limit, and each request may hold at most 6 simultaneous outgoing connections.
- A Files API upload must fit its multipart body under the 100 MiB outbound limit; larger files require the destination's multipart or resumable upload API with smaller parts.
- A single global object is single-threaded with a soft limit near 1,000 requests/second and returns `.overloaded` errors, which are not retried; it is also limited to 128 MB isolate memory.
- A cursor resumed after `await` can observe later writes with no snapshot isolation, so consume results before the next `await`; hibernation/eviction discards in-memory catalogue caches and forces state to be read back from SQLite.
- `ctx.storage.sql.databaseSize` reports the current SQLite size in bytes for capacity checks; PITR bookmarks restore the database to a point within the last 30 days, but PITR is not supported in local development.
Source: https://developers.cloudflare.com/durable-objects/platform/limits/#sqlite-backed-durable-objects-general-limits ; https://developers.cloudflare.com/durable-objects/platform/limits/#outbound-http-request-body-size ; https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type ; https://developers.cloudflare.com/durable-objects/api/alarms/ ; https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#databasesize

### Integration points

- `src/handlers/files.ts` calls `findFileByHash`, `beginUploadIntent`, `recordFileUpload`, and `completeUploadIntent` around the ProviderIO upload.
- `src/handlers/jobs.ts` reads the index through `listJobs` and calls `registerJob`, `updateJobIndexStatus`, `protectJobFileRefs`, and `releaseJobFileRefs` on lifecycle transitions.
- `src/lib/openai.ts` `uploadUserDataFile` (handler side) and `deleteProviderFile` (sweep side).
- `src/db/schema.ts` registry row types and migrations, `src/lib/guards.ts` (`assertFileUploadSize`, `clampPageLimit`), `src/lib/alarm.ts`, `src/constants.ts` (`FILE_RETENTION_SECONDS`, `REGISTRY_DO_NAME`, `MAX_FILE_UPLOAD_BYTES`).

### Anti-patterns

- Do not store file bytes, inline text, base64 payloads, or preparation caches in RegistryDO.
- Do not delete a file with active or non-terminal references, or before its retention window elapses.
- Do not dedupe by filename, size, or client-provided hashes, and do not trust an unverified digest.
- Do not upload without a durable intent, or complete an intent for a different hash or size.
- Do not double-increment or double-decrement `active_job_refs` on repeated calls.
- Do not clamp an oversized upload; reject it with an explicit error.
- Do not add job-listing or file-read RPC methods, or query the catalogue with page limits above 100.
- Do not schedule multiple alarms, use timers, or perform provider calls inside a transaction.
- Do not synthesize provider file IDs, reuse another provider's IDs, or record a file before the upload returns one.
- Do not sweep the full catalogue in one invocation or delete past the alarm wall-time budget.
- Do not let a stale index revision overwrite a newer status.
### Export

```ts
import { DurableObject } from "cloudflare:workers";

export class RegistryDO extends DurableObject<Env> {}
```

Keep the boot scaffold's synchronous `migrateRegistryDoSchema(ctx.storage)` style constructor migration.
