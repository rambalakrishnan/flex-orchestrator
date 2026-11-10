// Covers: 16, 17, 19, 20
//
// Wave D2 gaps for flex-orchestrator jobs handler: judge outcome branching,
// conditional feedback injection, streaming exports, and live JSON semantics.
// Drives mainWorker.fetch + stubbed provider fetch; settles RouterDO alarms
// against persisted deadlines; asserts handler/DO-observable state only.

import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REGISTRY_DO_NAME, ROUTER_DO_NAME } from "../../src/constants.ts";
import type {
  GenerationAttemptSummaryRow,
  JudgeCallSummaryRow,
  TurnSummaryRow,
} from "../../src/db/schema.ts";
import type { CursorPage, JobStateResponse, ResponseRouteMapping } from "../../src/types.ts";
import { buildWebhookHeaders } from "../fixtures/webhooks.ts";

// cloudflare:workers does not model the test worker's default export in this typing context.
const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;

const APP_ORIGIN = "https://app.test";
const APP_HOST = "app.test";
const HOOKS_URL = "https://hooks.test/openai";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

// ---------------------------------------------------------------------------
// Test plan state (reset per test via installProviderMock)
// ---------------------------------------------------------------------------

interface CapturedCall {
  readonly method: string;
  readonly url: string;
  readonly bodyText: string | null;
}

interface PlannedGeneration {
  readonly responseId: string;
  readonly text: string;
}

type PlannedJudge =
  | { readonly kind: "chat"; readonly json: string; readonly responseId: string }
  | { readonly kind: "error"; readonly status: number; readonly body: unknown };

let jobSequence = 0;
let webhookSequence = 0;
const trackedJobIds: string[] = [];

let capturedCalls: CapturedCall[] = [];
let generationQueue: PlannedGeneration[] = [];
let generationTexts = new Map<string, string>();
let judgeQueue: PlannedJudge[] = [];

function nextJobId(prefix: string): string {
  jobSequence += 1;
  return `${prefix}_${jobSequence}`;
}

function trackJobId(jobId: string): void {
  if (!trackedJobIds.includes(jobId)) {
    trackedJobIds.push(jobId);
  }
}

function nextWebhookIds(prefix: string): {
  readonly webhookId: string;
  readonly eventId: string;
} {
  webhookSequence += 1;
  return {
    webhookId: `wh-${prefix}-${webhookSequence}`,
    eventId: `evt-${prefix}-${webhookSequence}`,
  };
}

function providerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function decodeRequestBody(body: BodyInit | null | undefined): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return utf8Decoder.decode(new Uint8Array(body));
  }
  if (body instanceof Uint8Array) {
    return utf8Decoder.decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    return utf8Decoder.decode(new Uint8Array(buf as ArrayBuffer));
  }
  return null;
}

function completedGenerationBody(responseId: string, text: string): unknown {
  return {
    id: responseId,
    model: "gpt-5",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
  };
}

function chatJudgeBody(judgeJson: string, responseId: string): unknown {
  return {
    id: responseId,
    object: "chat.completion",
    created: 1_760_000_000,
    model: "gpt-5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: judgeJson },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

/**
 * Stubs outbound fetch for api.openai.com only. Generation POSTs pop from
 * generationQueue; GETs serve the stored text; judge POSTs pop from judgeQueue.
 */
function installProviderMock(): CapturedCall[] {
  capturedCalls = [];
  generationQueue = [];
  generationTexts = new Map();
  judgeQueue = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname !== "api.openai.com") {
        throw new Error(`Unexpected outbound fetch host: ${url}`);
      }
      const method = (init?.method ?? "GET").toUpperCase();
      const bodyText = decodeRequestBody(init?.body as BodyInit | null | undefined);
      capturedCalls.push({ method, url, bodyText });

      if (method === "POST" && url.endsWith("/chat/completions")) {
        const next = judgeQueue.shift();
        if (next === undefined) {
          throw new Error("No planned judge response for POST /chat/completions");
        }
        if (next.kind === "error") {
          return providerJson(next.body, next.status);
        }
        return providerJson(chatJudgeBody(next.json, next.responseId));
      }
      if (method === "POST" && url.endsWith("/responses")) {
        const next = generationQueue.shift();
        if (next === undefined) {
          throw new Error("No planned generation response for POST /responses");
        }
        generationTexts.set(next.responseId, next.text);
        return providerJson({ id: next.responseId, model: "gpt-5", status: "queued" });
      }
      const getMatch = /\/responses\/([^/]+)$/.exec(url);
      if (method === "GET" && getMatch !== null) {
        const responseId = decodeURIComponent(getMatch[1] ?? "");
        const text = generationTexts.get(responseId);
        if (text === undefined) {
          throw new Error(`No planned generation text for GET ${responseId}`);
        }
        return providerJson(completedGenerationBody(responseId, text));
      }
      if (method === "POST" && url.endsWith("/cancel")) {
        return providerJson({ ok: true });
      }
      throw new Error(`Unexpected provider call: ${method} ${url}`);
    }),
  );
  return capturedCalls;
}

