## Job routes handler — `src/handlers/jobs.ts`

### Purpose and owned state

Implement `ApplicationRoutes` for jobs: commands, reads, branching, and exports. This module owns no durable state; it parses and validates HTTP input, calls `JobDO` and `RegistryDO` through binding RPC, and serializes responses. ARCHITECTURE §16 maps it as "job commands, reads, branching, and exports".

Routing contract (`src/index.ts`): "host === env.HOOKS_HOST -> only POST /openai, everything else 404; other hosts -> /api/* handlers, else env.ASSETS.fetch." This handler runs only on the application host behind Cloudflare Access.

### Public surface

HTTP routes. Do not add any other HTTP route or public method; private helpers are allowed.

```ts
- POST /api/jobs body CreateJobCommand -> 201 JobStateResponse
- GET /api/jobs?limit&cursor -> CursorPage<JobSummaryItem>
- GET /api/jobs/:jobId -> JobStateResponse
- POST /api/jobs/:jobId/turns body AppendTurnCommand -> JobStateResponse
- POST /api/jobs/:jobId/review body OperatorReviewDecision -> JobStateResponse
- POST /api/jobs/:jobId/branch body { forkTurnIndex: number } -> BranchCreationOutcome
- GET /api/jobs/:jobId/turns?limit&cursor -> CursorPage<TurnSummaryRow>
- GET /api/jobs/:jobId/attempts?turnIndex&limit&cursor -> CursorPage<GenerationAttemptSummaryRow>
- GET /api/jobs/:jobId/judge-calls?turnIndex&limit&cursor -> CursorPage<JudgeCallSummaryRow>
- GET /api/jobs/:jobId/export?format=markdown|json -> streaming Response
```

Implementations MUST NOT invent interfaces: build responses from `src/types.ts`, use `src/http.ts` helpers (`jsonResponse`, `errorResponse`, `toErrorResponse`, `readJson`, `streamResponse`, `clampPageLimit`, `payloadTooLarge`, `notFound`, `conflict`, `unprocessableEntity`, `methodNotAllowed`), and call the exact `JobDO` / `RegistryDO` RPC methods above.

### Invariants

**Require an application Origin for state-changing requests.** TESTING §2: "State-changing browser requests without the application `Origin` are rejected." Reject a missing or foreign `Origin` on all `POST` routes before parsing the body or forwarding to a Durable Object; a request that arrives through `env.HOOKS_HOST` never reaches this handler. Do not accept an origin equal to the webhook host.

**Bound every JSON read.** Parse with `readJson` and `requireJsonContentType: true`. Default bound is `DEFAULT_MAX_JSON_BODY_BYTES` (262,144); branch commands that relay snapshot material use `MAX_BRANCH_SNAPSHOT_BYTES` (8,000,000). Reject larger bodies with `payloadTooLarge` and non-JSON bodies with `unsupportedMediaType`; never call `request.json()` directly (docs/HTTPHELPERS.md trap 4.1).

**Create jobs through JobDO and publish to the registry.** Forward `CreateJobCommand` to `JOB_DO.createJob`, then call `REGISTRY_DO.registerJob` with the returned `JobSummaryItem` (idempotent per `jobId`). Job status is `JobDO`'s decision; never set `ready` in the handler. README §Files and Limits: "Non-terminal file references are protected before a job becomes ready." The ready transition must not be observable through create's response, polling, or export until `REGISTRY_DO.protectJobFileRefs` completes for every attachment ID. A duplicate `jobId` is a `409` conflict, never an overwrite.

**Forward commands; never execute locally.** `appendTurn`, `applyOperatorDecision`, and all reads are RPC calls. Do not write storage, start attempts, or evaluate candidates in the handler. Preserve the RPC result (`JobStateResponse`) without reshaping state.

**Lists use cursor pages and BLOB-free projections.** Forward `limit` and `cursor` unchanged; clamp `limit` to 1–100 with `clampPageLimit`. README §Files and Limits: "Lists use primary-key cursors, omit BLOBs, and clamp page limits to 1–100." Return `CursorPage` items as received; never accumulate multiple pages into one response.

**Branching follows protection before activation.** Call `JOB_DO.captureBranchSnapshot(forkTurnIndex)`; on success call `REGISTRY_DO.protectJobFileRefs(branchJobId, snapshot.referencedFileIds)` for the child, then `JOB_DO.initializeBranch(snapshot)`. README §Monitoring: "Branch activation follows file protection and conditional superseding of the quiescent parent." Return the `BranchCreationOutcome` (or the clean rejected union) verbatim; map refusal reasons to a sanitized `409`/`422` without inventing different reason codes.

**Exports stream pages and one artifact at a time.** README §Monitoring: "Exports remain available in every job state and stream pages and one artifact at a time." Use `streamResponse` with a `ReadableStream` that pages `listTurns` / `listAttempts` / `listJudgeCalls` and calls `readArtifact` per artifact; never materialize the job and never hold a SQL cursor across a network wait (ARCHITECTURE §12). Do not reject an export because the job is failed, cancelled, or superseded.

**Markdown exports capture the boundary at start.** "Markdown captures the accepted-prefix boundary when export begins" (ARCHITECTURE §12). Read the accepted anchor once at request start and pass it as `maxTurnIndex`; later acceptances never appear. Emit accepted deliverables only, with the included turn range and status (README §Monitoring).

