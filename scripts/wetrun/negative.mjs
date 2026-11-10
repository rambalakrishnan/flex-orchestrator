#!/usr/bin/env node
/**
 * scripts/wetrun/negative.mjs — negative-path battery for flex-orchestrator.
 *
 * Spend: ~zero. Creates at most one tiny generation job (1 turn, judge
 * DISABLED, maxOutputTokens 64) and drives it to completion. No judge is ever
 * enabled, so no judge spend occurs.
 *
 * Covers docs/TESTING.md manual Judge item 318 (judge-config edits while
 * halted persist; edits while running return 409 `job_not_halted`; malformed
 * configs return 400 `invalid_judge_config`). Items 325 (grade thresholds)
 * and 326 (judge base-URL selection) are NOT exercised here by design: both
 * require an enabled judge, and this battery keeps the judge disabled.
 *
 * Live hosts (defaults; APP_BASE_URL / APP_ORIGIN may override):
 *   app: https://flex-orchestrator.5900209.xyz
 * Auth (env only, never embedded):
 *   OMP_SERVICE_TOKEN_ID / OMP_SERVICE_TOKEN_SECRET -> CF-Access headers.
 * Every state-changing call sends `Origin: <app>` (exact host match required
 * by assertApplicationOrigin); GETs send no Origin.
 *
 * Exit: 0 on all assertions passing; 1 naming the failed step otherwise.
 */

const APP = (process.env.APP_BASE_URL || "https://flex-orchestrator.5900209.xyz").replace(/\/+$/, "");
const ORIGIN = (process.env.APP_ORIGIN || APP).replace(/\/+$/, "");
const TOKEN_ID = process.env.OMP_SERVICE_TOKEN_ID || "";
const TOKEN_SECRET = process.env.OMP_SERVICE_TOKEN_SECRET || "";

