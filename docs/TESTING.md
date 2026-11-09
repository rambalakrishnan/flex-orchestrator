# TESTING.md

## Overview
This document defines how to verify the Worker against `ARCHITECTURE.md`. It covers automated tests (unit, integration, and Durable Object) plus the manual checks that cannot be fully automated (Cloudflare Access wiring, OpenAI webhook registration, real Flex capacity behavior).

Tests are organized by architecture concern. Each numbered item below is a verification obligation, not a single test case; a well-written test file may satisfy several items, and each item should have at least one direct assertion.

**Authoritative references:**
- §2 — deployment topology
- §6 — canonical generation request
- §7 — empty-output classification
- §8A — joint recovery procedure
- §11 — file storage
- §12 — artifact storage and export
- §16 — topology and dependency DAG

## Prerequisites and setup
- Node.js with `npm`
- `npx wrangler` authenticated to a non-production account for manual verification
- Local test bindings for `JOB_DO`, `ROUTER_DO`, `REGISTRY_DO` (see `wrangler.toml`)
- A fixture `OPENAI_API_KEY` for provider-IO tests that must not hit the real API
- A fixture `OPENAI_WEBHOOK_SECRET` for signature tests
- For manual checks only: a real Cloudflare account with Access, a real OpenAI project with webhooks, and a real judge provider credential

Recommended stack: `vitest` with `@cloudflare/vitest-pool-workers` so Durable Objects, `fetch`, and `waitUntil` behave like production.

## Running tests
```bash
npm install
npm test              # unit + integration
npm run test:watch    # watch mode
npm run test:do       # Durable Object tests
npm run test:coverage # coverage report
```
Tests must never call the real OpenAI, judge, or Cloudflare APIs.

## Test organization
```text
test/
├── unit/
│   ├── tag.test.ts
│   ├── signature.test.ts
│   ├── continuity.test.ts
│   ├── dispatch.test.ts
│   ├── judge.test.ts
│   ├── tokens.test.ts
│   ├── health.test.ts
│   ├── redaction.test.ts
│   ├── guards.test.ts        # pure guard functions, no real bytes
│   └── alarm.test.ts
├── integration/
│   ├── http.test.ts
│   ├── routing.test.ts
│   ├── operator-api.test.ts
│   ├── handlers-jobs.test.ts
│   ├── handlers-files.test.ts
│   ├── handlers-tokens.test.ts
│   ├── handlers-webhook.test.ts
│   └── generation-recovery.test.ts
├── do/
│   ├── job-do.test.ts
│   ├── registry-do.test.ts
│   └── router-do.test.ts
├── db/
│   ├── schema.test.ts
│   ├── migrations.test.ts
│   ├── job-storage.test.ts
│   └── router-storage.test.ts
└── fixtures/
    ├── requests.ts
    ├── jobs.ts
    ├── files.ts
    └── judge.ts
```
Each test file states which verification items it covers in a top-of-file comment (`// Covers: 7, 8, 9`), so reviewers can audit coverage against this document.

## Workerd and `vitest-pool-workers` patterns
These are the environment-specific idioms that all DO tests must follow.

### Intercepting outbound `fetch`
Node HTTP interceptors and `setupServer` from MSW do not patch `fetch` inside workerd. Intercept with `vi.stubGlobal('fetch', ...)` and dispatch by URL, or inject a fetch implementation into the `ProviderIO` seam and swap it per test. When you stub globally, filter by hostname so unrelated requests still fail loudly.

Assertions against outbound generation requests must compare the stored request bytes, not a reconstructed object. Stub `fetch`, capture the body as `arrayBuffer()`, and compare against the canonical-request builder output.

### Driving Durable Object alarms
Do not wait for real time and do not use `vi.useFakeTimers()` against the DO clock. Use `runDurableObjectAlarm(stub)` from `cloudflare:test` to fire a scheduled alarm synchronously and assert it ran. Use `runInDurableObject(stub, async (instance, state) => { ... })` to inspect state before and after.

Alarm handlers must depend on persisted deadlines, not `Date.now()`. Tests manipulate persisted deadlines (or the work records that produce them) and then fire the alarm. This makes backoff, fallback polling, and retention deletion deterministic.

**Crucial:** Durable Object alarms are not reset between test runs and do not respect isolated storage. Every test that schedules an alarm must either run it with `runDurableObjectAlarm()` or delete it before the test finishes, or it will bleed into the next test.

### SQLite transactions are synchronous
Cloudflare Durable Object SQLite transactions (`state.storage.transactionSync()`) are synchronous. You cannot `await` inside them; the TypeScript compiler will reject it, and the runtime will throw if you bypass the compiler. Therefore:
- Do not attempt to test “throw from a stubbed `fetch` inside a transaction.” The stubbed `fetch` returns a Promise; the transaction block closes before it can run.
- Do assert transaction atomicity by throwing a **synchronous** error inside the block and checking that all statements in that block rolled back.
- Do assert transaction purity structurally: inspect the transaction’s call graph in review (or via a lint rule) to ensure no `fetch`, `setTimeout`, `await`, or other asynchronous/IO calls appear inside any `transaction*` callback. This is a code-review obligation, not a runtime test.

