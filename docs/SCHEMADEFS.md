# SchemaDefs — platform excerpts for delegated workers

Below are the passages from the provided Cloudflare Durable Objects documentation (and the project’s own `ARCHITECTURE.md`) that bear directly on `src/db/schema.ts`. Each block is a direct excerpt or a tight condensation, labelled with its source. Hand these to the worker(s) drafting the TypeScript, in this order.

---

## 0. Scope reminder (from `ARCHITECTURE.md`)

> `src/db/schema.ts` → **Schema** — SQLite schemas, migrations, and shared artifact guards.

Relevant Decision Log entries:

> - Each artifact occupies one BLOB in its owning row.
> - Artifact fields and resulting rows independently enforce the 1,500,000-byte guard.
> - Artifact-bearing rows reserve capacity for bounded control metadata and diagnostics.
> - Oversized retained artifacts produce explicit errors rather than truncated substitutes.
> - Lists use primary-key cursors, omit BLOBs, and clamp page limits to 1–100.
> - SQL transactions and initialization locks contain no external I/O.

And the guard sizes:

> Every artifact and every resulting row has a **1,500,000-byte** guard. Encoded file data inside an inline judge request is part of that artifact and counts toward both the request-field and resulting-row guards.  
> …  
> The upload limit is **16,000,000 file bytes**.  
> …  
> Branch snapshots are bounded to 8,000,000 encoded bytes.

---

## 1. Configuration: the class must be SQLite-backed

**Source:** *Durable Objects → Get started → Configure Durable Object class with SQLite storage backend*; *Access Durable Objects Storage → Create SQLite-backed Durable Object class*; *SQLite-backed Durable Object Storage*.

> Use `new_sqlite_classes` on the migration in your Worker's Wrangler file:
> ```jsonc
> {
>   "migrations": [
>     { "tag": "v1", "new_sqlite_classes": ["MyDurableObject"] }
>   ]
> }
> ```

> `SQL API` methods accessed with `ctx.storage.sql` are only allowed on Durable Object classes with SQLite storage backend and will return an error if called on Durable Object classes with a KV-storage backend.

> Creating new namespaces with the key-value storage backend is no longer supported for accounts without an existing key-value-backed namespace.

> **Storage backend is immutable once a namespace exists.** Cloudflare rejects an `exports` change that switches a provisioned namespace from `sqlite` to `legacy-kv` or vice versa with the error `storage_type_mismatch`.

**Trap for SchemaDefs:** if the binding is declared with `new_classes` (KV backend) or `exports` without `"storage": "sqlite"`, every `ctx.storage.sql.exec(...)` in the schema module is dead on arrival. The schema module should assume — and its callers should assert — a SQLite-backed class.

---

## 2. Migration tracking: `PRAGMA user_version` is not available

**Source:** *Rules of Durable Objects → Initialize storage and run migrations in the constructor*.

> `PRAGMA user_version` is not supported by Durable Objects SQLite storage. You must use an alternative approach to track your schema version.

The same section gives the recommended pattern — a manual `_sql_schema_migrations` table, created first, with `COALESCE(MAX(id), 0)` read as the current version:

> ```js
> // Create the migrations tracking table if it does not exist
> this.ctx.storage.sql.exec(`
>   CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
>     id INTEGER PRIMARY KEY,
>     applied_at TEXT NOT NULL DEFAULT (datetime('now'))
>   );
> `);
>
> // Determine the current schema version
> const version = this.ctx.storage.sql
>   .exec("SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations")
>   .one().version;
>
> if (version < 1) { /* … CREATE TABLE …; INSERT INTO _sql_schema_migrations (id) VALUES (1); */ }
> if (version < 2) { /* … ALTER TABLE …; INSERT INTO _sql_schema_migrations (id) VALUES (2); */ }
> ```

The docs also point at two libraries that implement the same pattern (do not invent a third): `durable-utils`’ `SQLSchemaMigrations` and `@cloudflare/actors`’ `sql-schema-migrations.ts`.

