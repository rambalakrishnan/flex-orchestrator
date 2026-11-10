# Flex Orchestrator JSONL Export — Consumer Guide

A standalone contract for parsing `*-export.jsonl` files. No knowledge of
the producing system is required beyond this document.

## 1. Transport

- The file is **newline-delimited JSON** (NDJSON, media type
  `application/x-ndjson`): exactly one complete JSON object per line,
  lines separated by `\n`. There is no outer array and no trailing
  summary line (except the `export_incomplete` marker below).
- Parse **line by line**. Never `JSON.parse` the whole file.
- Skip truly empty lines defensively, but a well-formed export has none.
- Strings are UTF-8. Embedded newlines inside string values are JSON
  escapes (`\n`), never literal line breaks, so splitting on `\n` is safe.

## 2. Record envelope

Every line has a string field `type` discriminating the record:

| `type` | Order in file | Cardinality |
|---|---|---|
| `job` | First line, exactly once | 1 |
| `turn` | After `job`, ascending `turn.turn_index` | 0+ |
| `attempt` | After all turns, ascending primary key | 0+ |
| `judge_call` | After all attempts, ascending primary key | 0+ |
| `export_incomplete` | Last line, only on mid-stream failure | 0–1 |

Only `job` and `export_incomplete` carry `exportVersion` (currently `1`).
Consumers MUST ignore unknown `type` values and unknown fields within
known records (forward compatibility).

## 3. Record shapes

Field naming is mixed by design: `job` uses camelCase; `turn`,
`attempt`, and `judge_call` rows use snake_case (database row shapes).

### 3.1 `job` — `{"type":"job","exportVersion":1,"job":{...}}`

`job` is the job definition + live status snapshot taken when the export
started:

- `jobId` (string), `title` (string)
- `status` (string): `created|ready|running|paused_review|paused_dispatch|`
  `paused_storage|paused_operator|completed|failed|cancelled|superseded`
- `revision` (number): optimistic-concurrency counter; larger = newer.
- `config` (object): model, reasoning effort, token/cache controls,
  developer prompt, file ids, continuation/retry budgets, judge config.
- `currentTurnIndex` (number): turn the job is working on (1-based).
- `continuationsUsed`, `autoRetriesUsed`, `acceptedTurnCount` (numbers).
- `lastAcceptedResponseId`, `lastJudgeResponseId` (string|null): provider
  response ids chaining server-side history.
- `branchProvenance` (object|null): present on branched jobs
  (`parentJobId`, `forkTurnIndex`, ...).
- `supersededByJobId` (string|null).
- `warningMessages` (string[]): machine-readable warning tags, e.g.
  `operator_force_accepted`, `history_reanchored_at_turn:N`,
  `external_previous_response_id:<id>`.
- `errorCode` (string|null), `errorMessage` (string|null): populated on
  failed/paused jobs; null otherwise.
- `createdAtMs`, `updatedAtMs` (numbers, epoch millis).

### 3.2 `turn` — `{"type":"turn","turn":{...},"responseId":...,"prompt":...,"deliverable":...}`

- `turn` (object, snake_case row):
  - `turn_index` (number, 1-based), `status`: `pending|running|`
    `awaiting_judge|paused_review|accepted|accepted_with_warning|`
    `failed|cancelled`
  - `prompt_bytes`, `row_bytes` (numbers): byte sizes, not content.
  - `pinned_in_replay` (0|1): whether this turn replays after a
    history re-anchor.
  - `attachment_file_ids_json` (string): JSON-encoded string array of
    provider file ids. **Parse it as JSON**; it is not a plain string.
  - `accepted_candidate_id`, `accepted_attempt_id`,
    `accepted_response_id` (string|null): provenance of the accepted
    output; null until accepted.
  - `accepted_with_warning` (0|1).
  - `marginal_input_tokens` (number|null): provider-reported input
    tokens frozen at acceptance; null until accepted.
  - `created_at` (string, ISO-8601).
- `responseId` (string|null): duplicate of `turn.accepted_response_id`.
- `prompt` (string|null): the full turn prompt text (null if unavailable).
- `deliverable` (string|null): the accepted output text, **only when the
  turn is `accepted` or `accepted_with_warning` AND its artifact could be
  read**. Null in every other case — including unaccepted turns (their
  latest output is NOT in this export), accepted turns whose artifact is
  missing, and read failures. Null deliverable on an accepted turn means
  "unavailable", never "empty output".

### 3.3 `attempt` — `{"type":"attempt","attempt":{...}}`

One generation attempt (initial try, continuation, or retry):

- `attempt_id` (string), `turn_index` (number),
  `attempt_number` (number, monotonically increasing, never reused),
  `continuation_index` (number).
- `kind`: `initial|continuation|auto_retry|manual_retry`.
- `status`: `prepared|dispatching|dispatched|capacity_backoff|`
  `ambiguous_dispatch|completed|failed|cancelled|refused|incomplete|`
  `capacity_exhausted`.
- `idempotency_key` (string): stable per attempt across retries; a new
  attempt always mints a new key.