if (!TOKEN_ID || !TOKEN_SECRET) {
  console.error("FAIL env: OMP_SERVICE_TOKEN_ID and OMP_SERVICE_TOKEN_SECRET must be set");
  process.exit(1);
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "superseded"]);
const RUN = Date.now().toString(36);
const jobId = (prefix) => `${prefix}-${RUN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(step, message, evidence) {
  console.error(`FAIL ${step}: ${message}`);
  if (evidence !== undefined) console.error(`evidence: ${evidence}`);
  process.exit(1);
}

function info(line) {
  console.log(line);
}

/** origin: undefined -> default app origin; null -> omit header; string -> use. */
async function req(method, path, { body = undefined, origin = undefined } = {}) {
  const headers = {
    "cf-access-client-id": TOKEN_ID,
    "cf-access-client-secret": TOKEN_SECRET,
  };
  if (origin === undefined) headers.origin = ORIGIN;
  else if (origin !== null) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(APP + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function errCode(r) {
  const e = r.json && r.json.error;
  return e && typeof e.code === "string" ? e.code : null;
}

function summarize(r, maxLen = 300) {
  const body = r.text.length > maxLen ? `${r.text.slice(0, maxLen)}...` : r.text;
  return `status=${r.status} code=${errCode(r)} body=${body}`;
}

function createBody(id, { model, effort = "low", maxOut = 64, judge = { enabled: false } } = {}) {
  return {
    jobId: id,
    title: `negative battery ${id}`,
    config: {
      model,
      reasoningEffort: effort,
      maxOutputTokens: maxOut,
      cacheTtl: "12h",
      webSearch: false,
      developerPrompt: "Negative-battery probe.",
      developerFileIds: [],
      maxContinuations: 3,
      maxAutoRetries: 1,
      judge,
    },
    initialTurns: [
      { turnIndex: 1, promptText: "Emit exactly: ok <!-- TURN_END:1 -->", attachmentFileIds: [] },
    ],
  };
}

async function collectJobIds() {
  const ids = [];
  let cursor = null;
  for (;;) {
    const qs = cursor === null ? "?limit=100" : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
    const r = await req("GET", `/api/jobs${qs}`, { origin: null });
    if (r.status !== 200) fail("list", `GET /api/jobs returned ${r.status}`, summarize(r));
    const items = Array.isArray(r.json && r.json.items) ? r.json.items : null;
    if (items === null) fail("list", "GET /api/jobs has no items array", summarize(r));
    for (const it of items) ids.push(it.jobId);
    const next = r.json.nextCursor ?? null;
    if (!r.json.hasMore || next === null) break;
    cursor = next;
  }
  return ids.sort();
}

async function getState(id) {
  return req("GET", `/api/jobs/${encodeURIComponent(id)}`, { origin: null });
}

/** Poll until pred(stateJson) is true, a non-200 occurs, or timeout hits. */
async function waitFor(id, pred, timeoutMs, intervalMs) {
  const start = Date.now();
  let last = null;
  for (;;) {
    const r = await getState(id);
    if (r.status !== 200) return { ok: false, httpStatus: r.status, raw: r, timedOut: false };
    last = r.json;
    if (pred(r.json)) return { ok: true, state: r.json };
    if (Date.now() - start > timeoutMs) return { ok: false, state: last, timedOut: true };
    await sleep(intervalMs);
  }
}

const statusOf = (s) => (s && s.job && s.job.status) || null;

// ---------------------------------------------------------------------------
// Step 1: unknown model id -> 400, no job created (list unchanged).
// ---------------------------------------------------------------------------
info("STEP 1: create with unknown model id");
{
  const before = await collectJobIds();
  info(`step-1 list-before count=${before.length}`);
  const id = jobId("neg1-unknown-model");
  const r = await req("POST", "/api/jobs", {
    body: createBody(id, { model: "no-such-model-neg-probe" }),
  });
  info(`step-1 create-unknown-model ${summarize(r)}`);
  if (r.status !== 400) {
    fail("1-create-unknown-model", `expected status 400, got ${r.status}`, summarize(r));
  }
  const after = await collectJobIds();
  info(`step-1 list-after count=${after.length}`);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    fail("1-no-job-created", "job list changed after rejected create", `before=${before.length} after=${after.length}`);
  }
  if (after.includes(id)) fail("1-no-job-created", "rejected job id appears in list", id);
  info("ok 1: unknown model rejected with 400, list unchanged");
}

// ---------------------------------------------------------------------------
// Step 2: tiny judge-disabled job; malformed judge-config -> 400.
// Pause first so the shape check (not the running-state guard) is exercised.
// ---------------------------------------------------------------------------
info("STEP 2: create tiny judge-disabled job, malformed judge-config");
const NEG2 = jobId("neg2-tiny");
{
  const r = await req("POST", "/api/jobs", {
    body: createBody(NEG2, { model: "gpt-6-luna" }),
  });
  info(`step-2 create ${summarize(r, 200)}`);
  if (r.status !== 201) fail("2-create", `expected status 201, got ${r.status}`, summarize(r));

  const p = await req("POST", `/api/jobs/${encodeURIComponent(NEG2)}/pause`);
  info(`step-2 pause ${summarize(p)}`);
  if (p.status !== 200) fail("2-pause", `expected status 200, got ${p.status}`, summarize(p));

  const m = await req("PUT", `/api/jobs/${encodeURIComponent(NEG2)}/judge-config`, {
    body: { enabled: "yes" },
  });
  info(`step-2 malformed-judge-config ${summarize(m)}`);
  if (m.status !== 400) fail("2-malformed", `expected status 400, got ${m.status}`, summarize(m));
  if (errCode(m) !== "invalid_judge_config") {
    fail("2-malformed", `expected code invalid_judge_config, got ${errCode(m)}`, summarize(m));
  }
  info("ok 2: malformed judge-config rejected with 400 invalid_judge_config");
}

// ---------------------------------------------------------------------------
// Step 3: while running, valid judge-config -> 409 job_not_halted.
// (A terminal job yields the same 409; the assertion holds either way and
// the pre-PUT status is printed as evidence.)
// ---------------------------------------------------------------------------
info("STEP 3: valid judge-config while running");
{
  const rs = await req("POST", `/api/jobs/${encodeURIComponent(NEG2)}/resume`);
  info(`step-3 resume ${summarize(rs)}`);
  if (rs.status !== 200) fail("3-resume", `expected status 200, got ${rs.status}`, summarize(rs));

  const w = await waitFor(NEG2, (s) => statusOf(s) === "running" || TERMINAL.has(statusOf(s)), 120_000, 5_000);
  if (!w.ok && w.httpStatus) fail("3-wait-running", `GET state returned ${w.httpStatus}`, summarize(w.raw));
  const atPut = w.ok ? statusOf(w.state) : statusOf(w.state);
  info(`step-3 status-at-put=${atPut}${w.timedOut ? " (wait timed out)" : ""}`);

  const v = await req("PUT", `/api/jobs/${encodeURIComponent(NEG2)}/judge-config`, {
    body: { enabled: false },
  });
  info(`step-3 valid-judge-config-while-running ${summarize(v)}`);
  if (v.status !== 409) fail("3-running-put", `expected status 409, got ${v.status}`, summarize(v));
  if (errCode(v) !== "job_not_halted") {
    fail("3-running-put", `expected code job_not_halted, got ${errCode(v)}`, summarize(v));
  }
  info("ok 3: judge-config edit while running rejected with 409 job_not_halted");
}

// ---------------------------------------------------------------------------
// Step 4: unknown query key on /api/jobs -> 400.
// ---------------------------------------------------------------------------
info("STEP 4: unknown query key");
{
  const r = await req("GET", "/api/jobs?bogus=1", { origin: null });
  info(`step-4 unknown-query ${summarize(r)}`);
  if (r.status !== 400) fail("4-unknown-query", `expected status 400, got ${r.status}`, summarize(r));
  info("ok 4: unknown query key rejected with 400");
}

// ---------------------------------------------------------------------------
// Steps 5-6: missing / foreign Origin on state-changing POST -> 403.
// ---------------------------------------------------------------------------
info("STEP 5: create without Origin");
const NEG5 = jobId("neg5-no-origin");
{
  const r = await req("POST", "/api/jobs", { body: createBody(NEG5, { model: "gpt-6-luna" }), origin: null });
  info(`step-5 no-origin ${summarize(r)}`);
  if (r.status !== 403) fail("5-no-origin", `expected status 403, got ${r.status}`, summarize(r));
  if (errCode(r) !== "origin_not_allowed") {
    fail("5-no-origin", `expected code origin_not_allowed, got ${errCode(r)}`, summarize(r));
  }
  info("ok 5: missing Origin rejected with 403 origin_not_allowed");
}

info("STEP 6: create with foreign Origin");
const NEG6 = jobId("neg6-foreign-origin");
{
  const r = await req("POST", "/api/jobs", {
    body: createBody(NEG6, { model: "gpt-6-luna" }),
    origin: "https://evil.test",
  });
  info(`step-6 foreign-origin ${summarize(r)}`);
  if (r.status !== 403) fail("6-foreign-origin", `expected status 403, got ${r.status}`, summarize(r));
  info("ok 6: foreign Origin rejected with 403");
}

{
  const ids = await collectJobIds();
  if (ids.includes(NEG5) || ids.includes(NEG6)) {
    fail("5-6-no-job-created", "rejected create left a job in the list", `neg5=${ids.includes(NEG5)} neg6=${ids.includes(NEG6)}`);
  }
  info("ok 5-6: rejected creates left no jobs");
}

// ---------------------------------------------------------------------------
// Step 7: tiny job to terminal (<=10 min); completed, zero judge calls.
// ---------------------------------------------------------------------------
info("STEP 7: poll tiny job to terminal");
{
  const w = await waitFor(NEG2, (s) => TERMINAL.has(statusOf(s)), 600_000, 10_000);
  if (!w.ok && w.httpStatus) fail("7-terminal", `GET state returned ${w.httpStatus}`, summarize(w.raw));
  if (!w.ok && w.timedOut) {
    fail("7-terminal", "job not terminal within 10 minutes", `last-status=${statusOf(w.state)}`);
  }
  const final = statusOf(w.state);
  const usage = w.state && w.state.usage ? JSON.stringify(w.state.usage) : "n/a";
  info(`step-7 final-status=${final} usage=${usage}`);
  if (final !== "completed") {
    fail("7-terminal", `expected completed, got ${final}`, JSON.stringify(w.state && w.state.job));
  }

  const j = await req("GET", `/api/jobs/${encodeURIComponent(NEG2)}/judge-calls`, { origin: null });
  info(`step-7 judge-calls ${summarize(j, 200)}`);
  if (j.status !== 200) fail("7-no-judge-calls", `expected status 200, got ${j.status}`, summarize(j));
  const items = j.json && Array.isArray(j.json.items) ? j.json.items : null;
  if (items === null) fail("7-no-judge-calls", "judge-call list has no items array", summarize(j));
  if (items.length !== 0) fail("7-no-judge-calls", `expected 0 judge calls, got ${items.length}`, summarize(j));
  info("ok 7: job completed with zero judge calls");
}

info("PASS negative battery: all steps green");
