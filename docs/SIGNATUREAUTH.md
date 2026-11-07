## 5. SignatureAuth — `src/lib/signature.ts`

The architecture maps this to **Signature — Standard Webhooks authentication**. The traps are all about **which crypto API actually exists on Workers** and **how to compare bytes safely**.

**Trap 5.1 — `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension, not standard Web Crypto — and it is **synchronous**.**

> `crypto.subtle.timingSafeEqual` is a Cloudflare Workers extension to Web Crypto, not a standard Web Crypto API. Bun’s runtime lacks `crypto.subtle.timingSafeEqual` (a Workers extension).

> `crypto.subtle.timingSafeEqual` — This method is a real, synchronous `SubtleCrypto` extension but is Cloudflare-Workers-proprietary — it does not exist on Node or Deno.

> The `crypto.subtle.timingSafeEqual` function compares two values using a constant-time algorithm. The time taken is independent of the contents of the values. In order to compare two strings, you must use the `TextEncoder` API.

**Practical consequence:** `SignatureAuth` can use `crypto.subtle.timingSafeEqual(new Uint8Array(a), new Uint8Array(b))` — it is available on Workers and is the correct constant-time primitive — but the unit tests must not assume it exists on the Node-based test runner. If the test environment is Node/Vitest, either run the tests inside `@cloudflare/vitest-plugin` (so the Workers runtime provides it) or provide a portable fallback. **Do not** replace it with `a === b` “because the tests pass on Node” — that reintroduces the timing leak on the real Workers deployment.

**Trap 5.2 — `crypto.subtle.verify()` is also timing-safe and is portable; prefer it when you have an imported `CryptoKey`.**

> With the `CryptoKey` in hand, use `crypto.subtle.verify()` for HMAC verification. This is intentionally timing-safe by the Web Crypto specification — you don’t need a separate constant-time comparison step.

If `SignatureAuth` imports the secret once as an HMAC `CryptoKey` and calls `crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes)`, it gets timing safety from the Web Crypto spec **and** portability across Node/Deno/Bun/Workers. `crypto.subtle.timingSafeEqual` is the fallback when you already have two byte arrays and do not want to re-import a key.

**Trap 5.3 — Standard Webhooks requires exact raw bytes and a 300-second timestamp tolerance; do not re-serialise the body.**

The architecture decision log states:

> Webhooks authenticate exact raw bytes and enforce a 300-second delivery-timestamp tolerance.

This means `SignatureAuth` must read the body as **raw bytes** (`await request.arrayBuffer()` or `await request.text()` with no re-encoding), compute the HMAC over the raw bytes (plus the timestamp header), and compare. A helper that does `JSON.parse` then `JSON.stringify` will change key ordering and whitespace, and the signature will never match. The 300 s tolerance is a **project decision**, not a platform default — Standard Webhooks implementations often default to 5 minutes, but the worker must enforce exactly 300 s and reject timestamps outside that window.

**Trap 5.4 — `crypto.subtle.importKey` is async; do not cache a `Promise<CryptoKey>` that can outlive the request context.**

> It is async because `crypto.subtle.sign` has no synchronous form on edge runtimes.

Because `importKey` is async and the resulting `CryptoKey` may be tied to the request context (depending on compatibility flags), the safe pattern is to import the key **per request** or inside a short-lived cache that is explicitly cleared. A module-level `let keyPromise: Promise<CryptoKey>` that is never invalidated can hold a key across evictions in a DO; in a Worker it is usually fine, but the simplest and safest pattern is per-request import. (The Workers example does exactly this: it imports the key inside `fetch()`.)

**Trap 5.5 — `Buffer` is not available without `nodejs_compat`; use `TextEncoder`/`Uint8Array`.**

The signing-request example imports `Buffer` from `node:buffer` only because it runs with `nodejs_compat`. `SignatureAuth` should use `new TextEncoder().encode(...)` and `new Uint8Array(...)` — the `timingSafeEqual` docs explicitly say “In order to compare two strings, you must use the `TextEncoder` API.”
