## Webhook handler — `src/handlers/webhook.ts`

### Purpose and owned state

Implement the authenticated OpenAI webhook ingress. ARCHITECTURE §16 maps it as "authenticated webhook ingress" under `WebhookRoute → HTTP, Signature, Contracts`. The handler owns no storage: it authenticates the exact raw bytes with `src/lib/signature.ts`, converts them into a `VerifiedWebhookEvent`, and enqueues that event into `RouterDO`. It never calls `JobDO`, never mutates job state, and never acknowledges before the inbox is durable.

### Public surface

HTTP route. Do not add any other HTTP route or public method; private helpers are allowed.

```ts
- POST /openai (hooks host only) -> WebhookIngressReceipt, after durable inbox acceptance
```

Routing contract (`src/index.ts`): "host === env.HOOKS_HOST -> only POST /openai, everything else 404; other hosts -> /api/* handlers, else env.ASSETS.fetch." Use `WEBHOOK_OPENAI_PATH` from `src/constants.ts`.

Implementations MUST NOT invent interfaces: call `verifyWebhookRequest` from `src/lib/signature.ts`, `resolveEnvSecret` for `OPENAI_WEBHOOK_SECRET` only if the typed binding is not used directly, and `enqueueWebhook` on the `ROUTER_DO` binding with `VerifiedWebhookEvent` / `WebhookIngressReceipt` from `src/types.ts`. Do not reimplement HMAC, timestamp checks, or base64 comparison.

### Invariants

**Serve only on the webhook host.** README §Infrastructure: "Do **not** put `hooks.example.com` behind Access. OpenAI must reach it directly." On `env.HOOKS_HOST`, expose only `POST /openai`; every other path returns `404` and every other method returns `405`. On every other host, the webhook route is unreachable. Never compare hostnames against hardcoded domain literals.

**Authenticate the exact raw bytes.** TESTING §18: "Signature verification operates on exact raw bytes with a 300-second delivery-timestamp tolerance." Call `verifyWebhookRequest(request, env.OPENAI_WEBHOOK_SECRET, { maxBodyBytes: DEFAULT_MAX_WEBHOOK_BYTES })`; it reads the bounded raw body, enforces the tolerance, and verifies HMAC over `${webhook-id}.${webhook-timestamp}.${raw-body}`. Never parse JSON first, never re-serialize the body, never hash a string built from parsed fields (docs/SIGNATUREAUTH.md trap 5.3).

**Reject before enqueueing.** A missing/invalid header, a tampered body, a tampered `webhook-id`, or a timestamp outside 300 seconds returns `401` (or `403`) with `{ kind: "rejected" }`, and **no** `enqueueWebhook` call. TESTING manual: "A request with a deliberately corrupted signature returns `401`/`403` and does not enqueue an inbox record." An oversized body returns `413`; malformed JSON or an unknown event type after successful verification returns `400`; none of these may write to the inbox.

**Map only the subscribed events.** Accept exactly `OPENAI_WEBHOOK_EVENT_TYPES` (`response.completed`, `response.cancelled`, `response.failed`, `response.incomplete`, from `src/constants.ts`) and a non-empty `response_id` from the verified payload. Any other `type`, missing `id`, or missing `data.id` is a `400` rejection with no inbox write.

**Preserve raw bytes into the inbox.** Build `VerifiedWebhookEvent` with `webhookId` and `timestampSeconds` from the verified headers, `eventType`, `responseId`, `rawPayload` as the exact verified bytes (`ArrayBuffer`), and `receivedAtMs` from the handler clock. Never rebuild the payload from a parsed object; the stored bytes must equal what was signed and what was sent.

**Acknowledge only after durable acceptance.** README §Infrastructure step 4: "Acknowledgement follows durable inbox acceptance." `await` the `ROUTER_DO.enqueueWebhook(event)` RPC and return 2xx only after it resolves with a receipt. Never acknowledge from `ctx.waitUntil`, a background promise, or an in-memory queue; a failed RPC returns a sanitized `5xx` and the client retries.

**Duplicates are idempotent.** When the receipt indicates `duplicate: true`, return 2xx with the accepted receipt; do not treat it as an error, do not create a second inbox row, and do not reopen settled execution decisions. An unmatched event (`matchedJobId: null`) is still accepted and retained for registration reconciliation (README §Troubleshooting).

**Return only the receipt union.** Respond with `WebhookIngressReceipt` as JSON: `{ kind: "accepted", webhookId, duplicate, matchedJobId }` on success, or `{ kind: "rejected", statusCode: 400 | 401 | 403 | 413, message }` on failure. Never add fields, echo the raw body, or return the signature header.

**Use one injectable clock for the tolerance check.** Derive `receivedAtMs` and the verification window from `src/lib/clock.ts` (`now()`), so tests and production agree. Reject timestamps outside the 300-second window in either direction; do not extend the tolerance, ignore the timestamp, or accept a missing `webhook-timestamp`.

**Do not require Cloudflare Access.** README §Infrastructure: the webhook host must be reachable without an Access JWT. Authenticate solely with the Standard Webhooks signature; never require, parse, or trust an Access header here, and never put the hooks host behind the Access policy.

**Handle chunked bodies.** Do not require `Content-Length`; `readBoundedRawBody` streams up to `DEFAULT_MAX_WEBHOOK_BYTES` and fails with `413` on overflow. Never fall back to an unbounded `request.json()` or `request.text()` when the header is absent.