**Related trap — `PRAGMA table_list` is a legitimate way to check for a table,** as used in the seat-booking tutorial:

> ```js
> const cursor = this.sql.exec(`PRAGMA table_list`);
> if ([...cursor].find((t) => t.name === "seats")) {
>   console.log("Table already exists");
>   return;
> }
> ```

Do **not** try to read `PRAGMA user_version` or `PRAGMA schema_version`; they are not a supported migration channel here.

---

## 3. Where migrations run, and the 30-second guillotine

**Source:** *Rules of Durable Objects → Initialize storage and run migrations in the constructor*; *Durable Object State → blockConcurrencyWhile*.

> Use `blockConcurrencyWhile()` in the constructor to run migrations and initialize state before any requests are processed. This ensures your schema is ready and prevents race conditions during initialization.

> If the callback throws an exception, the object will be terminated and reset. This ensures that the object cannot be left stuck in an uninitialized state if something fails unexpectedly.  
> To avoid this behavior, enclose the body of your callback in a `try...catch` block to ensure it cannot throw an exception.  
> To help mitigate deadlocks there is a 30 second timeout applied when executing the callback. If this timeout is exceeded, the Durable Object will be reset. It is best practice to have the callback do as little work as possible …

Also relevant — *Do not use `blockConcurrencyWhile` across I/O*:

> Using `blockConcurrencyWhile()` across I/O operations (such as `fetch()`, KV, R2, or other external API calls) is an anti-pattern. This is equivalent to holding a lock across I/O in other languages … Keep `blockConcurrencyWhile()` callbacks fast and limited to local storage operations.

**Trap for SchemaDefs:** a migration that batches dozens of `CREATE INDEX` / `ALTER TABLE` statements inside one `blockConcurrencyWhile` can exceed 30 s and silently reset the DO. Keep the callback to local SQL only; if a migration is large, split it across version steps (`_sql_schema_migrations` rows) rather than one giant callback. Also: an uncaught throw inside the callback resets the object — the schema runner must wrap each version step and record failures.

---

## 4. `sql.exec()` is not a transaction manager, and it lies about multi-statement bindings

**Source:** *SQLite-backed Durable Object Storage → `exec`*.

