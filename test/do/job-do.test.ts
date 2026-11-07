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
  JobStateResponse,
  OperatorReviewDecision,
  VerifiedWebhookEvent,
} from "../../src/types.ts";

interface JobDoTestStub {
  createJob(command: CreateJobCommand): Promise<JobStateResponse>;
  getState(): Promise<JobStateResponse>;
  appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>;
  applyOperatorDecision(decision: OperatorReviewDecision): Promise<JobStateResponse>;
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

const JOB_CONFIG: JobConfig = {
  model: "gpt-5",
  reasoningEffort: "medium",
  maxOutputTokens: 4096,
  cacheTtl: "nocache",
  webSearch: false,
  maxContinuations: 3,
  maxAutoRetries: 1,
  judge: { enabled: false },
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
    expect(state.job.title).toBe("first job");
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
    expect(settled.job.status).toBe("completed");
    expect(settled.turns[0]!.status).toBe("accepted");
    expect(settled.turns[0]!.acceptedResponseId).toBe("resp_1");
    expect(settled.activeAttempt).toBeNull();
    expect(settled.usage.generationCalls).toBe(1);

    const deliverable = await stub.readArtifact({
      kind: "candidate_deliverable",
      id: `${appended.activeAttempt!.attemptId}:candidate`,
    });
    expect(deliverable).not.toBeNull();
    expect(new TextDecoder().decode(deliverable!.bytes)).toBe("hello");
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
    expect(branchState.job.status).toBe("ready");
    expect(branchState.job.branchProvenance?.parentJobId).toBe(parentJobId);
    expect(branchState.job.acceptedTurnCount).toBe(1);
    expect(branchState.turns[0]!.status).toBe("accepted");
    expect(branchState.turns[0]!.acceptedDeliverableBytes).toBe("hello".length);
  });
});