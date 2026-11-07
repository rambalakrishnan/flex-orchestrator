## RouterDO — `src/do/router-do.ts`

### Purpose and owned state

Implement the global response router through the `env.ROUTER_DO` binding (`class_name = "RouterDO"`) and the singleton name `ROUTER_DO_NAME` (`"global-router"`) from `src/constants.ts`. It owns exactly two SQLite tables and runs `migrateRouterDoSchema` in the constructor:

- `response_routes` — `response_id` → `job_id` / `attempt_id` / `turn_index` mapping (`src/db/router.ts`).
- `webhook_inbox` — durable, verified webhook deliveries with their raw payloads (`src/db/router.ts`).

RouterDO never writes job execution state. It carries verified events to `JobDO` and records their delivery; all job, turn, and attempt mutations belong to `JobDO`.

### Public surface

RouterDO RPC (binding RPC; all methods async). Do not add another public method or HTTP route; private helpers are allowed.

```ts
- enqueueWebhook(event: VerifiedWebhookEvent): Promise<{ receipt: WebhookIngressReceipt; duplicate: boolean }>
- registerResponseRoute(mapping: ResponseRouteMapping): Promise<void>
- deliverPending(): Promise<{ delivered: number; retried: number; failed: number }>
```

`alarm()` is the only additional platform handler. Implementations MUST NOT invent interfaces: call the exact functions in `src/db/router.ts` (`enqueueVerifiedWebhook`, `registerResponseRoute`, `getResponseRoute`, `markResponseRouteStatus`, `getWebhookInboxSummary`, `getWebhookInboxRawBodyBlob`, `listWebhookInboxSummaries`, `listDueWebhookDeliveries`, `getEarliestWebhookRetryAtMs`, `recordWebhookDeliveryResult`) with the exact types from `src/types.ts`; never reimplement inbox or route logic inside the DO.

### Invariants

**Accept durably before acknowledging.** README §Infrastructure: "Webhooks authenticate exact raw bytes and enforce a 300-second delivery-timestamp tolerance. Acknowledgement follows durable inbox acceptance." `enqueueWebhook` must complete its `storage.transactionSync` insert before `src/handlers/webhook.ts` returns 2xx. Never acknowledge from an uncommitted background promise (TESTING §24).

**Routes are immutable.** TESTING §18: "Response mappings are immutable". A registered `response_id` always resolves to the same `job_id`, `attempt_id`, and `turn_index`; only the delivery status may advance (`registered` → `delivered` → `settled`) through `markResponseRouteStatus`. Re-registering the same mapping is idempotent; re-registering a conflicting mapping is an error, never a silent rebind.

**Unmatched events are retained, not dropped.** `enqueueVerifiedWebhook` stores a verified event whose `response_id` has no route with `status = 'unmatched'`; `registerResponseRoute` reconciles those rows in its own transaction and returns the newly matched summaries. README §Troubleshooting: "Unmatched webhook events remain available for registration races."

**Duplicates and late results retain accounting without reopening decisions.** Return `duplicate: true` with the existing summary when `webhook_id` already exists; never overwrite a settled record or replay a terminal event into JobDO. README §Troubleshooting: "Duplicate and late results retain accounting without reopening settled execution decisions." TESTING §18 requires a duplicate `response.completed` delivery to accept a turn exactly once.

**Bounded artifacts.** `enqueueVerifiedWebhook` validates `rawBody` through `toGuardedBlob` and `assertArtifactAndRowSize` against the 1,500,000-byte guard; store the exact verified bytes once and read them only on demand with `getWebhookInboxRawBodyBlob`. Never truncate, never re-serialize the payload.

**Listing is BLOB-free and cursor-based.** Use `WEBHOOK_INBOX_SUMMARY_COLUMNS` with primary-key cursors (`webhook_id > ?`) and `clampPageLimit`; "Lists use primary-key cursors, omit BLOBs, and clamp page limits to 1–100" (README §Files and Limits).

**Delivery goes through JobDO.** For each row from `listDueWebhookDeliveries`, build a `VerifiedWebhookEvent` from the stored fields and the raw body, call `env.JOB_DO` stub `receiveWebhookDelivery`, then persist the result with `recordWebhookDeliveryResult` (`delivered`, `duplicate`, `retry`, or `failed`). A `delivered` result also advances the matching route to `delivered`. Never call OpenAI directly from RouterDO and never mutate job state here.

**One alarm at the earliest pending retry.** TESTING §24: "Each Durable Object uses one alarm scheduled against its earliest obligation or deadline." Read `getEarliestWebhookRetryAtMs`, schedule with `ensureAlarmNotLaterThan` (`scheduleEarliestAlarm`), and run `alarm()` through `runWithAlarmSafety`. Persist `next_attempt_at_ms` and `delivery_attempts` on every retry; schedule from persisted deadlines, never from in-memory timers. Inside `alarm()`, use `scheduleNextObligationFromAlarm` because `getAlarm()` returns `null` during an active invocation (docs/ALARMTIMING.md trap 6.3).

**Delivery respects the alarm budget.** `deliverPending` reads due rows with `listDueWebhookDeliveries(nowMs, limit)`, which orders by `next_attempt_at_ms` then `webhook_id`, and stops starting new deliveries once `isAlarmWallTimeBudgetExceeded(startedAtMs)` is true. Persist each row's result before starting the next one and return the `{ delivered, retried, failed }` counts for the invocation.