function planGenerations(plans: readonly PlannedGeneration[]): void {
  generationQueue.push(...plans);
}

function planJudges(plans: readonly PlannedJudge[]): void {
  judgeQueue.push(...plans);
}

function judgeJson(params: {
  readonly verdict: "YES" | "NO";
  readonly grade: string | number;
  readonly comment: string;
  readonly tag: boolean;
  readonly visibility: boolean;
}): string {
  return JSON.stringify({
    verdict: params.verdict,
    grade: params.grade,
    comment: params.comment,
    tag_matches_expected_step: params.tag,
    file_visibility: params.visibility,
  });
}

function capturedGenerationPosts(): CapturedCall[] {
  return capturedCalls.filter((call) => call.method === "POST" && call.url.endsWith("/responses"));
}


// ---------------------------------------------------------------------------
// HTTP helpers (mainWorker.fetch)
// ---------------------------------------------------------------------------

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

interface AcceptedReceipt {
  readonly kind: "accepted";
  readonly webhookId: string;
  readonly duplicate: boolean;
  readonly matchedJobId: string | null;
}

function baseJudge(enabled: true, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled,
    provider: "openai",
    apiRoot: "https://api.openai.com/v1",
    secretName: "OPENAI_API_KEY",
    model: "gpt-5",
    transport: "chat_completions",
    historyMode: "stateless",
    fileDeliveryMode: "inline",
    includePrior: false,
    maxGradeThreshold: 80,
    injectOnFail: true,
    injectOnPass: false,
    developerPrompt: "",
    ...overrides,
  };
}

function baseConfig(judge: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "gpt-5",
    reasoningEffort: "medium",
    maxOutputTokens: 4096,
    cacheTtl: "nocache",
    webSearch: false,
    maxContinuations: 3,
    maxAutoRetries: 1,
    judge,
    developerPrompt: "",
    developerFileIds: [],
  };
}

async function createJob(
  jobId: string,
  config: Record<string, unknown>,
  initialTurns: readonly Record<string, unknown>[],
): Promise<JobStateResponse> {
  const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({
      jobId,
      title: `Gaps ${jobId}`,
      config,
      initialTurns,
    }),
  });
  expect(response.status).toBe(201);
  trackJobId(jobId);
  return (await response.json()) as JobStateResponse;
}

async function getJob(jobId: string): Promise<JobStateResponse> {
  const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as JobStateResponse;
}

