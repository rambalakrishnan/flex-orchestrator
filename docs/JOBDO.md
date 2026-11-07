## JobDO — `src/do/job-do.ts`

### Purpose and owned state

Implement one `JobDO` instance per job through the `env.JOB_DO` binding (`class_name = "JobDO"`). README §Overview: "`JOB_DO` — one per job; sole execution-state writer; tracks at most one active generation attempt per job."

Own these SQLite tables; run `migrateJobDoSchema` in the constructor so the schema is addressable before the first RPC (ARCHITECTURE §16):

- `jobs`, `branch_lineage`, `job_files` — use `src/db/jobs.ts`.
- `turns`, `turn_candidates` — use `src/db/turns.ts`.
- `generation_attempts`, `attempt_response_artifacts`, `judge_calls`, `durable_work` — use `src/db/attempts.ts`.

Never write job execution state from any other object. `RouterDO` may only hand over a verified webhook; `RegistryDO` owns the catalogue and index; `src/handlers/jobs.ts` only forwards commands.

### Public surface

JobDO RPC (binding RPC; all methods async). Do not add another public method or HTTP route; private helpers are allowed.

```ts
- createJob(command: CreateJobCommand): Promise<JobStateResponse>
- getState(): Promise<JobStateResponse>
- appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>
- applyOperatorDecision(decision: OperatorReviewDecision): Promise<JobStateResponse>
- captureBranchSnapshot(forkTurnIndex: TurnIndex): Promise<BranchSnapshot | { kind: "rejected"; reason: "parent_not_quiescent" | "snapshot_too_large" | "invalid_fork_turn"; message: string }>
- initializeBranch(snapshot: BranchSnapshot): Promise<BranchCreationOutcome>
- receiveWebhookDelivery(event: VerifiedWebhookEvent): Promise<void>
- listTurns(request: CursorPageRequest): Promise<CursorPage<TurnSummaryRow>>
- listAttempts(request: CursorPageRequest & { turnIndex?: TurnIndex }): Promise<CursorPage<GenerationAttemptSummaryRow>>
- listJudgeCalls(request: CursorPageRequest & { turnIndex?: TurnIndex }): Promise<CursorPage<JudgeCallSummaryRow>>
- captureExportHighWaterMarks(): Promise<ExportHighWaterMarks>
- readArtifact(request: { kind: "turn_prompt" | "candidate_deliverable" | "attempt_request" | "attempt_response" | "judge_request"; id: string | number }): Promise<{ bytes: ArrayBuffer } | null>
```

`alarm()` is the only additional platform handler; it exposes no new contract. Implementations MUST NOT invent interfaces: import the exact functions from `src/db/*.ts`, `src/lib/*.ts`, and the shared types from `src/types.ts`; never reimplement storage, guards, tag parsing, dispatch, judge, token, or provider behavior inside the DO.

### Invariants

**One active attempt per job.** Track the attempt in `jobs.active_attempt_id` and refuse to start a second attempt while one is in a non-terminal state (`prepared`, `dispatching`, `dispatched`, `capacity_backoff`). Start every new attempt with a new idempotency key from `buildGenerationIdempotencyKey`; TESTING §7: "A different key on retry is a bug." README §Troubleshooting: "Ambiguous generation dispatches pause for manual recovery through a fresh attempt and key." Never resend an ambiguous dispatch under the same attempt key.

**Sequential turns.** `TurnIndex` is strictly 1-based (`src/types.ts`); `appendTurn` appends a `pending` turn, and generation may start a turn only after the previous accepted anchor is committed. Advance the accepted anchor only through `acceptTurnCandidate`, which updates `turn_candidates`, `turns`, and `jobs` in one `storage.transactionSync` and bumps `jobs.revision`.

**Cumulative structural evaluation.** TESTING §9: "Cumulative text concatenates the active run’s extracted deliverable across continuations, including tags split across continuation boundaries. Structural evaluation runs on cumulative text." Call `classifyCandidateOutcome` from `src/lib/tag.ts` over the joined text; persist its `structuralStatus` through `insertTurnCandidate`. Enforce precedence: "Provider failure, cancellation, and refusal handling retain precedence over this classification" (ARCHITECTURE §7) and "`empty_output` never reaches the judge" (TESTING §9). Empty output retries only while an automatic retry remains, otherwise fails (README §Recovery actions).

**Prepare–perform–reconcile.** Before any external call, persist the durable intent (attempt row plus a `durable_work` row written through `upsertDurableWork`). Perform the call (`dispatchResponsesCreate`, `retrieveProviderResponse`, judge dispatch) only after that commit, persist the outcome after it returns, and reconcile ambiguous outcomes from `alarm()` by retrieval, never by blind re-send. TESTING §24: "external side effects and execution-authorizing calls go through durable prepare–perform–reconcile".

