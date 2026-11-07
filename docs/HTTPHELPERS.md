## 4. HttpHelpers — `src/http.ts`

The architecture maps this to **HTTP — bounded JSON handling and HTTP response helpers**. This is where several of the sharpest Worker-specific traps live.

**Trap 4.1 — `request.json()` / `request.text()` buffer the entire body into the 128 MB isolate; there is no streaming JSON parser built in.**

> Use the Streams API to process JSON payloads that would exceed a Worker’s 128 MB memory limit if fully buffered.

> I just noticed that you’re calling `formData` on the request. This is causing you to read the object into RAM. Workers has a 128 MiB limit so what’s likely happening is that you’re exceeding that limit.

If `HttpHelpers` provides a `readJson<T>()` helper, it must be **bounded**: check `Content-Length` before reading, and reject bodies above the project’s max JSON size. The architecture’s §11 upload limit (16,000,000 bytes) is for multipart file uploads, not for the JSON request bodies handled by `http.ts`; the JSON helper should have its own much smaller cap. Do **not** call `request.json()` on a body that could be 100 MB — the 413 from the platform happens before your handler, but a body just under the zone limit will still blow the 128 MB isolate if you buffer it.

**Trap 4.2 — `request.signal` is not automatically connected to `fetch()` unless a compatibility flag is on.**

> Cloudflare support pointed at two compatibility flags that make the runtime pass the incoming request’s `AbortSignal` through to `fetch()`. — Enable `enable_request_signal` and `request_signal_passthrough`.

> To use this feature, you must set the `enable_request_signal` compatibility flag.

If `HttpHelpers` provides a `fetchWithAbort(request, url)` helper, it must either (a) forward `request.signal` only when the flag is enabled, or (b) document that it requires the flag. Otherwise a client disconnect will not cancel the upstream call, and the DO will keep burning duration.

**Trap 4.3 — `AbortSignal.timeout()` needs an active request context; do not call it at module top level.**

> `AbortSignal.timeout()` still requires an active request context because it needs to schedule a timer.

> `new AbortController()`, `AbortSignal.abort()`, `new WritableStream()`, and `request.signal` no longer throw when used during module evaluation … `AbortSignal.timeout()` still requires an active request context.

A helper that does `const controller = AbortSignal.timeout(5000)` at module scope will throw on Worker startup. Create the signal inside the request handler.

**Trap 4.4 — `AbortSignal` must be cleaned up after the operation it guards; aborting after completion raises an uncaught error in a DO.**

> Signal only a process that is still running. Aborting `signal` or calling `kill()` after the process exits raises an uncaught `internal error` in the Durable Object. Do not pass `AbortSignal.timeout()` or `request.signal` to `exec()` directly, because either can fire after the process exits. Pass the signal of an `AbortController` instead. Once `exitCode` resolves, stop anything that calls `abort()`.

The same pattern applies to any long-running helper: use a local `AbortController`, attach `request.signal` as a listener, and **remove the listener** when the operation completes. Do not hand `request.signal` or `AbortSignal.timeout()` directly to a helper that may outlive the operation.

**Trap 4.5 — Response bodies have no platform size limit, but `waitUntil()` adds a 30-second tail.**

> Response body size | No enforced limit

> `waitUntil()` extends execution for up to 30 seconds after the response or disconnect.【0†L—】(from the Workers limits table in the provided docs)

`HttpHelpers` can stream a large export response without a platform ceiling, but any `ctx.waitUntil()` used for post-response work (e.g. flushing analytics) gets only 30 s. If an export needs to continue after the response is sent, it must use an alarm or a DO RPC, not `waitUntil`.

**Trap 4.6 — Do not assume `request.cf` is populated in every environment.**

`request.cf` is a Cloudflare-specific property. It is present in production Workers but may be `undefined` or partial in `wrangler dev` / Miniflare. `HttpHelpers` should guard `request.cf?.colo` etc. rather than typing `cf` as always-present.
