// Covers: 18
//
// Race half of TESTING.md item 18 (webhook durability and ordering).
// Drives RouterDO directly (enqueue/register + runDurableObjectAlarm against
// persisted deadlines) and asserts RouterDO/JobDO observable state. Ingress
// signature verification is a sibling concern and is not duplicated here.

import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REGISTRY_DO_NAME, ROUTER_DO_NAME } from "../../src/constants.ts";
import type { GenerationAttemptSummaryRow } from "../../src/db/schema.ts";
import type {
  AppendTurnCommand,
  CreateJobCommand,
  CursorPage,
  JobConfig,
  JobStateResponse,
  OpenAIWebhookEventType,
  ResponseRouteMapping,
  VerifiedWebhookEvent,
  WebhookIngressReceipt,
} from "../../src/types.ts";

interface RouterTestRpc {
  enqueueWebhook(
    event: VerifiedWebhookEvent,
  ): Promise<{ receipt: WebhookIngressReceipt; duplicate: boolean }>;
  registerResponseRoute(mapping: ResponseRouteMapping): Promise<void>;
}

interface JobTestRpc {
  createJob(command: CreateJobCommand): Promise<JobStateResponse>;
  appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>;
  supersedeParent(epoch: number, childId: string): Promise<boolean>;
  getState(): Promise<JobStateResponse | null>;
  listAttempts(request: {
    limit: number;
  }): Promise<CursorPage<GenerationAttemptSummaryRow>>;
  readArtifact(request: {
    kind: "candidate_deliverable";
    id: string;
  }): Promise<{ bytes: ArrayBuffer } | null>;
}

/** Fixed far-future persisted deadline; never derived from a wall clock. */
const DEADLINE_MS = 4_000_000_000_000;

/** Fixed delivery timestamp (seconds) carried on synthetic verified events. */
const TIMESTAMP_SECONDS = 1_760_000_000;

/** Judge-free config so settlement accepts a structurally valid candidate. */
const RACE_JOB_CONFIG: JobConfig = {
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

let routerSequence = 0;
let jobSequence = 0;
const trackedRouters: DurableObjectStub[] = [];
const trackedJobIds: string[] = [];

interface ProviderPlan {
  dispatchId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

let plan: ProviderPlan = {
  dispatchId: "resp_unset",
  text: "hello <!-- TURN_END:1 -->",
  inputTokens: 12,
  outputTokens: 8,
};

/** Stubs only api.openai.com; any other host fails loudly. */
function stubOpenAI(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (new URL(url).hostname !== "api.openai.com") {
          throw new Error(`Unexpected outbound fetch host: ${url}`);
        }
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith("/responses")) {
          return new Response(
            JSON.stringify({
              id: plan.dispatchId,
              model: "gpt-5",
              status: "queued",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        const match = /\/responses\/([^/]+)$/.exec(url);
        if (method === "GET" && match !== null) {
          return new Response(
            JSON.stringify({
              id: match[1],
              model: "gpt-5",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: plan.text }],
                },
              ],
              usage: {
                input_tokens: plan.inputTokens,
                output_tokens: plan.outputTokens,
                total_tokens: plan.inputTokens + plan.outputTokens,
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error(`Unexpected provider call: ${method} ${url}`);
      },
    ),
  );
}

function nextRouter(): { rpc: RouterTestRpc; stub: DurableObjectStub } {
  routerSequence += 1;
  const stub = env.ROUTER_DO.get(
    env.ROUTER_DO.idFromName(`webhook-race-router-${routerSequence}`),
  );
  trackedRouters.push(stub);
  return { rpc: stub as unknown as RouterTestRpc, stub };
}

function nextJob(): { rpc: JobTestRpc; jobId: string } {
  jobSequence += 1;
  const jobId = `webhook-race-job-${jobSequence}`;
  trackedJobIds.push(jobId);
  const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
  return { rpc: stub as unknown as JobTestRpc, jobId };
}

/** Builds the exact raw bytes for one inbox row (single copy, byte-compared). */
function webhookBodyBytes(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes.buffer;
}

function webhookEvent(
  webhookId: string,
  eventType: OpenAIWebhookEventType,
  responseId: string,
  rawPayload: ArrayBuffer,
): VerifiedWebhookEvent {
  return {
    webhookId,
    timestampSeconds: TIMESTAMP_SECONDS,
    eventType,
    responseId,
    rawPayload,
    receivedAtMs: DEADLINE_MS,
  };
}

function routeMapping(
  responseId: string,
  jobId: string,
  attemptId: string,
  registeredAtMs: number,
): ResponseRouteMapping {
  return {
    responseId,
    jobId,
    attemptId,
    turnIndex: 1,
    registeredAtMs,
    settledAtMs: null,
  };
}

interface InboxRow extends Record<string, SqlStorageValue> {
  status: string;
  job_id: string | null;
  event_type: string;
  delivery_attempts: number;
  next_attempt_at_ms: number | null;
}

async function readInboxRow(
  stub: DurableObjectStub,
  webhookId: string,
): Promise<InboxRow> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<InboxRow>(
        `SELECT status, job_id, event_type, delivery_attempts, next_attempt_at_ms
         FROM webhook_inbox
         WHERE webhook_id = ?`,
        webhookId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing webhook inbox row: ${webhookId}`);
    }
    return row;
  });
}

async function readInboxBlob(
  stub: DurableObjectStub,
  webhookId: string,
): Promise<Uint8Array> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ raw_body_blob: ArrayBuffer }>(
        `SELECT raw_body_blob FROM webhook_inbox WHERE webhook_id = ?`,
        webhookId,
      )
      .toArray();
    const blob = rows[0]?.raw_body_blob;
    if (!(blob instanceof ArrayBuffer)) {
      throw new Error(`Missing raw body blob: ${webhookId}`);
    }
    return new Uint8Array(blob);
  });
}

async function readRouteStatus(
  stub: DurableObjectStub,
  responseId: string,
): Promise<string> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ status: string }>(
        `SELECT status FROM response_routes WHERE response_id = ?`,
        responseId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing response route: ${responseId}`);
    }
    return row.status;
  });
}

