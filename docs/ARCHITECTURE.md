# ARCHITECTURE.md

### §2 — Deployment diagram

```text
Browser → app.example.com, protected by Cloudflare Access
              │
              ▼
           Worker
              ├─ application API and static assets
              ├─ JOB_DO: one JobDO per job
              ├─ REGISTRY_DO: global job index and file catalogue
              └─ ROUTER_DO: global response map and webhook inbox

OpenAI → hooks.example.com/openai
              └─ signature verification → durable RouterDO inbox → acknowledgement
```

### §6 — Canonical generation request

Generation uses the stateful branch of §2’s shared reasoning-continuity rule. The canonical request builder obtains its continuity fields from the shared continuity helper; generation and judge adapters do not maintain separate versions of that rule.

Each attempt stores the exact UTF-8 request body that its sends use.

```ts
{
  model: job.model,
  background: true,
  service_tier: "flex",
  ...reasoningContinuityPayload("stateful", anchor),
  reasoning: { effort: job.reasoning_effort },
  max_output_tokens: job.max_output_tokens,
  ...cachePayload(job.cache_ttl),
  ...(job.web_search ? { tools: [{ type: "web_search" }] } : {}),
  input: buildInput(job, turn, attempt)
}
```

Authorization headers are resolved at call time and are never included in the stored request.

### §7 — Empty-output classification

Structural acceptance requires non-empty retained deliverable text. Output that becomes empty after normalization and completion-marker removal is `empty_output`, including whitespace-only and marker-only output. An apparent valid completion tag does not make an empty candidate judgeable.

Provider failure, cancellation, and refusal handling retain precedence over this classification.

| Structural result | Action |
|---|---|
| `empty_output`: no deliverable text remains after normalization and marker removal | Start a fresh run if an automatic retry remains; otherwise fail. Do not invoke the judge. |

The remaining structural outcomes and the joint recovery procedure follow §8A.

### §11 — File storage

Source attachments are catalogued through the Files API with `purpose: "user_data"`. Generation references their catalogue file IDs; judge delivery follows §8.

Developer-role messages are text-only. Developer files are delivered as `input_file` content in the user message, deduplicated against that turn's attachments, because the provider rejects file content inside developer messages.

The upload limit is **16,000,000 file bytes**. Multipart parsing, buffering, and hashing remain bounded.

Source file bytes are not stored in a separate SQLite file store or file-preparation cache. Server-constructed inline judge requests contain encoded file bytes, and those bytes are retained as part of the guarded canonical judge-request BLOB. Exporting that request also exports its encoded file bytes.

Passthrough and inherited judge attachments require no additional file upload or preparation.

### §12 — Artifact storage and export

Every artifact and every resulting row has a **1,500,000-byte** guard. Encoded file data inside an inline judge request is part of that artifact and counts toward both the request-field and resulting-row guards.

Retaining an inline request is distinct from maintaining a reusable file-preparation cache. The stored request preserves the actual bytes sent for that judge call.

Exports stream pages and one artifact at a time. They do not materialize the entire job or hold SQL cursors across network waits.

- **Markdown:** accepted deliverables only, with the included turn range and status.
- **JSON:** retained definitions, attempts, judge calls, usage, provenance, diagnostics, file IDs, and missing-artifact markers.

JSON exports include encoded file bytes when those bytes occur in a retained inline judge request. Exports do not fetch source files or attach a separate copy of their contents.

Markdown captures the accepted-prefix boundary when export begins.

A live JSON export is a versioned observation, not an atomic database backup. It records its starting revision and table high-water keys; each emitted mutable record carries its observed revision or update time. Records created beyond the captured high-water keys are excluded.

Credential values are never exported.

## 16. Topology

### Directory layout

```text
src/
├── index.ts
├── env.d.ts
├── constants.ts
├── types.ts
├── http.ts
├── handlers/
│   ├── jobs.ts
│   ├── files.ts
│   ├── tokens.ts
│   └── webhook.ts
├── do/
│   ├── job-do.ts
│   ├── registry-do.ts
│   └── router-do.ts
├── db/
│   ├── schema.ts
│   ├── jobs.ts
│   ├── turns.ts
│   ├── attempts.ts
│   └── router.ts
└── lib/
    ├── openai.ts
    ├── signature.ts
    ├── tag.ts
    ├── judge.ts
    ├── dispatch.ts
    ├── continuity.ts
    ├── alarm.ts
    └── tokens.ts

public/
├── index.html
├── app.js
└── app.css
```