**Capacity retry.** Use `computeCapacityBackoffMs`, `applyRetryAfter`, and `classifyDispatchResult` from `src/lib/dispatch.ts`. Persist `next_backoff_at_ms` on the attempt; allow "At most 5 per attempt, persisted exponential backoff" (README §System Limits); a fifth capacity failure persists `capacity_exhausted` and pauses for manual recovery. Do not fall back to the standard tier (README §Using the UI: "Generation uses Flex background Responses and never falls back to standard tier.").

**Fallback polling.** Schedule retrieval probes at five minutes, one minute, then five minutes with `getFallbackPollDelayMs` / `getNextFallbackPollAt`; stop at "24-probe bound" (README §System Limits, `src/lib/alarm.ts`). Persist `poll_probes` and `next_poll_at_ms`; never infer probe counts from wall-clock time.

**Judge outcomes.** Build requests with `buildJudgeRequest`, validate with `parseJudgeOutput`, and classify with `classifyJudgeEvaluation` from `src/lib/judge.ts`. Apply README §Recovery actions: accept an otherwise valid candidate with a warning on judge infrastructure failure; pause a structurally valid candidate for review on a valid rejection, excessive grade, or judge-only tag disagreement; accept with a coverage warning when file visibility is incomplete on an otherwise passing result. "Accept-with-warning uses the ordinary acceptance transition and preserves the original judge result." Operator acceptance never bypasses structural validity, admission, refusal handling, or artifact guards. Judge feedback never enters generation input automatically (TESTING §17).

**Branching.** README §Monitoring: "Branch initialization consumes a complete snapshot in one local transaction. Branch activation follows file protection and conditional superseding of the quiescent parent. Branch snapshots are bounded to 8,000,000 encoded bytes." `captureBranchSnapshot` reads the parent's turns, candidates, attempts, and judge calls inside one local read transaction and rejects a non-quiescent parent; validate the encoded size with `assertBranchSnapshotSize`. `initializeBranch` consumes the supplied `BranchSnapshot` in one local transaction, refuses activation when `snapshot_bytes` exceeds the guard, and supersedes only a parent that is still quiescent; abort without partial claims when the parent's revision advanced.

**Exports.** README §Monitoring: "Exports remain available in every job state and stream pages and one artifact at a time." Implement `listTurns` / `listAttempts` / `listJudgeCalls` over the `*_SUMMARY_COLUMNS` projections with primary-key cursors clamped to 1–100, and `readArtifact` for a single BLOB per call. Never materialize the whole job or hold a cursor across a network wait (ARCHITECTURE §12).

**Artifact guards.** Enforce the 1,500,000-byte guard on every stored artifact and resulting row via the storage functions; never truncate. Map `SQLITE_FULL` to `StorageFullError` and pause or fail explicitly (README §Recovery actions).

**Budgets and accounting.** Automatic continuations are "3 per turn, cumulative, fixed at job creation"; automatic full retries are "1, cumulative, fixed at job creation"; "Manual retry effect | Does not reset automatic recovery counters" (README §System Limits). Record usage once per call through `src/db/attempts.ts`; leave missing usage and unknown pricing explicit (`src/lib/tokens.ts`).

**One alarm.** TESTING §24: "Each Durable Object uses one alarm scheduled against its earliest obligation or deadline." Compute the earliest due time with `getEarliestDurableWorkDueAtMs` and `earliestDeadline`, schedule with `ensureAlarmNotLaterThan` (`scheduleEarliestAlarm`), and run `alarm()` through `runWithAlarmSafety`. Inside `alarm()`, reschedule with `scheduleNextObligationFromAlarm` because `getAlarm()` returns `null` during an active invocation; never call `setAlarm()` unconditionally in the constructor (docs/ALARMTIMING.md traps 6.2 and 6.3).

### Platform traps