### Controlling clock and randomness
`vi.setSystemTime()` does not reliably affect the DO clock in workerd. Design code so that time-sensitive behavior is driven by persisted deadlines and deterministic inputs:
- Idempotency keys derive from stable inputs (job ID, turn index, attempt index), not `crypto.randomUUID()` called mid-test.
- Retry counts and attempt indices are persisted and read back, not inferred from wall-clock deltas.
- Where jitter is required (e.g., Flex backoff), inject a seedable RNG so backoff timestamps are deterministic and assertable.
- If a module must call `Date.now()`, wrap it (`lib/clock.ts`) so tests can substitute it. Do not call `Date.now()` directly inside DO handlers that must be tested deterministically.

### `waitUntil` and test completion
Do not rely on `waitUntil` to finish before the test completes. Create an `ExecutionContext` with `createExecutionContext()` and pass it to the handler under test. Before asserting side effects, call `await waitOnExecutionContext(ctx)` to settle every promise passed to `ctx.waitUntil()`. Background tasks must not bleed into the next test.

### Test isolation and Durable Object teardown
`@cloudflare/vitest-pool-workers` provides **per-file** isolated storage. Tests within the same file share a storage environment. You must handle per-test state bleed explicitly.

Use `reset()` and `abortAllDurableObjects()` from `cloudflare:test` in an `afterEach` hook:

```ts
import { reset, abortAllDurableObjects } from "cloudflare:test";
import { afterEach } from "vitest";

afterEach(async () => {
  // 1. Settle or clear alarms first. Alarms do not respect isolated storage
  //    and are not cleared by reset(). If a test scheduled an alarm,
  //    run it with runDurableObjectAlarm() or delete it explicitly here.

  // 2. Wipe all storage bindings (KV, R2, D1, DO SQLite) and reset instances
  await reset();

  // 3. Evict running instances from memory
  await abortAllDurableObjects();
});
```

- **Do not manually `DROP TABLE` as a teardown strategy.** `reset()` removes the entire SQLite database content.
- **Do not use fresh Durable Object IDs as the primary isolation mechanism.** Per-file isolation plus `reset()` is the supported pattern. Reserve explicit schema resets or fixed IDs for migration tests.
- **Do not call `stub.deleteAll()`.** `deleteAll()` is a method on `DurableObjectStorage`, not on `DurableObjectStub`. Use `reset()`, or `runInDurableObject(stub, (instance, state) => state.storage.deleteAll())` when you must target one object.
- **Alarm nuance:** `deleteAll()` clears an active alarm only for Workers with compatibility date `2026-02-24` or later. `reset()` avoids that specific question by wiping the binding, but the known-issue still applies: alarms are never reset between test runs, so schedule-then-settle in every test regardless of which helper you use.
- **Eviction helpers are separate:** `evictDurableObject(stub, options?)` and `evictAllDurableObjects()` test eviction behavior; they wait for in-flight requests to drain and hibernate WebSockets by default. Do not use them as a storage-reset substitute.

## Verification suite

### Routing and security
**1. Worker-first hostname routing.** With `workers_dev = false` and `preview_urls = false`, requests to `workers.dev`, preview URLs, and unexpected `Host` values must not reach the application. `app.example.com` reaches the application behind Access; `hooks.example.com` reaches only the webhook ingress. Cover: `src/index.ts` hostname dispatch, `src/handlers/webhook.ts` mount.

**2. Browser-origin enforcement and secret hygiene.** State-changing browser requests without the application `Origin` are rejected. Stored request bodies, logs, and exports never contain credential values; authorization headers are resolved at call time only. Model output is emitted as text or sanitized Markdown (no raw HTML injection). Cover: `src/http.ts`, `src/do/job-do.ts`, `src/lib/openai.ts`, `public/app.js`.

