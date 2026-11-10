#!/usr/bin/env node
/**
 * Lifecycle wet-run battery (`scripts/wetrun/lifecycle.mjs`).
 *
 * Live end-to-end check for flex-orchestrator: create a 2-turn generation job
 * (gpt-6-luna, flex background) judged by the opencode judge provider, poll to
 * terminal `completed`, then assert turn acceptance, judge verdicts, provider
 * response ids, frozen usage, clean exports, and the HTML job fragment.
 *
 * Run: `node scripts/wetrun/lifecycle.mjs` (Node 18+, no deps beyond builtins).
 * Owner-run only against the live host (Wave B). NEVER run in CI.
 *
 * Env (secrets ONLY from env, never embedded):
 *   APP_ORIGIN               default https://flex-orchestrator.5900209.xyz
 *   OMP_SERVICE_TOKEN_ID     -> CF-Access-Client-Id header
 *   OMP_SERVICE_TOKEN_SECRET -> CF-Access-Client-Secret header
 *   JUDGE_SECRET_NAME        -> judge.secretName in the CreateJobCommand
 *
 * Every step asserts with printed evidence and exits non-zero naming the
 * failed step on the first failed assertion.
 *
 * Route contract (src/handlers/jobs.ts dispatch + assertApplicationOrigin):
 *   POST /api/jobs                    (Origin must exactly match app host; 201)
 *   GET  /api/jobs/:id                JobStateResponse { job, turns, ... }
 *   GET  /api/jobs/:id/turns|attempts|judge-calls   CursorPage snake_case rows
 *   GET  /api/jobs/:id/export/markdown  final markdown (markers stripped)
 *   GET  /api/jobs/:id/export?format=json
 *   GET  /api/jobs/:id/export/jsonl
 *   GET  /api/jobs/:id/fragment       text/html
 * State-changing calls MUST send Origin: <APP_ORIGIN>; GETs need no Origin.
 */

const APP_ORIGIN = process.env.APP_ORIGIN ?? "https://flex-orchestrator.5900209.xyz";
const SERVICE_ID = process.env.OMP_SERVICE_TOKEN_ID;
const SERVICE_SECRET = process.env.OMP_SERVICE_TOKEN_SECRET;
const JUDGE_SECRET_NAME = process.env.JUDGE_SECRET_NAME;

const GENERATION_MODEL = "gpt-6-luna";
const JUDGE_PROVIDER = "opencode";
const JUDGE_API_ROOT = "https://opencode.ai/inference/go/openai/v1";
const JUDGE_MODEL = "muse-spark-1.3-contributor";

const POLL_INTERVAL_MS = 30_000;
const POLL_BUDGET_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const TERMINAL_FAILURE = new Set(["failed", "cancelled", "superseded"]);
const MARKER_PATTERN = /<!--\s*TURN_END:\s*\d+\s*-->/;

function fail(step, message) {
  console.error(`FAIL step=${step} ${message}`);
  process.exit(1);
}

function accessHeaders() {
  return {
    "CF-Access-Client-Id": SERVICE_ID,
    "CF-Access-Client-Secret": SERVICE_SECRET,
  };
}

