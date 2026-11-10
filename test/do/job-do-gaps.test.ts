// Covers: 21, 24
import { env } from "cloudflare:workers";
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
  SchemaTransactionalStorage,
} from "../../src/db/schema.ts";
import type {
  AppendTurnCommand,
  BranchCreationOutcome,
  BranchSnapshot,
  CreateJobCommand,
  CursorPage,
  JobConfig,
  JobStateResponse,
  VerifiedWebhookEvent,
} from "../../src/types.ts";

interface JobDoGapsRpc {
  createJob(command: CreateJobCommand): Promise<JobStateResponse>;
  getState(): Promise<JobStateResponse | null>;
  appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>;
  pauseJob(): Promise<JobStateResponse>;
  resumeJob(): Promise<JobStateResponse>;
  supersedeParent(epoch: number, childId: string): Promise<boolean>;
  captureBranchSnapshot(
    forkTurnIndex: number
  ): Promise<BranchSnapshot | { kind: "rejected"; reason: string; message: string }>;
  initializeBranch(snapshot: BranchSnapshot): Promise<BranchCreationOutcome>;
  receiveWebhookDelivery(event: VerifiedWebhookEvent): Promise<void>;
  listAttempts(request: { limit: number }): Promise<CursorPage<GenerationAttemptSummaryRow>>;
  updateJudgeConfig(config: unknown): Promise<JobStateResponse>;
}

interface RegistryGapsRpc {
  recordFileUpload(input: {
    fileId: string;
    sha256: string;
    filename: string;
    mimeType: string;
    byteSize: number;
  }): Promise<unknown>;
}

const GAP_JOB_CONFIG: JobConfig = {
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

const TIMESTAMP_SECONDS = 1_760_000_000;
const CREATED_AT_ISO = "2026-01-01T00:00:00.000Z";
const EARLY_DUE_MS = 4_000_000_000_000;
const LATE_DUE_MS = 4_000_000_060_000;

let sequence = 0;
const trackedJobIds: string[] = [];

function nextJobId(prefix: string): string {
  sequence += 1;
  return `job-do-gaps-${prefix}-${sequence}`;
}

function trackJobId(jobId: string): string {
  if (!trackedJobIds.includes(jobId)) {
    trackedJobIds.push(jobId);
  }
  return jobId;
}

function rawFor(jobId: string): DurableObjectStub {
  trackJobId(jobId);
  return env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
}

function stubFor(jobId: string): JobDoGapsRpc {
  return rawFor(jobId) as unknown as JobDoGapsRpc;
}

function requireState(state: JobStateResponse | null): JobStateResponse {
  if (state === null) {
    throw new Error("Expected job state");
  }
  return state;
}

function webhookEvent(webhookId: string, responseId: string): VerifiedWebhookEvent {
  return {
    webhookId,
    timestampSeconds: TIMESTAMP_SECONDS,
    eventType: "response.completed",
    responseId,
    rawPayload: new ArrayBuffer(0),
    receivedAtMs: TIMESTAMP_SECONDS * 1000,
  };
}

interface ProviderCall {
  readonly method: string;
  readonly url: string;
}

interface ProviderPlan {
  dispatchIds: string[];
  text: string;
  inputTokens: number;
  outputTokens: number;
  cancel: "ok" | "reject";
}

let providerPlan: ProviderPlan = {
  dispatchIds: [],
  text: "hello <!-- TURN_END:1 -->",
  inputTokens: 12,
  outputTokens: 8,
  cancel: "ok",
};
let dispatchIndex = 0;
const providerCalls: ProviderCall[] = [];

function resetProvider(plan: Partial<ProviderPlan> & Pick<ProviderPlan, "dispatchIds">): void {
  providerPlan = {
    text: "hello <!-- TURN_END:1 -->",
    inputTokens: 12,
    outputTokens: 8,
    cancel: "ok",
    ...plan,
  };
  dispatchIndex = 0;
  providerCalls.length = 0;
}

/** Stubs only api.openai.com; any other host fails loudly. */
function stubOpenAI(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).hostname !== "api.openai.com") {
        throw new Error(`Unexpected outbound fetch host: ${url}`);
      }
      const method = init?.method ?? "GET";
      providerCalls.push({ method, url });
      if (method === "POST" && url.endsWith("/cancel")) {
        if (providerPlan.cancel === "reject") {
          throw new Error("cancel rejected");
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.endsWith("/responses")) {
        const responseId =
          providerPlan.dispatchIds[dispatchIndex] ?? `resp_gap_fallback_${dispatchIndex + 1}`;
        dispatchIndex += 1;
        return new Response(
          JSON.stringify({ id: responseId, model: "gpt-5", status: "queued" }),
          { status: 200, headers: { "content-type": "application/json" } }
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
                content: [{ type: "output_text", text: providerPlan.text }],
              },
            ],
            usage: {
              input_tokens: providerPlan.inputTokens,
              output_tokens: providerPlan.outputTokens,
              total_tokens: providerPlan.inputTokens + providerPlan.outputTokens,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected provider call: ${method} ${url}`);
    })
  );
}

function registryStub(): DurableObjectStub {
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME));
}

async function catalogueFile(fileId: string, sha256: string): Promise<void> {
  const rpc = registryStub() as unknown as RegistryGapsRpc;
  await rpc.recordFileUpload({
    fileId,
    sha256,
    filename: `${fileId}.txt`,
    mimeType: "text/plain",
    byteSize: 8,
  });
}

async function registryRefCount(jobId: string): Promise<number> {
  return await runInDurableObject(registryStub(), async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM job_file_refs WHERE job_id = ?", jobId)
      .toArray();
    return rows[0]?.count ?? 0;
  });
}

async function catalogueActiveRefs(fileId: string): Promise<number> {
  return await runInDurableObject(registryStub(), async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ active_job_refs: number }>(
        "SELECT active_job_refs FROM file_catalogue WHERE file_id = ?",
        fileId
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing catalogue row: ${fileId}`);
    }
    return row.active_job_refs;
  });
}