**2a. Server-rendered HTML fragments and Markdown safety.** The application serves pre-rendered HTML fragments; no JSON state is rendered client-side.
- `GET /api/jobs/fragment` reads the registry job index through `REGISTRY_DO.listJobs` (optional `limit`/`cursor`, unknown query keys rejected) and returns `renderJobList(page.items)`.
- `GET /api/jobs/:jobId/fragment` returns `404` when `JobDO.getState()` is `null`; otherwise it pages `listTurns`, `listAttempts`, and `listJudgeCalls` (limit 100, bounded to 4 pages), selects turns with status `accepted` or `accepted_with_warning` and a non-null `accepted_candidate_id`, reads each `candidate_deliverable` artifact, decodes UTF-8, and returns `renderJobDetail(state, deliverables, turnSummaries, attemptSummaries, judgeCallSummaries)`. The fragment renders escaped turn prompts/anchors, attempt rows, judge verdicts/grades/comments, and Markdown deliverables.
- Both fragments are matched before the generic `jobId` parser, return `Content-Type: text/html; charset=utf-8` with `Cache-Control: no-store`, and reject non-`GET` with `405`. Non-API paths continue to be served from `ASSETS`.
- Model output is rendered only through `src/lib/markdown.ts`. `marked@18.1.3` has **no** `escapeRawHtml` option; the module neutralizes raw HTML by escaping `renderer.html` token text and rewrites unsafe `javascript:`, `vbscript:`, and `data:` link/image hrefs to `#` in `walkTokens`.
- `renderMarkdown()` enforces a hard character limit: `text.length > 250,000` returns exactly `<p>Error: Output exceeds maximum safe rendering length.</p>` without parsing; exactly 250,000 characters still parses. Every non-Markdown dynamic value in views goes through `escapeHtml()`.
Cover: `src/lib/markdown.ts`, `src/views/jobs.ts`, `src/handlers/jobs.ts`, `src/index.ts`, `test/unit/markdown.test.ts`, `test/integration/routing.test.ts`.

### Files and storage
**3. Files API contract.** Uploads use `purpose: "user_data"` and produce `file_id` references; inline text, base64, and `file_url` are rejected at the submission interface. Uploads are bounded to **16,000,000 file bytes**; multipart parsing, buffering, and hashing remain bounded. Test multipart parsing and hashing at a small size; include exactly one integration test at the 16,000,000 / 16,000,001 boundary using `new Uint8Array(N)` (not a string) to avoid encoding overhead. Cover: `src/handlers/files.ts`, `src/do/registry-do.ts`.

**4. Upload dedupe and intent recovery.** Identical content hashes deduplicate source uploads. Ambiguous or redundant upload intents are recoverable and cleanable. Cover: `src/do/registry-do.ts`.

**Body decoding note.** UTF-8 body decoding strips a leading byte-order mark as standard `TextDecoder` behavior (`ignoreBOM: false`); BOM stripping is standard behavior, not a custom acceptance or rejection rule.

**5. File reference protection and retention.** Non-terminal file references are protected before a job becomes ready. RegistryDO periodically deletes retention-eligible files that no non-terminal job references. Drive the retention alarm with `runDurableObjectAlarm` and assert deletion against the catalogue. Cover: `src/do/registry-do.ts`, `src/db/jobs.ts`, `src/lib/alarm.ts`.

**6. Artifact guards.** Every artifact and every resulting row independently enforce the **1,500,000-byte** guard, including encoded file bytes inside retained inline judge requests. Oversized artifacts produce explicit errors; nothing is truncated. Test the pure guard function exhaustively with `{ size: N }` mocks; include exactly one integration test per guard boundary (1,500,000 / 1,500,001) to verify wiring. Do not allocate real 1.5 MB payloads for every insert test. Cover: `src/db/schema.ts`, `src/do/job-do.ts`.

**6a. Schema and migration validation.** The architecture mandates explicit migration tables (no `PRAGMA user_version`). Cover:
- **Schema DDL validation:** Run the actual `CREATE TABLE` DDL from `src/db/schema.ts` against an empty SQLite-backed DO. Assert no syntax errors. Insert a mock row into every table and verify constraints, `NOT NULL` columns, and `STRICT` mode behavior.
- **Migration idempotency:** Run the migration script against an empty database; assert the `_sql_schema_migrations` table exists and records each applied migration by ID. Run the script a second time; assert it applies zero new migrations and does not recreate tables.
- **Partial migration rollback:** Throw a synchronous error mid-migration and assert the migration record is unapplied and no half-created tables remain visible to a subsequent run.
- **Migration ordering:** Assert migrations run by migration ID, not by file mtime.
Cover: `src/db/schema.ts`, `test/db/migrations.test.ts`, `test/db/schema.test.ts`.

### Generation
**7. Canonical generation request.** Each attempt stores the exact UTF-8 request body used for its sends, omits authorization headers, uses Flex background Responses (`background: true`, `service_tier: "flex"`), selects cache explicitly among `30m`, `12h`, `nocache`, places developer messages in `input` (not `instructions`), keeps developer-role content text-only, delivers developer files as user-role `input_file` content deduplicated with turn attachments, and uses exact canonical-request counting. The developer message carries only the job developer prompt verbatim with no generated per-turn instruction, so it stays byte-identical across turns and attempts for prompt-cache reuse; when the job has no developer prompt, the developer message is omitted entirely.

Long-context classification test points, using mocked counts:
- **271,999** → not long-context
- **272,000** → not long-context (boundary; spec says *above* 272,000)
- **272,001** → long-context
Assert that cached input counts toward the threshold.

