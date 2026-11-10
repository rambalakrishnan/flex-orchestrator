// Covers: 10
//
// Recovery budgets and dispatch fences (TESTING.md item 10).
// Drives JobDO directly (createJob/appendTurn + receiveWebhookDelivery +
// runDurableObjectAlarm against persisted durable_work deadlines) and asserts
// JobDO-observable state: getState counters, listAttempts rows, durable_work
// rows, and the scheduled alarm. No real network; OpenAI fetch is stubbed by
// hostname (api.openai.com only, all other hosts fail loudly).

import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_POLL_FIRST_DELAY_MS,
  FALLBACK_POLL_SECOND_DELAY_MS,
  FALLBACK_POLL_STEADY_DELAY_MS,
  MAX_AUTO_CONTINUATIONS_PER_TURN,
  MAX_AUTO_FULL_RETRIES,
  MAX_FALLBACK_POLL_PROBES,
  MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT,
  REGISTRY_DO_NAME,
  ROUTER_DO_NAME,
} from "../../src/constants.ts";
import type { GenerationAttemptSummaryRow } from "../../src/db/schema.ts";
import type {
  AppendTurnCommand,
  CreateJobCommand,
  CursorPage,
  JobConfig,
  JobStateResponse,
  OpenAIWebhookEventType,
  VerifiedWebhookEvent,
} from "../../src/types.ts";

interface JobTestRpc {
  createJob(command: CreateJobCommand): Promise<JobStateResponse>;
  appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>;
  getState(): Promise<JobStateResponse | null>;
  listAttempts(request: { limit: number }): Promise<CursorPage<GenerationAttemptSummaryRow>>;
  receiveWebhookDelivery(event: VerifiedWebhookEvent): Promise<void>;
  retryTurn(turnIndex: number): Promise<JobStateResponse>;
  readArtifact(request: {
    kind: "candidate_deliverable";
    id: string;
  }): Promise<{ bytes: ArrayBuffer } | null>;
}

/** Judge-free config so settlement accepts structurally valid candidates. */
const RECOVERY_JOB_CONFIG: JobConfig = {
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

/** Fixed synthetic webhook timestamps; never derived from a wall clock. */
const TIMESTAMP_SECONDS = 1_760_000_000;
const RECEIVED_AT_MS = 1_760_000_000_000;

let jobSequence = 0;
const trackedJobIds: string[] = [];

function nextJob(prefix: string): {
  rpc: JobTestRpc;
  stub: DurableObjectStub;
  jobId: string;
} {
  jobSequence += 1;
  const jobId = `recovery-${prefix}-${jobSequence}`;
  trackedJobIds.push(jobId);
  const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
  return { rpc: stub as unknown as JobTestRpc, stub, jobId };
}

// ---------------------------------------------------------------------------
// Provider mock. Only api.openai.com is served; every other host fails loudly.
// ---------------------------------------------------------------------------

interface DispatchCall {
  readonly idempotencyKey: string | null;
}

let dispatchResponder: (callIndex: number, key: string | null) => Response = () => {
  throw new Error("dispatchResponder not set");
};
let retrievalResponder: (responseId: string, callIndex: number) => Response = () => {
  throw new Error("retrievalResponder not set");
};

let dispatchCalls: DispatchCall[] = [];
let retrievalCount = 0;

function stubOpenAI(): void {
  dispatchCalls = [];
  retrievalCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname !== "api.openai.com") {
        throw new Error(`Unexpected outbound fetch host: ${url}`);
      }
      const method = init?.method ?? "GET";

      const cancelMatch = /\/responses\/([^/]+)\/cancel$/.exec(url);
      if (method === "POST" && cancelMatch !== null) {
        // Best-effort manual-retry cancellation; the fresh attempt/key is authoritative.
        const responseId = decodeURIComponent(cancelMatch[1]!);
        return new Response(JSON.stringify({ id: responseId, status: "cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "POST" && url.endsWith("/responses")) {
        let key: string | null = null;
        const headers = init?.headers;
        if (headers instanceof Headers) {
          key = headers.get("Idempotency-Key");
        } else if (headers !== undefined && headers !== null && typeof headers === "object") {
          for (const [name, value] of Object.entries(headers as Record<string, string>)) {
            if (name.toLowerCase() === "idempotency-key") {
              key = String(value);
              break;
            }
          }
        }
        const callIndex = dispatchCalls.length;
        dispatchCalls.push({ idempotencyKey: key });
        return dispatchResponder(callIndex, key);
      }

      const getMatch = /\/responses\/([^/]+)$/.exec(url);
      if (method === "GET" && getMatch !== null) {
        const responseId = decodeURIComponent(getMatch[1]!);
        const callIndex = retrievalCount;
        retrievalCount += 1;
        return retrievalResponder(responseId, callIndex);
      }

      throw new Error(`Unexpected provider call: ${method} ${url}`);
    }),
  );
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function queuedDispatchResponse(responseId: string): Response {
  return jsonResponse({ id: responseId, model: "gpt-5", status: "queued" });
}

function completedRetrievalResponse(
  responseId: string,
  text: string,
  inputTokens = 12,
  outputTokens = 8,
): Response {
  return jsonResponse({
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
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  });
}

function incompleteRetrievalResponse(
  responseId: string,
  text: string,
  inputTokens = 12,
  outputTokens = 8,
): Response {
  return jsonResponse({
    id: responseId,
    model: "gpt-5",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireState(state: JobStateResponse | null): JobStateResponse {
  if (state === null) {
    throw new Error("Expected job state");
  }
  return state;
}

async function listAllAttempts(rpc: JobTestRpc): Promise<GenerationAttemptSummaryRow[]> {
  const page = await rpc.listAttempts({ limit: 100 });
  return [...page.items].sort((a, b) => a.attempt_number - b.attempt_number);
}

async function settle(
  rpc: JobTestRpc,
  webhookId: string,
  responseId: string,
  eventType: OpenAIWebhookEventType = "response.completed",
): Promise<void> {
  await rpc.receiveWebhookDelivery({
    webhookId,
    timestampSeconds: TIMESTAMP_SECONDS,
    eventType,
    responseId,
    rawPayload: new ArrayBuffer(0),
    receivedAtMs: RECEIVED_AT_MS,
  });
}

async function createAndStartTurn(
  rpc: JobTestRpc,
  jobId: string,
  promptText = "Write a greeting.",
): Promise<JobStateResponse> {
  await rpc.createJob({
    jobId,
    title: `${jobId} title`,
    config: RECOVERY_JOB_CONFIG,
    initialTurns: [],
  });
  return await rpc.appendTurn({ promptText, attachmentFileIds: [] });
}

interface JobCounters extends Record<string, SqlStorageValue> {
  continuations_used: number;
  auto_retries_used: number;
  manual_retries_used: number;
  status: string;
  active_attempt_id: string | null;
}

async function readJobCounters(stub: DurableObjectStub): Promise<JobCounters> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<JobCounters>(
        `SELECT continuations_used, auto_retries_used, manual_retries_used, status, active_attempt_id
         FROM jobs LIMIT 1`,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Missing jobs row");
    }
    return row;
  });
}

interface WorkRow extends Record<string, SqlStorageValue> {
  work_id: string;
  kind: string;
  attempt_id: string | null;
  due_at_ms: number;
  created_at: string;
}

async function readDurableWork(stub: DurableObjectStub): Promise<WorkRow[]> {
  return await runInDurableObject(stub, async (_instance, state) => {
    return state.storage.sql
      .exec<WorkRow>(
        `SELECT work_id, kind, attempt_id, due_at_ms, created_at
         FROM durable_work
         ORDER BY due_at_ms ASC, work_id ASC`,
      )
      .toArray();
  });
}

/** Makes one durable-work row due without touching the scheduled alarm. */
async function markWorkDue(stub: DurableObjectStub, workId: string): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(`UPDATE durable_work SET due_at_ms = 1 WHERE work_id = ?`, workId);
  });
}

