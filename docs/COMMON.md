## Cross-cutting traps (apply to more than one module)

**Cross 1 — Do not cache secrets or `CryptoKey`s in module-level variables in a Durable Object.**

DOs evict; in-memory state is lost. A module-level `let secretKey: CryptoKey` will be `undefined` after eviction, and the first request after wake will fail. Import the key inside the handler (or re-hydrate it in the constructor inside `blockConcurrencyWhile`).【0†L—】(from the Lifecycle / “Working without shutdown hooks” section in the provided docs.)

**Cross 2 — The 128 MB isolate is shared by all DO instances on the same isolate; do not buffer large bodies in `HttpHelpers` or `SignatureAuth`.**

> Each isolate is subject to a 128 MB memory limit.【0†L—】(from the Metrics and analytics memory-usage section.)

A single `await request.json()` on a 100 MB body can consume most of that. Bound reads before buffering.

**Cross 3 — `wrangler types` regenerates `worker-configuration.d.ts`; all modules that import `Env` must import from the generated file, not a hand-written duplicate.**

If `EnvTypes` defines `Env` in `env.d.ts` and `HttpHelpers` defines its own local `Env` interface, the two will drift and the `satisfies ExportedHandler<Env>` check will silently pass against the wrong type. One `Env` source of truth, generated.

**Cross 4 — Compatibility flags are part of the contract; document them in `Constants`.**

`enable_request_signal`, `nodejs_compat`, and the Workers compatibility date all change what `HttpHelpers` and `SignatureAuth` can assume. `Constants` should export a `COMPATIBILITY` record (or a comment block) listing the flags the code depends on, so a future config change is caught in review rather than at runtime.

---

## Quick checklist per module

| Module | Must-tick before merging |
|---|---|
| **EnvTypes** | `wrangler types` is run in CI; generated file is the single source; `satisfies ExportedHandler<Env>` on every handler; RPC bindings include callee config paths; secrets typed as `string`, not `CryptoKey`. |
| **Constants** | 1,500,000 guard ≠ 2 MB SQLite ceiling; no zone-plan-dependent body limit hard-coded; alarm retry budget is documented as platform-fixed; `blockConcurrencyWhile` 30 s cap is documented as non-tunable. |
| **CoreTypes** | Every wire type is structured-cloneable; no `Buffer`, `bigint`, functions, or class instances across RPC; binary fields are `ArrayBuffer`/`Uint8Array`; discriminated unions for optional variants. |
| **HttpHelpers** | JSON reader is bounded before buffering; `request.signal` forwarding gated on `enable_request_signal`; no `AbortSignal.timeout()` at module scope; abort listeners removed after completion; `waitUntil` limited to 30 s tail. |
| **SignatureAuth** | Raw bytes are authenticated (no re-serialisation); 300 s timestamp tolerance enforced; `crypto.subtle.timingSafeEqual` or `crypto.subtle.verify` used (never `===`); tests run under the Workers runtime or use a portable fallback; `TextEncoder` not `Buffer`. |
| **AlarmTiming** | “Earliest obligation” is read-modify-write, not bare `setAlarm`; constructor never calls `setAlarm` unconditionally; `getAlarm()` returning `null` inside `alarm()` is handled; handler reschedules before exhausting 6 retries; each invocation stays under 15 min wall time; tests use `runDurableObjectAlarm()`. |

The through-line is the same as for SchemaDefs: **the Workers runtime is not Node, the Durable Object storage is not a general SQLite server, and the alarm API is not a cron scheduler**. Each module’s traps are the places where those differences become silent failures rather than compile errors.
