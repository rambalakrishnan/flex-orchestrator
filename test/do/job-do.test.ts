// Covers: 6, 7, 9, 10, 16, 17, 19, 21, 23, 24
import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GenerationAttemptSummaryRow,
  JudgeCallSummaryRow,
  TurnSummaryRow,
} from "../../src/db/schema.ts";
import type {
  AppendTurnCommand,
  BranchCreationOutcome,
  BranchSnapshot,
  CreateJobCommand,
  CursorPage,
  CursorPageRequest,
  ExportHighWaterMarks,
  JobConfig,
  JudgeConfig,
  JobStateResponse,
  OperatorReviewDecision,
  VerifiedWebhookEvent,
} from "../../src/types.ts";

interface JobDoTestStub {
  createJob(command: CreateJobCommand): Promise<JobStateResponse>;
  getState(): Promise<JobStateResponse | null>;
  supersedeParent(epoch: number, childId: string): Promise<boolean>;
  appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>;
  applyOperatorDecision(decision: OperatorReviewDecision): Promise<JobStateResponse>;
  pauseJob(): Promise<JobStateResponse>;
  resumeJob(): Promise<JobStateResponse>;
  retryTurn(turnIndex: number): Promise<JobStateResponse>;
  setTurnPinned(turnIndex: number, pinned: boolean): Promise<JobStateResponse>;
  captureBranchSnapshot(
    forkTurnIndex: number
  ): Promise<
    BranchSnapshot | { kind: "rejected"; reason: string; message: string }
  >;
  initializeBranch(snapshot: BranchSnapshot): Promise<BranchCreationOutcome>;
  receiveWebhookDelivery(event: VerifiedWebhookEvent): Promise<void>;
  listTurns(request: CursorPageRequest): Promise<CursorPage<TurnSummaryRow>>;
  listAttempts(
    request: CursorPageRequest & { turnIndex?: number }
  ): Promise<CursorPage<GenerationAttemptSummaryRow>>;
  listJudgeCalls(
    request: CursorPageRequest & { turnIndex?: number }
  ): Promise<CursorPage<JudgeCallSummaryRow>>;
  captureExportHighWaterMarks(): Promise<ExportHighWaterMarks>;
  readArtifact(request: {
    kind:
      | "turn_prompt"
      | "candidate_deliverable"
      | "attempt_request"
      | "attempt_response"
      | "judge_request";
    id: string | number;
  }): Promise<{ bytes: ArrayBuffer } | null>;
}

const ENABLED_JUDGE_CONFIG: Extract<JudgeConfig, { enabled: true }> = {
  enabled: true,
  provider: "openai",
  apiRoot: "https://api.openai.com/v1",
  secretName: "OPENAI_API_KEY",
  model: "gpt-5",
  transport: "responses",
  historyMode: "stateless",
  fileDeliveryMode: "passthrough",
  includePrior: false,
  maxGradeThreshold: 80,
  injectOnFail: true,
  injectOnPass: false,
  developerPrompt: "",
};

const JOB_CONFIG: JobConfig = {
  model: "gpt-5",
  reasoningEffort: "medium",
  maxOutputTokens: 4096,
  cacheTtl: "nocache",
  webSearch: false,
  maxContinuations: 3,
  maxAutoRetries: 1,
  judge: { enabled: false },
  developerPrompt: "",
  developerFileIds: [],
};

let sequence = 0;
const createdJobIds: string[] = [];

function nextJobId(): string {
  sequence += 1;
  return `job-do-test-${sequence}`;
}

function trackJobId(jobId: string): string {
  if (!createdJobIds.includes(jobId)) {
    createdJobIds.push(jobId);
  }
  return jobId;
}

function stubFor(jobId: string): JobDoTestStub {
  trackJobId(jobId);
  return env.JOB_DO.get(
    env.JOB_DO.idFromName(jobId)
  ) as unknown as JobDoTestStub;
}

interface FetchCall {
  readonly method: string;
  readonly url: string;
}

function completedResponseBody(text: string): string {
  return JSON.stringify({
    id: "resp_1",
    model: "gpt-5",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
    },
  });
}