async function readAlarm(stub: DurableObjectStub): Promise<number | null> {
  return await runInDurableObject(stub, async (_instance, state) => {
    return await state.storage.getAlarm();
  });
}

function persistedDelayMs(work: WorkRow): number {
  return work.due_at_ms - Date.parse(work.created_at);
}

function expectMonotonicAttemptNumbers(attempts: readonly GenerationAttemptSummaryRow[]): void {
  const numbers = attempts.map((attempt) => attempt.attempt_number);
  expect(new Set(numbers).size).toBe(numbers.length);
  for (let index = 1; index < numbers.length; index += 1) {
    expect(numbers[index]!).toBeGreaterThan(numbers[index - 1]!);
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const jobId of trackedJobIds.splice(0)) {
    await runInDurableObject(
      env.JOB_DO.get(env.JOB_DO.idFromName(jobId)),
      async (_instance, state) => {
        await state.storage.deleteAlarm();
      },
    );
  }
  // createJob/appendTurn touch the singleton coordinators.
  await runInDurableObject(
    env.ROUTER_DO.get(env.ROUTER_DO.idFromName(ROUTER_DO_NAME)),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
    },
  );
  await runInDurableObject(
    env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME)),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
    },
  );
  await reset();
  await abortAllDurableObjects();
});