Idempotency-Key assertions:
- Assert that an `Idempotency-Key` header is present on every generation dispatch.
- Send the same attempt twice and assert the exact same key is used on both sends. A different key on retry is a bug.
- Assert that a new attempt (attempt index incremented) produces a new key.
Cover: `src/lib/dispatch.ts`, `src/db/attempts.ts`.

**8. Shared continuity helper.** Generation and judge obtain continuity fields from the same helper; neither adapter re-implements the §2 stateful/stateless rule. Parametrize the helper over `{ stateful, stateless } × { anchor present, absent }` and assert both adapters consume its output verbatim. **Assert the serialized payload:** stateful must contain `previous_response_id` (if anchored) and must *not* contain `include`. Stateless must contain `include: ["reasoning.encrypted_content"]` and must *not* contain `previous_response_id`. Cover: `src/lib/continuity.ts` plus both adapters.

**9. Cumulative assembly, structural classification, and precedence.** Cumulative text concatenates the active run’s extracted deliverable across continuations, including tags split across continuation boundaries. Structural evaluation runs on cumulative text. Precedence is fixed: **provider failure, cancellation, and refusal handling take precedence over empty-output classification**, and **`empty_output` never reaches the judge**. Cover at minimum:
- `""`, `"   "`, `"\n\n"`, `"\t"` → `empty_output`; no judge call
- `"<!-- TURN_END:1 -->"` → `empty_output`; no judge call
- `"<!-- TURN_END:1 --><!-- TURN_END:1 -->"` → `malformed_tag`; no judge call
- `"foo<!-- TURN_END:1 -->"` → accepted candidate; judge called; trailing content absent
- `"<!-- TURN_END:1 -->foo"` → **`trailing_content`** structural outcome: `foo` is truncated from the exported text, the judge is not asked to evaluate trailing bytes as deliverable, and a structural warning is passed to the judge (or to the recovery path per §8A).
- `"foo<!-- TURN_END:1 -->bar"` → `trailing_content`; `foo` retained, `bar` truncated with warning
- Marker split across continuations (`"<!-- TURN_E"` + `"ND:1 -->"`) → single marker recognized; classification matches the joined output
- Provider error part returned alongside text → provider path; not `empty_output`; not judge
- **Refusal part returned alongside text → refusal path; not `empty_output`; the judge is not invoked.** Assert via `judge` spy: zero calls.
- Cancellation observed alongside text → cancellation path; not `empty_output`; judge not invoked
Cover: `src/lib/tag.ts`, `src/do/job-do.ts`.

**10. Recovery budgets and dispatch fences.** Automatic recovery budgets are fixed at job creation, cumulative per turn, and default to three continuations and one full retry. Manual retries do not reset automatic counters. Ambiguous dispatches pause for a fresh attempt and idempotency key. Flex backoff is persisted and bounded to five sends per attempt; assert exactly five sends then pause. Capped/incomplete responses and `missed_tag` candidates auto-continue within the fixed continuation budget. Fallback polling follows the five-minute, one-minute, five-minute schedule with a 24-probe bound; drive each step with `runDurableObjectAlarm` against persisted deadlines. Attempt indices increase monotonically and are never reused.
*Integration loop:* Mock the OpenAI client to return a marker-only response on attempt 1, and a valid response on attempt 2. Assert the run reaches the configured maximum limit (defaulting to three continuations and one full retry) and either completes or fails at the boundary without exceeding the ceiling.
*(Note: This test belongs in `test/integration/generation-recovery.test.ts`)*
Cover: `src/lib/dispatch.ts`, `src/lib/alarm.ts`, `src/db/attempts.ts`.

### Judge
**11. Declared-capability handling.** Judge capability declarations are operator-authoritative. The adapter performs no runtime capability detection and no silent substitution; inconsistencies produce advisory warnings; an unencodable declared contract produces `UNKNOWN` rather than an invented capability. Specifically:
- Chat Completions declared stateful → warning; assert the outbound request contains no `previous_response_id` and no other invented stateful field.
- Passthrough with a non-OpenAI API root → permitted.
- Unencodable declared contract → `UNKNOWN`, **and** the request is not sent with the offending field dropped.
Cover: `src/lib/judge.ts`.

**12. History-aware file delivery.** Stateful judge history attaches each applicable file once and inherits its context on later calls; assert the second call omits inherited attachments. Stateless requests attach files per represented turn; `includePrior` adds prior accepted-output blocks and their applicable files. Files are deduplicated within a request. Cover at minimum:
- Stateful: call 1 attaches file; call 2 omits it as inherited.
- Stateful **failure before response-ID commit**: call 1’s outbound request fails or is cancelled before the response ID is recorded. Assert call 2 attaches the file again, because the chain was never established.
- Stateful failure **after response-ID commit but before delivery ack**: assert the attachment decision matches persisted chain state, not assumed success.
- Stateless with `includePrior`: files for prior accepted-output blocks appear once per request; dedupe holds.
- Duplicate file IDs across turns in one request: attached once.
Cover: `src/lib/judge.ts`.

