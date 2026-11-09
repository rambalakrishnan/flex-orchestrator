# README.md

## Overview

This Worker orchestrates long-running OpenAI Responses generation jobs with Flex background processing, sequential continuations, judging, file attachments, branching, and exports. It runs as one Worker with three SQLite-backed Durable Object classes:

- `JOB_DO` — one per job; sole execution-state writer; tracks at most one active generation attempt per job.
- `REGISTRY_DO` — global job index, file catalogue, uploads, and retention.
- `ROUTER_DO` — response routing and durable webhook inbox.

The application hostname is protected by Cloudflare Access. The webhook hostname is public and authenticated by signature. The Worker is only reachable on the custom domains you attach in the Cloudflare Dashboard; `workers.dev` and preview URLs are disabled.

## Quick Start

### 1. Configure `wrangler.toml`

This file is safe to commit to a public repository. It contains no secrets and no environment-specific hostnames.

```toml
name = "flex-orchestrator"
main = "src/index.ts"
compatibility_date = "2026-11-01"
workers_dev = false
preview_urls = false

[assets]
directory = "./public"
binding = "ASSETS"
run_worker_first = true

[[durable_objects.bindings]]
name = "JOB_DO"
class_name = "JobDO"

[[durable_objects.bindings]]
name = "ROUTER_DO"
class_name = "RouterDO"

[[durable_objects.bindings]]
name = "REGISTRY_DO"
class_name = "RegistryDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["JobDO", "RouterDO", "RegistryDO"]

[vars]
FILE_RETENTION_SECONDS = "604800"
JUDGE_DEFAULT_MODEL = "your-judge-model"

[secrets]
required = [
  "HOOKS_HOST",
  "OPENAI_WEBHOOK_SECRET",
  "OPENAI_API_KEY",
]
```

`FILE_RETENTION_SECONDS` controls file cleanup retention. `JUDGE_DEFAULT_MODEL` seeds the judge panel’s model field. The `[secrets] required` list is committed by name only; Wrangler refuses to deploy until every listed secret exists, so a new operator gets an immediate, named failure instead of a Worker that misroutes webhooks. Set each value for your own deployment; never commit secret values.

### 2. Install, authenticate, and deploy

```bash
npm install
npx wrangler login
npx wrangler secret put HOOKS_HOST
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put OPENAI_WEBHOOK_SECRET
# Add the judge secret named in each job’s judge configuration:
# npx wrangler secret put <JUDGE_SECRET_NAME>
npx wrangler deploy
```

On a fresh account the first `npx wrangler secret put` offers to create a stub Worker for the secret; accept it, set the remaining secrets, then deploy. For a single-command first deployment (for example in CI), `npx wrangler deploy --secrets-file <local-file>` accepts a gitignored `NAME=value` file; `.secrets.env` and `.dev.vars` are already ignored by this repository.

Set the judge credential named in each job’s judge configuration, using that configuration’s secret name. Credentials remain server-side secrets and are absent from stored request headers, logs, and exports.

## Infrastructure Setup

### 1. Attach custom domains

Because `wrangler.toml` deliberately omits `routes`, Wrangler deploys the Worker without attaching domains. Attach them once in the Cloudflare Dashboard.

1. Go to **Workers & Pages → flex-orchestrator → Settings → Domains & Routes**.
2. Click **Add → Custom Domain** and enter your application hostname, for example `app.example.com`.
3. Click **Add → Custom Domain** and enter your webhook hostname, for example `hooks.example.com`.
4. Confirm both hostnames appear under **Custom Domains and Routes**.

The Worker is now only reachable on these two hostnames. `workers.dev` and preview URLs remain disabled.

### 2. Configure the webhook host secret

`wrangler.toml` declares `HOOKS_HOST` in `[secrets] required` so a deployment fails fast when the host is missing. Keeping it a secret also keeps your custom hostname out of the public repository while still documenting the requirement for other operators.

1. Run `npx wrangler secret put HOOKS_HOST` and enter your webhook hostname, for example `hooks.example.com`. On a fresh project Wrangler offers to create a stub Worker for the secret; accept it.
2. Alternatively, once the Worker exists, open **Workers & Pages → flex-orchestrator → Settings → Variables and Secrets** and add `HOOKS_HOST` as a secret.
3. Deploy. A deploy with the secret missing fails before uploading code and names the missing secret.