**JSON exports pin high-water marks.** Call `captureExportHighWaterMarks` at start, emit `startingRevision`, `maxTurnIndex`, `maxAttemptId`, `maxJudgeCallId`, and exclude records created beyond those keys. ARCHITECTURE §12: "A live JSON export is a versioned observation, not an atomic database backup." Each mutable record carries its observed revision or update time. Include encoded file bytes only when they occur inside a retained inline judge request; never fetch source files or attach a separate copy (README §Monitoring). Emit `MissingArtifactMarker` records for absent artifacts; a missing artifact never silently disappears from the export.

**Never export or echo credentials.** README §Monitoring: "Credentials are never exported." Stored request bodies already omit authorization headers; the handler must not add headers, secrets, environment values, or provider auth details to any export or error body.

**Validate identifiers and query parameters before RPC.** Require a non-empty `jobId`; decode the path segment exactly once and never treat it as a filesystem path. Accept `format` only as `markdown` or `json`; parse `limit` with `clampPageLimit` and `turnIndex` as a positive integer; reject unknown query values with a sanitized `400`. Do not pass unvalidated strings into allowlists or SQL-shaped parameters.

**Missing jobs are 404.** `JobDO.getState()` returns `null` for an unknown job; `GET /api/jobs/:jobId` and both exports return `404 not_found` without creating state. **Pass state responses through unchanged.** Return `JobStateResponse` exactly as `JobDO` produced it, including `pollIntervalMs` (the browser polls every 12 seconds while work is active, README §Monitoring). Never substitute a client-supplied poll interval, recompute usage, or filter turns inside the handler.

**Export format is explicit.** `format` is mandatory (`markdown` or `json`); do not guess a default. A markdown export never includes rejected or unaccepted turns, and a JSON export always reports the high-water marks even when the job has no attempts or judge calls (`null` keys).

**Sanitize errors.** Use `toErrorResponse` / `errorResponse` with stable codes; never return stack traces, raw provider messages containing secrets, or internal SQL errors. Unknown `jobId` is `404 not_found`; invalid `format` or `forkTurnIndex` is a `400`/`422` with a sanitized message. Answer unsupported methods with `methodNotAllowed`.

### Platform traps

- An incoming `Request` body is a single-consumption `ReadableStream`: once `text()`, `json()`, or `arrayBuffer()` reads it, `bodyUsed` is true and a second read fails; call `request.clone()` before the first read when verification and parsing both need the bytes.
- A `fetch()` body supplied as a `ReadableStream` cannot be replayed by automatic retries; bodies such as string, `ArrayBuffer`, `Blob`, `FormData`, and `URLSearchParams` can be sent again.
- RPC arguments and return values cross a serialization boundary and must be structured-cloneable data; streams, stubs, functions, and `RpcTarget` arguments are not retryable, and sending a `Request`/returning a `Response` requires the stub's `fetch()` handler instead.
- Always `await` stub calls: unawaited calls are dangling promises that swallow errors and lose return values, and a stub that throws fails all in-flight and future calls until it is recreated.
- A stub delivers calls in E-order (calls arrive in the order made), but there are no ordering guarantees between different stubs; recreate a stub after any exception rather than reusing the poisoned one.
- Runtime retries make up to 5 attempts total and start no retry more than 10 seconds after the first call; errors thrown by Durable Object code, HTTP error responses, and `.overloaded` errors are not retried.
- Only a method marked with `retryable()` may run twice when the runtime cannot tell whether the first attempt arrived; an unmarked method rejects the replay and the caller receives the original error.
- CPU per invocation defaults to 30 seconds; incoming HTTP requests have no hard wall-time limit while the client stays connected, while `waitUntil()` extends execution only up to 30 seconds after the response or disconnect.
- Each isolate has a 128 MB memory limit, and JSON serialization/deserialization of large payloads reduces achievable throughput; named-object first access can take up to a few hundred milliseconds before location caching.
Source: https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/ ; https://developers.cloudflare.com/durable-objects/api/stub/ ; https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/ ; https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type

### Integration points

- `env.JOB_DO`: `createJob`, `getState`, `appendTurn`, `applyOperatorDecision`, `captureBranchSnapshot`, `initializeBranch`, `listTurns`, `listAttempts`, `listJudgeCalls`, `captureExportHighWaterMarks`, `readArtifact`.
- `env.REGISTRY_DO`: `registerJob`, `updateJobIndexStatus`, `listJobs`, `protectJobFileRefs`, `releaseJobFileRefs`.
- `src/http.ts` bounded readers and response helpers; `src/types.ts` wire types; `src/db/schema.ts` summary row types.
- `GET /api/jobs` reads the index through the amended `REGISTRY_DO.listJobs`.

### Anti-patterns

- Do not bypass the Origin check, or trust `Referer` in its place.
- Do not call `request.json()` or buffer an unbounded body.
- Do not write job or catalogue state directly from the handler.
- Do not ack a created job before registry publication and file-reference protection complete.
- Do not capture a branch snapshot, initialize a branch, or protect files in a different order.
- Do not buffer full exports, hold cursors across RPC waits, or include records beyond the captured high-water marks.
- Do not export credentials, authorization headers, or raw provider envelopes.
- Do not add routes, RPC methods, or schema-shaped responses outside the shared contract.
- Do not cache job state in the handler, recompute usage, or override the DO's `pollIntervalMs`.
- Do not accept an unvalidated `format`, `limit`, `cursor`, or `turnIndex`, or decode a path segment twice.
- Do not answer a command with a cached or synthesized `JobStateResponse`.
### Export

```ts
export function handleJobsRequest(request: Request, env: Env): Promise<Response>
```

Matches `/api/jobs` and `/api/jobs/:jobId/...`; unknown subpaths return `404 not_found`. The list route reads `REGISTRY_DO.listJobs`.
