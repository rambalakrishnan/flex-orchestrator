## Tokens handler — `src/handlers/tokens.ts`

### Purpose and owned state

Implement the pending marginal-token preview. ARCHITECTURE §16 maps it as "pending marginal-count previews" under `ApplicationRoutes`. The handler owns no durable state: it builds the pending canonical request, asks ProviderIO for the provider count, evaluates admission with `src/lib/tokens.ts`, and returns a projection. It must not create turns, attempts, work obligations, or job revisions.

### Public surface

HTTP route. Do not add any other HTTP route or public method; private helpers are allowed.

```ts
- POST /api/tokens/preview body MarginalTokenPreviewRequest -> MarginalTokenPreviewResponse
```

Implementations MUST NOT invent interfaces: use `MarginalTokenPreviewRequest` / `MarginalTokenPreviewResponse` / `TokenAdmissionOutcome` from `src/types.ts`, `buildCanonicalGenerationRequest` from `src/lib/dispatch.ts`, `countResponsesInputTokens` / `resolveEnvSecret` from `src/lib/openai.ts`, and `buildMarginalTokenPreview` / `evaluateTokenAdmission` from `src/lib/tokens.ts`. Do not re-derive model limits or admission rules in the handler.

### Invariants

**Count the pending call, not a guess.** The preview describes the next pending turn. Build its request with `buildCanonicalGenerationRequest` so the counted payload is the exact ARCHITECTURE §6 canonical object (`model`, `background: true`, `service_tier: "flex"`, continuity fields from `src/lib/continuity.ts`, reasoning effort, `max_output_tokens`, cache fields, optional web search, and `input`). Never construct a reduced ad-hoc payload or count only the prompt string.

**Resolve job context only from persisted state.** When `jobId` is present, read `JOB_DO.getState()` and take the declared `cache_ttl`, the continuity anchor, and the current turn/turn index from that state; do not guess them. When `jobId` is absent, use the request fields as given, no continuity anchor, and `"nocache"` (no retention is claimed); never invent a prior context. The canonical builder still requires stable identity fields: use a preview identity and `attemptKind: "initial"` that cannot collide with a real attempt.

**Call the provider count endpoint.** Call `countResponsesInputTokens({ apiKey: resolveEnvSecret(env, "OPENAI_API_KEY"), payload })` with the canonical request object. The provider count for the pending payload is the marginal count; do not add a second prior total on top of it. Never estimate tokens locally, never substitute a character heuristic, and never return a fabricated zero on provider failure.

**Apply admission.** Pass the count to `buildMarginalTokenPreview` (`model`, `marginalInputTokens`, prior total, `maxOutputTokens`); it computes `contextTier` and calls `evaluateTokenAdmission`. Return the `admission` union unchanged, including every rejection reason.

**Reject unknown models; never guess limits.** README §Using the UI: "Select a verified generation model. Unknown models receive no guessed limits or fallback profile." `evaluateTokenAdmission` returns `{ kind: "rejected", reason: "unknown_model" }`; propagate it with `maxAllowedInputTokens: null` and a sanitized message. Do not read limits from an unverified table or fall back to a default profile.

**Long-context boundary is strictly above 272,000.** README §System Limits: "Long-context classification | Full request input above 272,000 tokens, including cached input." TESTING §7 requires 271,999 and 272,000 to remain `standard` and 272,001 to be `long_context`; cached input counts toward the threshold. Do not round, subtract cache reads, or move the boundary.

**Derive response fields from the count.** `buildMarginalTokenPreview` computes `contextTier` and `projectedTotalInputTokens`; return those values unchanged. The `admission.contextTier` must agree with the projection. Never restate client-supplied model metadata or claim a tier from a different token count.

**Counts are per-request observations.** Do not cache the provider count across requests, persist it, or reuse it for a different prompt or model. The count is authoritative only for the canonical payload sent at call time.

**Scope aborts and timeouts.** Forward the incoming request signal only through the `src/http.ts` scoped-abort path (gated on the `enable_request_signal` compatibility flag), pass a bounded `timeoutMs` to `countResponsesInputTokens`, and remove listeners and timers in `finally` (docs/HTTPHELPERS.md traps 4.2–4.4). Never create `AbortSignal.timeout()` at module scope.

**A provider failure never yields a projection.** Timeouts, network errors, non-2xx responses, and unparseable count bodies return a sanitized error. Never answer `{ marginalInputTokens: 0 }` or an estimated value, and never fall back to a local tokenizer.

**Admission rejections are successful previews.** Return `200` with `MarginalTokenPreviewResponse` when the count succeeded but admission rejected (`unknown_model`, `context_window_exceeded`, `output_limit_exceeded`, `artifact_guard_exceeded`); the rejection belongs inside `admission`. Reserve `4xx` for malformed input and sanitized `5xx` for count failures.

**Preview identity cannot collide with a real attempt.** Use a preview-only `jobId`/turn/attempt identity when `jobId` is absent, and never persist or reuse the canonical builder's preview idempotency key. The key is not sent by the count endpoint and must not be recorded as an execution decision.