/** Makes every row for a response due without touching the scheduled alarm. */
async function markDue(
  stub: DurableObjectStub,
  responseId: string,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE webhook_inbox SET next_attempt_at_ms = 1 WHERE response_id = ?`,
      responseId,
    );
  });
}

async function readAlarm(stub: DurableObjectStub): Promise<number | null> {
  return await runInDurableObject(stub, async (_instance, state) => {
    return await state.storage.getAlarm();
  });
}

async function dispatchTurn(
  job: JobTestRpc,
  jobId: string,
): Promise<{ attemptId: string; responseId: string }> {
  await job.createJob({
    jobId,
    title: "webhook race job",
    config: RACE_JOB_CONFIG,
    initialTurns: [],
  });
  const appended = await job.appendTurn({
    promptText: "Write a greeting.",
    attachmentFileIds: [],
  });
  const attempt = appended.activeAttempt;
  if (attempt === null || attempt.responseId === null) {
    throw new Error("Expected a dispatched attempt with a response id");
  }
  return { attemptId: attempt.attemptId, responseId: attempt.responseId };
}

function requireState(state: JobStateResponse | null): JobStateResponse {
  if (state === null) {
    throw new Error("Expected job state");
  }
  return state;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const stub of trackedRouters.splice(0)) {
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  }
  for (const jobId of trackedJobIds.splice(0)) {
    await runInDurableObject(
      env.JOB_DO.get(env.JOB_DO.idFromName(jobId)),
      async (_instance, state) => {
        await state.storage.deleteAlarm();
      },
    );
  }
  // createJob/appendTurn register routes and jobs on the singleton coordinators.
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

describe("webhook delivery races", () => {
  it("accepts a duplicate response.completed exactly once and records usage once", async () => {
    plan = {
      dispatchId: "resp_dup",
      text: "hello <!-- TURN_END:1 -->",
      inputTokens: 12,
      outputTokens: 8,
    };
    stubOpenAI();
    const { rpc: job, jobId } = nextJob();
    const { attemptId } = await dispatchTurn(job, jobId);

    const { rpc: router, stub } = nextRouter();
    await router.registerResponseRoute(
      routeMapping("resp_dup", jobId, attemptId, DEADLINE_MS),
    );
    const body = webhookBodyBytes(
      `{"type":"response.completed","response":{"id":"resp_dup"}}`,
    );
    await router.enqueueWebhook(
      webhookEvent("wh-dup-1", "response.completed", "resp_dup", body),
    );
    await router.enqueueWebhook(
      webhookEvent("wh-dup-2", "response.completed", "resp_dup", body),
    );
    await markDue(stub, "resp_dup");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const settled = requireState(await job.getState());
    expect(settled.job.status).toBe("completed");
    expect(settled.turns).toHaveLength(1);
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.turns[0]?.acceptedResponseId).toBe("resp_dup");
    expect(settled.turns[0]?.marginalInputTokens).toBe(12);
    expect(settled.activeAttempt).toBeNull();
    expect(settled.usage.generationCalls).toBe(1);

    const attempts = await job.listAttempts({ limit: 100 });
    expect(attempts.items).toHaveLength(1);

    const deliverable = await job.readArtifact({
      kind: "candidate_deliverable",
      id: `${attemptId}:candidate`,
    });
    expect(deliverable).not.toBeNull();
    expect(new TextDecoder().decode(deliverable?.bytes)).toBe("hello");

    for (const webhookId of ["wh-dup-1", "wh-dup-2"]) {
      const row = await readInboxRow(stub, webhookId);
      expect(row.status).toBe("delivered");
      expect(row.event_type).toBe("response.completed");
      expect(row.delivery_attempts).toBe(1);
      expect(Array.from(await readInboxBlob(stub, webhookId))).toEqual(
        Array.from(new Uint8Array(body)),
      );
    }
    expect(await readRouteStatus(stub, "resp_dup")).toBe("delivered");
    expect(await readAlarm(stub)).toBeNull();
  });

  it("keeps the settled decision on a failed-then-completed pair and retains both observations", async () => {
    plan = {
      dispatchId: "resp_ooo",
      text: "hello <!-- TURN_END:1 -->",
      inputTokens: 12,
      outputTokens: 8,
    };
    stubOpenAI();
    const { rpc: job, jobId } = nextJob();
    const { attemptId } = await dispatchTurn(job, jobId);

    const { rpc: router, stub } = nextRouter();
    await router.registerResponseRoute(
      routeMapping("resp_ooo", jobId, attemptId, DEADLINE_MS),
    );

    const failedBody = webhookBodyBytes(
      `{"type":"response.failed","response":{"id":"resp_ooo"}}`,
    );
    await router.enqueueWebhook(
      webhookEvent("wh-ooo-fail", "response.failed", "resp_ooo", failedBody),
    );
    await markDue(stub, "resp_ooo");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const afterFailed = requireState(await job.getState());
    expect(afterFailed.turns[0]?.status).toBe("accepted");
    expect(afterFailed.turns[0]?.acceptedResponseId).toBe("resp_ooo");
    expect(afterFailed.usage.generationCalls).toBe(1);

    const completedBody = webhookBodyBytes(
      `{"type":"response.completed","response":{"id":"resp_ooo"}}`,
    );
    await router.enqueueWebhook(
      webhookEvent(
        "wh-ooo-completed",
        "response.completed",
        "resp_ooo",
        completedBody,
      ),
    );
    await markDue(stub, "resp_ooo");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const settled = requireState(await job.getState());
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.turns[0]?.acceptedResponseId).toBe("resp_ooo");
    expect(settled.turns[0]?.marginalInputTokens).toBe(12);
    expect(settled.usage.generationCalls).toBe(1);
    expect((await job.listAttempts({ limit: 100 })).items).toHaveLength(1);

    const failedRow = await readInboxRow(stub, "wh-ooo-fail");
    expect(failedRow.status).toBe("delivered");
    expect(failedRow.event_type).toBe("response.failed");
    expect(failedRow.delivery_attempts).toBe(1);
    expect(Array.from(await readInboxBlob(stub, "wh-ooo-fail"))).toEqual(
      Array.from(new Uint8Array(failedBody)),
    );

    const completedRow = await readInboxRow(stub, "wh-ooo-completed");
    expect(completedRow.status).toBe("delivered");
    expect(completedRow.event_type).toBe("response.completed");
    expect(completedRow.delivery_attempts).toBe(1);
    expect(
      Array.from(await readInboxBlob(stub, "wh-ooo-completed")),
    ).toEqual(Array.from(new Uint8Array(completedBody)));

    expect(await readRouteStatus(stub, "resp_ooo")).toBe("delivered");
    expect(await readAlarm(stub)).toBeNull();
  });

  it("holds a pre-mapping event in the inbox and resolves it once the mapping registers", async () => {
    stubOpenAI();
    plan = {
      dispatchId: "resp_pre",
      text: "hello <!-- TURN_END:1 -->",
      inputTokens: 12,
      outputTokens: 8,
    };
    const { rpc: router, stub } = nextRouter();

    const body = webhookBodyBytes(
      `{"type":"response.completed","response":{"id":"resp_pre"}}`,
    );
    const receipt = await router.enqueueWebhook(
      webhookEvent("wh-pre-1", "response.completed", "resp_pre", body),
    );
    expect(receipt).toEqual({
      receipt: {
        kind: "accepted",
        webhookId: "wh-pre-1",
        duplicate: false,
        matchedJobId: null,
      },
      duplicate: false,
    });

    const unmatched = await readInboxRow(stub, "wh-pre-1");
    expect(unmatched.status).toBe("unmatched");
    expect(unmatched.job_id).toBeNull();
    expect(Array.from(await readInboxBlob(stub, "wh-pre-1"))).toEqual(
      Array.from(new Uint8Array(body)),
    );
    expect(await readAlarm(stub)).toBeNull();

    const { rpc: job, jobId } = nextJob();
    const { attemptId } = await dispatchTurn(job, jobId);
    await router.registerResponseRoute(
      routeMapping("resp_pre", jobId, attemptId, DEADLINE_MS),
    );

    const reconciled = await readInboxRow(stub, "wh-pre-1");
    expect(reconciled.status).toBe("pending");
    expect(reconciled.job_id).toBe(jobId);
    expect(reconciled.next_attempt_at_ms).toBe(DEADLINE_MS);
    expect(await readAlarm(stub)).toBe(DEADLINE_MS);

    await markDue(stub, "resp_pre");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const settled = requireState(await job.getState());
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.turns[0]?.acceptedResponseId).toBe("resp_pre");
    expect(settled.usage.generationCalls).toBe(1);

    const delivered = await readInboxRow(stub, "wh-pre-1");
    expect(delivered.status).toBe("delivered");
    expect(delivered.delivery_attempts).toBe(1);
    expect(await readAlarm(stub)).toBeNull();
  });

  it("leaves a superseded attempt untouched on a late terminal event and retains accounting", async () => {
    plan = {
      dispatchId: "resp_old",
      text: "hello <!-- TURN_END:1 -->",
      inputTokens: 12,
      outputTokens: 8,
    };
    stubOpenAI();
    const { rpc: job, jobId } = nextJob();
    const { attemptId } = await dispatchTurn(job, jobId);
    // supersedeParent requires a quiescent parent (no in-flight active
    // attempt), so settle the dispatched attempt first via an early terminal
    // event. The late event below then exercises the superseded branch.
    const { rpc: router, stub } = nextRouter();
    await router.registerResponseRoute(
      routeMapping("resp_old", jobId, attemptId, DEADLINE_MS),
    );
    const earlyBody = webhookBodyBytes(
      `{"type":"response.completed","response":{"id":"resp_old"}}`,
    );
    await router.enqueueWebhook(
      webhookEvent("wh-early-1", "response.completed", "resp_old", earlyBody),
    );
    await markDue(stub, "resp_old");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const settled = requireState(await job.getState());
    expect(settled.turns[0]?.status).toBe("accepted");
    expect(settled.usage.generationCalls).toBe(1);

    const beforeSupersede = requireState(await job.getState());
    expect(
      await job.supersedeParent(beforeSupersede.job.revision, "child-1"),
    ).toBe(true);
    const superseded = requireState(await job.getState());
    expect(superseded.job.status).toBe("superseded");
    const snapshotBefore = JSON.stringify(superseded);

    const body = webhookBodyBytes(
      `{"type":"response.completed","response":{"id":"resp_old"}}`,
    );
    await router.enqueueWebhook(
      webhookEvent("wh-late-1", "response.completed", "resp_old", body),
    );
    await markDue(stub, "resp_old");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const snapshotAfter = JSON.stringify(
      requireState(await job.getState()),
    );
    expect(snapshotAfter).toBe(snapshotBefore);

    const afterLate = requireState(await job.getState());
    expect(afterLate.job.status).toBe("superseded");
    expect(afterLate.usage.generationCalls).toBe(1);

    const row = await readInboxRow(stub, "wh-late-1");
    expect(row.status).toBe("delivered");
    expect(row.delivery_attempts).toBe(1);
    expect(Array.from(await readInboxBlob(stub, "wh-late-1"))).toEqual(
      Array.from(new Uint8Array(body)),
    );
    expect(await readRouteStatus(stub, "resp_old")).toBe("delivered");
    expect(await readAlarm(stub)).toBeNull();
  });
});
