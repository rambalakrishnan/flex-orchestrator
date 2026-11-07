## 3. CoreTypes — `src/types.ts`

The architecture maps `types.ts` to **Contracts — shared configuration, state, and wire data types**. The traps are about the **Worker runtime’s type boundaries**, not about SQLite.

**Trap 3.1 — `structuredClone` is the RPC serialisation boundary; types must be structured-cloneable.**

Durable Object RPC arguments and return values are serialised. The docs state:

> All RPC calls are asynchronous, accept and return serializable types, and propagate exceptions to the caller without a stack trace.【23†L—】(from the RPC lifecycle docs in the provided file)

> An RPC call whose arguments include a stream, a stub, a function, or an `RpcTarget` … Arguments made only of structured cloneable values can be sent again.【23†L—】(from the Automatic retries docs in the provided file)

`CoreTypes` must not contain `class` instances with methods, `WeakMap`/`WeakSet`, `Promise`, `Symbol`, or functions if those types cross an RPC boundary (Worker → DO or DO → DO). Plain interfaces/type aliases over `string | number | boolean | null | ArrayBuffer | Array | object` are safe. If a type like `JobState` is used both in the Worker and in `JobDO` RPC methods, it must be a **data** type, not a behavioural class.

**Trap 3.2 — `ArrayBuffer` is the only binary type that crosses RPC cleanly; `Buffer` does not.**

The signing-request example uses `Buffer` only behind the `nodejs_compat` flag:

> This example Worker makes use of the Node.js Buffer API, which is available as part of the Workers runtime Node.js compatibility mode. To run this Worker, you will need to enable the `nodejs_compat` compatibility flag.

If `CoreTypes` declares a binary field as `Buffer`, the module now implicitly depends on `nodejs_compat`. Prefer `ArrayBuffer` or `Uint8Array` in shared types unless the compatibility flag is explicitly enabled and documented in the architecture.

**Trap 3.3 — Discriminated unions are the only safe way to model “either a continuation response or a terminal response”.**

Because the Worker runtime erases TypeScript at build time, the **only** runtime validation you get is what you write. `CoreTypes` should define wire types as discriminated unions with a literal `kind` field, so `SignatureAuth` and `AlarmTiming` can narrow without `as` casts. A plain `type JudgeResult = { verdict?: string; grade?: number; … }` gives no compile-time exhaustiveness and no runtime safety.

**Trap 3.4 — Avoid `bigint` in wire types.**

> Any numeric value in a column is affected by JavaScript’s 52-bit precision for numbers. If you store a very large number (`int64`), then retrieve the same value, the returned value may be less precise than your original number.【0†L—】(from the SQLite-backed DO Storage docs, quoted in the previous message.)

`bigint` is not structured-cloneable in all RPC paths and is not JSON-serialisable. Use `number` for IDs/timestamps that fit in 52 bits (the 1.5 M guard values and epoch-ms timestamps do), and `string` for anything larger.