### Dependency DAG

An arrow means **depends on**. Nodes group files at implementation/build granularity. Runtime HTTP and binding-RPC communication are not dependency edges; erased namespace type annotations do not introduce implementation dependencies.

```text
HTTP             → Contracts
Schema           → Contracts
ProviderIO       → HTTP, Contracts
Continuity       → Contracts
Tags             → Contracts
Alarm            → Contracts
Signature        → Contracts

JobStorage       → Schema, Contracts
RouterStorage    → Schema, Contracts

Generation       → Continuity, ProviderIO, Contracts
Judge            → Continuity, ProviderIO, Contracts
Tokens           → ProviderIO, Contracts

ApplicationRoutes → HTTP, Generation, Judge, Tokens, ProviderIO, Contracts
WebhookRoute      → HTTP, Signature, Contracts

JobDO            → Schema, JobStorage, Generation, Judge, Tokens,
                   Tags, Alarm, ProviderIO, Contracts
RouterDO         → Schema, RouterStorage, Alarm, Contracts
RegistryDO       → Schema, Alarm, ProviderIO, Contracts

Worker           → ApplicationRoutes, WebhookRoute, JobDO,
                   RouterDO, RegistryDO, HTTP, Contracts

BrowserPage      → BrowserClient, BrowserStyles
```

### File-to-node mapping

```text
src/index.ts              → Worker — hostname routing, assets, and Durable Object exports.
src/env.d.ts              → Contracts — Worker bindings, variables, and secret types.
src/constants.ts          → Contracts — fixed limits and verified generation-model metadata.
src/types.ts              → Contracts — shared configuration, state, and wire data types.
src/http.ts               → HTTP — bounded JSON handling and HTTP response helpers.
src/handlers/jobs.ts      → ApplicationRoutes — job commands, reads, branching, and exports.
src/handlers/files.ts     → ApplicationRoutes — multipart uploads and catalogue coordination.
src/handlers/tokens.ts    → ApplicationRoutes — pending marginal-count previews.
src/handlers/webhook.ts   → WebhookRoute — authenticated webhook ingress.
src/do/job-do.ts          → JobDO — sequential execution and job-local coordination.
src/do/registry-do.ts     → RegistryDO — job index, file catalogue, uploads, and retention.
src/do/router-do.ts       → RouterDO — response routing and webhook delivery.
src/db/schema.ts          → Schema — SQLite schemas, migrations, and shared artifact guards.
src/db/jobs.ts            → JobStorage — job records and branch metadata.
src/db/turns.ts           → JobStorage — turn records, candidates, and accepted anchors.
src/db/attempts.ts        → JobStorage — generation attempts, judge calls, and durable work.
src/db/router.ts          → RouterStorage — response mappings and webhook inbox records.
src/lib/openai.ts         → ProviderIO — one-shot Responses and Files API operations.
src/lib/signature.ts      → Signature — Standard Webhooks authentication.
src/lib/tag.ts            → Tags — normalization and structural classification.
src/lib/judge.ts          → Judge — declared-provider adapters and five-field result validation.
src/lib/dispatch.ts       → Generation — canonical requests, dispatch classification, and capacity backoff.
src/lib/continuity.ts     → Continuity — shared Responses reasoning-continuity payloads.
src/lib/alarm.ts          → Alarm — earliest-obligation and fallback-poll timing.
src/lib/tokens.ts         → Tokens — count projection, admission, and usage aggregation.
public/index.html         → BrowserPage — application document and asset references.
public/app.js             → BrowserClient — controls, polling, rendering, and downloads.
public/app.css            → BrowserStyles — application presentation.
```

### Runtime data flow

- **Commands:** `public/app.js → src/index.ts → handlers/jobs.ts → JobDO` through binding RPC; JobDO uses the job stores and execution libraries, with catalogue publication reaching RegistryDO. Uploads and count previews use `handlers/files.ts` and `handlers/tokens.ts`.
- **Webhooks:** `src/index.ts → handlers/webhook.ts → lib/signature.ts → RouterDO`; `db/router.ts` holds routing and inbox records. Router delivery reaches JobDO, whose authoritative retrieval uses `lib/openai.ts`.
- **Alarms:** Cloudflare invokes the corresponding object in `src/do/`. JobDO uses its work records and execution libraries; RouterDO uses its inbox records and JobDO binding; RegistryDO uses catalogue records and Files API operations. `lib/alarm.ts` supplies scheduling calculations.