async function appendTurn(jobId: string, promptText: string): Promise<JobStateResponse> {
  const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify({ promptText, attachmentFileIds: [] }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as JobStateResponse;
}

async function listTurns(jobId: string): Promise<CursorPage<TurnSummaryRow>> {
  const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/turns?limit=100`);
  expect(response.status).toBe(200);
  return (await response.json()) as CursorPage<TurnSummaryRow>;
}

async function listAttempts(jobId: string): Promise<CursorPage<GenerationAttemptSummaryRow>> {
  const response = await mainWorker.fetch(
    `https://${APP_HOST}/api/jobs/${jobId}/attempts?limit=100`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as CursorPage<GenerationAttemptSummaryRow>;
}

async function listJudgeCalls(jobId: string): Promise<CursorPage<JudgeCallSummaryRow>> {
  const response = await mainWorker.fetch(
    `https://${APP_HOST}/api/jobs/${jobId}/judge-calls?limit=100`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as CursorPage<JudgeCallSummaryRow>;
}

function routerStub(): DurableObjectStub {
  return env.ROUTER_DO.get(env.ROUTER_DO.idFromName(ROUTER_DO_NAME));
}

interface RouterTestRpc {
  registerResponseRoute(mapping: ResponseRouteMapping): Promise<void>;
}

async function postWebhook(responseId: string, prefix: string): Promise<string> {
  const ids = nextWebhookIds(prefix);
  const rawBody = utf8Encoder.encode(
    JSON.stringify({ id: ids.eventId, type: "response.completed", data: { id: responseId } }),
  );
  const headers = await buildWebhookHeaders({
    webhookId: ids.webhookId,
    timestampSeconds: Math.floor(Date.now() / 1000),
    rawBody,
    secret: env.OPENAI_WEBHOOK_SECRET,
  });
  const response = await mainWorker.fetch(HOOKS_URL, {
    method: "POST",
    headers,
    body: rawBody,
  });
  expect(response.status).toBe(200);
  const receipt = (await response.json()) as AcceptedReceipt;
  expect(receipt.kind).toBe("accepted");
  expect(receipt.webhookId).toBe(ids.webhookId);
  return ids.webhookId;
}

/** Makes one inbox row due then drives the RouterDO alarm; asserts delivery effect. */
async function deliverViaRouterAlarm(webhookId: string): Promise<void> {
  const stub = routerStub();
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec("UPDATE webhook_inbox SET next_attempt_at_ms = 1 WHERE webhook_id = ?", webhookId);
    await state.storage.setAlarm(1);
  });
  // The RouterDO alarm is scheduled at receivedAtMs ≈ now and may auto-fire on
  // stub activity between ingress and this helper, so the manual fire is not
  // asserted — delivery success is. Either path must leave a delivered row.
  await runDurableObjectAlarm(stub);
  const status = await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ status: string }>("SELECT status FROM webhook_inbox WHERE webhook_id = ?", webhookId)
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing webhook inbox row: ${webhookId}`);
    }
    return row.status;
  });
  expect(status).toBe("delivered");
}

/** Settles the job's current active attempt via webhook ingress + RouterDO alarm. */
async function settleActiveAttempt(jobId: string, prefix: string): Promise<JobStateResponse> {
  const before = await getJob(jobId);
  const activeAttempt = before.activeAttempt;
  const responseId = activeAttempt?.responseId ?? null;
  expect(responseId).not.toBeNull();
  expect(activeAttempt).not.toBeNull();
  if (responseId === null || activeAttempt === null) {
    throw new Error(`Expected active attempt for ${jobId}`);
  }
  // Mirror test/integration/webhook-races.test.ts: register the response route
  // before ingress so the enqueue matches (pending) and schedules the delivery
  // alarm. Re-registering the identical mapping is idempotent when JobDO already
  // registered it during dispatch.
  const router = routerStub() as unknown as RouterTestRpc;
  await router.registerResponseRoute({
    responseId,
    jobId,
    attemptId: activeAttempt.attemptId,
    turnIndex: activeAttempt.turnIndex,
    registeredAtMs: Date.now(),
    settledAtMs: null,
  });
  const webhookId = await postWebhook(responseId, prefix);
  await deliverViaRouterAlarm(webhookId);
  return getJob(jobId);
}

async function readRouterAlarm(): Promise<number | null> {
  return runInDurableObject(routerStub(), async (_instance, state) => state.storage.getAlarm());
}

interface JsonExportBody {
  readonly exportFormat: string;
  readonly exportVersion: number;
  readonly startingRevision: number;
  readonly maxTurnIndex: number;
  readonly maxAttemptId: string | null;
  readonly maxJudgeCallId: string | null;
  readonly highWaterMarks: {
    readonly startingRevision: number;
    readonly maxTurnIndex: number;
    readonly maxAttemptId: string | null;
    readonly maxJudgeCallId: string | null;
  };
  readonly job: { readonly jobId: string; readonly status: string; readonly revision: number; readonly acceptedTurnCount: number };
  readonly turns: ReadonlyArray<{ readonly turn_index: number; readonly status: string }>;
  readonly attempts: ReadonlyArray<{ readonly attempt_id: string; readonly turn_index: number }>;
  readonly judgeCalls: ReadonlyArray<{ readonly judge_call_id: string }>;
  readonly fileIds: readonly string[];
  readonly missingArtifacts: ReadonlyArray<{
    readonly artifactKind: string;
    readonly ownerId: string;
    readonly reason: string;
  }>;
  readonly exportComplete: boolean;
}

function expectNoCredentials(text: string): void {
  const apiKey = String(env.OPENAI_API_KEY ?? "");
  const webhookSecret = String(env.OPENAI_WEBHOOK_SECRET ?? "");
  expect(apiKey.length).toBeGreaterThan(0);
  expect(webhookSecret.length).toBeGreaterThan(0);
  expect(text).not.toContain(apiKey);
  expect(text).not.toContain(webhookSecret);
  expect(text).not.toContain("Authorization");
  expect(text).not.toContain("authorization");
  expect(text).not.toContain("Bearer");
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const jobId of trackedJobIds.splice(0)) {
    const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
  await runInDurableObject(routerStub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  const registry = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME));
  await runInDurableObject(registry, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  await reset();
  await abortAllDurableObjects();
});

// ---------------------------------------------------------------------------
// Items 16 + 17: judge branching and conditional injection
// ---------------------------------------------------------------------------

describe("judge feedback injection", () => {
  it("injectOnFail true appends the exact JUDGE CRITIQUE suffix to the retry prompt and request", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_crit_true");
    const originalPrompt = "Write section one.";
    const critique = "Add citations.";
    planGenerations([
      { responseId: `${jobId}_r1`, text: "Draft one <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Draft two <!-- TURN_END:1 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "NO", grade: "F", comment: critique, tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Good now.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, { injectOnFail: true, injectOnPass: false })), [
      { turnIndex: 1, promptText: originalPrompt, attachmentFileIds: [] },
    ]);
    const afterFirst = await settleActiveAttempt(jobId, "crit-true-1");
    expect(afterFirst.job.status).toBe("running");
    expect(afterFirst.job.autoRetriesUsed).toBe(1);
    expect(afterFirst.turns[0]?.promptText).toBe(
      `${originalPrompt}\n\n### JUDGE CRITIQUE:\n${critique}\n\nRevise your output to address this.`,
    );

    const posts = capturedGenerationPosts();
    expect(posts).toHaveLength(2);
    expect(posts[0]?.bodyText ?? "").toContain(originalPrompt);
    expect(posts[0]?.bodyText ?? "").not.toContain("### JUDGE CRITIQUE");
    expect(posts[1]?.bodyText ?? "").toContain("### JUDGE CRITIQUE");
    expect(posts[1]?.bodyText ?? "").toContain(critique);
    expect(posts[1]?.bodyText ?? "").toContain("Revise your output to address this.");

    const settled = await settleActiveAttempt(jobId, "crit-true-2");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.turns[0]?.promptText).toContain("### JUDGE CRITIQUE");

    const judges = await listJudgeCalls(jobId);
    expect(judges.items).toHaveLength(2);
    expect(judges.items[0]?.verdict).toBe("FAIL");
    expect(judges.items[1]?.verdict).toBe("PASS");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("injectOnFail false leaves the retry prompt and request unmodified", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_crit_false");
    const originalPrompt = "Write section one.";
    // Grade-only failure (PASS verdict, grade below threshold) still consumes retry budget.
    planGenerations([
      { responseId: `${jobId}_r1`, text: "Draft one <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Draft two <!-- TURN_END:1 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "F", comment: "Too shallow.", tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Good now.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, { injectOnFail: false, injectOnPass: false })), [
      { turnIndex: 1, promptText: originalPrompt, attachmentFileIds: [] },
    ]);
    const afterFirst = await settleActiveAttempt(jobId, "crit-false-1");
    expect(afterFirst.job.status).toBe("running");
    expect(afterFirst.job.autoRetriesUsed).toBe(1);
    expect(afterFirst.turns[0]?.promptText).toBe(originalPrompt);

    const posts = capturedGenerationPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.bodyText ?? "").not.toContain("### JUDGE CRITIQUE");
    expect(posts[1]?.bodyText ?? "").not.toContain("Too shallow.");

    const settled = await settleActiveAttempt(jobId, "crit-false-2");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]?.promptText).toBe(originalPrompt);

    const judges = await listJudgeCalls(jobId);
    expect(judges.items[0]?.verdict).toBe("PASS");
    expect(judges.items[0]?.grade).toBe(50);
    expect(await readRouterAlarm()).toBeNull();
  });

  it("injectOnPass true appends the exact PM STEERING NOTE to the next pending prompt before dispatch", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_steer_true");
    const firstPrompt = "First.";
    const secondPrompt = "Second.";
    const steering = "Keep tone.";
    planGenerations([
      { responseId: `${jobId}_r1`, text: "One <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Two <!-- TURN_END:2 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: steering, tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Done.", tag: true, visibility: true }),
      },
    ]);

    await createJob(
      jobId,
      baseConfig(baseJudge(true, { injectOnFail: true, injectOnPass: true })),
      [
        { turnIndex: 1, promptText: firstPrompt, attachmentFileIds: [] },
        { turnIndex: 2, promptText: secondPrompt, attachmentFileIds: [] },
      ],
    );
    const afterFirst = await settleActiveAttempt(jobId, "steer-true-1");
    expect(afterFirst.turns[0]?.status).toBe("accepted");
    expect(afterFirst.turns[1]?.promptText).toBe(`${secondPrompt}\n\n### PM STEERING NOTE:\n${steering}`);

    const posts = capturedGenerationPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.bodyText ?? "").toContain("### PM STEERING NOTE");
    expect(posts[1]?.bodyText ?? "").toContain(steering);

    const settled = await settleActiveAttempt(jobId, "steer-true-2");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[1]?.status).toBe("accepted");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("injectOnPass false leaves the next prompt unchanged", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_steer_false");
    const secondPrompt = "Second.";
    planGenerations([
      { responseId: `${jobId}_r1`, text: "One <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Two <!-- TURN_END:2 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Keep tone.", tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Done.", tag: true, visibility: true }),
      },
    ]);

    await createJob(
      jobId,
      baseConfig(baseJudge(true, { injectOnFail: true, injectOnPass: false })),
      [
        { turnIndex: 1, promptText: "First.", attachmentFileIds: [] },
        { turnIndex: 2, promptText: secondPrompt, attachmentFileIds: [] },
      ],
    );
    const afterFirst = await settleActiveAttempt(jobId, "steer-false-1");
    expect(afterFirst.turns[1]?.promptText).toBe(secondPrompt);
    const posts = capturedGenerationPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1]?.bodyText ?? "").not.toContain("### PM STEERING NOTE");

    const settled = await settleActiveAttempt(jobId, "steer-false-2");
    expect(settled.job.status).toBe("completed");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("legacy judge JSON without injection flags defaults to injectOnFail true and injectOnPass false", async () => {
    installProviderMock();
    planGenerations([{ responseId: "resp_legacy_unused", text: "x <!-- TURN_END:1 -->" }]);
    const jobId = nextJobId("job_gaps_legacy_flags");
    const legacyJudge = {
      enabled: true,
      provider: "openai",
      apiRoot: "https://api.openai.com/v1",
      secretName: "OPENAI_API_KEY",
      model: "gpt-5",
      transport: "chat_completions",
      historyMode: "stateless",
      fileDeliveryMode: "inline",
      includePrior: false,
      maxGradeThreshold: 80,
      developerPrompt: "",
    };
    const created = await createJob(jobId, baseConfig(legacyJudge), [
      { turnIndex: 1, promptText: "Legacy.", attachmentFileIds: [] },
    ]);
    const judge = created.job.config.judge;
    expect(judge.enabled).toBe(true);
    if (!judge.enabled) {
      throw new Error("expected enabled judge");
    }
    expect(judge.injectOnFail).toBe(true);
    expect(judge.injectOnPass).toBe(false);
  });
});