describe("recovery budgets are fixed at creation", () => {
  it("rejects non-fixed continuation and retry budgets", async () => {
    dispatchResponder = () => {
      throw new Error("must not dispatch on invalid config");
    };
    retrievalResponder = () => {
      throw new Error("must not retrieve on invalid config");
    };
    stubOpenAI();

    async function invalidCreateMessage(stub: DurableObjectStub, jobId: string, title: string, config: JobConfig): Promise<string> {
      return await runInDurableObject(stub, async (instance): Promise<string> => {
        // Invoke in-process so the rejected RPC never surfaces as an unhandled report.
        const jobDo = instance as unknown as JobTestRpc;
        try {
          await jobDo.createJob({ jobId, title, config, initialTurns: [] });
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
    }

    const first = nextJob("budget-fixed");
    expect(
      await invalidCreateMessage(first.stub, first.jobId, "bad continuations", {
        ...RECOVERY_JOB_CONFIG,
        maxContinuations: 2,
      }),
    ).toContain("fixed at 3");

    const second = nextJob("budget-fixed");
    expect(
      await invalidCreateMessage(second.stub, second.jobId, "bad retries", {
        ...RECOVERY_JOB_CONFIG,
        maxAutoRetries: 2,
      }),
    ).toContain("fixed at 1");

    expect(dispatchCalls).toHaveLength(0);
    expect(retrievalCount).toBe(0);
    expect(MAX_AUTO_CONTINUATIONS_PER_TURN).toBe(3);
    expect(MAX_AUTO_FULL_RETRIES).toBe(1);
  });
});

describe("continuation and retry ceilings", () => {
  it("stops exactly at three continuations then fails the fourth incomplete without a fifth attempt", async () => {
    const { rpc, stub, jobId } = nextJob("cont");
    dispatchResponder = () => {
      const seq = dispatchCalls.length;
      return queuedDispatchResponse(`resp_${jobId}_${seq}`);
    };
    retrievalResponder = (responseId) => {
      return incompleteRetrievalResponse(responseId, `chunk-${responseId} `, 10, 5);
    };
    stubOpenAI();

    const started = await createAndStartTurn(rpc, jobId);
    expect(started.job.status).toBe("running");
    expect(dispatchCalls).toHaveLength(1);

    for (let settled = 1; settled <= 4; settled += 1) {
      await settle(rpc, `wh-${jobId}-${settled}`, `resp_${jobId}_${settled}`, "response.incomplete");
      const after = requireState(await rpc.getState());
      const attempts = await listAllAttempts(rpc);

      if (settled < 4) {
        expect(after.job.status).toBe("running");
        expect(after.job.continuationsUsed).toBe(settled);
        expect(after.job.autoRetriesUsed).toBe(0);
        expect(attempts).toHaveLength(settled + 1);
        expect(dispatchCalls).toHaveLength(settled + 1);
        expect(retrievalCount).toBe(settled);
        const latest = attempts[attempts.length - 1]!;
        expect(latest.kind).toBe("continuation");
        expect(latest.attempt_number).toBe(settled + 1);
        expect(latest.continuation_index).toBe(settled);
        expect(latest.parent_response_id).toBe(`resp_${jobId}_${settled}`);
        expectMonotonicAttemptNumbers(attempts);
      } else {
        expect(after.job.status).toBe("failed");
        expect(after.job.errorCode).toBe("incomplete");
        expect(after.job.continuationsUsed).toBe(3);
        expect(after.job.continuationsUsed).toBe(MAX_AUTO_CONTINUATIONS_PER_TURN);
        expect(after.job.autoRetriesUsed).toBe(0);
        expect(after.turns[0]?.status).toBe("failed");
        expect(attempts).toHaveLength(4);
        expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2, 3, 4]);
        expect(attempts.map((attempt) => attempt.continuation_index)).toEqual([0, 1, 2, 3]);
        expect(attempts.map((attempt) => attempt.kind)).toEqual([
          "initial",
          "continuation",
          "continuation",
          "continuation",
        ]);
        for (const attempt of attempts) {
          expect(attempt.status).toBe("incomplete");
        }
        const keys = attempts.map((attempt) => attempt.idempotency_key);
        expect(new Set(keys).size).toBe(4);
        expect(keys).toEqual([
          `${jobId}:t1:a1:c0`,
          `${jobId}:t1:a2:c1`,
          `${jobId}:t1:a3:c2`,
          `${jobId}:t1:a4:c3`,
        ]);
        expectMonotonicAttemptNumbers(attempts);
        expect(dispatchCalls).toHaveLength(4);
        expect(retrievalCount).toBe(4);
        expect(await readDurableWork(stub)).toHaveLength(0);
      }
    }
  });

  it("stops exactly at one marker-only retry then fails without a third attempt", async () => {
    const { rpc, stub, jobId } = nextJob("retry");
    dispatchResponder = () => {
      const seq = dispatchCalls.length;
      return queuedDispatchResponse(`resp_${jobId}_${seq}`);
    };
    retrievalResponder = (responseId) => {
      return completedRetrievalResponse(responseId, "<!-- TURN_END:1 -->", 11, 7);
    };
    stubOpenAI();

    await createAndStartTurn(rpc, jobId);
    expect(dispatchCalls).toHaveLength(1);

    await settle(rpc, `wh-${jobId}-1`, `resp_${jobId}_1`);
    const mid = requireState(await rpc.getState());
    expect(mid.job.status).toBe("running");
    expect(mid.job.autoRetriesUsed).toBe(1);
    expect(mid.job.autoRetriesUsed).toBe(MAX_AUTO_FULL_RETRIES);
    expect(mid.job.continuationsUsed).toBe(0);
    let attempts = await listAllAttempts(rpc);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.kind).toBe("auto_retry");
    expect(attempts[1]!.attempt_number).toBe(2);
    expect(attempts[1]!.continuation_index).toBe(0);
    expect(attempts[1]!.parent_response_id).toBeNull();
    expect(dispatchCalls).toHaveLength(2);
    expectMonotonicAttemptNumbers(attempts);

    await settle(rpc, `wh-${jobId}-2`, `resp_${jobId}_2`);
    const failed = requireState(await rpc.getState());
    expect(failed.job.status).toBe("failed");
    expect(failed.job.errorCode).toBe("empty_output");
    expect(failed.job.autoRetriesUsed).toBe(1);
    expect(failed.job.continuationsUsed).toBe(0);
    expect(failed.turns[0]?.status).toBe("failed");
    attempts = await listAllAttempts(rpc);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
    expect(attempts.map((attempt) => attempt.kind)).toEqual(["initial", "auto_retry"]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);
    expect(attempts.map((attempt) => attempt.idempotency_key)).toEqual([
      `${jobId}:t1:a1:c0`,
      `${jobId}:t1:a2:c0`,
    ]);
    expectMonotonicAttemptNumbers(attempts);
    expect(dispatchCalls).toHaveLength(2);
    expect(retrievalCount).toBe(2);
    expect(await readDurableWork(stub)).toHaveLength(0);
  });
});