**One verification and one enqueue per delivery.** The handler performs no internal retry, sleep, or queueing; OpenAI retries deliveries. A failed `enqueueWebhook` returns a sanitized `5xx` so the sender retries with the same `webhook-id`, which the inbox deduplicates.

**Preserve the duplicate and match observation.** Return the receipt's `duplicate` and `matchedJobId` unchanged; a duplicate is still `accepted`, and an unmatched event is still accepted with `matchedJobId: null` for later reconciliation (README §Troubleshooting).

**Parse once, after verification, for metadata only.** After `verifyWebhookRequest` succeeds, parse `rawText` exactly once to extract `type` and `data.id`; on parse failure return `400` without an inbox write. The parsed object supplies metadata only; `rawPayload` remains the exact verified bytes and is never rebuilt from it.

**Redact credentials and payloads.** Never log or return the signing secret, signature header values, authorization material, or raw body content. Errors use stable codes (`invalid_signature`, `invalid_timestamp`, `payload_too_large`, `invalid_event`) with sanitized messages; `toErrorResponse` must not surface a stack trace or header contents.

**Use only the bounded reader.** `verifyWebhookRequest` performs the bounded body read (`DEFAULT_MAX_WEBHOOK_BYTES`, the 1,500,000-byte artifact guard). Do not call `request.text()` or `request.formData()` separately, and do not read the body twice (docs/HTTPHELPERS.md trap 4.1).

### Platform traps

- Buffer the raw webhook body with `arrayBuffer()` before verification/forwarding; the request body stream can be consumed once, and a `ReadableStream` payload cannot be replayed by automatic retries.
- Pass cloned bytes (`Uint8Array`/`ArrayBuffer`), not a stream, into the `RouterDO` RPC; RPC arguments containing streams, stubs, functions, or `RpcTarget` are not retryable.
- `await` every RouterDO RPC: unawaited calls lose errors and results, and a stub that throws is poisoned for all in-flight and future calls until recreated.
- Runtime retries may deliver the same webhook call up to 5 attempts within 10 seconds; an unmarked enqueue method rejects replay after an ambiguous drop, while `retryable()` permits a second execution.
- E-order applies only within one stub; webhook events delivered through different stubs or after stub recreation have no ordering guarantee.
- `waitUntil()` keeps work alive only 30 seconds after the response/disconnect; `RouterDO` `alarm()` handlers have a 15-minute wall-time limit with at most 6 retries at 2-second exponential backoff.
- CPU per invocation defaults to 30 seconds, incoming HTTP wall time is unlimited while the client stays connected, and each isolate is limited to 128 MB memory.
- A single global RouterDO is single-threaded with a soft limit near 1,000 requests/second; excess requests are queued and then rejected as `.overloaded`, which the runtime does not retry.
- A Durable Object alarm is single-valued: `setAlarm()` overwrites any pending alarm, alarms do not repeat, and `getAlarm()` returns `null` while `alarm()` runs unless a new alarm is set.
Source: https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/ ; https://developers.cloudflare.com/durable-objects/api/alarms/ ; https://developers.cloudflare.com/durable-objects/api/stub/ ; https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type

### Integration points

- `src/index.ts` hostname dispatch: `env.HOOKS_HOST` + `POST /openai` → this handler; all other hooks-host paths `404`.
- `src/lib/signature.ts`: `verifyWebhookRequest`, `verifyWebhookSignature`, `readBoundedRawBody`, `DEFAULT_MAX_WEBHOOK_BYTES`, `WEBHOOK_TOLERANCE_SECONDS`.
- `env.ROUTER_DO` (via `ROUTER_DO_NAME`): `enqueueWebhook`.
- `src/constants.ts`: `WEBHOOK_OPENAI_PATH`, `OPENAI_WEBHOOK_EVENT_TYPES`; `src/types.ts`: `VerifiedWebhookEvent`, `WebhookIngressReceipt`; `src/http.ts`: `jsonResponse`, `unauthorized`, `forbidden`, `payloadTooLarge`, `methodNotAllowed`, `toErrorResponse`.

### Anti-patterns

- Do not expose any path other than `POST /openai` on the webhook host, and do not serve it on the application host.
- Do not parse or reserialize the body before verification, or verify a reconstructed JSON string.
- Do not widen the 300-second tolerance, skip the `webhook-id` concatenation, or compare signatures with `===`.
- Do not enqueue on a failed verification, or ack before the inbox RPC resolves.
- Do not write the inbox from a background promise or from `waitUntil`.
- Do not insert a second row for a duplicate `webhook_id` or reject a duplicate as an error.
- Do not call `JobDO` directly, mutate job state, or deliver webhooks from this handler.
- Do not log or echo the signing secret, signature headers, or raw payload.
- Do not add fields beyond `WebhookIngressReceipt`, echo the body, or return HTTP 200 for a rejected receipt.
- Do not require a `Content-Length` header, or fall back to an unbounded body read when it is absent.
- Do not require or validate a Cloudflare Access JWT on the hooks host.
- Do not retry, sleep, queue, or spam duplicates inside the handler; return the error and let OpenAI redeliver.
- Do not expose `GET`, `PUT`, or `DELETE /openai`, or any second hooks-host path.
- Do not verify a header-only signature or a body re-encoded from parsed JSON.
- Do not treat an unmatched `response_id` as a rejection; retain it and return the accepted receipt.
- Do not forward the raw body to `JobDO`; RouterDO owns inbox persistence and event construction.
### Export

```ts
export function handleWebhookRequest(request: Request, env: Env): Promise<Response>
```

Only `POST /openai`; any other path returns `404 not_found`.
