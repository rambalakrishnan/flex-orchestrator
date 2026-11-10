#!/usr/bin/env node
/**
 * Recovery wet-run battery: pause/resume -> branch -> force-accept -> JSONL lineage.
 *
 * Live spend battery against the deployed Worker. Every step prints evidence
 * (ids + status transitions) and the script exits non-zero naming the failed
 * step on the first failed assertion.
 *
 * Required env (never hardcode secrets):
 *   APP_ORIGIN                  e.g. https://flex-orchestrator.5900209.xyz
 *   OMP_SERVICE_TOKEN_ID        (alias CF_ACCESS_CLIENT_ID)
 *   OMP_SERVICE_TOKEN_SECRET    (alias CF_ACCESS_CLIENT_SECRET)
 * Optional env:
 *   JUDGE_API_ROOT              default https://opencode.ai/inference/go/openai/v1
 *                               (bare version root: dispatch appends /responses itself)
 *   JUDGE_MODEL                 default muse-spark-1.3-contributor
 *   JUDGE_SECRET_NAME           default JUDGE_API_KEY (server-side secret name)
 *   POLL_TIMEOUT_MS             default 600000 (10 min spend-gate wait)
 *   POLL_INTERVAL_MS            default 10000
 *
 * Cost ceiling: 3-turn job, gpt-6-luna / low / 256 max tokens / nocache,
 * lenient judge (F-equivalent threshold 50).
 */

const APP_ORIGIN = (process.env.APP_ORIGIN ?? "https://flex-orchestrator.5900209.xyz").replace(/\/+$/, "");
const ACCESS_ID = process.env.OMP_SERVICE_TOKEN_ID ?? process.env.CF_ACCESS_CLIENT_ID ?? "";
const ACCESS_SECRET =
  process.env.OMP_SERVICE_TOKEN_SECRET ?? process.env.CF_ACCESS_CLIENT_SECRET ?? "";
const JUDGE_API_ROOT =
  process.env.JUDGE_API_ROOT ?? "https://opencode.ai/inference/go/openai/v1";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "muse-spark-1.3-contributor";
const JUDGE_SECRET_NAME = process.env.JUDGE_SECRET_NAME ?? "JUDGE_API_KEY";
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 600000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 10000);

if (Number.isNaN(POLL_TIMEOUT_MS) || Number.isNaN(POLL_INTERVAL_MS)) {
  console.error("FAIL step=env detail=POLL_TIMEOUT_MS/POLL_INTERVAL_MS must be numbers");
  process.exit(1);
}

function fail(step, detail, evidence) {
  console.error(`FAIL step=${step} ${detail}`);
  if (evidence !== undefined) console.error(`evidence=${JSON.stringify(evidence)}`);
  process.exit(1);
}

function info(msg, obj) {
  console.log(msg + (obj === undefined ? "" : ` ${JSON.stringify(obj)}`));
}

function accessHeaders() {
  if (ACCESS_ID && ACCESS_SECRET) {
    return { "CF-Access-Client-Id": ACCESS_ID, "CF-Access-Client-Secret": ACCESS_SECRET };
  }
  return {};
}