describe("manual retry preserves automatic counters", () => {
  it("never resets continuation or retry usage across manual recoveries", async () => {
    // Part A: retry budget stays exhausted across manuals.
    {
      const { rpc, stub, jobId } = nextJob("manual-retry");
      dispatchResponder = () => {
        const seq = dispatchCalls.length;
        return queuedDispatchResponse(`resp_${jobId}_${seq}`);
      };
      retrievalResponder = (responseId) => {
        if (responseId === `resp_${jobId}_4`) {
          return completedRetrievalResponse(responseId, "recovered <!-- TURN_END:1 -->", 22, 9);
        }
        return completedRetrievalResponse(responseId, "<!-- TURN_END:1 -->", 11, 7);
      };
      stubOpenAI();

      await createAndStartTurn(rpc, jobId);
      await settle(rpc, `wh-${jobId}-1`, `resp_${jobId}_1`);
      await settle(rpc, `wh-${jobId}-2`, `resp_${jobId}_2`);
      const exhausted = requireState(await rpc.getState());
      expect(exhausted.job.status).toBe("failed");
      expect(exhausted.job.autoRetriesUsed).toBe(1);
      expect(exhausted.job.continuationsUsed).toBe(0);
      expect((await readJobCounters(stub)).manual_retries_used).toBe(0);

      // First manual: another marker-only must fail immediately (no fresh auto-retry).
      await rpc.retryTurn(1);
      const afterManual = requireState(await rpc.getState());
      expect(afterManual.job.status).toBe("running");
      expect(afterManual.job.autoRetriesUsed).toBe(1);
      expect(afterManual.job.continuationsUsed).toBe(0);
      let counters = await readJobCounters(stub);
      expect(counters.manual_retries_used).toBe(1);
      expect(counters.auto_retries_used).toBe(1);
      expect(counters.continuations_used).toBe(0);
      let attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(3);
      expect(attempts[2]!.kind).toBe("manual_retry");
      expect(attempts[2]!.attempt_number).toBe(3);
      expect(attempts[2]!.idempotency_key).toBe(`${jobId}:t1:a3:c0`);
      expect(dispatchCalls).toHaveLength(3);

      await settle(rpc, `wh-${jobId}-3`, `resp_${jobId}_3`);
      const stillFailed = requireState(await rpc.getState());
      expect(stillFailed.job.status).toBe("failed");
      expect(stillFailed.job.autoRetriesUsed).toBe(1);
      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(3);
      expect(dispatchCalls).toHaveLength(3);

      // Second manual with valid output completes without touching auto counters.
      await rpc.retryTurn(1);
      expect(dispatchCalls).toHaveLength(4);
      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(4);
      expect(attempts[3]!.kind).toBe("manual_retry");
      expect(attempts[3]!.idempotency_key).toBe(`${jobId}:t1:a4:c0`);
      await settle(rpc, `wh-${jobId}-4`, `resp_${jobId}_4`);
      const done = requireState(await rpc.getState());
      expect(done.job.status).toBe("completed");
      expect(done.job.autoRetriesUsed).toBe(1);
      expect(done.job.continuationsUsed).toBe(0);
      counters = await readJobCounters(stub);
      expect(counters.manual_retries_used).toBe(2);
      expect(counters.auto_retries_used).toBe(1);
      expect(done.turns[0]?.marginalInputTokens).toBe(22);
      expect(done.usage.generationCalls).toBe(4);
      attempts = await listAllAttempts(rpc);
      expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2, 3, 4]);
      expect(new Set(attempts.map((attempt) => attempt.idempotency_key)).size).toBe(4);
      expectMonotonicAttemptNumbers(attempts);
    }

    // Part B: continuation budget stays exhausted across manuals.
    {
      const { rpc, stub, jobId } = nextJob("manual-cont");
      dispatchResponder = () => {
        const seq = dispatchCalls.length;
        return queuedDispatchResponse(`resp_${jobId}_${seq}`);
      };
      retrievalResponder = (responseId) => {
        if (responseId === `resp_${jobId}_6`) {
          return completedRetrievalResponse(responseId, "fixed <!-- TURN_END:1 -->", 33, 9);
        }
        return incompleteRetrievalResponse(responseId, `c-${responseId} `, 10, 5);
      };
      stubOpenAI();

      await createAndStartTurn(rpc, jobId);
      for (let seq = 1; seq <= 4; seq += 1) {
        await settle(rpc, `wh-${jobId}-${seq}`, `resp_${jobId}_${seq}`, "response.incomplete");
      }
      const exhausted = requireState(await rpc.getState());
      expect(exhausted.job.status).toBe("failed");
      expect(exhausted.job.continuationsUsed).toBe(3);
      expect(exhausted.job.autoRetriesUsed).toBe(0);

      await rpc.retryTurn(1);
      const afterManual = requireState(await rpc.getState());
      expect(afterManual.job.continuationsUsed).toBe(3);
      expect(afterManual.job.autoRetriesUsed).toBe(0);
      let counters = await readJobCounters(stub);
      expect(counters.manual_retries_used).toBe(1);
      expect(counters.continuations_used).toBe(3);
      expect(dispatchCalls).toHaveLength(5);

      // Another incomplete must fail immediately: the continuation budget is still spent.
      await settle(rpc, `wh-${jobId}-5`, `resp_${jobId}_5`, "response.incomplete");
      const stillFailed = requireState(await rpc.getState());
      expect(stillFailed.job.status).toBe("failed");
      expect(stillFailed.job.errorCode).toBe("incomplete");
      expect(stillFailed.job.continuationsUsed).toBe(3);
      expect((await listAllAttempts(rpc)).length).toBe(5);
      expect(dispatchCalls).toHaveLength(5);

      await rpc.retryTurn(1);
      expect(dispatchCalls).toHaveLength(6);
      await settle(rpc, `wh-${jobId}-6`, `resp_${jobId}_6`);
      const done = requireState(await rpc.getState());
      expect(done.job.status).toBe("completed");
      expect(done.job.continuationsUsed).toBe(3);
      counters = await readJobCounters(stub);
      expect(counters.manual_retries_used).toBe(2);
      expect(counters.continuations_used).toBe(3);
      const attempts = await listAllAttempts(rpc);
      expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(attempts[5]!.kind).toBe("manual_retry");
      expect(new Set(attempts.map((attempt) => attempt.idempotency_key)).size).toBe(6);
      expectMonotonicAttemptNumbers(attempts);
    }
  });
});