**13. Manifest and `file_visibility`.** The manifest distinguishes delivered-now, inherited, and withheld files across all applicable files. Boolean `file_visibility` reports complete applicable-file coverage versus any missing coverage. Assert `file_visibility` is derived from coverage, not from `manifest.deliveredNow`. Cover: `src/lib/judge.ts`.

**14. Judge output shape.** Judge output validation accepts exactly the five-field steering shape: verdict (`YES`/`NO`), letter grade (`A`–`F`), comment, `tag_matches_expected_step`, and boolean `file_visibility`; it normalizes to `PASS`/`FAIL`, numeric grade (A=95,B=85,C=75,D=65,F=50), and `tag_agreement`. Legacy `PASS`/`FAIL`, numeric grades, and `tag_agreement` are also accepted; mixed/extra/missing keys and wrong types are rejected before the database. Cover: `src/lib/judge.ts`.

**15. Judge audit records.** Audit records retain the request, extracted message body, IDs, usage, diagnostics, and required continuity items, and not a redundant response envelope. Judge history and response IDs remain separate from generation history. Cover: `src/db/attempts.ts`, `src/lib/judge.ts`.

**16. Judge outcome branching.** Judge infrastructure failure accepts an otherwise valid candidate with a warning. A judge rejection or grade below the minimum acceptable threshold consumes the automatic retry budget: when `injectOnFail` is true the retry prompt carries the judge critique; with the flag off the retry is unmodified. Once the budget is exhausted the job pauses for review. Judge-only tag disagreement pauses a structurally valid candidate; it is distinct from parser-confirmed `wrong_index`. Incomplete file visibility on an otherwise passing result accepts with a coverage warning. Storage and artifact-guard errors pause or fail explicitly. Accept-with-warning uses the ordinary acceptance transition and preserves the original judge result. Operator acceptance does not bypass structural validity, admission, refusal handling, or artifact guards. Cover: `src/do/job-do.ts`, `src/lib/judge.ts`, `src/handlers/jobs.ts`.

**17. Conditional judge feedback injection.** Judge feedback enters generation only when declared. With `injectOnFail` false, a failed-turn retry request must not contain the judge comment. With it true, the stored turn prompt and auto-retry request contain the exact `### JUDGE CRITIQUE` suffix. With `injectOnPass` true, the next pending turn prompt is updated with the exact `### PM STEERING NOTE` suffix before dispatch; with it false the next prompt is unchanged. Config booleans default to `true`/`false` for legacy persisted judge JSON. Cover: `src/do/job-do.ts`, `src/db/turns.ts`, `src/lib/judge.ts`.

### Webhooks
**18. Webhook durability, ordering, and signature concatenation.** Signature verification operates on exact raw bytes with a 300-second delivery-timestamp tolerance. Acknowledgement follows durable inbox acceptance. Response mappings are immutable; unmatched events remain available for registration races. Duplicate and late results retain usable accounting observations without reopening settled execution decisions.

Signature tests must exercise the Standard Webhooks concatenation, not just independent tampering. The signed string is `webhook-id + "." + webhook-timestamp + "." + raw-body` under HMAC with the shared secret. Cover:
- **Baseline valid:** all three fields intact, signature matches.
- **Body tampered:** change one byte of raw body; signature fails; inbox untouched.
- **Timestamp tampered:** valid signature for a different timestamp; fails.
- **`webhook-id` tampered:** body and timestamp unchanged, `webhook-id` changed, signature fails. This is the case that catches missing concatenation of the ID.
- **Timestamp outside tolerance:** valid signature for a timestamp older than 300 seconds; fails.
- **Raw-byte fidelity:** a body that is byte-identical but whose JSON serialization differs (whitespace, key order) verifies only if the exact raw bytes are hashed.

Delivery-race and ordering tests:
- **Duplicate delivery:** inject `response.completed` twice for the same response ID; assert the turn is accepted exactly once and usage is recorded once.
- **Out-of-order terminal events:** inject `response.failed` then a delayed `response.completed` for the same response ID; assert the settled execution decision is not reopened and accounting observations for both are retained.
- **Pre-mapping race:** inject an event before the response mapping exists; assert it stays in the inbox and resolves once the mapping is registered.
- **Late event for a superseded execution:** inject a terminal event for an attempt that was superseded; assert no state change and accounting retention.
Cover: `src/lib/signature.ts`, `src/handlers/webhook.ts`, `src/do/router-do.ts`, `src/db/router.ts`.

### Exports
**19. Streaming exports.** Exports stream pages and one artifact at a time, remain available in every job state, and capture the Markdown accepted-prefix boundary at export start. JSON exports include encoded file bytes only when those bytes occur in a retained inline judge request; exports do not fetch source files or attach separate copies. Credentials are never exported. Missing artifacts produce explicit markers. Cover: `src/handlers/jobs.ts`.