> Note that `sql.exec()` cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`. Instead, use the [`ctx.storage.transaction()`] or [`ctx.storage.transactionSync()`] APIs to start a transaction, and then execute SQL queries in your callback.

> Multiple SQL statements, separated with a semicolon, can be executed in the `query`. With multiple SQL statements, any parameter bindings are applied to the last SQL statement in the `query`, and the returned cursor is only for the last SQL statement.

**Source:** *SQLite-backed Durable Object Storage → Other → `transactionSync`*.

> `transactionSync(callback)`: `any` — Only available when using SQLite-backed Durable Objects. Invokes `callback()` wrapped in a transaction, and returns its result. If `callback()` throws an exception, the transaction will be rolled back. The callback must complete synchronously, that is, it should not be declared `async` nor otherwise return a Promise. Only synchronous storage operations can be part of the transaction.

**Trap for SchemaDefs:** a migration runner that does `exec("CREATE TABLE …; INSERT INTO _sql_schema_migrations …", 1)` will bind `1` to the *last* statement only — if the INSERT needs the version number, it gets it; if a prior statement needed a binding, it does not. Prefer one statement per `exec` inside a `transactionSync` callback so the whole migration is atomic.

---

## 5. Cursors: no snapshot across `await`; `one()` is strict

**Source:** *SQLite-backed Durable Object Storage → `exec` → Consume cursors synchronously*.

> Although a cursor object can technically be held across an `await`, it does not provide a stable snapshot of the query results. A cursor resumed after an `await` may observe rows inserted, updated, or deleted after the cursor was created, including writes from a later implicit transaction that has not yet committed. If that later transaction rolls back, the cursor may have already returned data from a state that never became durable.  
> For predictable behavior, fully consume cursors synchronously before the next `await`, for example with `.toArray()` or `Array.from(cursor)`.

> `one()` — Returns a row object if query result has exactly one row. If query result has zero rows or more than one row, `one()` throws an exception.

**Trap for SchemaDefs:** the `_sql_schema_migrations` read is `SELECT COALESCE(MAX(id), 0) … .one()` — safe because it always returns exactly one row. But any helper that does `.one()` on an optional lookup must be wrapped or use `.toArray()[0]`. Do not hold a cursor across an `await` in a migration loop.

---

## 6. Type safety: the TS type parameter is decorative; STRICT tables are on you

**Source:** *SQLite-backed Durable Object Storage → TypeScript and query results*.

> Providing a type parameter does *not* validate that the query result matches your type definition. In TypeScript, properties (fields) that do not exist in your result type will be silently dropped.

> Any numeric value in a column is affected by JavaScript's 52-bit precision for numbers. If you store a very large number (in `int64`), then retrieve the same value, the returned value may be less precise than your original number.

> The column type must be a valid `SqlStorageValue`: one of `ArrayBuffer | string | number | null`.

**Note on `STRICT` tables:** the provided Durable Objects documentation does not mention `STRICT` explicitly. The closest guidance is the caveat above — the TS generic is not a runtime validator, and `int64` values round-trip through JS `number`. `CREATE TABLE … STRICT` is a standard SQLite feature and is the right way to enforce column types at the DB layer, but **verify at build time that the Durable Objects SQLite build accepts `STRICT`** before making it mandatory. If it does, make every table `STRICT` and mirror the column types in the TS row types; if it does not, add explicit `CHECK` constraints (`typeof(col) = 'integer'`, etc.) so the 1.5 MB guard cannot be bypassed by a text value sneaking into a byte-count column.

**Practical consequence for the 1.5 MB guard:** store the guard as an `INTEGER` byte-count column (or compute it with `length(CAST(blob AS BLOB))`), never as a textified number. 1,500,000 fits comfortably in 52-bit precision, but a `TEXT` column would let a caller store `"1500000 "` or `"1.5e6"` and pass a naive comparison.

---

## 7. Hard SQLite limits that bound the guard design

**Source:** *Limits → SQL storage limits*.

| SQL | Limit |
|---|---|
| Maximum number of columns per table | 100 |
| Maximum number of rows per table | Unlimited (excluding per-object storage limits) |
| Maximum string, `BLOB` or table row size | **2 MB** |
| Maximum SQL statement length | **100 KB** |
| Maximum bound parameters per query | **100** |
| Maximum arguments per SQL function | 32 |
| Maximum characters (bytes) in a `LIKE` or `GLOB` pattern | 50 bytes |

**Source:** *Limits → SQLite-backed Durable Objects general limits*.

> | Storage per Durable Object | 10 GB |
> | Key size | Key and value combined cannot exceed 2 MB |
> | Value size | Key and value combined cannot exceed 2 MB |

**Source:** *Pricing → SQLite storage backend*.

> Rows reads | First 25 billion / month included + $0.001 / million rows  
> Rows written | First 50 million / month included + $1.00 / million rows  
> SQL Stored data | 5 GB-month, + $0.20/ GB-month

**Trap for SchemaDefs:** the 1,500,000-byte guard is deliberately under the **2 MB** per-row/BLOB ceiling — leave headroom for the “bounded control metadata and diagnostics” that share the row. Do not design a row where the artifact BLOB alone can approach 2 MB; the row *and* the artifact each carry the 1.5 MB guard independently, and the row also carries metadata. A `LIST`-style query that selects `*` on an artifact-bearing table will pull every BLOB and can blow the 128 MB isolate memory limit — hence the Decision Log rule that lists omit BLOBs and use primary-key cursors clamped to 1–100.

Also note the per-query bound-parameter ceiling of **100**: a batch insert helper that builds `VALUES (?,?),(?,?)…` must chunk at ≤ 50 rows if each row binds two values.

---

## 8. Storage-limit failure mode

**Source:** *Limits → What happens when a Durable Object exceeds its storage limit?*

> When a SQLite-backed Durable Object reaches its maximum storage limit (10 GB on Workers Paid, or 1 GB on the Free plan), write operations (such as `INSERT`, `UPDATE`, or calls to the `put()` and `sql.exec()` storage APIs) will fail with the following error:
> ```
> database or disk is full: SQLITE_FULL
> ```
> Read operations (such as `SELECT` queries, `get()`, and `list()` calls) will continue to work, and `DELETE` operations will also succeed so that you can remove data to free up space.

**Trap for SchemaDefs:** the schema’s insert helper must let `SQLITE_FULL` propagate as a distinct, catchable error — not swallow it into a generic “failed to write”. The architecture’s “Oversized retained artifacts produce explicit errors rather than truncated substitutes” applies at the SQL layer too: never `INSERT OR REPLACE` a truncated BLOB to “make it fit”.

---

## 9. `deleteAll`, `databaseSize`, `rowsRead`/`rowsWritten`, `PRAGMA optimize`

**Source:** *SQLite-backed Durable Object Storage → Other*, and *Release notes 2025-02-19*.

> `deleteAll()` … For Workers with a compatibility date of `2026-02-24` or later, `deleteAll()` also deletes any active alarm. For earlier compatibility dates, `deleteAll()` does not delete alarms. Use `deleteAlarm()` separately, or enable the `delete_all_deletes_alarm` compatibility flag.

> `databaseSize`: `number` — Returns: The current SQLite database size in bytes.

> `rowsRead`: `number` — The number of rows read so far as part of this SQL `query`. … The final value is used for SQL billing.  
> `rowsWritten`: `number` — The number of rows written so far as part of this SQL `query`. … The final value is used for SQL billing.

> SQLite-backed Durable Objects now support `PRAGMA optimize` command, which can improve database query performance. It is recommended to run this command after a schema change (for example, after creating an index).

**Trap for SchemaDefs:** if the schema module exposes a reset/delete helper, it must be aware that on older compat dates `deleteAll()` leaves an alarm behind. The migration runner should run `PRAGMA optimize` after each schema version that creates an index, and should surface `databaseSize` on a diagnostics endpoint so the 1.5 MB / 10 GB headroom is observable.

---

## 10. Testing: the four rules the worker must follow

### 10a. `runDurableObjectAlarm()` — never timers

**Source:** *Testing Durable Objects → Testing alarms*.

> Use `runDurableObjectAlarm()` to immediately trigger a scheduled alarm without waiting for the timer. This allows you to test alarm handlers synchronously:

> ```ts
> const alarmRan = await runDurableObjectAlarm(stub);
> expect(alarmRan).toBe(true); // Alarm was scheduled and executed
> // …
> const alarmRanAgain = await runDurableObjectAlarm(stub);
> expect(alarmRanAgain).toBe(false);
> ```

`runDurableObjectAlarm()` returns `false` when no alarm is scheduled. Do **not** write `await new Promise(r => setTimeout(r, …))` in a DO test — the test runner’s fake timers do not drive the DO alarm scheduler, and the architecture explicitly says alarms are the only scheduling primitive:

> Each Durable Object uses one alarm scheduled against its earliest obligation or deadline.

### 10b. `runInDurableObject()` — direct storage access for schema assertions

**Source:** *Testing Durable Objects → Direct access to Durable Object internals*.

> Use `runInDurableObject()` to access instance properties and storage directly. This is useful for verifying internal state or testing private methods:

> ```ts
> await runInDurableObject(stub, async (instance: Counter, state) => {
>   expect(instance).toBeInstanceOf(Counter);
>   const result = state.storage.sql
>     .exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", "default")
>     .one();
>   expect(result.value).toBe(2);
> });
> ```

Use this to assert that `_sql_schema_migrations` has the expected rows after `migrate()`, and that the guard columns exist with the right declared types (`PRAGMA table_info`).

### 10c. `evictDurableObject()` — verify migration idempotency across eviction

**Source:** *Testing Durable Objects → Testing eviction*.

> Use `evictDurableObject()` to evict a Durable Object instance during tests. Eviction tears down the instance to reset its in-memory state. This lets you test how your Durable Object recovers state from storage after being evicted.

> ```ts
> await evictDurableObject(stub);
> // In-memory state is wiped; durable storage survives
> expect(await stub.getHits()).toBe(0);
> expect(await stub.getCount()).toBe(2);
> ```

**Trap for SchemaDefs:** the migration runner must be safe to run again after eviction (constructor runs again). A test that migrates, evicts, then immediately calls a method exercises exactly the “constructor re-runs `blockConcurrencyWhile`” path. `evictDurableObject(stub, { webSockets: "close" })` is the variant to use if the test opened a hibernatable WebSocket.

### 10d. Do not allocate 1.5 MB strings in tests — test the pure validator with mocked numbers

The provided docs do not phrase this as a rule, but two hard limits make it the only sane approach:

> Each isolate is subject to a [128 MB memory limit].  
> — *Metrics and analytics → Memory usage*

> | Maximum string, `BLOB` or table row size | 2 MB |
> — *Limits → SQL storage limits*

Allocating a real 1,500,000-byte `Uint8Array`/string per assertion burns ~1.5 MB of the 128 MB isolate, multiplies across parallel test cases, and can push the test runner into eviction. Instead:

- Extract the guard as a **pure function** — e.g. `assertArtifactSize(bytes: number): void` or `guardBytes(n: number, limit = 1_500_000)` — and unit-test it with mocked numbers (`1_499_999`, `1_500_000`, `1_500_001`, `-1`, `NaN`, `Infinity`, `2_000_001`).
- For the DB layer, use **small sentinel blobs** (e.g. a 64-byte `Uint8Array`) and assert that the guard function is *called* with the right length — via a spy on the pure function, or by inserting a row whose metadata column carries the real length while the BLOB carries a sentinel. Do not insert the real 1.5 MB payload unless a dedicated, serial integration test explicitly needs it, and mark it as such.

This is also why the docs emphasize `.toArray()` over lazy cursors and why the Decision Log says lists omit BLOBs — the same memory discipline applies to tests.

---

## 11. Two more DO-level facts that leak into schema design

**Source:** *Known issues → Code updates*; *Lifecycle of a Durable Object → Working without shutdown hooks*.

> Code changes for Workers and Durable Objects are released globally in an eventually consistent manner. A request can reach the latest version of your Worker, which then calls a unique Durable Object running a previous version of your code.

> A Durable Object shuts down when it becomes inactive, when a code update strategy applies new code, or when Cloudflare deploys a new version of the Workers runtime. … Rather than relying on shutdown hooks (which are not provided), design your application to write state incrementally.

**Trap for SchemaDefs:** a migration that runs for several seconds can be interrupted by a code update mid-flight. The `_sql_schema_migrations` row for a version must only be inserted **after** that version’s DDL fully succeeds, and the DDL should be written so that re-running an interrupted version is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` guarded by a `PRAGMA table_info` check, since SQLite has no `ADD COLUMN IF NOT EXISTS`).