describe("ambiguous dispatch fence", () => {
  it("pauses without reusing the attempt, then resumes with a fresh attempt and key", async () => {
    const cases = [
      {
        name: "server_5xx",
        firstDispatch: (): Response =>
          jsonResponse(
            { error: { code: "server_error", type: "server_error", message: "Internal server error" } },
            500,
          ),
      },
      {
        name: "network_error",
        firstDispatch: (): Response => {
          throw new Error("socket reset during dispatch");
        },
      },
      {
        name: "unparseable_response",
        firstDispatch: (): Response => jsonResponse({ model: "gpt-5", status: "queued" }, 200),
      },
    ] as const;

    for (const testCase of cases) {
      const { rpc, stub, jobId } = nextJob(`amb-${testCase.name}`);
      dispatchResponder = (callIndex) => {
        if (callIndex === 0) {
          return testCase.firstDispatch();
        }
        return queuedDispatchResponse(`resp_${jobId}_2`);
      };
      retrievalResponder = (responseId) => {
        return completedRetrievalResponse(responseId, `ok ${testCase.name} <!-- TURN_END:1 -->`, 12, 8);
      };
      stubOpenAI();

      const paused = await createAndStartTurn(rpc, jobId);
      expect(paused.job.status).toBe("paused_dispatch");
      expect(paused.job.errorCode).toBe("ambiguous_dispatch");
      expect(paused.turns[0]?.status).toBe("paused_review");
      expect(paused.activeAttempt).toBeNull();
      expect(dispatchCalls).toHaveLength(1);
      expect(dispatchCalls[0]!.idempotencyKey).toBe(`${jobId}:t1:a1:c0`);

      let attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.status).toBe("ambiguous_dispatch");
      expect(attempts[0]!.attempt_number).toBe(1);
      expect(attempts[0]!.idempotency_key).toBe(`${jobId}:t1:a1:c0`);
      expect(await readDurableWork(stub)).toHaveLength(0);

      const resumed = await rpc.retryTurn(1);
      expect(resumed.job.status).toBe("running");
      expect(dispatchCalls).toHaveLength(2);
      expect(dispatchCalls[1]!.idempotencyKey).toBe(`${jobId}:t1:a2:c0`);
      expect(dispatchCalls[1]!.idempotencyKey).not.toBe(dispatchCalls[0]!.idempotencyKey);

      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(2);
      expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
      expect(attempts[0]!.status).toBe("ambiguous_dispatch");
      expect(attempts[1]!.kind).toBe("manual_retry");
      expect(attempts[1]!.status).toBe("dispatched");
      expect(attempts[1]!.idempotency_key).toBe(`${jobId}:t1:a2:c0`);
      expectMonotonicAttemptNumbers(attempts);

      await settle(rpc, `wh-${jobId}-2`, `resp_${jobId}_2`);
      const done = requireState(await rpc.getState());
      expect(done.job.status).toBe("completed");
      expect(done.turns[0]?.status).toBe("accepted");
      expect(dispatchCalls).toHaveLength(2);
    }
  });
});