**20. Live JSON export semantics.** A live JSON export records its starting revision and table high-water keys; each emitted mutable record carries its observed revision or update time; records created beyond the captured high-water keys are excluded. It does not claim atomic-backup semantics. Drive this by capturing a revision, writing new records mid-stream, and asserting exclusion. Cover: `src/handlers/jobs.ts`, `src/db/jobs.ts`.

### Branching
**21. Branch invariants and superseding race.** Branch initialization consumes a complete Worker-supplied snapshot in one local transaction. Activation follows file protection and conditional superseding of the quiescent parent. Snapshots are bounded to **8,000,000 encoded bytes**; test the pure guard with mocked sizes and include one integration test at 8,000,000 / 8,000,001. Copied history preserves call provenance and remains inherited rather than new branch spend. Cover at minimum:
- Happy path: quiescent parent, protected files, snapshot < 8 MB → child activates.
- Snapshot over 8,000,000 → explicit error, no activation.
- **Superseding race:** create the child snapshot while the parent is quiescent, then, before child activation, advance the parent’s execution epoch (simulate a resume/retry on the parent). Assert child activation aborts safely, does not partially claim the parent, and cleans up any child-created files or references. The parent remains the active job.
- **File-protection race:** attempt child activation before parent file protection completes; assert activation is refused rather than racing retention.
Cover: `src/handlers/jobs.ts`, `src/do/job-do.ts`, `src/db/jobs.ts`.

### Accounting
**22. Usage and pricing.** Usage is recorded once per call and includes discarded, partial, failed, and cancelled work when known. A completed turn freezes the provider response's `usage.input_tokens` into `turns.marginal_input_tokens` at acceptance; branch initialization copies the frozen value and never recomputes it, and the detail fragment renders it. Missing usage and unknown pricing remain explicit rather than estimated. Pricing uses per-request rate cards and does not infer cache-write premiums from TTL. Cover: `src/lib/tokens.ts`, `src/db/attempts.ts`.

### Lists and pagination
**23. List contract.** Lists use primary-key cursors, omit BLOBs, and clamp page limits to 1–100. Cover: `src/handlers/jobs.ts`, `src/handlers/files.ts`.

### Durable Object invariants
**24. Alarm, transaction, and side-effect invariants.** Each Durable Object uses one alarm scheduled against its earliest obligation or deadline; assert by inspecting the scheduled alarm time via `runInDurableObject` after state changes. `waitUntil` accelerates persisted work but never supplies its only execution guarantee. Cover at minimum:
- **Transaction atomicity (synchronous only):** throw a synchronous error inside `state.storage.transactionSync()` and assert all statements in the block roll back. Do not attempt to `await` inside the transaction.
- **Transaction purity (structural):** code review obligation plus a lint rule (`no-restricted-syntax` on `AwaitExpression`, `CallExpression` matching `fetch`/`setTimeout`/`setInterval`, and `ImportExpression` inside `state.storage.transaction*` callbacks).
- **Prepare–perform–reconcile:** external side effects and execution-authorizing calls go through durable prepare–perform–reconcile; assert a durable record exists before the side effect and that the reconcile step resolves ambiguous outcomes on replay.
- **Command acknowledgement:** acknowledgements follow durable state or work obligations, not uncommitted background promises. Assert by killing the background promise (stubbed to reject) and confirming the acknowledgement still reflects persisted state.
- **Fencing:** revision, execution epoch, and work-claim sequence serve distinct ordering and fencing purposes. Assert that a stale-epoch write is rejected and that a superseding operation bumps the epoch.
Cover: `src/do/*.ts`, `src/db/*.ts`, `src/lib/alarm.ts`.

## Manual verification
These checks exercise real Cloudflare and OpenAI infrastructure and cannot be fully automated. Run them once per deployment change and after any `wrangler.toml` edit.

### Deployment and routing
- [ ] A first deploy with `HOOKS_HOST`, `OPENAI_WEBHOOK_SECRET`, or `OPENAI_API_KEY` missing fails before uploading code and names every missing required secret.
- [ ] `npx wrangler secret put HOOKS_HOST` (creating the stub Worker when prompted) followed by `wrangler deploy` succeeds, and a `wrangler deploy --secrets-file <gitignored-file>` path also succeeds.
- [ ] `workers.dev` and preview URLs are unreachable for the application hostname.
- [ ] `app.example.com` is reachable only through Cloudflare Access; unauthenticated requests are redirected to the Access login.
- [ ] `hooks.example.com` is reachable without Access; other paths on that hostname return 404.
- [ ] State-changing browser requests from a foreign origin are rejected.