The Worker treats `HOOKS_HOST` as the public webhook ingress and every other reachable host as the application. Because only the two custom domains above reach the Worker, unexpected hosts cannot expose the application.

### 3. Protect the application hostname with Cloudflare Access

1. In **Cloudflare Zero Trust → Access → Applications**, create a self-hosted application for `app.example.com` with an operator policy.
2. Do **not** put `hooks.example.com` behind Access. OpenAI must reach it directly.
3. Confirm that an unauthenticated request to `app.example.com` is redirected to the Access login, while `hooks.example.com/openai` remains reachable without an Access JWT.

### 4. Register the OpenAI webhook

1. In the OpenAI dashboard, go to **Webhooks** and add an endpoint: `https://hooks.example.com/openai`.
2. Subscribe to: `response.completed`, `response.cancelled`, `response.failed`, `response.incomplete`.
3. Store the signing secret as `OPENAI_WEBHOOK_SECRET`.
4. Webhooks authenticate exact raw bytes and enforce a 300-second delivery-timestamp tolerance. Acknowledgement follows durable inbox acceptance.

## Using the UI

### Creating a job

1. Click **New Job**.
2. Select a verified generation model. Unknown models receive no guessed limits or fallback profile.
3. Set generation controls: reasoning effort, maximum output tokens, cache selection, and optional web search.
   - Cache selection is explicit among `30m`, `12h`, and `nocache`. The retired `24h` retention option is not accepted; legacy persisted rows are read as `12h`.
   - Optionally supply an **External previous_response_id**. It seeds turn 1's continuity anchor, is recorded as the warning `external_previous_response_id:<id>`, and is replaced by the first accepted turn.
4. Upload attachments. Client-submitted generation attachments use Files API uploads and returned `file_id` references.
5. Configure the judge: Base URL (OpenAI/OpenRouter datalist), model, API-key env var name, transport, history mode, file-delivery mode, minimum acceptable grade, and the two steering toggles; or disable the judge.
   - **Inject Critique on Failure** (default on): a judge failure retries the turn with `### JUDGE CRITIQUE` appended to the prompt.
   - **Steer Next Turn on Pass** (default off): a passing judge comment is appended to the next pending turn as `### PM STEERING NOTE`.
6. Start the job. Accepted turns auto-advance; capped/incomplete and missed-tag turns auto-continue within the fixed budgets.

Token counting:
- Each turn card has its own **Count Tokens** button; the preview includes that turn plus the developer context and reports projected input tokens and admission inline.
- A failed count reports the sanitized provider status and error code when available, rather than only a generic 502.
- **Health Check** probes the provider status summary and model list for the main provider; inside a job's detail it also probes the configured judge provider and checks both configured model IDs.
- After a turn completes, its provider-reported `usage.input_tokens` is frozen into the turn record and shown in job details; branch copies preserve that value. Provider response IDs are shown for each accepted turn and its latest attempt.

Generation uses Flex background Responses and never falls back to standard tier.

### Monitoring, recovery, branching, and exports

- Browser state polling runs every 12 seconds while work is active. An open job dialog refreshes its fragment on the same cadence.
- Active jobs expose **Pause Job**, which halts scheduling, cancels the in-flight provider response (best-effort), and freezes pending judge calls without settling them. Accepted turns are untouched. **Resume Job** on `paused_operator` continues from the current turn without spending a retry; on `failed`, `paused_dispatch`, or `paused_storage` it retries the current turn. **Retry Turn** is available on the current turn for those states and `paused_review`; it starts a manual retry without changing automatic recovery counters.
- Failure banners show the persisted error code and message. The attempts table shows sanitized provider error details parsed from attempt diagnostics.
- Branch initialization consumes a complete snapshot in one local transaction. Branch activation follows file protection and conditional superseding of the quiescent parent. Branch snapshots are bounded to 8,000,000 encoded bytes.
- Exports remain available in every job state and stream pages and one artifact at a time.
  - **Markdown:** accepted deliverables only, with the included turn range and status.
  - **Final Markdown:** `GET /api/jobs/:id/export/markdown` concatenates accepted deliverables with turn markers stripped; completed jobs show a **Download Final Markdown** button.
  - **JSON:** retained definitions, attempts, judge calls, usage, provenance, diagnostics, file IDs, and missing-artifact markers.
  - **JSONL:** `GET /api/jobs/:id/export/jsonl` streams job, turn, attempt, and judge-call summaries as `application/x-ndjson` ordered by primary key. It omits request BLOBs, credentials, and encoded file bytes; it is available for incomplete jobs. If a page read fails after streaming starts, the final line is `{"type":"export_incomplete",...}` rather than a silently truncated file. The detail’s **Inspect JSONL** action parses the stream line-by-line and reports record counts and any incomplete marker.
  - JSON exports include encoded file bytes only when those bytes occur in a retained inline judge request. Exports do not fetch source files or attach a separate copy of their contents. Credentials are never exported.
  - A live JSON export is a versioned observation, not an atomic database backup.