async function countTableRows(
  stub: DurableObjectStub,
  table: "jobs" | "branch_lineage" | "job_files" | "durable_work"
): Promise<number> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)
      .toArray();
    return rows[0]?.count ?? 0;
  });
}

async function durableWorkCount(stub: DurableObjectStub, workId: string): Promise<number> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM durable_work WHERE work_id = ?", workId)
      .toArray();
    return rows[0]?.count ?? 0;
  });
}

async function earliestDurableDue(stub: DurableObjectStub): Promise<number | null> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ earliest: number | null }>("SELECT MIN(due_at_ms) AS earliest FROM durable_work")
      .toArray();
    return rows[0]?.earliest ?? null;
  });
}

async function readJobRevision(stub: DurableObjectStub, jobId: string): Promise<number> {
  return await runInDurableObject(stub, async (_instance, state) => {
    const rows = state.storage.sql
      .exec<{ revision: number }>("SELECT revision FROM jobs WHERE job_id = ?", jobId)
      .toArray();
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Missing job row: ${jobId}`);
    }
    return row.revision;
  });
}

async function readAlarm(stub: DurableObjectStub): Promise<number | null> {
  return await runInDurableObject(stub, async (_instance, state) => {
    return await state.storage.getAlarm();
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const jobId of trackedJobIds.splice(0)) {
    await runInDurableObject(
      env.JOB_DO.get(env.JOB_DO.idFromName(jobId)),
      async (_instance, state) => {
        await state.storage.deleteAlarm();
      }
    );
  }
  await runInDurableObject(
    env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME)),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
    }
  );
  await runInDurableObject(
    env.ROUTER_DO.get(env.ROUTER_DO.idFromName(ROUTER_DO_NAME)),
    async (_instance, state) => {
      await state.storage.deleteAlarm();
    }
  );
  await reset();
  await abortAllDurableObjects();
});

describe("JobDO branch superseding race", () => {
  it("aborts activation when the parent resumes before the child activates", async () => {
    const fileId = "file-gap-race";
    await catalogueFile(fileId, "sha-gap-race");
    resetProvider({
      dispatchIds: ["resp_gap_race_1", "resp_gap_race_2", "resp_gap_race_3"],
      cancel: "ok",
    });
    stubOpenAI();

    const parentJobId = nextJobId("parent-race");
    const parent = stubFor(parentJobId);
    await parent.createJob({
      jobId: parentJobId,
      title: "race parent",
      config: GAP_JOB_CONFIG,
      initialTurns: [
        { turnIndex: 1, promptText: "Parent turn one.", attachmentFileIds: [fileId] },
        { turnIndex: 2, promptText: "Parent turn two.", attachmentFileIds: [] },
      ],
    });
    await parent.receiveWebhookDelivery(webhookEvent("wh_gap_race_1", "resp_gap_race_1"));

    const paused = await parent.pauseJob();
    expect(paused.job.status).toBe("paused_operator");
    expect(paused.activeAttempt).toBeNull();

    const snapshotResult = await parent.captureBranchSnapshot(1);
    if ("kind" in snapshotResult) {
      throw new Error(`Expected a quiescent snapshot: ${snapshotResult.message}`);
    }
    const snapshot = snapshotResult;
    expect(snapshot.parentJob.jobId).toBe(parentJobId);
    expect(snapshot.referencedFileIds).toContain(fileId);
    const snapshotRevision = snapshot.parentJob.revision;

    const resumed = await parent.resumeJob();
    expect(resumed.job.status).toBe("running");
    expect(resumed.job.revision).toBeGreaterThan(snapshotRevision);
    expect(resumed.activeAttempt?.status).toBe("dispatched");

    const childDoId = nextJobId("child-race");
    const child = stubFor(childDoId);
    const outcome = await child.initializeBranch(snapshot);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") {
      throw new Error("Expected rejected branch activation");
    }
    expect(outcome.reason).toBe("parent_not_quiescent");
    expect(await child.getState()).toBeNull();

    const childRaw = rawFor(childDoId);
    expect(await countTableRows(childRaw, "jobs")).toBe(0);
    expect(await countTableRows(childRaw, "branch_lineage")).toBe(0);
    expect(await countTableRows(childRaw, "job_files")).toBe(0);

    const expectedBranchJobId = `${parentJobId}:branch:${snapshot.forkTurnIndex}:${snapshot.capturedAtMs}`;
    expect(await registryRefCount(expectedBranchJobId)).toBe(0);
    expect(await catalogueActiveRefs(fileId)).toBe(1);

    const parentAfter = requireState(await parent.getState());
    expect(parentAfter.job.status).toBe("running");
    expect(parentAfter.job.status).not.toBe("superseded");
    expect(parentAfter.job.revision).toBe(resumed.job.revision);
    expect(
      parentAfter.job.warningMessages.some((warning) => warning.startsWith("superseded_by:"))
    ).toBe(false);
    expect(parentAfter.activeAttempt?.status).toBe("dispatched");
  });
});

describe("JobDO branch file-protection race", () => {
  it("refuses activation when a referenced file is not protected", async () => {
    resetProvider({ dispatchIds: ["resp_gap_protect_1"] });
    stubOpenAI();

    const parentJobId = nextJobId("parent-protect");
    const parent = stubFor(parentJobId);
    await parent.createJob({
      jobId: parentJobId,
      title: "protection parent",
      config: GAP_JOB_CONFIG,
      initialTurns: [],
    });
    await parent.appendTurn({ promptText: "Parent turn.", attachmentFileIds: [] });
    await parent.receiveWebhookDelivery(webhookEvent("wh_gap_protect_1", "resp_gap_protect_1"));

    const before = requireState(await parent.getState());
    expect(before.job.status).toBe("completed");

    const snapshotResult = await parent.captureBranchSnapshot(1);
    if ("kind" in snapshotResult) {
      throw new Error(`Expected a quiescent snapshot: ${snapshotResult.message}`);
    }
    const snapshot = snapshotResult;
    const tampered: BranchSnapshot = {
      ...snapshot,
      referencedFileIds: ["file-gap-unprotected"],
    };

    const childDoId = nextJobId("child-protect");
    const child = stubFor(childDoId);
    const outcome = await child.initializeBranch(tampered);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") {
      throw new Error("Expected refused branch activation");
    }
    expect(outcome.reason).toBe("file_protection_failed");
    expect(await child.getState()).toBeNull();

    const childRaw = rawFor(childDoId);
    expect(await countTableRows(childRaw, "jobs")).toBe(0);
    expect(await countTableRows(childRaw, "branch_lineage")).toBe(0);
    expect(await countTableRows(childRaw, "job_files")).toBe(0);

    const expectedBranchJobId = `${tampered.parentJob.jobId}:branch:${tampered.forkTurnIndex}:${tampered.capturedAtMs}`;
    expect(await registryRefCount(expectedBranchJobId)).toBe(0);

    const parentAfter = requireState(await parent.getState());
    expect(parentAfter.job.status).toBe("completed");
    expect(parentAfter.job.revision).toBe(before.job.revision);
    expect(
      parentAfter.job.warningMessages.some((warning) => warning.startsWith("superseded_by:"))
    ).toBe(false);
  });
});

describe("JobDO epoch fencing", () => {
  it("rejects stale epochs and bumps the epoch exactly once on supersede", async () => {
    const jobId = nextJobId("fence");
    const stub = stubFor(jobId);
    const created = await stub.createJob({
      jobId,
      title: "fenced job",
      config: GAP_JOB_CONFIG,
      initialTurns: [],
    });
    const epoch = created.job.revision;

    expect(await stub.supersedeParent(epoch + 1, "child-gap-stale")).toBe(false);
    const held = requireState(await stub.getState());
    expect(held.job.status).toBe("ready");
    expect(held.job.revision).toBe(epoch);
    expect(
      held.job.warningMessages.some((warning) => warning.startsWith("superseded_by:"))
    ).toBe(false);

    expect(await stub.supersedeParent(epoch, "child-gap-1")).toBe(true);
    const superseded = requireState(await stub.getState());
    expect(superseded.job.status).toBe("superseded");
    expect(superseded.job.revision).toBe(epoch + 1);
    expect(superseded.job.warningMessages).toContain("superseded_by:child-gap-1");

    expect(await stub.supersedeParent(epoch, "child-gap-1")).toBe(true);
    const again = requireState(await stub.getState());
    expect(again.job.revision).toBe(epoch + 1);
    expect(again.job.warningMessages).toContain("superseded_by:child-gap-1");
  });
});

describe("JobDO command acknowledgement", () => {
  it("acknowledges the persisted pause when the best-effort cancel rejects", async () => {
    resetProvider({ dispatchIds: ["resp_gap_ack_1"], cancel: "reject" });
    stubOpenAI();

    const jobId = nextJobId("ack");
    const stub = stubFor(jobId);
    await stub.createJob({
      jobId,
      title: "acknowledged pause",
      config: GAP_JOB_CONFIG,
      initialTurns: [],
    });
    const appended = await stub.appendTurn({
      promptText: "Write a greeting.",
      attachmentFileIds: [],
    });
    const attemptId = appended.activeAttempt?.attemptId;
    if (attemptId === undefined) {
      throw new Error("Expected a dispatched attempt");
    }
    expect(appended.activeAttempt?.responseId).toBe("resp_gap_ack_1");

    const paused = await stub.pauseJob();
    expect(paused.job.status).toBe("paused_operator");
    expect(paused.job.errorCode).toBe("operator_paused");
    expect(paused.activeAttempt).toBeNull();
    expect(providerCalls.some((call) => call.method === "POST" && call.url.endsWith("/cancel"))).toBe(
      true
    );

    const held = requireState(await stub.getState());
    expect(held.job.status).toBe(paused.job.status);
    expect(held.job.revision).toBe(paused.job.revision);
    expect(held.job.currentTurnIndex).toBe(paused.job.currentTurnIndex);
    expect(held.activeAttempt).toBeNull();

    const attempts = await stub.listAttempts({ limit: 100 });
    expect(attempts.items.find((attempt) => attempt.attempt_id === attemptId)?.status).toBe(
      "cancelled"
    );
    expect(await countTableRows(rawFor(jobId), "durable_work")).toBe(0);
  });
});

describe("JobDO alarm earliest obligation", () => {
  it("schedules one alarm at the earliest persisted obligation and reschedules from deadlines", async () => {
    const jobId = nextJobId("alarm");
    const stub = stubFor(jobId);
    const raw = rawFor(jobId);
    await stub.createJob({
      jobId,
      title: "alarm job",
      config: GAP_JOB_CONFIG,
      initialTurns: [],
    });
    expect(await readAlarm(raw)).toBeNull();

    await runInDurableObject(raw, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO durable_work (work_id, kind, attempt_id, turn_index, due_at_ms, payload_json, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)",
        "gap-early",
        "cleanup",
        EARLY_DUE_MS,
        "{}",
        CREATED_AT_ISO
      );
      state.storage.sql.exec(
        "INSERT INTO durable_work (work_id, kind, attempt_id, turn_index, due_at_ms, payload_json, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)",
        "gap-late",
        "cleanup",
        LATE_DUE_MS,
        "{}",
        CREATED_AT_ISO
      );
    });

    await stub.updateJudgeConfig({ enabled: false });
    expect(await earliestDurableDue(raw)).toBe(EARLY_DUE_MS);
    expect(await readAlarm(raw)).toBe(EARLY_DUE_MS);

    await runInDurableObject(raw, async (_instance, state) => {
      state.storage.sql.exec("UPDATE durable_work SET due_at_ms = ? WHERE work_id = ?", 1, "gap-early");
    });
    expect(await readAlarm(raw)).toBe(EARLY_DUE_MS);

    expect(await runDurableObjectAlarm(raw)).toBe(true);
    expect(await durableWorkCount(raw, "gap-early")).toBe(0);
    expect(await durableWorkCount(raw, "gap-late")).toBe(1);
    expect(await readAlarm(raw)).toBe(LATE_DUE_MS);

    await runInDurableObject(raw, async (_instance, state) => {
      await state.storage.deleteAlarm();
    });
  });
});

describe("JobDO transaction atomicity", () => {
  // Transaction purity is a structural review obligation and is intentionally not tested at runtime.
  it("rolls back every statement when a synchronous error escapes transactionSync", async () => {
    const jobId = nextJobId("atomic");
    const stub = stubFor(jobId);
    const raw = rawFor(jobId);
    const created = await stub.createJob({
      jobId,
      title: "atomic job",
      config: GAP_JOB_CONFIG,
      initialTurns: [],
    });
    const revision = created.job.revision;

    const outcome = await runInDurableObject(raw, async (_instance, state) => {
      const storage = state.storage as unknown as SchemaTransactionalStorage;
      try {
        storage.transactionSync(() => {
          storage.sql.exec(
            "INSERT INTO durable_work (work_id, kind, attempt_id, turn_index, due_at_ms, payload_json, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)",
            "gap-atomic",
            "cleanup",
            EARLY_DUE_MS,
            "{}",
            CREATED_AT_ISO
          );
          storage.sql.exec("UPDATE jobs SET revision = revision + 1, updated_at = ? WHERE job_id = ?", CREATED_AT_ISO, jobId);
          throw new Error("atomicity-boom");
        });
        return "no-throw";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(outcome).toBe("atomicity-boom");
    expect(await durableWorkCount(raw, "gap-atomic")).toBe(0);
    expect(await readJobRevision(raw, jobId)).toBe(revision);
    const held = requireState(await stub.getState());
    expect(held.job.revision).toBe(revision);
  });
});