**Source:** *Known issues → Global uniqueness*; *Troubleshooting → Durable Object reset because its code was updated*.

> Uniqueness is enforced upon starting a new event (such as receiving an HTTP request), and upon accessing storage.

> Reset in error messages refers to in-memory state. Any durable state already persisted with `ctx.storage` is not affected. Make operations retryable and persist important state so a forced update can safely restart the object.

**Trap for SchemaDefs:** the schema module must never cache “migrated = true” in a module-level variable. It must re-read `_sql_schema_migrations` on every constructor wake (inside `blockConcurrencyWhile`), because the in-memory flag is lost on every eviction and every code-update reset.

---

## 12. Supported SQLite extensions (relevant if the schema adds search or JSON columns)

**Source:** *SQLite-backed Durable Object Storage → SQL API*.

> Durable Objects support a subset of SQLite extensions for added functionality, including:
> - FTS5 module for full-text search (including `fts5vocab`).
> - JSON extension for JSON functions and operators.
> - Math functions.

If the schema stores judge-request provenance as JSON (the architecture’s §12 mentions “encoded file bytes inside an inline judge request”), use `json_*` functions and `CHECK (json_valid(col))` rather than string matching. If it adds any search over artifacts, prefer FTS5 over `LIKE` — and remember the **50-byte `LIKE`/`GLOB` pattern limit** from §7 above.