async function api(path, { method = "GET", body, sendOrigin = false } = {}) {
  const headers = { ...accessHeaders() };
  if (sendOrigin) headers.Origin = APP_ORIGIN;
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${APP_ORIGIN}${path}`, { method, headers, body: payload });
  } catch (err) {
    fail("fetch", `network error ${method} ${path}`, String(err));
  }
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function reqState(body, step) {
  if (!body || typeof body !== "object" || !body.job || !Array.isArray(body.turns)) {
    fail(step, "expected JobStateResponse {job, turns}", body);
  }
  return body;
}

// Defensive field access across camelCase records and snake_case summary rows.
const turnIdx = (t) => t.turnIndex ?? t.turn_index;
const turnStatus = (t) => t.status;
const acceptedResponseId = (t) => t.acceptedResponseId ?? t.accepted_response_id ?? null;
const warningsOf = (t) => {
  if (Array.isArray(t.warningMessages)) return t.warningMessages;
  if (typeof t.warning_json === "string") {
    try {
      const v = JSON.parse(t.warning_json);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  return [];
};
const attemptResponseId = (a) => a.responseId ?? a.provider_response_id ?? null;
const attemptKind = (a) => a.kind ?? "";

async function listAllAttempts(jobId, turnIndex) {
  const items = [];
  let cursor = null;
  for (;;) {
    const q = new URLSearchParams({ limit: "100" });
    if (cursor) q.set("cursor", cursor);
    if (turnIndex !== undefined) q.set("turnIndex", String(turnIndex));
    const r = await api(`/api/jobs/${encodeURIComponent(jobId)}/attempts?${q}`);
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) {
      fail("attempts-list", `GET attempts job=${jobId} status=${r.status}`, r.text.slice(0, 500));
    }
    items.push(...r.json.items);
    if (!r.json.hasMore || !r.json.nextCursor) break;
    cursor = r.json.nextCursor;
  }
  return items;
}

async function getState(jobId, step) {
  const r = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (r.status !== 200) fail(step, `GET state job=${jobId} status=${r.status}`, r.text.slice(0, 500));
  return reqState(r.json, step);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function newJobId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `wetrun-recovery-${Date.now().toString(36)}-${rand}`;
}

async function main() {
  info("[config]", {
    appOrigin: APP_ORIGIN,
    judgeApiRoot: JUDGE_API_ROOT,
    judgeModel: JUDGE_MODEL,
    judgeSecretName: JUDGE_SECRET_NAME,
    accessHeaders: ACCESS_ID && ACCESS_SECRET ? "present" : "absent",
  });
  if (JUDGE_API_ROOT.endsWith("/responses")) {
    fail("env", "JUDGE_API_ROOT must be the bare version root (no trailing /responses)");
  }

  // ---- Step 1: create 3-turn cheap job; wait for turn-1 acceptance ----
  const jobId = newJobId();
  const createBody = {
    jobId,
    title: `wetrun recovery battery ${jobId}`,
    config: {
      model: "gpt-6-luna",
      reasoningEffort: "low",
      maxOutputTokens: 256,
      cacheTtl: "nocache",
      webSearch: false,
      maxContinuations: 3,
      maxAutoRetries: 1,
      judge: {
        enabled: true,
        provider: "openai",
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
      developerPrompt: "Write plain sentences. Keep every turn under 60 words.",
      developerFileIds: [],
    },
    initialTurns: [
      { turnIndex: 1, promptText: "Write one sentence about a lighthouse keeper.", attachmentFileIds: [] },
      { turnIndex: 2, promptText: "Write one sentence about the storm that followed.", attachmentFileIds: [] },
      { turnIndex: 3, promptText: "Write one sentence about the calm after the storm.", attachmentFileIds: [] },
    ],
  };
  const created = await api("/api/jobs", { method: "POST", body: createBody, sendOrigin: true });
  if (created.status !== 201) {
    fail("step1-create", `POST /api/jobs status=${created.status}`, created.text.slice(0, 500));
  }
  const createdState = reqState(created.json, "step1-create");
  info("[step1-create] job created", {
    jobId,
    status: createdState.job.status,
    currentTurnIndex: createdState.job.currentTurnIndex,
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let state = null;
  let turn1 = null;
  for (;;) {
    state = await getState(jobId, "step1-poll");
    turn1 = state.turns.find((t) => turnIdx(t) === 1);
    const s1 = turn1 ? turnStatus(turn1) : "missing";
    info("[step1-poll] status", {
      jobStatus: state.job.status,
      turn1Status: s1,
      acceptedTurnCount: state.job.acceptedTurnCount,
      generationCalls: state.usage?.generationCalls ?? null,
    });
    if (s1 === "accepted" || s1 === "accepted_with_warning") break;
    if (state.job.status === "failed" || state.job.status === "cancelled") {
      fail("step1-poll", `job reached terminal status=${state.job.status} before turn1 accepted`, {
        errorCode: state.job.errorCode,
        errorMessage: state.job.errorMessage,
      });
    }
    if (Date.now() > deadline) {
      fail("step1-poll", `turn1 not accepted within ${POLL_TIMEOUT_MS}ms`, {
        jobStatus: state.job.status,
        turn1Status: s1,
      });
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const parentTurn1ResponseId = acceptedResponseId(turn1);
  const genCalls = state.usage?.generationCalls ?? 0;
  if (!parentTurn1ResponseId) {
    fail("step1-poll", "turn1 accepted but accepted_response_id is null", turn1);
  }
  if (genCalls < 1) {
    fail("step1-poll", "spend gate: turn1 accepted with zero generation calls", state.usage);
  }
  info("[step1-accepted] spend gate proven", {
    jobId,
    turn1Status: turnStatus(turn1),
    acceptedResponseId: parentTurn1ResponseId,
    generationCalls: genCalls,
  });

  // ---- Step 2: pause -> resume without spending a retry ----
  const turn2Before = (await listAllAttempts(jobId, 2)).length;
  info("[step2-baseline] turn2 attempts before pause", { jobId, turn2Attempts: turn2Before });

  const paused = await api(`/api/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: "POST",
    sendOrigin: true,
  });
  if (paused.status !== 200) {
    fail("step2-pause", `POST pause status=${paused.status}`, paused.text.slice(0, 500));
  }
  const pausedState = reqState(paused.json, "step2-pause");
  if (pausedState.job.status !== "paused_operator") {
    fail("step2-pause", `expected paused_operator got ${pausedState.job.status}`, pausedState.job);
  }
  info("[step2-pause] halted", {
    jobId,
    from: state.job.status,
    to: pausedState.job.status,
    currentTurnIndex: pausedState.job.currentTurnIndex,
  });

  const turn2Paused = (await listAllAttempts(jobId, 2)).length;
  if (turn2Paused !== turn2Before) {
    fail("step2-pause", `pause added attempts on turn2 (${turn2Before} -> ${turn2Paused})`, null);
  }
  info("[step2-pause] attempt count unchanged by pause", { turn2Attempts: turn2Paused });

  const autoRetriesBefore = pausedState.job.autoRetriesUsed;
  const continuationsBefore = pausedState.job.continuationsUsed;

  const resumed = await api(`/api/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: "POST",
    sendOrigin: true,
  });
  if (resumed.status !== 200) {
    fail("step2-resume", `POST resume status=${resumed.status}`, resumed.text.slice(0, 500));
  }
  let resumedState = reqState(resumed.json, "step2-resume");
  info("[step2-resume] resumed", {
    jobId,
    to: resumedState.job.status,
    currentTurnIndex: resumedState.job.currentTurnIndex,
  });
  if (resumedState.job.currentTurnIndex !== 2) {
    fail("step2-resume", `resume skipped turn: currentTurnIndex=${resumedState.job.currentTurnIndex}`, null);
  }
  if (
    resumedState.job.autoRetriesUsed !== autoRetriesBefore ||
    resumedState.job.continuationsUsed !== continuationsBefore
  ) {
    fail("step2-resume", "resume spent automatic budget", {
      autoRetries: [autoRetriesBefore, resumedState.job.autoRetriesUsed],
      continuations: [continuationsBefore, resumedState.job.continuationsUsed],
    });
  }
  // Resume restarts scheduling (ready -> running); allow a short settle.
  if (resumedState.job.status !== "running") {
    const settleBy = Date.now() + 60000;
    while (resumedState.job.status !== "running" && Date.now() < settleBy) {
      await sleep(5000);
      resumedState = await getState(jobId, "step2-resume");
    }
  }
  if (resumedState.job.status !== "running" && resumedState.job.status !== "ready") {
    fail("step2-resume", `job not running after resume: ${resumedState.job.status}`, null);
  }
  info("[step2-resume] scheduling again", {
    jobId,
    status: resumedState.job.status,
    currentTurnIndex: resumedState.job.currentTurnIndex,
  });

  const turn2After = await listAllAttempts(jobId, 2);
  const retryKinds = turn2After.filter((a) => /retry|manual/i.test(attemptKind(a)));
  if (retryKinds.length > 0) {
    fail("step2-resume", "resume spent a retry-kind attempt on turn2", retryKinds.map((a) => a.attemptId ?? a.attempt_id));
  }
  info("[step2-resume] no retry spent", {
    turn2AttemptsBefore: turn2Before,
    turn2AttemptsAfter: turn2After.length,
    autoRetriesUsed: resumedState.job.autoRetriesUsed,
    continuationsUsed: resumedState.job.continuationsUsed,
  });

  // ---- Step 3: branch at forkTurnIndex 1 (parent must be quiescent) ----
  let parentState = await getState(jobId, "step3-quiesce");
  if (parentState.activeAttempt !== null) {
    const repause = await api(`/api/jobs/${encodeURIComponent(jobId)}/pause`, {
      method: "POST",
      sendOrigin: true,
    });
    if (repause.status !== 200) {
      fail("step3-quiesce", `re-pause before branch status=${repause.status}`, repause.text.slice(0, 500));
    }
    parentState = reqState(repause.json, "step3-quiesce");
    info("[step3-quiesce] parent re-paused for branch quiescence", {
      jobId,
      status: parentState.job.status,
    });
  } else {
    info("[step3-quiesce] parent already quiescent", {
      jobId,
      status: parentState.job.status,
    });
  }

  const branched = await api(`/api/jobs/${encodeURIComponent(jobId)}/branch`, {
    method: "POST",
    body: { forkTurnIndex: 1 },
    sendOrigin: true,
  });
  if (branched.status !== 200) {
    fail("step3-branch", `POST branch status=${branched.status}`, branched.text.slice(0, 500));
  }
  if (!branched.json || branched.json.kind !== "created" || !branched.json.branchJobId) {
    fail("step3-branch", "branch outcome not created", branched.json ?? branched.text.slice(0, 500));
  }
  const childJobId = branched.json.branchJobId;
  info("[step3-branch] child created", {
    parentJobId: jobId,
    childJobId,
    parentSuperseded: branched.json.parentSuperseded,
  });

  const childState = await getState(childJobId, "step3-branch");
  const childTurn1 = childState.turns.find((t) => turnIdx(t) === 1);
  if (!childTurn1) fail("step3-branch", "child has no turn 1", childState.turns);
  if (!["ready", "running", "completed"].includes(childState.job.status)) {
    fail("step3-branch", `child did not activate: status=${childState.job.status}`, childState.job);
  }
  const childProvenance = childState.job.branchProvenance ?? null;
  if (!childProvenance || childProvenance.parentJobId !== jobId || childProvenance.forkTurnIndex !== 1) {
    fail("step3-branch", "child branch provenance mismatch", childProvenance);
  }
  const childTurn1ResponseId = acceptedResponseId(childTurn1);
  if (childTurn1ResponseId !== parentTurn1ResponseId) {
    fail("step3-branch", "child turn1 provenance differs from parent", {
      parent: parentTurn1ResponseId,
      child: childTurn1ResponseId,
    });
  }
  info("[step3-branch] child active with inherited provenance", {
    childJobId,
    childStatus: childState.job.status,
    childTurn1Status: turnStatus(childTurn1),
    acceptedResponseId: childTurn1ResponseId,
  });

  // ---- Step 4: force_accept_latest on the child iff a turn is unaccepted ----
  const childNow = await getState(childJobId, "step4-review");
  const unaccepted = childNow.turns.filter(
    (t) => turnStatus(t) !== "accepted" && turnStatus(t) !== "accepted_with_warning",
  );
  if (unaccepted.length === 0) {
    info("[step4-review] SKIP no unaccepted turn on child; force_accept_latest not applicable", {
      childJobId,
      childStatus: childNow.job.status,
    });
  } else {
    const target = unaccepted[0];
    info("[step4-review] unaccepted child turn found", {
      childJobId,
      turnIndex: turnIdx(target),
      turnStatus: turnStatus(target),
    });
    if (!["paused_operator", "paused_review", "paused_dispatch", "paused_storage", "failed"].includes(childNow.job.status)) {
      const cp = await api(`/api/jobs/${encodeURIComponent(childJobId)}/pause`, {
        method: "POST",
        sendOrigin: true,
      });
      if (cp.status !== 200) {
        fail("step4-review", `pause child before force-accept status=${cp.status}`, cp.text.slice(0, 500));
      }
      info("[step4-review] child paused for force-accept", { childJobId });
    }
    const reviewed = await api(`/api/jobs/${encodeURIComponent(childJobId)}/review`, {
      method: "POST",
      body: { kind: "force_accept_latest", note: "wetrun recovery battery" },
      sendOrigin: true,
    });
    if (reviewed.status !== 200) {
      fail("step4-review", `POST review force_accept_latest status=${reviewed.status}`, reviewed.text.slice(0, 500));
    }
    const afterReview = reqState(reviewed.json, "step4-review");
    const forced = afterReview.turns.find((t) => turnIdx(t) === turnIdx(target));
    const warns = forced ? warningsOf(forced) : [];
    if (!warns.includes("operator_force_accepted")) {
      fail("step4-review", "operator_force_accepted warning missing after force_accept", {
        turnIndex: turnIdx(target),
        warnings: warns,
      });
    }
    info("[step4-review] force-accepted with warning", {
      childJobId,
      turnIndex: turnIdx(target),
      turnStatus: forced ? turnStatus(forced) : "missing",
      warnings: warns,
    });
  }

  // ---- Step 5: child JSONL export inherits, never re-spends ----
  const parentAttempts = await listAllAttempts(jobId);
  const parentResponseIds = new Set(
    parentAttempts.map(attemptResponseId).filter((id) => typeof id === "string" && id.length > 0),
  );
  info("[step5-baseline] parent provider response ids", {
    parentJobId: jobId,
    attemptCount: parentAttempts.length,
    responseIdCount: parentResponseIds.size,
  });

  const jsonl = await api(`/api/jobs/${encodeURIComponent(childJobId)}/export/jsonl`);
  if (jsonl.status !== 200) {
    fail("step5-export", `GET child jsonl status=${jsonl.status}`, jsonl.text.slice(0, 500));
  }
  const lines = jsonl.text.split("\n").filter((l) => l.trim().length > 0);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      fail("step5-export", "child JSONL has unparseable line", line.slice(0, 200));
    }
  }
  const attemptLines = records.filter((r) => r && r.type === "attempt");
  const copiedAttempts = attemptLines.filter((r) => {
    const a = r.attempt ?? {};
    const ti = a.turn_index ?? a.turnIndex;
    return ti === 1;
  });
  const freshSpend = copiedAttempts.filter((r) => {
    const a = r.attempt ?? {};
    const id = a.provider_response_id ?? a.responseId ?? a.response_id ?? null;
    return typeof id === "string" && id.length > 0 && !parentResponseIds.has(id);
  });
  if (freshSpend.length > 0) {
    fail("step5-export", "child copied turns carry new provider spend", freshSpend.slice(0, 3));
  }
  const turnLines = records.filter((r) => r && r.type === "turn" && (r.turn?.turn_index ?? r.turn?.turnIndex) === 1);
  const exportTurn1Response = turnLines.length > 0 ? (turnLines[0].responseId ?? turnLines[0].turn?.accepted_response_id ?? null) : null;
  info("[step5-export] lineage holds, no fresh spend on copied turns", {
    childJobId,
    jsonlLines: lines.length,
    copiedTurn1Attempts: copiedAttempts.length,
    freshSpend: 0,
    turn1ResponseId: exportTurn1Response,
    parentTurn1ResponseId,
  });

  info("[done] recovery battery passed", { parentJobId: jobId, childJobId });
}

main().catch((err) => fail("fatal", String(err?.stack ?? err)));