describe("judge outcome branching", () => {
  it("exhausted retry budget pauses for review with judge rejection codes", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_exhausted");
    planGenerations([
      { responseId: `${jobId}_r1`, text: "Bad one <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Bad two <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r3`, text: "Fixed <!-- TURN_END:1 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "NO", grade: "F", comment: "Bad one.", tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "NO", grade: "F", comment: "Bad two.", tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j3`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Fixed.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, { injectOnFail: true })), [
      { turnIndex: 1, promptText: "Write it.", attachmentFileIds: [] },
    ]);
    await settleActiveAttempt(jobId, "exhaust-1");
    const paused = await settleActiveAttempt(jobId, "exhaust-2");
    expect(paused.job.status).toBe("paused_review");
    expect(paused.turns[0]?.status).toBe("paused_review");
    expect(paused.job.autoRetriesUsed).toBe(1);
    expect(paused.job.errorCode ?? "").toContain("judge_rejected");
    expect(paused.job.errorMessage).toBe("Bad two.");
    expect(paused.activeAttempt).toBeNull();

    const fragment = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`);
    expect(fragment.status).toBe(200);
    const html = await fragment.text();
    expect(html).toContain("judge_rejected");
    expect(html).toContain("Retry Turn");
    expect(html).toContain("Force Accept");
    expect(html).toContain("Bad two.");

    // While halted the judge config is replaceable; the retry then resumes via review.
    const updated = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/judge-config`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify(baseJudge(true, { injectOnFail: true, maxGradeThreshold: 70 })),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as JobStateResponse;
    const judge = updatedBody.job.config.judge;
    expect(judge.enabled).toBe(true);
    if (judge.enabled) {
      expect(judge.maxGradeThreshold).toBe(70);
    }

    const retried = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ kind: "manual_retry" }),
    });
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as JobStateResponse;
    expect(retriedBody.job.status).toBe("running");
    expect(retriedBody.activeAttempt?.responseId).toBe(`${jobId}_r3`);

    const completed = await settleActiveAttempt(jobId, "exhaust-3");
    expect(completed.job.status).toBe("completed");
    expect(completed.turns[0]?.status).toBe("accepted");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("judge-only tag disagreement pauses distinctly from parser wrong_index", async () => {
    installProviderMock();
    const tagJobId = nextJobId("job_gaps_tag");
    const wrongJobId = nextJobId("job_gaps_wrong");
    planGenerations([
      { responseId: `${tagJobId}_r1`, text: "Valid body <!-- TURN_END:1 -->" },
      { responseId: `${wrongJobId}_r1`, text: "Hello <!-- TURN_END:99 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${tagJobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Tag looks off.", tag: false, visibility: true }),
      },
    ]);

    await createJob(tagJobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Tag turn.", attachmentFileIds: [] },
    ]);
    await createJob(wrongJobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Wrong turn.", attachmentFileIds: [] },
    ]);

    const tagPaused = await settleActiveAttempt(tagJobId, "tag-1");
    expect(tagPaused.job.status).toBe("paused_review");
    expect(tagPaused.turns[0]?.status).toBe("paused_review");
    expect(tagPaused.job.errorCode).toBe("judge_tag_disagreement");
    expect(tagPaused.job.errorMessage).toBe("Tag looks off.");
    const tagJudges = await listJudgeCalls(tagJobId);
    expect(tagJudges.items).toHaveLength(1);
    expect(tagJudges.items[0]?.verdict).toBe("PASS");
    expect(tagJudges.items[0]?.tag_agreement).toBe(0);

    const wrongFailed = await settleActiveAttempt(wrongJobId, "wrong-1");
    expect(wrongFailed.job.status).toBe("failed");
    expect(wrongFailed.turns[0]?.status).toBe("failed");
    expect(wrongFailed.job.errorCode).toBe("wrong_index");
    const wrongJudges = await listJudgeCalls(wrongJobId);
    expect(wrongJudges.items).toHaveLength(0);

    // Operator review accepts the structurally valid tag-paused candidate.
    const accepted = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${tagJobId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ kind: "accept_with_warning", note: "operator reviewed tag" }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as JobStateResponse;
    expect(acceptedBody.job.status).toBe("completed");
    expect(acceptedBody.turns[0]?.status).toBe("accepted");
    expect(acceptedBody.turns[0]?.warningMessages).toContain("operator_accept_with_warning");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("incomplete file visibility on PASS accepts with a coverage warning", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_visibility");
    planGenerations([{ responseId: `${jobId}_r1`, text: "Covered <!-- TURN_END:1 -->" }]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Good but missing file.", tag: true, visibility: false }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Visibility turn.", attachmentFileIds: [] },
    ]);
    const settled = await settleActiveAttempt(jobId, "vis-1");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.turns[0]?.warningMessages).toContain("judge_file_visibility_incomplete");
    expect(settled.turns[0]?.marginalInputTokens).toBe(12);

    const judges = await listJudgeCalls(jobId);
    expect(judges.items).toHaveLength(1);
    expect(judges.items[0]?.verdict).toBe("PASS");
    expect(judges.items[0]?.file_visibility).toBe(0);
    expect(judges.items[0]?.comment).toBe("Good but missing file.");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("judge infrastructure failure accepts with a warning and preserves the unknown result", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_judge_unknown");
    planGenerations([{ responseId: `${jobId}_r1`, text: "Valid body <!-- TURN_END:1 -->" }]);
    planJudges([
      { kind: "error", status: 500, body: { error: { code: "server_error", message: "judge down" } } },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Unknown turn.", attachmentFileIds: [] },
    ]);
    const settled = await settleActiveAttempt(jobId, "unknown-1");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.turns[0]?.warningMessages.some((w) => w.startsWith("judge_unknown:"))).toBe(true);

    const judges = await listJudgeCalls(jobId);
    expect(judges.items).toHaveLength(1);
    expect(judges.items[0]?.status).toBe("unknown");
    expect(judges.items[0]?.verdict).toBe("UNKNOWN");

    const fragment = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`);
    expect(fragment.status).toBe(200);
    expect(await fragment.text()).toContain("UNKNOWN");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("rejects judge-config edits while running and validates replacement shape while halted", async () => {
    installProviderMock();
    planGenerations([
      { responseId: "resp_halt_r1", text: "x <!-- TURN_END:1 -->" },
      { responseId: "resp_halt_r2", text: "y <!-- TURN_END:1 -->" },
    ]);
    const jobId = nextJobId("job_gaps_halt");
    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Halt turn.", attachmentFileIds: [] },
    ]);

    const runningEdit = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/judge-config`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ enabled: false }),
    });
    expect(runningEdit.status).toBe(409);
    expect(((await runningEdit.json()) as ErrorBody).error.code).toBe("job_not_halted");

    const paused = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/pause`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(paused.status).toBe(200);

    const malformed = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/judge-config`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ enabled: true, model: "x" }),
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as ErrorBody).error.code).toBe("invalid_judge_config");

    const disabled = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/judge-config`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as JobStateResponse).job.config.judge).toEqual({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// Items 19 + 20: streaming exports and live JSON semantics
// ---------------------------------------------------------------------------

describe("streaming exports", () => {
  it("markdown export captures the accepted-prefix boundary and excludes later acceptances", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_md_boundary");
    planGenerations([
      { responseId: `${jobId}_r1`, text: "Alpha content <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Beta content <!-- TURN_END:2 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Alpha ok.", tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Beta ok.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "First section.", attachmentFileIds: [] },
    ]);
    const firstSettled = await settleActiveAttempt(jobId, "md-1");
    expect(firstSettled.job.acceptedTurnCount).toBe(1);

    // Marks are captured when headers return, before the body streams.
    const exportResponse = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/export?format=markdown`,
    );
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type") ?? "").toContain("text/markdown");

    // Mid-stream acceptance: appended and settled before the body is consumed.
    await appendTurn(jobId, "Second section.");
    await settleActiveAttempt(jobId, "md-2");
    const afterMidStream = await getJob(jobId);
    expect(afterMidStream.job.acceptedTurnCount).toBe(2);

    const markdown = await exportResponse.text();
    expect(markdown).toContain("Included turns: 1-1");
    expect(markdown).toContain("Accepted turns: 1");
    expect(markdown).toContain("Alpha content");
    expect(markdown).not.toContain("Beta content");
    expectNoCredentials(markdown);

    const fresh = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export?format=markdown`);
    expect(fresh.status).toBe(200);
    const freshText = await fresh.text();
    expect(freshText).toContain("Included turns: 1-2");
    expect(freshText).toContain("Alpha content");
    expect(freshText).toContain("Beta content");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("live JSON export records starting revision and high-water keys and excludes mid-stream records", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_json_hwm");
    planGenerations([
      { responseId: `${jobId}_r1`, text: "First <!-- TURN_END:1 -->" },
      { responseId: `${jobId}_r2`, text: "Second <!-- TURN_END:2 -->" },
    ]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "First ok.", tag: true, visibility: true }),
      },
      {
        kind: "chat",
        responseId: `${jobId}_j2`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Second ok.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Turn one.", attachmentFileIds: [] },
    ]);
    await settleActiveAttempt(jobId, "hwm-1");
    const before = await getJob(jobId);
    const beforeAttempts = await listAttempts(jobId);
    const beforeJudges = await listJudgeCalls(jobId);
    expect(beforeAttempts.items).toHaveLength(1);
    expect(beforeJudges.items).toHaveLength(1);
    const expectedAttemptId = beforeAttempts.items[0]?.attempt_id ?? null;
    const expectedJudgeId = beforeJudges.items[0]?.judge_call_id ?? null;
    expect(expectedAttemptId).not.toBeNull();
    expect(expectedJudgeId).not.toBeNull();

    const exportResponse = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/export?format=json`,
    );
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type") ?? "").toContain("application/json");

    // Mid-stream writes: new turn, attempt, and judge call beyond the captured marks.
    await appendTurn(jobId, "Turn two.");
    await settleActiveAttempt(jobId, "hwm-2");
    const afterWrites = await getJob(jobId);
    expect(afterWrites.turns).toHaveLength(2);
    expect(afterWrites.job.revision).toBeGreaterThan(before.job.revision);

    const rawExport = await exportResponse.text();
    expectNoCredentials(rawExport);
    const body = JSON.parse(rawExport) as JsonExportBody;
    expect(body.exportFormat).toBe("json");
    expect(body.exportComplete).toBe(true);
    expect(body.startingRevision).toBe(before.job.revision);
    expect(body.maxTurnIndex).toBe(1);
    expect(body.maxAttemptId).toBe(expectedAttemptId);
    expect(body.maxJudgeCallId).toBe(expectedJudgeId);
    expect(body.highWaterMarks.startingRevision).toBe(before.job.revision);
    expect(body.highWaterMarks.maxTurnIndex).toBe(1);
    expect(body.job.revision).toBe(before.job.revision);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]?.turn_index).toBe(1);
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]?.attempt_id).toBe(expectedAttemptId);
    expect(body.judgeCalls).toHaveLength(1);
    expect(body.judgeCalls[0]?.judge_call_id).toBe(expectedJudgeId);
    expect(rawExport).not.toContain("Turn two.");
    expect(rawExport).not.toContain("Second <!-- TURN_END:2 -->");

    // The mid-stream records exist; a fresh export includes them.
    const freshAttempts = await listAttempts(jobId);
    const freshJudges = await listJudgeCalls(jobId);
    expect(freshAttempts.items).toHaveLength(2);
    expect(freshJudges.items).toHaveLength(2);
    expect(await readRouterAlarm()).toBeNull();
  });

  it("missing artifacts produce explicit markers and no export leaks credentials", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_missing");
    planGenerations([{ responseId: `${jobId}_r1`, text: "Kept <!-- TURN_END:1 -->" }]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Kept ok.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "Missing-marker turn.", attachmentFileIds: [] },
    ]);
    await settleActiveAttempt(jobId, "missing-1");
    const judges = await listJudgeCalls(jobId);
    const judgeCallId = judges.items[0]?.judge_call_id ?? "";
    expect(judgeCallId.length).toBeGreaterThan(0);

    const jsonResponse = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export?format=json`);
    expect(jsonResponse.status).toBe(200);
    const jsonText = await jsonResponse.text();
    expectNoCredentials(jsonText);
    const jsonBody = JSON.parse(jsonText) as JsonExportBody;
    // Retained judge responses are presence-only; completed calls always mark the omission.
    expect(
      jsonBody.missingArtifacts.some(
        (marker) =>
          marker.artifactKind === "judge_response" &&
          marker.ownerId === judgeCallId &&
          marker.reason === "omitted_or_missing",
      ),
    ).toBe(true);
    for (const marker of jsonBody.missingArtifacts) {
      expect(marker.artifactKind.length).toBeGreaterThan(0);
      expect(marker.ownerId.length).toBeGreaterThan(0);
      expect(["not_recorded", "omitted_or_missing"]).toContain(marker.reason);
    }

    const markdownResponse = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/export?format=markdown`,
    );
    expect(markdownResponse.status).toBe(200);
    expectNoCredentials(await markdownResponse.text());

    const finalResponse = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export/markdown`);
    expect(finalResponse.status).toBe(200);
    const finalText = await finalResponse.text();
    expect(finalText).toContain("Kept");
    expectNoCredentials(finalText);

    const jsonlResponse = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export/jsonl`);
    expect(jsonlResponse.status).toBe(200);
    expect(jsonlResponse.headers.get("content-type") ?? "").toMatch(/^application\/x-ndjson/);
    const jsonlText = await jsonlResponse.text();
    expectNoCredentials(jsonlText);
    const lines = jsonlText.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0] ?? "{}") as { readonly type?: string };
    expect(first.type).toBe("job");
    expect(await readRouterAlarm()).toBeNull();
  });

  it("failed dispatch exports mark the missing response without credentials", async () => {
    // Terminal 400 on POST /responses fails before any response artifact exists.
    const calls: CapturedCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).hostname !== "api.openai.com") {
          throw new Error(`Unexpected outbound fetch host: ${url}`);
        }
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method, url, bodyText: decodeRequestBody(init?.body as BodyInit | null | undefined) });
        if (method === "POST" && url.endsWith("/responses")) {
          return providerJson(
            { error: { code: "invalid_request_error", message: "model not available" } },
            400,
          );
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      }),
    );
    const jobId = nextJobId("job_gaps_failed_export");
    const created = await createJob(jobId, baseConfig({ enabled: false }), [
      { turnIndex: 1, promptText: "Will fail.", attachmentFileIds: [] },
    ]);
    expect(created.job.status).toBe("failed");
    expect(created.job.errorCode).toBe("invalid_request_error");

    const jsonResponse = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export?format=json`);
    expect(jsonResponse.status).toBe(200);
    const jsonText = await jsonResponse.text();
    expectNoCredentials(jsonText);
    const body = JSON.parse(jsonText) as JsonExportBody;
    expect(
      body.missingArtifacts.some(
        (marker) => marker.artifactKind === "generation_response" && marker.reason === "not_recorded",
      ),
    ).toBe(true);
    expect(body.attempts).toHaveLength(1);

    const jsonlResponse = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export/jsonl`);
    expect(jsonlResponse.status).toBe(200);
    expectNoCredentials(await jsonlResponse.text());
  });

  it("rejects malformed export format queries", async () => {
    installProviderMock();
    planGenerations([{ responseId: "resp_fmt_unused", text: "x <!-- TURN_END:1 -->" }]);
    const jobId = nextJobId("job_gaps_export_fmt");
    await createJob(jobId, baseConfig({ enabled: false }), [
      { turnIndex: 1, promptText: "Format.", attachmentFileIds: [] },
    ]);

    const missing = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export`);
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as ErrorBody).error.code).toBe("invalid_format");

    const invalid = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/export?format=xml`);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as ErrorBody).error.code).toBe("invalid_format");
  });
});

describe("job detail fragment", () => {
  it("renders escaped prompts, judge results, recovery controls, and export links", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_fragment");
    const hostilePrompt = "<img src=x onerror=alert(1)> Write safely.";
    planGenerations([{ responseId: `${jobId}_r1`, text: "Safe deliverable <!-- TURN_END:1 -->" }]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Looks <b>good</b>.", tag: true, visibility: true }),
      },
    ]);

    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: hostilePrompt, attachmentFileIds: [] },
    ]);
    await settleActiveAttempt(jobId, "frag-1");

    const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain("Safe deliverable");
    expect(html).toContain("Marginal input tokens: 12");
    expect(html).toContain("Looks &lt;b&gt;good&lt;/b&gt;.");
    expect(html).toContain("Download JSONL");
    expect(html).toContain("Inspect JSONL");
    expectNoCredentials(html);

    const missing = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/job_gaps_no_such_job/fragment`);
    expect(missing.status).toBe(404);

    const wrongMethod = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(wrongMethod.status).toBe(405);
    expect(await readRouterAlarm()).toBeNull();
  });

  it("lists turns through the paginated handler without blobs", async () => {
    installProviderMock();
    const jobId = nextJobId("job_gaps_list_turns");
    planGenerations([{ responseId: `${jobId}_r1`, text: "Listed <!-- TURN_END:1 -->" }]);
    planJudges([
      {
        kind: "chat",
        responseId: `${jobId}_j1`,
        json: judgeJson({ verdict: "YES", grade: "A", comment: "Listed ok.", tag: true, visibility: true }),
      },
    ]);
    await createJob(jobId, baseConfig(baseJudge(true, {})), [
      { turnIndex: 1, promptText: "List me.", attachmentFileIds: [] },
    ]);
    await settleActiveAttempt(jobId, "list-1");
    const page = await listTurns(jobId);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.turn_index).toBe(1);
    expect(page.items[0]?.status).toBe("accepted");
    expect("prompt_blob" in (page.items[0] ?? {})).toBe(false);
  });
});