### Frontend (manual only)
No browser-based E2E tests are defined; `public/app.js` is verified by hand.
- [ ] `public/index.html` loads and `/app.css` and `/app.js` return `200` from the application host.
- [ ] Submitting the Create Job form uploads developer/turn files, posts a valid `CreateJobCommand` (developer context, dynamic turns, judge panel), and the job appears in `#job-list` after the next fragment poll.
- [ ] Count Tokens uploads developer/turn files and shows one projected input-count line (plus admission) for the developer context and every turn; requests are issued in parallel.
- [ ] The list refreshes every 12 seconds by replacing `#job-list` with the `/api/jobs/fragment` HTML.
- [ ] Clicking a job card loads `/api/jobs/:id/fragment` into the dialog and rendered Markdown is visible.
- [ ] A job title containing `<img onerror=...>` renders as text, and model output containing raw HTML renders escaped, not executable.
- [ ] The `public/app.js` source stays dependency-free and under 500 lines (lightweight vanilla module; no build step).

### OpenAI webhook registration
- [ ] OpenAI dashboard → Webhooks lists `https://hooks.example.com/openai` with the four subscriptions.
- [ ] A test event from the OpenAI dashboard is acknowledged by RouterDO (inbox record created).
- [ ] A request with a deliberately corrupted signature returns `401`/`403` and does not enqueue an inbox record.
- [ ] A request whose delivery timestamp is outside the 300-second tolerance is rejected.
- [ ] A request with a tampered `webhook-id` (body and timestamp valid) is rejected.

### Files and retention
- [ ] A source upload at the 16,000,000-byte bound succeeds; at 16,000,001 bytes it fails with an explicit error.
- [ ] An artifact that would exceed the 1,500,000-byte guard produces an explicit error, not truncated output.
- [ ] After `FILE_RETENTION_SECONDS` elapses on an unreferenced file, RegistryDO deletes it.

### Generation
- [ ] A real Flex job reaches completion with `service_tier: "flex"` and never falls back to standard.
- [ ] A deliberately induced `empty_output` (marker-only) starts a fresh run when budget remains, and fails otherwise without invoking the judge.
- [ ] A Flex capacity outage drives persisted backoff and, if sustained, pauses for manual recovery.

### Judge
- [ ] A declared OpenAI stateful passthrough judge accepts a candidate without warning when capabilities align.
- [ ] A declared Chat Completions stateful judge produces an advisory warning (not a substitution).
- [ ] A judge infrastructure failure accepts with a warning; the original judge result is preserved.
- [ ] A judge rejection with "Inject Critique on Failure" retries with the critique visible in the retry prompt; disabling it retries without the critique and the budget still bounds retries.
- [ ] A passing judge with "Steer Next Turn on Pass" appends the PM steering note to the next turn prompt; disabling it leaves the next prompt unchanged.
- [ ] Minimum Acceptable Grade uses A/B/C/D/F thresholds and the judge's letter grade is normalized for the decision.
- [ ] Base URL selects the judge API root; an OpenRouter URL sends the OpenRouter root.
- [ ] A judge that reports `file_visibility: false` on an otherwise passing result accepts with a coverage warning.
- [ ] A judge-only tag disagreement pauses the candidate for review; parser-confirmed `wrong_index` handles separately.
- [ ] A stateful judge whose first call failed before response-ID commit re-attaches the file on the retry.

### Webhook delivery races
- [ ] A webhook arriving before the response mapping is written remains in the inbox and resolves once the mapping is registered.
- [ ] Duplicate webhook delivery retains accounting but does not reopen a settled execution decision.

### Branching
- [ ] A snapshot above 8,000,000 encoded bytes is rejected with an explicit error.
- [ ] A branch on a quiescent parent activates after file protection and conditional superseding.
- [ ] A branch whose parent resumes during snapshot initialization aborts safely and cleans up its files.
- [ ] Copied history shows inherited provenance, not new branch spend.

### Operator recovery and diagnostics
- [ ] A failed job detail shows its persisted error code and message, **Resume Job**, and **Retry Turn** on the current turn.
- [ ] **Resume Job** on a failed, `paused_dispatch`, or `paused_storage` job starts a new manual attempt and does not reset automatic recovery counters.
- [ ] **Retry Turn** rejects a turn index other than the current one with HTTP 409 `turn_not_current`; a non-recoverable status returns 409 `job_not_recoverable`.
- [ ] Creating a job with an external `previous_response_id` shows that ID as the initial anchor, records the `external_previous_response_id:<id>` warning, and replaces it after turn 1 is accepted.
- [ ] Accepted and latest-attempt provider response IDs are visible in the job detail and in each turn row.
- [ ] **Count Tokens** succeeds for each pending turn; with an invalid provider credential it shows a sanitized provider status/code and the **Health Check** probes report the failure without exposing the secret.
- [ ] A job-scoped **Health Check** reports main and judge latency, OpenAI status, model-list count, and model presence.
- [ ] JSONL export of a failed or incomplete job is parseable line-by-line, includes job/turn/attempt/judge-call summaries, and contains no request BLOBs or credentials.
- [ ] **Inspect JSONL** reports per-type record counts and flags an `export_incomplete` marker.