function stubProviderFetch(calls: FetchCall[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (method === "POST" && url.endsWith("/responses")) {
        return new Response(completedResponseBody("hello <!-- TURN_END:1 -->"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.includes("/responses/resp_1")) {
        return new Response(completedResponseBody("hello <!-- TURN_END:1 -->"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected provider call: ${method} ${url}`);
    })
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const jobId of createdJobIds.splice(0)) {
    const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
  await reset();
  await abortAllDurableObjects();
});

describe("JobDO contract amendments", () => {
  it("returns null for a missing job and supersedes a quiescent parent exactly once", async () => {
    const missing = stubFor(nextJobId());
    expect(await missing.getState()).toBeNull();

    const jobId = nextJobId();
    const stub = stubFor(jobId);
    const created = await stub.createJob({
      jobId,
      title: "supersede me",
      config: JOB_CONFIG,
      initialTurns: [],
    });
    const epoch = created.job.revision;

    expect(await stub.supersedeParent(epoch + 1, "child-stale")).toBe(false);

    expect(await stub.supersedeParent(epoch, "child-1")).toBe(true);
    const after = await stub.getState();
    if (after === null) throw new Error("expected superseded state");
    expect(after.job.status).toBe("superseded");
    expect(after.job.revision).toBe(epoch + 1);
    expect(after.job.warningMessages).toContain("superseded_by:child-1");

    // Idempotent once superseded, even with the original epoch.
    expect(await stub.supersedeParent(epoch, "child-1")).toBe(true);
  });
});

describe("JobDO command surface", () => {
  it("creates, reads, and rejects duplicate jobs", async () => {
    const jobId = nextJobId();
    const stub = stubFor(jobId);

    const created = await stub.createJob({
      jobId,
      title: "first job",
      config: JOB_CONFIG,
      initialTurns: [],
    });

    expect(created.job.jobId).toBe(jobId);
    expect(created.job.status).toBe("ready");
    expect(created.job.revision).toBe(2);
    expect(created.job.config.model).toBe("gpt-5");
    expect(created.turns).toEqual([]);
    expect(created.activeAttempt).toBeNull();
    expect(created.pollIntervalMs).toBe(12_000);
    expect(created.usage.generationCalls).toBe(0);

    const rawStub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
    const duplicateMessage = await runInDurableObject(
      rawStub,
      async (instance): Promise<string> => {
        // The test-local interface mirrors JobDO's documented RPC surface.
        const jobDo = instance as unknown as JobDoTestStub;
        try {
          await jobDo.createJob({
            jobId,
            title: "duplicate",
            config: JOB_CONFIG,
            initialTurns: [],
          });
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    expect(duplicateMessage).toContain("already exists");

    const state = await stub.getState();
    if (state === null) throw new Error("expected job state");
    expect(state.job.title).toBe("first job");
  });

  it("round-trips developer context and enforces model capability limits", async () => {
    const jobId = nextJobId();
    const stub = stubFor(jobId);

    const created = await stub.createJob({
      jobId,
      title: "developer context job",
      config: {
        ...JOB_CONFIG,
        model: "gpt-6-astra",
        reasoningEffort: "xhigh",
        maxOutputTokens: 128_000,
        developerPrompt: "shared context",
        developerFileIds: [],
      },
      initialTurns: [],
    });

    expect(created.job.config.reasoningEffort).toBe("xhigh");
    expect(created.job.config.developerPrompt).toBe("shared context");
    expect(created.job.config.developerFileIds).toEqual([]);

    const state = await stub.getState();
    if (state === null) throw new Error("expected job state");
    expect(state.job.config.developerPrompt).toBe("shared context");
    expect(state.job.config.developerFileIds).toEqual([]);

    const effortJobId = nextJobId();
    trackJobId(effortJobId);
    const unsupportedEffortMessage = await runInDurableObject(
      env.JOB_DO.get(env.JOB_DO.idFromName(effortJobId)),
      async (instance): Promise<string> => {
        const jobDo = instance as unknown as JobDoTestStub;
        try {
          await jobDo.createJob({
            jobId: effortJobId,
            title: "unsupported effort",
            config: { ...JOB_CONFIG, model: "gpt-5", reasoningEffort: "xhigh" },
            initialTurns: [],
          });
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    expect(unsupportedEffortMessage).toContain("does not support reasoning effort");
    expect(unsupportedEffortMessage).toContain("xhigh");

    const outputJobId = nextJobId();
    trackJobId(outputJobId);
    const oversizedOutputMessage = await runInDurableObject(
      env.JOB_DO.get(env.JOB_DO.idFromName(outputJobId)),
      async (instance): Promise<string> => {
        const jobDo = instance as unknown as JobDoTestStub;
        try {
          await jobDo.createJob({
            jobId: outputJobId,
            title: "oversized output budget",
            config: {
              ...JOB_CONFIG,
              model: "gpt-6-astra",
              reasoningEffort: "xhigh",
              maxOutputTokens: 128_001,
            },
            initialTurns: [],
          });
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    expect(oversizedOutputMessage).toContain("maxOutputTokens 128001");
    expect(oversizedOutputMessage).toContain("gpt-6-astra");
  });

  it("cancels through an operator decision and exposes BLOB-free pages", async () => {
    const jobId = nextJobId();
    const stub = stubFor(jobId);
    await stub.createJob({
      jobId,
      title: "cancel me",
      config: JOB_CONFIG,
      initialTurns: [],
    });

    const cancelled = await stub.applyOperatorDecision({
      kind: "cancel_job",
      reason: "test cancel",
    });
    expect(cancelled.job.status).toBe("cancelled");
    expect(cancelled.job.errorMessage).toBe("test cancel");

    const turns = await stub.listTurns({ limit: 100 });
    expect(turns.items).toEqual([]);
    expect(turns.hasMore).toBe(false);
    const attempts = await stub.listAttempts({ limit: 100 });
    expect(attempts.items).toEqual([]);
    const judgeCalls = await stub.listJudgeCalls({ limit: 100 });
    expect(judgeCalls.items).toEqual([]);

    const highWater = await stub.captureExportHighWaterMarks();
    expect(highWater.startingRevision).toBeGreaterThanOrEqual(1);
    expect(highWater.maxTurnIndex).toBe(0);
    expect(highWater.maxAttemptId).toBeNull();
    expect(highWater.maxJudgeCallId).toBeNull();
  });
});

describe("JobDO generation lifecycle", () => {
  it("dispatches, settles through the authoritative webhook retrieval, and accepts", async () => {
    const jobId = nextJobId();
    const calls: FetchCall[] = [];
    stubProviderFetch(calls);
    const stub = stubFor(jobId);

    await stub.createJob({
      jobId,
      title: "generation job",
      config: JOB_CONFIG,
      initialTurns: [],
    });

    const appended = await stub.appendTurn({
      promptText: "Write a greeting.",
      attachmentFileIds: [],
    });

    expect(appended.job.status).toBe("running");
    expect(appended.turns).toHaveLength(1);
    expect(appended.turns[0]!.status).toBe("running");
    expect(appended.activeAttempt?.status).toBe("dispatched");
    expect(appended.activeAttempt?.responseId).toBe("resp_1");
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/responses"))).toBe(
      true
    );

    const attemptsPage = await stub.listAttempts({ limit: 1 });
    expect(attemptsPage.items).toHaveLength(1);
    expect(attemptsPage.hasMore).toBe(false);

    const requestArtifact = await stub.readArtifact({
      kind: "attempt_request",
      id: appended.activeAttempt!.attemptId,
    });
    expect(requestArtifact).not.toBeNull();
    const requestText = new TextDecoder().decode(requestArtifact!.bytes);
    expect(requestText).toContain('"service_tier":"flex"');
    expect(requestText).toContain('"background":true');
    expect(requestText).not.toContain("Authorization");

    await stub.receiveWebhookDelivery({
      webhookId: "wh_1",
      timestampSeconds: 1_760_000_000,
      eventType: "response.completed",
      responseId: "resp_1",
      rawPayload: new ArrayBuffer(0),
      receivedAtMs: 1_760_000_000_000,
    });

    const settled = await stub.getState();
    if (settled === null) throw new Error("expected settled state");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]!.status).toBe("accepted");
    expect(settled.turns[0]!.acceptedResponseId).toBe("resp_1");
    expect(settled.activeAttempt).toBeNull();
    expect(settled.usage.generationCalls).toBe(1);
    expect(settled.turns[0]!.marginalInputTokens).toBe(12);
    const acceptedTurns = await stub.listTurns({ limit: 1 });
    expect(acceptedTurns.items[0]!.marginal_input_tokens).toBe(12);

    const deliverable = await stub.readArtifact({
      kind: "candidate_deliverable",
      id: `${appended.activeAttempt!.attemptId}:candidate`,
    });
    expect(deliverable).not.toBeNull();
    expect(new TextDecoder().decode(deliverable!.bytes)).toBe("hello");
  });

  it("evaluates through a chat_completions judge and accepts on PASS", async () => {
    const jobId = nextJobId();
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "POST" && url.endsWith("/responses")) {
          return new Response(completedResponseBody("hello <!-- TURN_END:1 -->"), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "GET" && url.includes("/responses/resp_1")) {
          return new Response(completedResponseBody("hello <!-- TURN_END:1 -->"), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (method === "POST" && url.endsWith("/chat/completions")) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl_judge1",
              object: "chat.completion",
              created: 1_760_000_000,
              model: "deepseek/deepseek-v4.1-flash-1017",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content:
                      '{"verdict":"YES","grade":"A","comment":"Clean greeting.","tag_matches_expected_step":true,"file_visibility":true}',
                  },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      }),
    );
    const stub = stubFor(jobId);

    await stub.createJob({
      jobId,
      title: "chat judge job",
      config: {
        ...JOB_CONFIG,
        judge: {
          ...ENABLED_JUDGE_CONFIG,
          provider: "openrouter",
          apiRoot: "https://openrouter.ai/api/v1",
          model: "deepseek/deepseek-v4.1-flash-1017",
          transport: "chat_completions",
          fileDeliveryMode: "inline",
        },
      },
      initialTurns: [],
    });
    await stub.appendTurn({ promptText: "Write a greeting.", attachmentFileIds: [] });
    await stub.receiveWebhookDelivery({
      webhookId: "wh_chat_judge",
      timestampSeconds: 1_760_000_000,
      eventType: "response.completed",
      responseId: "resp_1",
      rawPayload: new ArrayBuffer(0),
      receivedAtMs: 1_760_000_000_000,
    });

    expect(calls.some((call) => call.url.endsWith("/chat/completions"))).toBe(true);
    const judgeCalls = await stub.listJudgeCalls({ limit: 10 });
    expect(judgeCalls.items).toHaveLength(1);
    expect(judgeCalls.items[0]!.status).toBe("completed");
    expect(judgeCalls.items[0]!.verdict).toBe("PASS");
    expect(judgeCalls.items[0]!.grade).toBe(95);

    const settled = await stub.getState();
    if (settled === null) throw new Error("expected settled state");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]!.status).toBe("accepted");
  });

  it("breaks the chain with a bounded replay window once frozen input crosses the tier", async () => {
    const jobId = nextJobId();
    const calls: FetchCall[] = [];
    const bodiesByResponse: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "POST" && url.endsWith("/responses")) {
          const turnIndex = Object.keys(bodiesByResponse).length + 1;
          const responseId = `resp_chain_${turnIndex}`;
          bodiesByResponse[responseId] = `turn ${turnIndex} <!-- TURN_END:${turnIndex} -->`;
          return new Response(
            JSON.stringify({ id: responseId, model: "gpt-5", status: "queued" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const match = /\/responses\/(resp_chain_\d+)$/.exec(url);
        if (method === "GET" && match !== null) {
          const responseId = match[1]!;
          const turnIndex = Number(responseId.split("_").pop());
          return new Response(
            JSON.stringify({
              id: responseId,
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: bodiesByResponse[responseId] }],
                },
              ],
              usage: {
                input_tokens: turnIndex >= 3 ? 300_000 : 12,
                output_tokens: 8,
                total_tokens: turnIndex >= 3 ? 300_008 : 20,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      }),
    );
    const stub = stubFor(jobId);

    await stub.createJob({
      jobId,
      title: "re-anchor job",
      config: JOB_CONFIG,
      initialTurns: [],
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      await stub.appendTurn({ promptText: `Turn ${turn}.`, attachmentFileIds: [] });
      await stub.receiveWebhookDelivery({
        webhookId: `wh_chain_${turn}`,
        timestampSeconds: 1_760_000_000,
        eventType: "response.completed",
        responseId: `resp_chain_${turn}`,
        rawPayload: new ArrayBuffer(0),
        receivedAtMs: 1_760_000_000_000,
      });
    }
    const chained = await stub.getState();
    if (chained === null) throw new Error("expected job state");
    expect(chained.job.acceptedTurnCount).toBe(3);
    expect(chained.job.lastAcceptedResponseId).toBe("resp_chain_3");

    const appended = await stub.appendTurn({
      promptText: "Turn 4.",
      attachmentFileIds: [],
    });
    expect(appended.job.status).toBe("running");
    const requestArtifact = await stub.readArtifact({
      kind: "attempt_request",
      id: appended.activeAttempt!.attemptId,
    });
    expect(requestArtifact).not.toBeNull();
    const request = JSON.parse(new TextDecoder().decode(requestArtifact!.bytes)) as {
      previous_response_id?: string;
      input: Array<{ role?: string }>;
    };
    // Fresh chain: no anchor, exactly the two most recent turns replayed.
    expect("previous_response_id" in request).toBe(false);
    const assistantReplays = request.input.filter((item) => item.role === "assistant");
    expect(assistantReplays).toHaveLength(2);

    const reanchored = await stub.getState();
    if (reanchored === null) throw new Error("expected job state");
    expect(reanchored.job.lastAcceptedResponseId).toBeNull();
    expect(reanchored.job.warningMessages).toContain("history_reanchored_at_turn:4");
  });

  it("keeps pinned turns in the replay window past the trailing window", async () => {
    const jobId = nextJobId();
    const bodiesByResponse: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith("/responses")) {
          const turnIndex = Object.keys(bodiesByResponse).length + 1;
          const responseId = `resp_pin_${turnIndex}`;
          bodiesByResponse[responseId] = `turn ${turnIndex} <!-- TURN_END:${turnIndex} -->`;
          return new Response(
            JSON.stringify({ id: responseId, model: "gpt-5", status: "queued" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const match = /\/responses\/(resp_pin_\d+)$/.exec(url);
        if (method === "GET" && match !== null) {
          const responseId = match[1]!;
          const turnIndex = Number(responseId.split("_").pop());
          return new Response(
            JSON.stringify({
              id: responseId,
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: bodiesByResponse[responseId] }],
                },
              ],
              usage: {
                input_tokens: turnIndex >= 4 ? 300_000 : 12,
                output_tokens: 8,
                total_tokens: turnIndex >= 4 ? 300_008 : 20,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      }),
    );
    const stub = stubFor(jobId);

    await stub.createJob({
      jobId,
      title: "pinned replay job",
      config: JOB_CONFIG,
      initialTurns: [
        { turnIndex: 1, promptText: "Turn 1.", attachmentFileIds: [], pinnedInReplay: true },
        { turnIndex: 2, promptText: "Turn 2.", attachmentFileIds: [] },
        { turnIndex: 3, promptText: "Turn 3.", attachmentFileIds: [] },
        { turnIndex: 4, promptText: "Turn 4.", attachmentFileIds: [] },
        { turnIndex: 5, promptText: "Turn 5.", attachmentFileIds: [] },
      ],
    });
    const created = await stub.getState();
    if (created === null) throw new Error("expected job state");
    expect(created.turns[0]!.pinnedInReplay).toBe(true);
    expect(created.turns[1]!.pinnedInReplay).toBe(false);

    for (let turn = 1; turn <= 4; turn += 1) {
      await stub.receiveWebhookDelivery({
        webhookId: `wh_pin_${turn}`,
        timestampSeconds: 1_760_000_000,
        eventType: "response.completed",
        responseId: `resp_pin_${turn}`,
        rawPayload: new ArrayBuffer(0),
        receivedAtMs: 1_760_000_000_000,
      });
    }

    const running = await stub.getState();
    if (running === null) throw new Error("expected job state");
    expect(running.job.status).toBe("running");
    expect(running.job.currentTurnIndex).toBe(5);
    if (running.activeAttempt === null) throw new Error("expected active attempt");
    const requestArtifact = await stub.readArtifact({
      kind: "attempt_request",
      id: running.activeAttempt.attemptId,
    });
    expect(requestArtifact).not.toBeNull();
    const request = JSON.parse(new TextDecoder().decode(requestArtifact!.bytes)) as {
      previous_response_id?: string;
      input: Array<{ role?: string; content?: Array<{ text?: string }> }>;
    };
    expect("previous_response_id" in request).toBe(false);
    const replayedTexts = request.input
      .filter((item) => item.role === "assistant")
      .flatMap((item) => (item.content ?? []).map((part) => part.text ?? ""));
    expect(replayedTexts).toEqual(["turn 1", "turn 3", "turn 4"]);

    const unpinned = await stub.setTurnPinned(1, false);
    expect(unpinned.turns[0]!.pinnedInReplay).toBe(false);
  });

  it("captures a quiescent branch snapshot and initializes the child in one transaction", async () => {
    const parentJobId = nextJobId();
    stubProviderFetch([]);
    const parent = stubFor(parentJobId);

    await parent.createJob({
      jobId: parentJobId,
      title: "branch parent",
      config: JOB_CONFIG,
      initialTurns: [],
    });
    await parent.appendTurn({ promptText: "Parent turn.", attachmentFileIds: [] });
    await parent.receiveWebhookDelivery({
      webhookId: "wh_parent",
      timestampSeconds: 1_760_000_000,
      eventType: "response.completed",
      responseId: "resp_1",
      rawPayload: new ArrayBuffer(0),
      receivedAtMs: 1_760_000_000_000,
    });

    const snapshot = await parent.captureBranchSnapshot(1);
    expect("kind" in snapshot && snapshot.kind === "rejected").toBe(false);
    const branchSnapshot = snapshot as BranchSnapshot;
    expect(branchSnapshot.encodedByteLength).toBeGreaterThan(0);
    expect(branchSnapshot.turns).toHaveLength(1);

    const childJobId = nextJobId();
    const child = stubFor(childJobId);
    const outcome = await child.initializeBranch(branchSnapshot);
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") {
      throw new Error(outcome.message);
    }
    expect(outcome.parentSuperseded).toBe(true);

    const branchState = await child.getState();
    if (branchState === null) throw new Error("expected branch state");
    expect(branchState.job.status).toBe("ready");
    expect(branchState.job.branchProvenance?.parentJobId).toBe(parentJobId);
    expect(branchState.job.acceptedTurnCount).toBe(1);
    expect(branchState.turns[0]!.status).toBe("accepted");
    expect(branchState.turns[0]!.acceptedDeliverableBytes).toBe("hello".length);
    expect(branchState.turns[0]!.marginalInputTokens).toBe(12);
    const branchTurns = await child.listTurns({ limit: 1 });
    expect(branchTurns.items[0]!.marginal_input_tokens).toBe(12);
  });

  it("force-accepts the latest candidate of a failed turn and advances", async () => {
    const jobId = nextJobId();
    const bodiesByResponse: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith("/responses")) {
          const attempt = Object.keys(bodiesByResponse).length + 1;
          const responseId = `resp_force_${attempt}`;
          bodiesByResponse[responseId] = `unstyled draft ${attempt}`;
          return new Response(
            JSON.stringify({ id: responseId, model: "gpt-5", status: "queued" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const match = /\/responses\/(resp_force_\d+)$/.exec(url);
        if (method === "GET" && match !== null) {
          const responseId = match[1]!;
          return new Response(
            JSON.stringify({
              id: responseId,
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: bodiesByResponse[responseId] }],
                },
              ],
              usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      }),
    );
    const stub = stubFor(jobId);

    await stub.createJob({
      jobId,
      title: "force accept job",
      config: JOB_CONFIG,
      initialTurns: [
        { turnIndex: 1, promptText: "Turn 1.", attachmentFileIds: [] },
        { turnIndex: 2, promptText: "Turn 2.", attachmentFileIds: [] },
      ],
    });
    // Markerless output consumes continuations, then fails the turn.
    for (let delivery = 1; delivery <= 4; delivery += 1) {
      await stub.receiveWebhookDelivery({
        webhookId: `wh_force_${delivery}`,
        timestampSeconds: 1_760_000_000,
        eventType: "response.completed",
        responseId: `resp_force_${delivery}`,
        rawPayload: new ArrayBuffer(0),
        receivedAtMs: 1_760_000_000_000,
      });
    }
    const failed = await stub.getState();
    if (failed === null) throw new Error("expected job state");
    expect(failed.job.status).toBe("failed");
    expect(failed.turns[0]!.status).toBe("failed");

    const latest = await stub.getLatestCandidate(1);
    expect(latest).not.toBeNull();
    expect(latest!.structuralStatus).toBe("missing_tag");
    expect(latest!.text).toContain("unstyled draft");

    const advanced = await stub.applyOperatorDecision({ kind: "force_accept_latest" });
    expect(advanced.job.status).toBe("running");
    expect(advanced.job.currentTurnIndex).toBe(2);
    expect(advanced.turns[0]!.status).toBe("accepted");
    expect(advanced.turns[0]!.warningMessages).toContain("operator_force_accepted");
    expect(advanced.turns[0]!.warningMessages).toContain(
      "force_accepted_structural_status:missing_tag",
    );
    expect(advanced.activeAttempt).not.toBeNull();
    expect(advanced.activeAttempt!.turnIndex).toBe(2);
  });
});

describe("JobDO judge steering configuration", () => {
  it("persists injection flags and defaults legacy persisted configs", async () => {
    const jobId = nextJobId();
    const stub = stubFor(jobId);
    await stub.createJob({
      jobId,
      title: "explicit judge steering",
      config: {
        ...JOB_CONFIG,
        judge: {
          ...ENABLED_JUDGE_CONFIG,
          injectOnFail: false,
          injectOnPass: true,
        },
      },
      initialTurns: [],
    });

    const state = await stub.getState();
    if (state === null) throw new Error("expected job state");
    const judge = state.job.config.judge;
    expect(judge.enabled).toBe(true);
    if (!judge.enabled) throw new Error("expected an enabled judge config");
    expect(judge.injectOnFail).toBe(false);
    expect(judge.injectOnPass).toBe(true);

    const legacyJobId = nextJobId();
    const legacyStub = stubFor(legacyJobId);
    const legacyJudge = {
      ...ENABLED_JUDGE_CONFIG,
      injectOnFail: undefined,
      injectOnPass: undefined,
    } as unknown as JudgeConfig;
    await legacyStub.createJob({
      jobId: legacyJobId,
      title: "legacy judge steering",
      config: { ...JOB_CONFIG, judge: legacyJudge },
      initialTurns: [],
    });

    const legacyState = await legacyStub.getState();
    if (legacyState === null) throw new Error("expected legacy job state");
    const legacyJudgeConfig = legacyState.job.config.judge;
    expect(legacyJudgeConfig.enabled).toBe(true);
    if (!legacyJudgeConfig.enabled) {
      throw new Error("expected an enabled legacy judge config");
    }
    expect(legacyJudgeConfig.injectOnFail).toBe(true);
    expect(legacyJudgeConfig.injectOnPass).toBe(false);
  });
});

describe("JobDO operator recovery", () => {
  it("seeds external continuity for the first initial attempt and records a warning", async () => {
    const jobId = nextJobId();
    const stub = stubFor(jobId);

    const created = await stub.createJob({
      jobId,
      title: "external continuity",
      config: JOB_CONFIG,
      initialTurns: [],
      initialPreviousResponseId: "resp_external_1",
    });

    expect(created.job.lastAcceptedResponseId).toBe("resp_external_1");
    expect(created.job.acceptedTurnCount).toBe(0);
    expect(created.job.warningMessages).toContain(
      "external_previous_response_id:resp_external_1"
    );
    expect(created.job.errorCode).toBeNull();

    const state = await stub.getState();
    if (state === null) throw new Error("expected job state");
    expect(state.job.lastAcceptedResponseId).toBe("resp_external_1");
    expect(state.job.acceptedTurnCount).toBe(0);
    expect(state.job.warningMessages).toContain(
      "external_previous_response_id:resp_external_1"
    );
  });

  it("rejects retryTurn for a non-current turn and resumeJob for a running job", async () => {
    const jobId = nextJobId();
    const stub = stubFor(jobId);
    await stub.createJob({
      jobId,
      title: "recovery guards",
      config: JOB_CONFIG,
      initialTurns: [],
    });

    const rawStub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
    const retryMessage = await runInDurableObject(
      rawStub,
      async (instance): Promise<string> => {
        // Invoke in-process so the rejected RPC never surfaces as an unhandled report.
        const jobDo = instance as unknown as JobDoTestStub;
        try {
          await jobDo.retryTurn(2);
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    expect(retryMessage).toContain("retryTurn requires the current turn index 1");

    stubProviderFetch([]);
    await stub.appendTurn({
      promptText: "Start the first turn.",
      attachmentFileIds: [],
    });
    const running = await stub.getState();
    if (running === null) throw new Error("expected job state");
    expect(running.job.status).toBe("running");

    const resumeMessage = await runInDurableObject(
      rawStub,
      async (instance): Promise<string> => {
        const jobDo = instance as unknown as JobDoTestStub;
        try {
          await jobDo.resumeJob();
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
    );
    expect(resumeMessage).toContain("current status is running");
  });

  it("pauses a running job mid-flight, blocks late settlement, and resumes the same turn", async () => {
    const jobId = nextJobId();
    const calls: FetchCall[] = [];
    let dispatchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (method === "POST" && url.endsWith("/responses")) {
          dispatchCount += 1;
          const responseId = dispatchCount === 1 ? "resp_1" : "resp_2";
          return new Response(
            JSON.stringify({ id: responseId, model: "gpt-5", status: "queued" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "GET" && url.includes("/responses/")) {
          const responseId = url.includes("resp_2") ? "resp_2" : "resp_1";
          return new Response(
            JSON.stringify({
              id: responseId,
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "hello <!-- TURN_END:1 -->" }],
                },
              ],
              usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "POST" && url.endsWith("/cancel")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      }),
    );
    const stub = stubFor(jobId);

    await stub.createJob({
      jobId,
      title: "operator pause",
      config: JOB_CONFIG,
      initialTurns: [],
    });
    const appended = await stub.appendTurn({
      promptText: "Write a greeting.",
      attachmentFileIds: [],
    });
    expect(appended.job.status).toBe("running");
    expect(appended.activeAttempt?.status).toBe("dispatched");
    expect(appended.activeAttempt?.responseId).toBe("resp_1");

    const paused = await stub.pauseJob();
    expect(paused.job.status).toBe("paused_operator");
    expect(paused.job.currentTurnIndex).toBe(1);
    expect(paused.job.errorCode).toBe("operator_paused");
    expect(paused.activeAttempt).toBeNull();
    expect(
      calls.some((call) => call.method === "POST" && call.url.endsWith("/cancel")),
    ).toBe(true);

    // A completion for the cancelled response must not settle the turn.
    await stub.receiveWebhookDelivery({
      webhookId: "wh_pause_1",
      timestampSeconds: 1_760_000_000,
      eventType: "response.completed",
      responseId: "resp_1",
      rawPayload: new ArrayBuffer(0),
      receivedAtMs: 1_760_000_000_000,
    });
    const held = await stub.getState();
    if (held === null) throw new Error("expected job state");
    expect(held.job.status).toBe("paused_operator");
    expect(held.turns[0]!.status).not.toBe("accepted");

    // Resume continues the same turn from the accepted anchor: no new turn
    // is created and the fresh attempt dispatches a new provider response.
    const resumed = await stub.resumeJob();
    expect(resumed.job.status).toBe("running");
    expect(resumed.job.currentTurnIndex).toBe(1);
    expect(resumed.turns).toHaveLength(1);
    expect(resumed.activeAttempt?.status).toBe("dispatched");
    expect(resumed.activeAttempt?.responseId).toBe("resp_2");

    await stub.receiveWebhookDelivery({
      webhookId: "wh_pause_2",
      timestampSeconds: 1_760_000_100,
      eventType: "response.completed",
      responseId: "resp_2",
      rawPayload: new ArrayBuffer(0),
      receivedAtMs: 1_760_000_100_000,
    });
    const settled = await stub.getState();
    if (settled === null) throw new Error("expected job state");
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]!.status).toBe("accepted");
    expect(settled.turns[0]!.acceptedResponseId).toBe("resp_2");
  });

  it("rejects pauseJob for halted or terminal jobs", async () => {
    const jobId = nextJobId();
    const calls: FetchCall[] = [];
    stubProviderFetch(calls);
    const stub = stubFor(jobId);
    await stub.createJob({
      jobId,
      title: "pause guards",
      config: JOB_CONFIG,
      initialTurns: [],
    });

    const rawStub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
    const pauseOnce = await stub.pauseJob();
    expect(pauseOnce.job.status).toBe("paused_operator");
    const repeatMessage = await runInDurableObject(
      rawStub,
      async (instance): Promise<string> => {
        const jobDo = instance as unknown as JobDoTestStub;
        try {
          await jobDo.pauseJob();
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
    );
    expect(repeatMessage).toContain("pauseJob requires an active job");
  });
});