describe("capacity backoff fence", () => {
  it("persists five sends on one attempt then pauses without a sixth send", async () => {
    const { rpc, stub, jobId } = nextJob("cap");
    dispatchResponder = () =>
      jsonResponse(
        {
          error: {
            code: "rate_limit_exceeded",
            type: "rate_limit_error",
            message: "Rate limit exceeded. Try again later.",
          },
        },
        429,
      );
    retrievalResponder = () => {
      throw new Error("must never retrieve before a successful dispatch");
    };
    stubOpenAI();

    const attemptId = `${jobId}:t1:a1`;
    const dispatchWorkId = `${attemptId}:dispatch`;

    const started = await createAndStartTurn(rpc, jobId);
    expect(started.job.status).toBe("running");
    expect(started.activeAttempt?.status).toBe("capacity_backoff");
    expect(started.activeAttempt?.capacitySendCount).toBe(1);
    expect(dispatchCalls).toHaveLength(1);
    const attemptKey = dispatchCalls[0]!.idempotencyKey;
    expect(attemptKey).toBe(`${jobId}:t1:a1:c0`);

    let attempts = await listAllAttempts(rpc);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("capacity_backoff");
    expect(attempts[0]!.capacity_sends).toBe(1);
    let work = await readDurableWork(stub);
    expect(work).toHaveLength(1);
    expect(work[0]!.work_id).toBe(dispatchWorkId);
    expect(work[0]!.kind).toBe("capacity_backoff");
    expect(work[0]!.attempt_id).toBe(attemptId);
    expect(work[0]!.due_at_ms).toBe(attempts[0]!.next_backoff_at_ms);
    // First capacity failure persists sends=1 with the 10s backoff (5s * 2^1).
    expect(persistedDelayMs(work[0]!)).toBe(10_000);
    // Earliest-obligation scheduling (ensureAlarmNotLaterThan never moves the
    // alarm forward): the alarm still reflects the earlier dispatch-intent
    // fence (now+5s) written at prepare time, not the later 10s backoff
    // deadline. The retry loop below drives the alarm and asserts each
    // deadline's effect.
    const backoffAlarmMs = await readAlarm(stub);
    expect(backoffAlarmMs).not.toBeNull();
    expect(backoffAlarmMs!).toBeLessThanOrEqual(work[0]!.due_at_ms);

    const expectedDelays = [20_000, 40_000, 80_000];
    for (let send = 2; send <= 4; send += 1) {
      await markWorkDue(stub, dispatchWorkId);
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(dispatchCalls).toHaveLength(send);
      for (const call of dispatchCalls) {
        expect(call.idempotencyKey).toBe(attemptKey);
      }
      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.attempt_number).toBe(1);
      expect(attempts[0]!.status).toBe("capacity_backoff");
      expect(attempts[0]!.capacity_sends).toBe(send);
      work = await readDurableWork(stub);
      expect(work).toHaveLength(1);
      expect(work[0]!.due_at_ms).toBe(attempts[0]!.next_backoff_at_ms);
      expect(persistedDelayMs(work[0]!)).toBe(expectedDelays[send - 2]!);
      expect(await readAlarm(stub)).toBe(work[0]!.due_at_ms);
      const state = requireState(await rpc.getState());
      expect(state.job.status).toBe("running");
      expect(state.activeAttempt?.capacitySendCount).toBe(send);
      expectMonotonicAttemptNumbers(attempts);
    }

    // Fifth send exhausts the budget and pauses for manual recovery.
    await markWorkDue(stub, dispatchWorkId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(dispatchCalls).toHaveLength(5);
    for (const call of dispatchCalls) {
      expect(call.idempotencyKey).toBe(attemptKey);
    }
    const paused = requireState(await rpc.getState());
    expect(paused.job.status).toBe("paused_dispatch");
    expect(paused.job.errorCode).toBe("capacity_exhausted");
    expect(paused.turns[0]?.status).toBe("paused_review");
    expect(paused.activeAttempt).toBeNull();
    attempts = await listAllAttempts(rpc);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe("capacity_exhausted");
    // The fifth send is authoritative in fetch count; the persisted counter
    // holds the four completed backoff sends that preceded exhaustion.
    expect(attempts[0]!.capacity_sends).toBe(4);
    expect(attempts[0]!.next_backoff_at_ms).toBeNull();
    expect(await readDurableWork(stub)).toHaveLength(0);
    expect(await readAlarm(stub)).toBeNull();

    // No sixth send: the alarm is settled and the attempt stays fenced.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(dispatchCalls).toHaveLength(5);
    expect(MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT).toBe(5);
  });
});