async function doFetch(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`)),
    REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyText(res) {
  try {
    return await res.text();
  } catch (err) {
    return `<unreadable body: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

/** GET a JSON endpoint; GETs carry Access headers but no Origin. */
async function getJson(step, path) {
  const url = `${APP_ORIGIN}${path}`;
  let res;
  try {
    res = await doFetch(url, { method: "GET", headers: accessHeaders() });
  } catch (err) {
    fail(step, `GET ${path} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await readBodyText(res);
  if (res.status !== 200) fail(step, `GET ${path} status=${res.status} body=${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    fail(step, `GET ${path} returned non-JSON body: ${text.slice(0, 500)}`);
  }
}

/** Paginate a CursorPage list endpoint ({ items, nextCursor, hasMore }). */
async function listAll(step, path) {
  const items = [];
  let cursor = null;
  for (;;) {
    const url = new URL(`${APP_ORIGIN}${path}`);
    url.searchParams.set("limit", "100");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    let res;
    try {
      res = await doFetch(url.toString(), { method: "GET", headers: accessHeaders() });
    } catch (err) {
      fail(step, `GET ${path} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await readBodyText(res);
    if (res.status !== 200) {
      fail(step, `GET ${path} status=${res.status} body=${text.slice(0, 500)}`);
    }
    let page;
    try {
      page = JSON.parse(text);
    } catch {
      fail(step, `GET ${path} returned non-JSON body: ${text.slice(0, 500)}`);
    }
    if (!Array.isArray(page.items)) fail(step, `GET ${path} missing items array`);
    items.push(...page.items);
    if (!page.hasMore || page.nextCursor === null || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

// ---------------------------------------------------------------------------
// step0_env
// ---------------------------------------------------------------------------
if (!SERVICE_ID || !SERVICE_SECRET) {
  fail("step0_env", "OMP_SERVICE_TOKEN_ID and OMP_SERVICE_TOKEN_SECRET must both be set");
}
if (!JUDGE_SECRET_NAME) fail("step0_env", "JUDGE_SECRET_NAME must be set");
console.log(
  `PASS step=step0_env appOrigin=${APP_ORIGIN} judgeSecretName=${JUDGE_SECRET_NAME} ` +
    `serviceToken=present(${SERVICE_ID.length} chars)`,
);

// ---------------------------------------------------------------------------
// step1_create — POST /api/jobs (Origin required; handler returns 201)
// ---------------------------------------------------------------------------
const runTag = `wetrun-lifecycle-${Date.now()}`;
const createCommand = {
  jobId: runTag,
  title: `wetrun lifecycle ${runTag}`,
  config: {
    model: GENERATION_MODEL,
    reasoningEffort: "low",
    maxOutputTokens: 256,
    cacheTtl: "nocache",
    webSearch: false,
    developerPrompt:
      "You are a terse test assistant. Follow the turn prompt exactly, especially the marker protocol.",
    developerFileIds: [],
    maxContinuations: 1,
    maxAutoRetries: 0,
    judge: {
      enabled: true,
      provider: JUDGE_PROVIDER,
      apiRoot: JUDGE_API_ROOT,
      secretName: JUDGE_SECRET_NAME,
      model: JUDGE_MODEL,
      transport: "responses",
      historyMode: "stateless",
      fileDeliveryMode: "inline",
      includePrior: false,
      maxGradeThreshold: 50,
      injectOnFail: true,
      injectOnPass: false,
      developerPrompt: "",
    },
  },
  initialTurns: [
    {
      turnIndex: 1,
      promptText:
        "Reply with one short sentence about the color blue. " +
        "Finish with exactly this marker on its own final line and nothing after it: <!-- TURN_END:1 -->",
      attachmentFileIds: [],
    },
    {
      turnIndex: 2,
      promptText:
        "Reply with one short sentence about the color green. " +
        "Finish with exactly this marker on its own final line and nothing after it: <!-- TURN_END:2 -->",
      attachmentFileIds: [],
    },
  ],
};

let jobId;
{
  const url = `${APP_ORIGIN}/api/jobs`;
  let res;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: {
        ...accessHeaders(),
        Origin: APP_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createCommand),
    });
  } catch (err) {
    fail("step1_create", `POST /api/jobs threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await readBodyText(res);
  if (res.status !== 200 && res.status !== 201) {
    fail("step1_create", `POST /api/jobs status=${res.status} body=${text.slice(0, 500)}`);
  }
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    fail("step1_create", `POST /api/jobs returned non-JSON body: ${text.slice(0, 500)}`);
  }
  if (state?.job?.jobId !== runTag) {
    fail("step1_create", `response jobId=${state?.job?.jobId ?? "<missing>"} expected=${runTag}`);
  }
  jobId = state.job.jobId;
  console.log(
    `PASS step=step1_create status=${res.status} jobId=${jobId} ` +
      `jobStatus=${state.job.status} currentTurnIndex=${state.job.currentTurnIndex}`,
  );
}

// ---------------------------------------------------------------------------
// step2_poll — GET state every 30s up to 15 min; assert terminal completed
// ---------------------------------------------------------------------------
let finalState;
{
  const startedAt = Date.now();
  let lastSig = "";
  let polls = 0;
  for (;;) {
    const elapsedS = Math.round((Date.now() - startedAt) / 1000);
    const state = await getJson("step2_poll", `/api/jobs/${jobId}`);
    polls += 1;
    const job = state.job;
    const turnSig = (state.turns ?? []).map((t) => `${t.turnIndex}:${t.status}`).join(",");
    const active = state.activeAttempt
      ? `${state.activeAttempt.attemptId}:${state.activeAttempt.status}`
      : "none";
    const sig = `${job.status}|turn${job.currentTurnIndex}|${turnSig}|${active}`;
    if (sig !== lastSig) {
      console.log(`[poll +${elapsedS}s] TRANSITION status=${job.status} currentTurn=${job.currentTurnIndex} turns=[${turnSig}] activeAttempt=${active}`);
      lastSig = sig;
    } else {
      console.log(`[poll +${elapsedS}s] status=${job.status} currentTurn=${job.currentTurnIndex} turns=[${turnSig}] activeAttempt=${active}`);
    }
    if (job.status === "completed") {
      console.log(
        `PASS step=step2_poll polls=${polls} elapsedS=${elapsedS} status=completed ` +
          `acceptedTurnCount=${job.acceptedTurnCount} lastAcceptedResponseId=${job.lastAcceptedResponseId}`,
      );
      finalState = state;
      break;
    }
    if (TERMINAL_FAILURE.has(job.status)) {
      fail(
        "step2_poll",
        `job reached non-completed terminal status=${job.status} errorCode=${job.errorCode} errorMessage=${job.errorMessage}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// step3_state_asserts — turns accepted, judge verdicts, response ids, usage
// ---------------------------------------------------------------------------
{
  const turns = [...(finalState.turns ?? [])].sort((a, b) => a.turnIndex - b.turnIndex);
  for (const n of [1, 2]) {
    const turn = turns.find((t) => t.turnIndex === n);
    if (!turn) fail("step3_state_asserts", `turn ${n} missing from state (turns=${turns.length})`);
    if (turn.status !== "accepted" && turn.status !== "accepted_with_warning") {
      fail("step3_state_asserts", `turn ${n} status=${turn.status} expected accepted`);
    }
    console.log(
      `evidence turn${n}: status=${turn.status} acceptedAttemptId=${turn.acceptedAttemptId} ` +
        `acceptedResponseId=${turn.acceptedResponseId} marginalInputTokens=${turn.marginalInputTokens}`,
    );
    if (typeof turn.marginalInputTokens !== "number" || turn.marginalInputTokens === null) {
      fail("step3_state_asserts", `turn ${n} marginalInputTokens not frozen (got ${turn.marginalInputTokens})`);
    }
  }

  const judgeCalls = await listAll("step3_state_asserts", `/api/jobs/${jobId}/judge-calls`);
  for (const n of [1, 2]) {
    const calls = judgeCalls.filter((c) => c.turn_index === n);
    const verdicts = calls.filter((c) => c.verdict === "PASS" || c.verdict === "FAIL");
    console.log(
      `evidence judge turn${n}: calls=${calls.length} ` +
        calls.map((c) => `${c.judge_call_id}:${c.verdict}/${c.grade}`).join(","),
    );
    if (verdicts.length === 0) {
      fail("step3_state_asserts", `turn ${n} has no judge call with a PASS/FAIL verdict`);
    }
  }

  const attempts = await listAll("step3_state_asserts", `/api/jobs/${jobId}/attempts`);
  for (const n of [1, 2]) {
    const rows = attempts.filter((a) => a.turn_index === n);
    const withResponse = rows.filter(
      (a) => typeof a.provider_response_id === "string" && a.provider_response_id.length > 0,
    );
    console.log(
      `evidence attempts turn${n}: rows=${rows.length} ` +
        rows.map((a) => `${a.attempt_id}:${a.status}:${a.provider_response_id ?? "<no-response-id>"}`).join(","),
    );
    if (withResponse.length === 0) {
      fail("step3_state_asserts", `turn ${n} has no attempt row carrying a provider response id`);
    }
  }
  console.log(
    `PASS step=step3_state_asserts turns=2/2-accepted judgeCalls=${judgeCalls.length} attempts=${attempts.length}`,
  );
}

// ---------------------------------------------------------------------------
// step4_exports — markdown/json/jsonl: markers stripped, no secrets, jsonl parses
// ---------------------------------------------------------------------------
async function getExportText(step, path, label) {
  const url = `${APP_ORIGIN}${path}`;
  let res;
  try {
    res = await doFetch(url, { method: "GET", headers: accessHeaders() });
  } catch (err) {
    fail(step, `GET ${label} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await readBodyText(res);
  if (res.status !== 200) fail(step, `GET ${label} status=${res.status} body=${text.slice(0, 500)}`);
  return { text, contentType: res.headers.get("content-type") ?? "<missing>" };
}

function assertNoSecrets(step, label, text) {
  if (text.includes("sk-")) fail(step, `${label} export leaks a 'sk-' secret-like value`);
  if (text.includes("Bearer")) fail(step, `${label} export leaks a 'Bearer' credential`);
}

{
  const md = await getExportText("step4_exports", `/api/jobs/${jobId}/export/markdown`, "md-final");
  if (MARKER_PATTERN.test(md.text)) fail("step4_exports", "md-final still contains a TURN_END marker");
  assertNoSecrets("step4_exports", "md-final", md.text);
  console.log(
    `evidence md-final: contentType=${md.contentType} bytes=${md.text.length} markersStripped=true`,
  );

  const json = await getExportText("step4_exports", `/api/jobs/${jobId}/export?format=json`, "json");
  let parsed;
  try {
    parsed = JSON.parse(json.text);
  } catch {
    fail("step4_exports", `json export is not valid JSON: ${json.text.slice(0, 500)}`);
  }
  assertNoSecrets("step4_exports", "json", json.text);
  console.log(
    `evidence json: contentType=${json.contentType} bytes=${json.text.length} ` +
      `turns=${parsed?.turns?.length ?? "?"} attempts=${parsed?.attempts?.length ?? "?"} ` +
      `judgeCalls=${parsed?.judgeCalls?.length ?? "?"}`,
  );

  const jsonl = await getExportText("step4_exports", `/api/jobs/${jobId}/export/jsonl`, "jsonl");
  const lines = jsonl.text.split("\n").filter((l) => l.length > 0);
  const counts = { job: 0, turn: 0, attempt: 0, judge_call: 0, other: 0 };
  for (let i = 0; i < lines.length; i += 1) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      fail("step4_exports", `jsonl line ${i + 1} does not parse: ${lines[i].slice(0, 200)}`);
    }
    if (record.type === "job") counts.job += 1;
    else if (record.type === "turn") counts.turn += 1;
    else if (record.type === "attempt") counts.attempt += 1;
    else if (record.type === "judge_call") counts.judge_call += 1;
    else counts.other += 1;
  }
  assertNoSecrets("step4_exports", "jsonl", jsonl.text);
  console.log(
    `evidence jsonl: contentType=${jsonl.contentType} lines=${lines.length} ` +
      `job=${counts.job} turn=${counts.turn} attempt=${counts.attempt} judge_call=${counts.judge_call} other=${counts.other}`,
  );
  if (counts.job < 1 || counts.turn < 2 || counts.attempt < 1 || counts.judge_call < 1) {
    fail(
      "step4_exports",
      `jsonl missing expected records (need job>=1 turn>=2 attempt>=1 judge_call>=1): ${JSON.stringify(counts)}`,
    );
  }
  console.log("PASS step=step4_exports md-final/json/jsonl all fetched, clean, and parseable");
}

// ---------------------------------------------------------------------------
// step5_fragment — GET job fragment, assert 200 HTML
// ---------------------------------------------------------------------------
{
  const url = `${APP_ORIGIN}/api/jobs/${jobId}/fragment`;
  let res;
  try {
    res = await doFetch(url, { method: "GET", headers: accessHeaders() });
  } catch (err) {
    fail("step5_fragment", `GET fragment threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await readBodyText(res);
  const contentType = res.headers.get("content-type") ?? "<missing>";
  if (res.status !== 200) fail("step5_fragment", `GET fragment status=${res.status} body=${text.slice(0, 500)}`);
  if (!contentType.includes("text/html")) {
    fail("step5_fragment", `fragment content-type=${contentType} expected text/html`);
  }
  console.log(
    `PASS step=step5_fragment status=200 contentType=${contentType} bytes=${text.length}`,
  );
}

console.log(`LIFECYCLE_WETRUN_OK jobId=${jobId}`);