- `ctx.storage.transactionSync(callback)` wraps the callback in one SQLite transaction and rolls back if it throws; the callback must complete synchronously (not `async`, no Promise) because only synchronous storage calls, notably `sql.exec()`, can join the transaction.
- `sql.exec()` cannot run `BEGIN TRANSACTION` or `SAVEPOINT`; use `transactionSync()`/`transaction()` instead. It accepts multiple statements, but bindings apply only to the last statement, the cursor covers only the last statement, and `int64` values above JavaScript's 52-bit precision lose accuracy when read.
- SQL hard caps: 2 MB maximum string, `BLOB`, or table row; 100 KB maximum statement length; 100 bound parameters per query; 100 columns per table; 32 arguments per function; 50 bytes maximum `LIKE`/`GLOB` pattern.
- Cursors have no snapshot isolation across `await`: a resumed cursor can observe later inserts/updates/deletes, including uncommitted rows from a newer transaction, so consume with `toArray()`/`Array.from()` before the next `await`; `rowsRead` and `rowsWritten` grow during iteration and are the final SQL billing counters (each index-row update also counts as a row written).
- Storage per SQLite-backed Durable Object is 10 GB on Workers Paid (1 GB on Free); on exhaustion writes fail with `SQLITE_FULL`, while `SELECT`, `get()`, `list()`, and `DELETE` still work so space can be reclaimed. `deleteAll()` removes the entire SQLite database atomically and, with compatibility date 2026-02-24 or later, also deletes the active alarm; earlier dates require a separate `deleteAlarm()`.
- `ctx.blockConcurrencyWhile(callback)` blocks every other event until the callback resolves; an exception terminates and resets the object, and exceeding the 30-second timeout resets it, so holding it across external I/O blocks all events for that I/O duration.
- Each object has at most one alarm: `setAlarm(ms)` overwrites it, alarms never repeat, `getAlarm()` returns `null` while `alarm()` runs unless `setAlarm()` is called again, and constructor `setAlarm()` can interfere with a pending alarm; `alarm()` is at-least-once, capped at 15 minutes wall time, and retried after uncaught exceptions with exponential backoff from 2 seconds for at most 6 retries (for the most recent `setAlarm()`), while `deleteAlarm()` inside the handler suppresses retries only best-effort.
- `waitUntil()` prevents eviction until its promise settles or 15 minutes elapse, but does not change when the request/RPC completes; in-memory fields are discarded on hibernation after ~10 seconds idle or eviction after 70–140 seconds, and no shutdown hooks are provided.
- Runtime retries allow up to 5 attempts total with no retry starting more than 10 seconds after the first; an unmarked method is never run twice by a retry, `retryable()` opts an idempotent method into replay, and calls carrying streams, stubs, functions, `RpcTarget`, or pipelined results are not retried.
- CPU time defaults to 30 seconds per invocation (configurable to 5 minutes via `limits.cpu_ms`) and resets on each incoming request/message; an object has a soft limit near 1,000 requests/second and responds with `.overloaded` errors that the runtime does not retry.
Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync ; https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec ; https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits ; https://developers.cloudflare.com/durable-objects/api/alarms/#handler-methods ; https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile ; https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/#default-limits

### Integration points

- `src/handlers/jobs.ts` calls this RPC surface for commands, reads, branching, and export enumeration.
- `env.ROUTER_DO`: call `registerResponseRoute` after a dispatch returns a response ID; receive deliveries through `receiveWebhookDelivery` (RouterDO → JobDO).
- `env.REGISTRY_DO`: call `protectJobFileRefs` before activation/ready, `releaseJobFileRefs` when a job becomes terminal, and `registerJob` / `updateJobIndexStatus` on lifecycle changes.
- `src/lib/openai.ts`: `resolveEnvSecret`, `dispatchResponsesCreate`, `retrieveProviderResponse`, `cancelProviderResponse`.
- `src/lib/dispatch.ts`, `src/lib/judge.ts`, `src/lib/tokens.ts`, `src/lib/tag.ts`, `src/lib/alarm.ts`, `src/lib/guards.ts`.
- `src/db/jobs.ts`, `src/db/turns.ts`, `src/db/attempts.ts`, `src/db/schema.ts`.

### Anti-patterns

- Do not write `jobs`, `turns`, or attempt rows from handlers, RouterDO, or RegistryDO; they are not the execution-state writer.
- Do not `await` anything inside `storage.transactionSync`, and do not perform `fetch` there.
- Do not dispatch or judge before the durable prepare record commits, or retry an ambiguous dispatch under the same key.
- Do not classify candidates in the DO by hand; reuse `classifyCandidateOutcome` and the `empty_output` precedence rules.
- Do not let judge text flow into the next generation request.
- Do not truncate oversized artifacts or catch `ArtifactGuardError` to store a substitute.
- Do not add a second alarm or schedule from the constructor.
- Do not expose extra RPC methods, read BLOBs in list queries, or bypass `clampPageLimit`.
### Export

```ts
import { DurableObject } from "cloudflare:workers";

export class JobDO extends DurableObject<Env> {}
```

Keep the boot scaffold's synchronous `migrateJobDoSchema(ctx.storage)` style constructor migration.