describe("incomplete and missing-tag auto-continue", () => {
  it("auto-continues within budget with cumulative text across the chain", async () => {
    // Capped/incomplete response auto-continues.
    {
      const { rpc, stub, jobId } = nextJob("inc");
      dispatchResponder = () => {
        const seq = dispatchCalls.length;
        return queuedDispatchResponse(`resp_${jobId}_${seq}`);
      };
      retrievalResponder = (responseId) => {
        if (responseId === `resp_${jobId}_1`) {
          return incompleteRetrievalResponse(responseId, "hello ", 10, 5);
        }
        return completedRetrievalResponse(responseId, "world <!-- TURN_END:1 -->", 12, 8);
      };
      stubOpenAI();

      await createAndStartTurn(rpc, jobId);
      await settle(rpc, `wh-${jobId}-1`, `resp_${jobId}_1`, "response.incomplete");
      const continued = requireState(await rpc.getState());
      expect(continued.job.status).toBe("running");
      expect(continued.job.continuationsUsed).toBe(1);
      expect(continued.job.autoRetriesUsed).toBe(0);
      let attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.kind).toBe("continuation");
      expect(attempts[1]!.attempt_number).toBe(2);
      expect(attempts[1]!.continuation_index).toBe(1);
      expect(attempts[1]!.parent_response_id).toBe(`resp_${jobId}_1`);
      expect(dispatchCalls).toHaveLength(2);
      expectMonotonicAttemptNumbers(attempts);

      await settle(rpc, `wh-${jobId}-2`, `resp_${jobId}_2`);
      const done = requireState(await rpc.getState());
      expect(done.job.status).toBe("completed");
      expect(done.job.continuationsUsed).toBe(1);
      expect(done.turns[0]?.status).toBe("accepted");
      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(2);
      const deliverable = await rpc.readArtifact({
        kind: "candidate_deliverable",
        id: `${attempts[1]!.attempt_id}:candidate`,
      });
      expect(deliverable).not.toBeNull();
      expect(new TextDecoder("utf-8").decode(deliverable!.bytes)).toBe("hello world");
      expect(retrievalCount).toBe(2);
      expect(await readDurableWork(stub)).toHaveLength(0);
    }

    // Missing-tag candidate auto-continues.
    {
      const { rpc, stub, jobId } = nextJob("miss");
      dispatchResponder = () => {
        const seq = dispatchCalls.length;
        return queuedDispatchResponse(`resp_${jobId}_${seq}`);
      };
      retrievalResponder = (responseId) => {
        if (responseId === `resp_${jobId}_1`) {
          return completedRetrievalResponse(responseId, "prefix ", 10, 5);
        }
        return completedRetrievalResponse(responseId, "suffix <!-- TURN_END:1 -->", 12, 8);
      };
      stubOpenAI();

      await createAndStartTurn(rpc, jobId);
      await settle(rpc, `wh-${jobId}-1`, `resp_${jobId}_1`);
      const continued = requireState(await rpc.getState());
      expect(continued.job.status).toBe("running");
      expect(continued.job.continuationsUsed).toBe(1);
      expect(continued.job.autoRetriesUsed).toBe(0);
      let attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.kind).toBe("continuation");
      expect(attempts[1]!.continuation_index).toBe(1);
      expect(attempts[1]!.parent_response_id).toBe(`resp_${jobId}_1`);
      expect(dispatchCalls).toHaveLength(2);

      await settle(rpc, `wh-${jobId}-2`, `resp_${jobId}_2`);
      const done = requireState(await rpc.getState());
      expect(done.job.status).toBe("completed");
      expect(done.job.continuationsUsed).toBe(1);
      expect(done.turns[0]?.status).toBe("accepted");
      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(2);
      const deliverable = await rpc.readArtifact({
        kind: "candidate_deliverable",
        id: `${attempts[1]!.attempt_id}:candidate`,
      });
      expect(deliverable).not.toBeNull();
      expect(new TextDecoder("utf-8").decode(deliverable!.bytes)).toBe("prefix suffix");
      expect(retrievalCount).toBe(2);
      expect(await readDurableWork(stub)).toHaveLength(0);
    }
  });
});