### Exports
- [ ] A completed job shows **Download Final Markdown**; the `.md` attachment concatenates accepted deliverables with `<!-- TURN_END:n -->` markers stripped.
- [ ] A Markdown export captures the accepted-prefix boundary at export start; later acceptances do not appear.
- [ ] A JSON export of a job with a retained inline judge request includes the encoded file bytes; a job with passthrough files does not.
- [ ] A live JSON export reports starting revision and high-water keys; a record created after export start is excluded.
- [ ] No export contains credential values.

## Fixtures and helpers
- `fixtures/requests.ts` — canonical generation request builders using the shared continuity helper; assert against stored bytes, not reconstructed objects.
- `fixtures/jobs.ts` — deterministic job states (ready, running, awaiting judge, paused, failed, cancelled, branched).
- `fixtures/files.ts` — byte buffers at guard boundaries **only where an integration test needs real bytes**. All guard arithmetic tests belong in `guards.test.ts` and take mocked sizes. Allocate real buffers with `new Uint8Array(N)` and only once per test file; do not build them with string concatenation.
- `fixtures/judge.ts` — declared judge configurations covering every provider/transport/history/file-delivery combination in `README.md`, plus intentionally inconsistent declarations, including an unencodable contract that must fail request generation rather than send a stripped request.
- `fixtures/webhooks.ts` — Standard Webhooks signing helper: given `webhook-id`, `webhook-timestamp`, and raw body bytes, produce the signature under a test secret. Used by all webhook tests so concatenation is exercised consistently.

Helpers must intercept outbound `fetch` at the `ProviderIO` seam so canonical-request bytes and header resolution are still asserted.

## Coverage expectations
- Every numbered item above has at least one direct test.
- `src/lib/continuity.ts` has 100% branch coverage; it owns the stateful/stateless serialization contract and is shared by generation and judge.
- `src/db/schema.ts` guard arithmetic has 100% branch coverage; pure guard functions are exhaustively unit-tested with mocked sizes. Schema DDL validation and migration idempotency are covered by `test/db/schema.test.ts` and `test/db/migrations.test.ts`.
- `src/lib/tag.ts` normalization, marker-removal, and structural classification paths have 100% branch coverage; `empty_output`, `trailing_content`, and precedence over refusal/cancellation are the highest-risk branches.
- `src/lib/signature.ts` byte-exactness, field concatenation (ID + timestamp + body), and timestamp-tolerance paths are covered by both positive and negative tests, including a `webhook-id`-only tamper case.
- `src/db/router.ts` inbox idempotency and out-of-order handling have explicit duplicate and reordered-event tests.
- `src/lib/dispatch.ts` long-context classification has explicit tests at 271,999 / 272,000 / 272,001 with cached input included. Idempotency-Key **presence** and stability across retries are explicitly asserted; the test does not assert a string format the architecture does not define.
- `src/lib/markdown.ts` has explicit tests for raw-HTML neutralization, unsafe link/image protocols, and the 250,000/250,001 character boundary; `src/handlers/jobs.ts` fragment routes assert HTML content type, no-store caching, `404` for missing jobs, and escaping of hostile job metadata.
- `src/lib/judge.ts` stateful history has explicit tests for both commit-before-success and failure-before-response-ID-commit attachment behavior.
- `src/do/job-do.ts` branch activation has an explicit superseding-race test.
- `src/handlers/health.ts` probes parse only the OpenAI status indicator/description and model IDs; error text is redacted, and tests cover 400/404/405/502 plus main-only and job-scoped judge probes. `test/integration/operator-api.test.ts` mocks status and model endpoints and asserts no real provider call.
- Provider error text is bounded and redacted before persistence/export. Tests assert exact secret values, Bearer, `sk-`, JWT, query-key, and `x-api-key` forms disappear on dispatch/retrieval/model errors; provider error codes over 64 characters normalize to null.
- `/api/health` rejects cross-site browser probes, path-unsafe `jobId` values, and does not disclose missing secret binding names. Lookalike `api.openai.com.*` hosts do not inherit OpenAI status.
- Job fragments assert escaped error banners, Resume/Retry/JSONL controls, external initial-response anchors, and active response anchors.
- Token-preview integration asserts the count request omits generation-only fields (`background`, `service_tier`, `max_output_tokens`, `prompt_cache_retention`, `prompt_cache_options`) and projects the mocked provider input tokens.
- JSONL export tests parse every line from a failed job, require job/turn/attempt records, and assert provider diagnostics without request BLOBs or credentials.
- Test files use `reset()` and `abortAllDurableObjects()` in `afterEach` and settle all scheduled alarms before finishing; no test relies on fresh Durable Object IDs as its primary isolation mechanism.
- `waitUntil` promises are settled with `waitOnExecutionContext` or an equivalent explicit await; no test finishes with outstanding background work.
- Manual verification is required for any deployment-level change; CI cannot substitute for it.