- `provider_response_id` (string|null),
  `parent_response_id` (string|null): provider-side chaining.
- `capacity_sends` (number), `next_backoff_at_ms` (number|null),
  `poll_probes` (number), `next_poll_at_ms` (number|null): dispatch
  telemetry.
- `request_bytes`, `row_bytes` (numbers): sizes only. **The stored
  request body is never included.**
- `usage_json` (string|null): JSON-encoded usage object when reported.
  **Parse it as JSON.** Null when the provider reported nothing.
- `diagnostics_json` (string): JSON-encoded diagnostics (always
  present; parse it). Contains provider error details when failed.
- `created_at`, `updated_at` (ISO-8601 strings).

### 3.4 `judge_call` — `{"type":"judge_call","judgeCall":{...}}`

One judge evaluation of a candidate (note camelCase wrapper key):

- `judge_call_id` (string), `turn_index` (number),
  `candidate_id` (string), `attempt_id` (string).
- `transport`: `responses|chat_completions`.
  `history_mode`: `chained|stateless`.
  `file_delivery_mode`: `passthrough|inline`. `model` (string).
- `provider_response_id` (string|null),
  `previous_judge_response_id` (string|null): judge-side history
  (separate from generation history).
- `status`: `pending|completed|unknown|failed`.
- `verdict`: `PASS|FAIL|UNKNOWN|null`.
  `grade` (number|null, 0–100 scale).
  `comment` (string|null): judge's free-text rationale.
- `tag_agreement` (0|1|null): whether the judge confirmed the turn-end
  marker matched the expected turn. **0/1 integers, not booleans.**
- `file_visibility` (0|1|null): complete applicable-file coverage.
- `manifest_json` (string): JSON-encoded per-file delivery/withheld
  manifest. **Parse it as JSON.**
- `request_bytes`, `row_bytes` (numbers): sizes only.
- `usage_json` (string|null): JSON-encoded usage. **Parse it as JSON.**
- `diagnostics_json` (string): always present; parse it. Carries
  `unknown_reason`/`unknown_message` when `status` is `unknown`.
- `created_at` (ISO-8601 string).

### 3.5 `export_incomplete` — `{"type":"export_incomplete","exportVersion":1,"section":...,"reason":...}`

Present as the **last line only** when a page read failed after
streaming started. `section` names the truncated section
(`turns|attempts|judge_calls`); `reason` is `internal_error`.
**If this line is present, every section after `section` is missing
and `section` itself is cut off — treat the file as a partial
observation, never as complete.**

## 4. Reading an incomplete (still-running) job

Exports are available in every job state; for a live job the file is a
**versioned observation, not a snapshot**:

- The `job` line reflects export-start state. Later sections stream
  after it, so a fast-moving job can show a turn as `running` in its
  row while the job line says `completed`, or vice versa. Prefer
  row-level statuses for per-entity truth; use the `job` line for
  job-level status at export start.
- Unaccepted turns have null `deliverable` and null acceptance
  provenance by design. Their in-flight attempt rows (with statuses
  like `dispatched` or `capacity_backoff`) are the progress signal.
- `pending` judge calls and attempts with null `provider_response_id`
  are normal mid-flight markers, not errors.
- `*_json` string fields that are null mean "not reported", never zero.
- HTTP 404 with a plain message (not JSONL) means the job id does not
  exist.

## 5. Privacy guarantees (safe to forward)

- No credential values appear anywhere: no API keys, Bearer tokens,
  `sk-` strings, JWTs, or `x-api-key` forms. Authorization headers are
  resolved at call time and never persisted.
- Stored generation request bodies are excluded (only `request_bytes`
  sizes are exported).
- Source file bytes are never embedded. The sole exception elsewhere in
  the system (encoded bytes inside a retained inline judge request in
  the *JSON* export) does not apply here: **JSONL carries no file
  bytes at all.**

## 6. Minimal parser (Python)

```python
import json

def read_export(path):
    job, turns, attempts, judges = None, [], [], []
    complete = True
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            t = rec.get("type")
            if t == "job":
                job = rec["job"]
            elif t == "turn":
                turns.append(rec)
            elif t == "attempt":
                attempts.append(rec["attempt"])
            elif t == "judge_call":
                judges.append(rec["judgeCall"])  # note camelCase key
            elif t == "export_incomplete":
                complete = False  # sections from rec["section"] on are missing
            # else: ignore unknown types (forward compatibility)
    # *_json string fields need a second json.loads; None means "not reported"
    return {"job": job, "turns": turns, "attempts": attempts,
            "judge_calls": judges, "complete": complete}
```

Join keys: `turn.turn_index` ↔ `attempt.turn_index` ↔
`judge_call.turn_index`; `judge_call.attempt_id` ↔ `attempt.attempt_id`;
`turn.accepted_attempt_id` ↔ `attempt.attempt_id` for the winning attempt.
`0/1` integer flags (`pinned_in_replay`, `accepted_with_warning`,
`tag_agreement`, `file_visibility`) need `== 1` comparison, not truthiness
of the string form.