**Cache selection comes from the job, not the client.** `MarginalTokenPreviewRequest` carries no cache TTL; when `jobId` is present use the job's declared `cache_ttl`, otherwise use `"nocache"` and claim no retention. Never invent a TTL or count a retention field the request did not declare.

**Bound the request body.** Parse with `readJson` and `requireJsonContentType: true` at `DEFAULT_MAX_JSON_BODY_BYTES` (262,144). Reject larger bodies with `payloadTooLarge` and non-JSON bodies with `unsupportedMediaType` (docs/HTTPHELPERS.md trap 4.1). Validate that `model` is a non-empty string, `maxOutputTokens` a positive integer, `reasoningEffort` a declared level, `webSearch` a boolean, and `attachmentFileIds` an array of strings before any provider call.

**Read-only preview.** This route performs no durable write and no external generation dispatch. It never persists the prompt, the provider payload, or the count. Actual admission is enforced again when an attempt starts in `JobDO`; the preview is advisory. Reuse the shared state-changing Origin guard for commands; do not weaken it, and do not add a second origin policy for this endpoint.

**Credential hygiene.** Resolve `OPENAI_API_KEY` at call time with `resolveEnvSecret`; never cache, log, echo, or include it in errors. Do not log prompt text or attachment bytes.

**Sanitize failures.** Provider errors return a stable sanitized error through `toErrorResponse`; invalid input returns `400`/`422`. Never forward raw provider bodies or stack traces.

### Platform traps

- An incoming `Request` body is read once; take `request.clone()` before parsing if both raw bytes and decoded JSON are needed, because a consumed body cannot be read again.
- Outbound `fetch()` request bodies are limited to 100 MiB each and only 6 outbound connections may be open simultaneously per request.
- CPU per invocation defaults to 30 seconds; incoming HTTP requests have no hard wall-time limit while connected, and `waitUntil()` extends execution only 30 seconds past the response/disconnect.
- RPC payloads and results must be structured-cloneable; functions, `Promise`, `Symbol`, `WeakMap`/`WeakSet`, streams, and stubs do not cross the RPC boundary as data, so token-count payloads carry only structured-cloneable values.
- Stub calls are asynchronous and must be awaited; an exception poisons the stub for all in-flight and future calls until a new stub is created.
- Runtime retries allow up to 5 attempts with no retry starting after 10 seconds; retries do not count toward the subrequest limit, only the first attempt does.
- A token-count call can be replayed by a runtime retry even when it is only a preview; an unmarked method rejects replay after an ambiguous drop, `retryable()` permits a second run, and `.overloaded` errors are not retried.
- Errors that reach handler code may expose `.retryable` and `.overloaded`; exceptions tunnel from Durable Objects to the caller without a stack trace.
Source: https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/ ; https://developers.cloudflare.com/durable-objects/platform/limits/#outbound-http-request-body-size ; https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type ; https://developers.cloudflare.com/durable-objects/best-practices/error-handling/

### Integration points

- `env.JOB_DO`: `getState` for the job's declared cache TTL, continuity anchor, and turn context.
- `src/lib/dispatch.ts`: `buildCanonicalGenerationRequest` (canonical §6 object).
- `src/lib/openai.ts`: `resolveEnvSecret`, `countResponsesInputTokens`.
- `src/lib/tokens.ts`: `buildMarginalTokenPreview`, `evaluateTokenAdmission`, `computeContextTier`; `src/constants.ts`: `LONG_CONTEXT_INPUT_TOKENS_THRESHOLD`, `VERIFIED_GENERATION_MODELS`.
- `src/http.ts`: `readJson`, `withScopedAbort` signal forwarding, `jsonResponse`, `toErrorResponse`, `payloadTooLarge`, `unsupportedMediaType`, `unprocessableEntity`.
- `Env`: `OPENAI_API_KEY` resolved at call time; no storage module is imported and no Durable Object state is written.

### Anti-patterns

- Do not write attempts, turns, durable work, or job revisions from the preview.
- Do not dispatch a Responses request or invoke the judge to obtain a count.
- Do not count a partial payload, a prompt-only string, or a locally estimated token figure.
- Do not invent model limits or silently accept an unknown model.
- Do not treat cached input as excluded from long-context classification.
- Do not return a 0 or estimated count when the provider call fails.
- Do not persist or log the prompt, attachment bytes, or API key.
- Do not cache or persist a provider count, or reuse it for a different payload.
- Do not derive `contextTier` from anything other than the counted projection.
- Do not create module-scope abort timers or leave listeners attached after the call.
- Do not invent a cache TTL or count a retention field the request did not declare.
- Do not turn a successful admission rejection into an HTTP error response.
- Do not preview an unverified model; report `unknown_model` through `admission` instead.
- Do not send a probe Responses request, judge call, or generation dispatch to learn model limits.
### Export

```ts
export function handleTokensRequest(request: Request, env: Env): Promise<Response>
```

Only `POST /api/tokens/preview`; any other path returns `404 not_found`.