The application health endpoint is `GET /api/health` and optionally `GET /api/health?jobId=<id>`. It reports latency, OpenAI status indicator, model-list availability, and whether the job's configured main/judge model IDs are present. Provider credentials and raw error bodies are never returned.

## Provider Configurations

Judge reference configurations are documentation only; runtime behavior follows the job’s declared judge configuration. The adapter performs no runtime capability detection or silent substitution. Capability inconsistencies produce advisory warnings. Chat Completions has no stateful response-history mechanism. Passthrough with a non-OpenAI API root remains permitted because a proxy can forward to the OpenAI Files API holding the job’s files. An unencodable declared contract produces `UNKNOWN`.

| Provider | Transport | History | File Delivery |
| :--- | :--- | :--- | :--- |
| OpenAI | Responses | Chained | Passthrough |
| Meta | Responses | Chained | Passthrough / Inline |
| OpenRouter | Responses | Stateless | Inline |
| Any | Chat Completions | Stateless | Inline |

The judge panel defaults to stateless history, and saved jobs carry explicit history declarations.

- **Passthrough:** supply existing OpenAI file IDs without uploading or preparing files again.
- **Inline:** supply encoded file bytes in the judge request, subject to the artifact guard.
- Stateful judge history introduces each applicable file once and inherits its context on subsequent calls. It does not resend inherited attachments.
- Stateless judge requests include files for the turns represented in their explicit context, attached to those turns’ content. `includePrior` adds prior accepted-output blocks and their applicable files. Files are deduplicated within each request.
- The manifest covers all applicable files and distinguishes delivered-now, inherited, and withheld files.
- Boolean `file_visibility` reports complete applicable-file coverage versus any missing coverage.
- Judge output accepts the steering-shaped JSON (verdict `YES`/`NO`, letter grade `A`–`F`, comment, `tag_matches_expected_step`, boolean `file_visibility`) and normalizes it to the validated five-field record; legacy `PASS`/`FAIL`, numeric grades, and `tag_agreement` remain accepted.
- Judge feedback enters generation only through the declared toggles: an on-failure critique retry or an on-pass steering note appended to the next pending turn prompt. With both off, feedback never reaches generation input.

## Files and Limits

- Client-submitted generation attachments use Files API uploads with `purpose: "user_data"` and returned `file_id` references.
- Inline file text, base64 attachments, and `file_url` are not accepted by that submission interface.
- The upload limit is **16,000,000 file bytes**. Multipart parsing, buffering, and hashing remain bounded.
- Live content hashes deduplicate source uploads. Upload intents support recovery and cleanup of ambiguous or redundant uploads.
- Non-terminal file references are protected before a job becomes ready. RegistryDO periodically deletes retention-eligible files unreferenced by non-terminal jobs.
- Source file bytes are not stored in a separate SQLite file store or file-preparation cache.
- Server-constructed inline judge requests are permitted. Encoded file bytes inside an inline judge request are retained as part of the guarded canonical judge-request BLOB and count toward both the request-field and resulting-row guards.
- Every artifact and every resulting row has a **1,500,000-byte** guard. Oversized retained artifacts produce explicit errors rather than truncated substitutes.
- Lists use primary-key cursors, omit BLOBs, and clamp page limits to 1–100.

