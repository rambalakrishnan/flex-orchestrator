## 2. Constants — `src/constants.ts`

The architecture defines this as **Contracts — fixed limits and verified generation-model metadata**. The traps here are mostly about **not trusting numbers that look like constants but are actually platform-dependent**.

**Trap 2.1 — The “1.5 MB artifact guard” is a project constant, but the platform ceiling above it is 2 MB, not 1.5 MB.**

From the Limits table:

> Maximum string, `BLOB` or table row size | **2 MB**(the DO-specific limits table in the provided docs gives the same 2 MB figure).

`1_500_000` is a deliberate headroom choice — it leaves ~500 KB for the bounded control metadata and diagnostics that share the row. **Do not** redefine `ARTIFACT_GUARD_BYTES` to `2 * 1024 * 1024` “because the platform allows 2 MB”: that would violate the architecture’s “Artifact fields and resulting rows independently enforce the 1,500,000-byte guard” decision. The constant should be named unambiguously (e.g. `ARTIFACT_ROW_GUARD_BYTES = 1_500_000`) and documented as **not** equal to the SQLite row ceiling.

**Trap 2.2 — Do not hard-code the incoming request-body ceiling as if it were a Workers-plan constant.**

> For incoming requests to a Worker on your domain, request body size limits depend on the domain’s Cloudflare plan, not your Workers plan.

> Cloudflare Plan | Maximum request body size  
> Free | 100 MB  
> Pro | 100 MB  
> Business | 200 MB  
> Enterprise | Up to 5 GB (self-serve)

If `Constants` exports something like `MAX_INCOMING_BODY_BYTES`, it must either omit it or derive it from the **zone plan** — the Workers plan (Free/Paid) is not the right dimension. The architecture’s own limits (16,000,000 file bytes, 1,500,000 artifact bytes, 8,000,000 branch-snapshot bytes) are project policy and belong here; the platform’s 100 MB / 200 MB / 5 GB tiering does **not**.

**Trap 2.3 — Environment variable count and size limits bound how many “constants” can be injected via `vars`.**

> Environment variables | 64/Worker | 128/Worker  
> Environment variable size | 5 KB | 5 KB

If `Constants` is implemented as a large set of `vars` entries, it will hit the 64/128 count limit quickly. Constants should be **compiled-in literals** in `src/constants.ts`, not deployment-time variables, unless they genuinely need to vary per environment.

**Trap 2.4 — Do not hard-code the alarm retry budget as if it were configurable.**

> Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws. … Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed.

The **6-retry / 2-second-base** figures are platform behaviour, not tunables. `Constants` may expose them as documentation constants (e.g. `ALARM_MAX_RETRIES = 6`), but `AlarmTiming` must not assume it can raise them — there is no `setAlarmRetryPolicy()`. The architecture’s separate “at most five sends per attempt” and “24-probe bound” are **project-level** budgets layered on top, not replacements for the platform retry mechanism.

**Trap 2.5 — Do not encode the 30-second `blockConcurrencyWhile` timeout as a constant you can “raise”.**

> To help mitigate deadlocks there is a 30 second timeout applied when executing the callback. If this timeout is exceeded, the Durable Object will be reset.【0†L—】(from the Durable Object State docs, quoted in the previous message.)

`blockConcurrencyWhile` has a fixed 30 s cap; there is no config constant to extend it. If `Constants` defines `MIGRATION_LOCK_TIMEOUT_MS = 30_000`, it must be labelled **platform-fixed**, not tunable, or the worker will be tempted to “increase it” when a migration is slow — the correct fix is to split the migration, not to raise the constant.