**Delivery failures remain accounted.** If the `JobDO` RPC rejects, record `retry` with a sanitized `last_error` and a future `next_attempt_at_ms` (or `failed` for a permanent rejection), never delete the inbox row, and never drop the observation. Do not throw past the retry-budget threshold; let `runWithAlarmSafety` reschedule (docs/ALARMTIMING.md trap 6.5).

**The webhook ID is the idempotency key.** Deduplicate the inbox on `webhook_id` alone; never key on `response_id` or `event_type`, because distinct deliveries of different events for one response must all be retained. A webhook ID is immutable; a changed ID is a new event even with identical bytes.

**Status transitions are one-way.** `unmatched` → `pending` on reconciliation; `pending` → `delivered` / `duplicate` / `failed` on a delivery result. Never move a delivered or duplicate row back to `pending`, and never reset `delivery_attempts`.

**Registration is atomic.** `registerResponseRoute` inserts the route and reconciles matching unmatched rows inside one `storage.transactionSync`; if either step fails, the whole transaction rolls back and no partial route or reconciliation is visible.

**Exact route lookup only.** `getResponseRoute` matches the full `response_id`; never prefix-match, case-fold, or guess a job from a partial identifier. A null lookup is an unmatched event, not an error.

**No credentials.** RouterDO never resolves or stores API keys or signing secrets; the webhook handler verifies signatures before the event reaches this object.

### Platform traps

- Use `transactionSync()` for response-route registration plus unmatched-inbox reconciliation: the callback must be synchronous, cannot await, and a throw rolls back both the route write and inbox updates.
- SQL rows and BLOBs are capped at 2 MB, statements at 100 KB, and bound parameters at 100 per query; an oversized webhook body exceeds the row cap and fails the write, and exhausted storage surfaces as `SQLITE_FULL` while reads/deletes remain available.
- Cursors are not stable across `await`: a cursor resumed later can observe subsequent writes, so read inbox summaries fully before the next await and treat `rowsRead`/`rowsWritten` as the billing counters.
- A single `setAlarm()` value exists per object and a later call overwrites it; alarms do not repeat, `getAlarm()` is `null` during `alarm()` unless reset, and scheduling from the constructor risks overriding a pending alarm.
- Alarm retries are at-least-once with exponential backoff from 2 seconds for at most 6 retries and a 15-minute wall-time cap; an uncaught failure after the sixth retry stops invoking the handler until a new `setAlarm()` occurs.
- Calls to a `JobDO` stub follow E-order, but an exception poisons that stub so all in-flight and future calls fail until a new stub is created; different stubs provide no ordering guarantees.
- Runtime retries make up to 5 attempts with no retry starting after 10 seconds, but an unmarked method that may have been received is not re-run and the caller gets the original error; `retryable()` permits replay, and calls with stream/stub/function arguments are not retried.
- `blockConcurrencyWhile()` blocks all unrelated events; an exception or 30-second overrun resets the object, which is why it is documented for constructor migrations rather than request handling.
- `waitUntil()` keeps the object alive up to 15 minutes but does not extend the caller's RPC; `alarm()` handlers have a separate 15-minute wall-time limit, longer than the 30-second request tail.
Source: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync ; https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits ; https://developers.cloudflare.com/durable-objects/api/alarms/ ; https://developers.cloudflare.com/durable-objects/api/stub/ ; https://developers.cloudflare.com/durable-objects/api/state/#waituntil

### Integration points

- `src/handlers/webhook.ts` resolves `env.ROUTER_DO` (via `ROUTER_DO_NAME`) and calls `enqueueWebhook` after signature verification; it returns the receipt only after the RPC resolves.
- `JobDO` calls `registerResponseRoute` when a dispatch returns a `response_id`.
- RouterDO calls `env.JOB_DO.receiveWebhookDelivery` for each due inbox row.
- `alarm()`: compute the earliest pending retry, call `deliverPending`, persist every result, and reschedule from persisted deadlines only.
- `src/db/router.ts`, `src/db/schema.ts` (`migrateRouterDoSchema`, guards, summary columns), `src/lib/alarm.ts`, `src/lib/guards.ts`, `src/types.ts`.

### Anti-patterns

- Do not return 2xx before the inbox transaction commits.
- Do not verify signatures inside RouterDO; verification is a handler responsibility with the raw request bytes.
- Do not rewrite a route's `job_id`, `attempt_id`, or `turn_index`, or rebind a `response_id` to a new attempt.
- Do not drop unmatched events or treat them as terminal errors.
- Do not re-deliver a duplicate `webhook_id` as new execution work or reopen a settled decision.
- Do not buffer, transform, or truncate the raw payload; store and forward the exact verified bytes.
- Do not select BLOB columns in list queries, exceed the 1–100 page clamp, or add extra RPC methods.
- Do not poll with timers or `waitUntil`; use the single earliest-obligation alarm.
- Do not scan or materialize the whole inbox; page due rows and respect the alarm wall-time budget.
- Do not persist a delivery result before the `JobDO` RPC settles, or mark a row `delivered` on a transport failure.
- Do not key inbox dedupe on `response_id` or `event_type`, or reopen a `delivered`/`duplicate` row.
- Do not store the verified payload twice (raw blob plus a decoded copy) or reserialize it when forwarding.
### Export

```ts
import { DurableObject } from "cloudflare:workers";

export class RouterDO extends DurableObject<Env> {}
```

Keep the boot scaffold's synchronous `migrateRouterDoSchema(ctx.storage)` style constructor migration.