describe("fallback polling schedule and bound", () => {
  it("follows 5m/1m/5m then pauses at the 24-probe bound", async () => {
    const { rpc, stub, jobId } = nextJob("poll");
    dispatchResponder = () => queuedDispatchResponse(`resp_${jobId}_1`);
    retrievalResponder = (responseId) =>
      jsonResponse({ id: responseId, model: "gpt-5", status: "in_progress" });
    stubOpenAI();

    const attemptId = `${jobId}:t1:a1`;
    const pollWorkId = `${attemptId}:poll`;

    const dispatched = await createAndStartTurn(rpc, jobId);
    expect(dispatched.job.status).toBe("running");
    expect(dispatched.activeAttempt?.status).toBe("dispatched");
    expect(dispatchCalls).toHaveLength(1);

    let attempts = await listAllAttempts(rpc);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.poll_probes).toBe(0);
    let work = await readDurableWork(stub);
    expect(work).toHaveLength(1);
    expect(work[0]!.work_id).toBe(pollWorkId);
    expect(work[0]!.kind).toBe("fallback_poll");
    expect(work[0]!.attempt_id).toBe(attemptId);
    expect(work[0]!.due_at_ms).toBe(attempts[0]!.next_poll_at_ms);
    expect(persistedDelayMs(work[0]!)).toBe(300_000);
    // Earliest-obligation scheduling (ensureAlarmNotLaterThan never moves the
    // alarm forward): the alarm still reflects the earlier dispatch-intent
    // fence (now+5s), not the later 5m poll deadline. The probe loop below
    // drives the alarm and asserts each deadline's effect.
    const pollAlarmMs = await readAlarm(stub);
    expect(pollAlarmMs).not.toBeNull();
    expect(pollAlarmMs!).toBeLessThanOrEqual(work[0]!.due_at_ms);

    expect(FALLBACK_POLL_FIRST_DELAY_MS).toBe(300_000);
    expect(FALLBACK_POLL_SECOND_DELAY_MS).toBe(60_000);
    expect(FALLBACK_POLL_STEADY_DELAY_MS).toBe(300_000);
    expect(MAX_FALLBACK_POLL_PROBES).toBe(24);

    for (let probe = 1; probe <= 24; probe += 1) {
      await markWorkDue(stub, pollWorkId);
      expect(await runDurableObjectAlarm(stub)).toBe(true);

      expect(retrievalCount).toBe(probe);
      expect(dispatchCalls).toHaveLength(1);
      attempts = await listAllAttempts(rpc);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.attempt_number).toBe(1);
      expect(attempts[0]!.poll_probes).toBe(probe);
      expectMonotonicAttemptNumbers(attempts);

      if (probe < 24) {
        const expectedDelay = probe === 1 ? 60_000 : 300_000;
        expect(attempts[0]!.status).toBe("dispatched");
        expect(attempts[0]!.next_poll_at_ms).not.toBeNull();
        work = await readDurableWork(stub);
        expect(work).toHaveLength(1);
        expect(work[0]!.work_id).toBe(pollWorkId);
        expect(work[0]!.due_at_ms).toBe(attempts[0]!.next_poll_at_ms);
        expect(persistedDelayMs(work[0]!)).toBe(expectedDelay);
        expect(await readAlarm(stub)).toBe(work[0]!.due_at_ms);
        const state = requireState(await rpc.getState());
        expect(state.job.status).toBe("running");
        expect(state.activeAttempt?.fallbackPollCount).toBe(probe);
      } else {
        expect(attempts[0]!.status).toBe("ambiguous_dispatch");
        expect(attempts[0]!.next_poll_at_ms).toBeNull();
        const paused = requireState(await rpc.getState());
        expect(paused.job.status).toBe("paused_dispatch");
        expect(paused.job.errorCode).toBe("fallback_poll_exhausted");
        expect(paused.turns[0]?.status).toBe("paused_review");
        expect(paused.activeAttempt).toBeNull();
        expect(await readDurableWork(stub)).toHaveLength(0);
        expect(await readAlarm(stub)).toBeNull();
      }
    }

    // No 25th probe: the bound holds and the alarm stays settled.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(retrievalCount).toBe(24);
    attempts = await listAllAttempts(rpc);
    expect(attempts[0]!.poll_probes).toBe(24);
  });
});

describe("capstone recovery loop", () => {
  it("marker-only then valid reaches the retry ceiling and completes without exceeding budgets", async () => {
    const { rpc, stub, jobId } = nextJob("capstone");
    dispatchResponder = () => {
      const seq = dispatchCalls.length;
      return queuedDispatchResponse(`resp_${jobId}_${seq}`);
    };
    retrievalResponder = (responseId) => {
      if (responseId === `resp_${jobId}_1`) {
        return completedRetrievalResponse(responseId, "<!-- TURN_END:1 -->", 11, 7);
      }
      return completedRetrievalResponse(responseId, "final answer <!-- TURN_END:1 -->", 22, 9);
    };
    stubOpenAI();

    await createAndStartTurn(rpc, jobId);
    expect(dispatchCalls).toHaveLength(1);

    await settle(rpc, `wh-${jobId}-1`, `resp_${jobId}_1`);
    const mid = requireState(await rpc.getState());
    expect(mid.job.status).toBe("running");
    expect(mid.job.autoRetriesUsed).toBe(1);
    expect(mid.job.autoRetriesUsed).toBe(MAX_AUTO_FULL_RETRIES);
    expect(mid.job.continuationsUsed).toBe(0);
    expect(dispatchCalls).toHaveLength(2);

    await settle(rpc, `wh-${jobId}-2`, `resp_${jobId}_2`);
    const done = requireState(await rpc.getState());
    expect(done.job.status).toBe("completed");
    expect(done.turns[0]?.status).toBe("accepted");
    expect(done.job.autoRetriesUsed).toBe(1);
    expect(done.job.continuationsUsed).toBe(0);
    expect(done.job.continuationsUsed).toBeLessThanOrEqual(MAX_AUTO_CONTINUATIONS_PER_TURN);
    expect(done.job.autoRetriesUsed).toBeLessThanOrEqual(MAX_AUTO_FULL_RETRIES);

    const attempts = await listAllAttempts(rpc);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.attempt_number)).toEqual([1, 2]);
    expect(attempts.map((attempt) => attempt.kind)).toEqual(["initial", "auto_retry"]);
    expect(attempts.map((attempt) => attempt.idempotency_key)).toEqual([
      `${jobId}:t1:a1:c0`,
      `${jobId}:t1:a2:c0`,
    ]);
    expect(new Set(attempts.map((attempt) => attempt.idempotency_key)).size).toBe(2);
    expectMonotonicAttemptNumbers(attempts);

    expect(dispatchCalls).toHaveLength(2);
    expect(retrievalCount).toBe(2);
    expect(done.usage.generationCalls).toBe(2);
    expect(done.turns[0]?.marginalInputTokens).toBe(22);

    const deliverable = await rpc.readArtifact({
      kind: "candidate_deliverable",
      id: `${attempts[1]!.attempt_id}:candidate`,
    });
    expect(deliverable).not.toBeNull();
    expect(new TextDecoder("utf-8").decode(deliverable!.bytes)).toBe("final answer");
    expect(await readDurableWork(stub)).toHaveLength(0);
  });
});