## Troubleshooting

### Common symptoms

| Symptom | What to check / do |
| :--- | :--- |
| Webhook returns `401` or `403` | Signature mismatch, wrong `OPENAI_WEBHOOK_SECRET`, or timestamp outside the 300-second tolerance. Verify exact raw bytes and clock. Confirm `HOOKS_HOST` matches the hostname OpenAI calls. |
| Webhook accepted but job does not advance | Check RouterDO inbox and response mapping. Unmatched webhook events remain available for registration races. Duplicate and late results retain accounting without reopening settled execution decisions. |
| App hostname is reachable without Access | Confirm the Access self-hosted application covers `app.example.com` and is not bypassed. Confirm `HOOKS_HOST` is set to the webhook host, not the app host. |
| Unexpected hostname reaches the app | Confirm only the two custom domains are attached under **Domains & Routes** and that `workers_dev` and `preview_urls` are disabled. |
| Judge result is `UNKNOWN` | Judge infrastructure error or unencodable declared contract. Check declared transport, history mode, file-delivery mode, model, secret name, API root, and response shape. A structurally valid candidate advances with a warning. |
| Turn stalls | Check Flex capacity backoff. Ambiguous generation dispatches pause for manual recovery through a fresh attempt and key. Fallback polling follows the five-minute, one-minute, five-minute schedule with a 24-probe bound. |
| Candidate is empty | Whitespace-only and marker-only output is `empty_output` and never reaches the judge. Start a fresh run if an automatic retry remains; otherwise fail. |
| Artifact or export is too large | The artifact/row guard is 1,500,000 bytes. Encoded inline judge-request bytes count toward it. Reduce output, files, or switch file delivery mode. |
| Judge reports incomplete file visibility | The otherwise passing result is accepted with a coverage warning. Check passthrough file IDs/proxy access or inline artifact guard. |
| Job paused for review | Valid judge rejection, excessive grade, or judge-only tag disagreement pauses a structurally valid candidate. Review it; judge-only tag disagreement is distinct from parser-confirmed `wrong_index`. |
| Branch creation fails | Snapshot exceeds 8,000,000 encoded bytes, the parent is not quiescent, or file protection has not completed. Export instead if needed. |

### Recovery actions

| Condition | Action |
|---|---|
| `empty_output`: no deliverable text remains after normalization and marker removal, including whitespace-only and marker-only output | Start a fresh run if an automatic retry remains; otherwise fail. Do not invoke the judge. |
| Provider failure, cancellation, or refusal | Handle under provider/cancellation/refusal paths before empty-output classification. Do not reclassify as `empty_output`. |
| Judge infrastructure failure | Accept an otherwise valid candidate with a warning. |
| Incomplete judge file visibility on an otherwise passing result | Accept with a coverage warning rather than triggering generation retry. |
| Valid judge rejection, excessive grade, or judge-only tag disagreement | Pause a structurally valid candidate for review. |
| Storage or artifact-guard error | Pause or fail explicitly; never substitute truncated content. |

Accept-with-warning uses the ordinary acceptance transition and preserves the original judge result. Operator acceptance never bypasses structural validity, admission, refusal handling, or artifact guards.

## System Limits

| Limit | Value / behavior |
| :--- | :--- |
| File upload | 16,000,000 file bytes |
| Artifact / resulting row guard | 1,500,000 bytes |
| Branch snapshot | 8,000,000 encoded bytes |
| List page limit | 1–100, primary-key cursors, no BLOBs |
| Automatic continuations | 3 per turn, cumulative, fixed at job creation |
| Automatic full retry | 1, cumulative, fixed at job creation |
| Manual retry effect | Does not reset automatic recovery counters |
| Flex capacity sends | At most 5 per attempt, persisted exponential backoff |
| Fallback polling | Five-minute, one-minute, five-minute schedule; 24-probe bound |
| Webhook timestamp tolerance | 300 seconds |
| Browser polling | Every 12 seconds while work is active |
| Long-context classification | Full request input above 272,000 tokens, including cached input |
| Cache choices | Explicit among `30m`, `12h`, and `nocache` (retired `24h` rows read as `12h`) |
| Usage accounting | Recorded once per call; missing usage and unknown pricing remain explicit |