---

## 13. Quick checklist for the drafting worker

Before the worker writes `src/db/schema.ts`, they should be able to tick these:

- [ ] Class is declared with `new_sqlite_classes` (or `exports` + `"storage": "sqlite"`).
- [ ] Migration version is tracked in `_sql_schema_migrations` (a table), not `PRAGMA user_version`.
- [ ] Migration runs inside `blockConcurrencyWhile` in the constructor; callback is local-SQL-only and wraps each version step in `try/catch`.
- [ ] Each version step is idempotent (`IF NOT EXISTS` / `PRAGMA table_info` guard for `ADD COLUMN`) and inserts its `_sql_schema_migrations` row only after DDL succeeds.
- [ ] Multi-statement `exec` is avoided where bindings matter; transactions use `transactionSync`.
- [ ] Cursors are consumed with `.toArray()` before any `await`; `.one()` is only used where exactly-one-row is guaranteed.
- [ ] Tables are `STRICT` **if verified to be supported**, otherwise carry explicit `CHECK (typeof(col)=…)` constraints; byte-count columns are `INTEGER`, not `TEXT`.
- [ ] The 1,500,000-byte guard is a pure function tested with mocked numbers; no test allocates a real 1.5 MB payload.
- [ ] Artifact-bearing tables put the BLOB in its own column, omit it from list queries, and use primary-key cursors clamped to 1–100.
- [ ] `SQLITE_FULL` is caught and surfaced distinctly; oversized artifacts raise explicit errors, never truncation.
- [ ] `PRAGMA optimize` is run after index-creating versions.
- [ ] Alarm tests use `runDurableObjectAlarm()`, not `setTimeout`; schema re-init is tested via `evictDurableObject()`.
- [ ] No module-level “migrated” cache; the version is re-read on every constructor wake.

---

### Source index (for the worker to consult)

- *Get started* — SQLite class config, `new_sqlite_classes`.
- *Access Durable Objects Storage* — `new_sqlite_classes`, SQL vs KV, D1 comparison.
- *SQLite-backed Durable Object Storage* — `exec`, cursors, `one()`, `transactionSync`, `databaseSize`, `deleteAll`, SQL limits, extensions.
- *Durable Object State* — `blockConcurrencyWhile` (30 s timeout, throw-resets).
- *Rules of Durable Objects* — `PRAGMA user_version` unsupported, migration pattern, `blockConcurrencyWhile` anti-pattern, input/output gates.
- *Limits* — SQL limits table, `SQLITE_FULL`, 2 MB row/BLOB.
- *Pricing* — rows read/written billing.
- *Testing Durable Objects* — `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`.
- *Known issues* / *Lifecycle* — code updates, reset semantics, write incrementally.
- *Release notes 2025-02-19* — `PRAGMA optimize`.
- *Architecture (`ARCHITECTURE.md`)* — §11, §12, Decision Log (guard sizes, BLOB-per-row, list rules, transaction/no-I/O rule).
