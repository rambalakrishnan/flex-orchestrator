// Covers: 2, 7, 10, 19

import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

// cloudflare:workers does not model the test worker's default export in this typing context.
const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;

const APP_ORIGIN = "https://app.test";
const APP_HOST = "app.test";
const OPENAI_STATUS_URL = "https://status.openai.com/api/v2/summary.json";

interface JobView {
  readonly jobId: string;
  readonly status: string;
  readonly currentTurnIndex: number;
  readonly acceptedTurnCount: number;
  readonly lastAcceptedResponseId: string | null;
  readonly warningMessages: readonly string[];
  readonly config: { readonly model: string };
}

interface ActiveAttemptView {
  readonly responseId: string | null;
}

interface JobStateBody {
  readonly job: JobView;
  readonly activeAttempt?: ActiveAttemptView | null;
}

interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

interface HealthProbeBody {
  readonly ok: boolean;
  readonly status: { readonly indicator: string; readonly description: string } | null;
  readonly models: {
    readonly ok: boolean;
    readonly count: number;
    readonly modelPresent: boolean | null;
    readonly error: string | null;
  };
  readonly error: string | null;
}

interface HealthBody {
  readonly main: HealthProbeBody;
  readonly judge: HealthProbeBody | null;
}

interface TokenPreviewBody {
  readonly model: string;
  readonly marginalInputTokens: number;
  readonly projectedTotalInputTokens: number;
  readonly admission: { readonly kind: string };
}

interface ExportRecord {
  readonly type?: string;
  readonly job?: { readonly status?: string };
  readonly attempt?: {
    readonly status?: string;
    readonly diagnostics_json?: string;
  };
}

interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly bodyText: string | null;
}

type ResponsesHandler = (init: RequestInit | undefined) => Response;

let jobSequence = 0;
const createdJobIds: string[] = [];

function nextJobId(prefix: string): string {
  jobSequence += 1;
  return `${prefix}_${Date.now()}_${jobSequence}`;
}

function trackJobId(jobId: string): void {
  if (!createdJobIds.includes(jobId)) {
    createdJobIds.push(jobId);
  }
}

function providerJson(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
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
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body);
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(body);
  }
  return null;
}

function installProviderMock(responses: ResponsesHandler): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, bodyText: decodeRequestBody(init?.body) });

      if (url.endsWith("/responses/input_tokens")) {
        return providerJson({ input_tokens: 55 });
      }
      if (url.endsWith("/responses")) {
        return responses(init);
      }
      if (url.endsWith("/models")) {
        return providerJson({ data: [{ id: "gpt-6-astra" }, { id: "gpt-6.1-sol" }] });
      }
      if (url === OPENAI_STATUS_URL) {
        return providerJson({
          status: { indicator: "none", description: "All Systems Operational" },
        });
      }
      throw new Error(`Unexpected provider call: ${method} ${url}`);
    }),
  );
  return calls;
}

function baseConfig(): Record<string, unknown> {
  return {
    model: "gpt-6-astra",
    reasoningEffort: "high",
    maxOutputTokens: 32_768,
    cacheTtl: "12h",
    webSearch: false,
    maxContinuations: 3,
    maxAutoRetries: 1,
    judge: { enabled: false },
    developerPrompt: "",
    developerFileIds: [],
  };
}

interface CreateJobOptions {
  readonly title?: string;
  readonly config?: Record<string, unknown>;
  readonly initialTurns?: readonly Record<string, unknown>[];
  readonly initialPreviousResponseId?: string | null;
}

function createJobCommand(jobId: string, options: CreateJobOptions = {}): Record<string, unknown> {
  return {
    jobId,
    title: options.title ?? "Operator API test job",
    config: { ...baseConfig(), ...(options.config ?? {}) },
    initialTurns:
      options.initialTurns ?? [
        { turnIndex: 1, promptText: "Write the first section.", attachmentFileIds: [] },
      ],
    ...(options.initialPreviousResponseId === undefined
      ? {}
      : { initialPreviousResponseId: options.initialPreviousResponseId }),
  };
}

async function postJob(jobId: string, options: CreateJobOptions = {}): Promise<Response> {
  return mainWorker.fetch(`https://${APP_HOST}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(createJobCommand(jobId, options)),
  });
}

async function waitForJobStatus(
  jobId: string,
  expectedStatuses: readonly string[],
): Promise<JobStateBody> {
  let latest: JobStateBody | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as JobStateBody;
    latest = body;
    if (expectedStatuses.includes(body.job.status)) {
      return body;
    }
    // Durable Object dispatch is asynchronous across RPC; a real short delay is
    // the only way to yield between bounded status reads. It is always awaited.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
  expect(latest).not.toBeNull();
  expect(expectedStatuses).toContain(latest?.job.status);
  return latest as JobStateBody;
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

describe("operator API diagnostics", () => {
  it("projects marginal tokens and strips generation-only fields from the count request", async () => {
    const calls = installProviderMock(() => providerJson({ id: "resp_unused", status: "queued" }));

    const response = await mainWorker.fetch(`https://${APP_HOST}/api/tokens/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-astra",
        promptText: "turn prompt",
        developerPrompt: "dev context",
        developerFileIds: [],
        attachmentFileIds: [],
        maxOutputTokens: 1000,
        reasoningEffort: "high",
        webSearch: false,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenPreviewBody;
    expect(body.projectedTotalInputTokens).toBe(55);
    expect(body.marginalInputTokens).toBe(55);
    expect(body.admission.kind).toBe("admitted");

    const countCalls = calls.filter((call) => call.url.endsWith("/responses/input_tokens"));
    expect(countCalls).toHaveLength(1);
    const countBodyText = countCalls[0]?.bodyText ?? "";
    expect(countBodyText.length).toBeGreaterThan(0);
    const payload = JSON.parse(countBodyText) as Record<string, unknown>;
    expect(payload.model).toBe("gpt-6-astra");
    for (const strippedField of [
      "background",
      "service_tier",
      "max_output_tokens",
      "prompt_cache_retention",
      "prompt_cache_options",
    ]) {
      expect(payload).not.toHaveProperty(strippedField);
    }
  });

  it("reports a healthy main provider with no job-scoped judge", async () => {
    installProviderMock(() => providerJson({ id: "resp_unused", status: "queued" }));

    const response = await mainWorker.fetch(`https://${APP_HOST}/api/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthBody;

    expect(body.main.ok).toBe(true);
    expect(body.main.models.count).toBe(2);
    expect(body.main.status?.indicator).toBe("none");
    expect(body.judge).toBeNull();
  });

  it("accepts an external previous response id and records a warning", async () => {
    installProviderMock(() => providerJson({ id: "resp_unused", status: "queued" }));

    const jobId = nextJobId("job_operator_external_response");
    const created = await postJob(jobId, {
      initialPreviousResponseId: "resp_external_http",
      initialTurns: [],
    });
    expect(created.status).toBe(201);
    trackJobId(jobId);

    const body = (await created.json()) as JobStateBody;
    expect(body.job.lastAcceptedResponseId).toBe("resp_external_http");
    expect(body.job.acceptedTurnCount).toBe(0);
    expect(body.job.warningMessages).toContain(
      "external_previous_response_id:resp_external_http",
    );
  });

  it("rejects malformed external previous response ids before dispatch", async () => {
    const calls = installProviderMock(() =>
      providerJson({ id: "resp_unused", status: "queued" }),
    );

    for (const invalidId of ["bad id", "x".repeat(513)]) {
      const jobId = nextJobId("job_operator_invalid_previous_response");
      const response = await postJob(jobId, {
        initialPreviousResponseId: invalidId,
        initialTurns: [],
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe("invalid_request_body");
    }

    expect(calls.filter((call) => call.url.endsWith("/responses"))).toHaveLength(0);
  });

  it("exports a failed job as JSONL with job, turn, and attempt records", async () => {
    installProviderMock(() =>
      providerJson(
        { error: { code: "invalid_request_error", message: "model not available" } },
        400,
      ),
    );

    const jobId = nextJobId("job_operator_jsonl");
    const created = await postJob(jobId);
    expect(created.status).toBe(201);
    trackJobId(jobId);

    const state = await waitForJobStatus(jobId, ["failed"]);
    expect(state.job.status).toBe("failed");

    const exportResponse = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/export/jsonl`,
    );
    expect(exportResponse.status).toBe(200);
    expect(exportResponse.headers.get("content-type") ?? "").toMatch(/^application\/x-ndjson/);

    const exportText = new TextDecoder("utf-8", {
      fatal: false,
      ignoreBOM: false,
    }).decode(await exportResponse.arrayBuffer());
    const lines = exportText
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    const records = lines.map((line) => JSON.parse(line) as ExportRecord);
    const jobRecord = records[0];
    expect(jobRecord).toBeDefined();
    expect(jobRecord?.type).toBe("job");
    expect(jobRecord?.job?.status).toBe("failed");

    const recordTypes = new Set(records.map((record) => record.type));
    expect(recordTypes.has("turn")).toBe(true);
    expect(recordTypes.has("attempt")).toBe(true);

    const attemptRecord = records.find((record) => record.type === "attempt");
    expect(attemptRecord).toBeDefined();
    expect(attemptRecord?.attempt?.status).toBe("failed");
    const diagnostics = attemptRecord?.attempt?.diagnostics_json ?? "";
    expect(diagnostics).toContain("provider_error_code");
    expect(diagnostics).toContain("invalid_request_error");
    expect(diagnostics).toContain("model not available");
  });

  it("resumes a failed job and serves its running state", async () => {
    installProviderMock(() =>
      providerJson(
        { error: { code: "invalid_request_error", message: "model not available" } },
        400,
      ),
    );

    const jobId = nextJobId("job_operator_resume");
    const created = await postJob(jobId);
    expect(created.status).toBe(201);
    trackJobId(jobId);
    await waitForJobStatus(jobId, ["failed"]);

    // Re-stub the provider: the resumed attempt now dispatches successfully.
    installProviderMock(() => providerJson({ id: "resp_resumed", status: "queued" }));

    const resumed = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as JobStateBody;
    expect(resumedBody.job.status).not.toBe("failed");
    expect(["running", "dispatched"]).toContain(resumedBody.job.status);

    const readBack = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}`);
    expect(readBack.status).toBe(200);
    const readBackBody = (await readBack.json()) as JobStateBody;
    expect(readBackBody.job.status).not.toBe("failed");
  });

  it("pauses a running job, rejects a second pause, and resumes it", async () => {
    const calls = installProviderMock(() =>
      providerJson({ id: "resp_pause_route", status: "queued" }),
    );

    const jobId = nextJobId("job_operator_pause");
    const created = await postJob(jobId);
    expect(created.status).toBe(201);
    trackJobId(jobId);
    await waitForJobStatus(jobId, ["running"]);

    const paused = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/pause`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(paused.status).toBe(200);
    const pausedBody = (await paused.json()) as JobStateBody;
    expect(pausedBody.job.status).toBe("paused_operator");
    expect(pausedBody.activeAttempt).toBeNull();

    const repeated = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/pause`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(repeated.status).toBe(409);
    const repeatedBody = (await repeated.json()) as ErrorBody;
    expect(repeatedBody.error.code).toBe("job_not_pausable");

    const resumed = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/resume`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(resumed.status).toBe(200);
    const resumedBody = (await resumed.json()) as JobStateBody;
    expect(resumedBody.job.status).toBe("running");
    expect(resumedBody.job.currentTurnIndex).toBe(1);
    expect(calls.some((call) => call.url.endsWith("/cancel"))).toBe(true);
  });

  it("replaces the judge config while halted and rejects edits while running", async () => {
    installProviderMock(() => providerJson({ id: "resp_judge_edit", status: "queued" }));

    const jobId = nextJobId("job_operator_judge_edit");
    const created = await postJob(jobId, {
      config: {
        judge: {
          enabled: true,
          provider: "openrouter",
          apiRoot: "https://openrouter.ai/api/v1",
          secretName: "OPENROUTER_API_KEY",
          model: "deepseek-v4.1-flash-1017",
          transport: "chat_completions",
          historyMode: "stateless",
          fileDeliveryMode: "inline",
          includePrior: false,
          maxGradeThreshold: 70,
          injectOnFail: true,
          injectOnPass: false,
          developerPrompt: "",
        },
      },
    });
    expect(created.status).toBe(201);
    trackJobId(jobId);
    await waitForJobStatus(jobId, ["running"]);

    const runningEdit = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/judge-config`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(runningEdit.status).toBe(409);
    const runningEditBody = (await runningEdit.json()) as ErrorBody;
    expect(runningEditBody.error.code).toBe("job_not_halted");

    const paused = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/pause`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(paused.status).toBe(200);

    const fixedJudge = {
      enabled: true,
      provider: "openrouter",
      apiRoot: "https://openrouter.ai/api/v1",
      secretName: "OPENROUTER_API_KEY",
      model: "deepseek/deepseek-v4.1-flash-1017",
      transport: "chat_completions",
      historyMode: "stateless",
      fileDeliveryMode: "inline",
      includePrior: false,
      maxGradeThreshold: 70,
      injectOnFail: true,
      injectOnPass: false,
      developerPrompt: "",
    };
    const updated = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/judge-config`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify(fixedJudge),
      },
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as JobStateBody;
    expect(updatedBody.job.config.judge).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash-1017",
    });

    const malformed = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/judge-config`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", origin: APP_ORIGIN },
        body: JSON.stringify({ enabled: true, model: "x" }),
      },
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as ErrorBody;
    expect(malformedBody.error.code).toBe("invalid_judge_config");

    const fragment = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/fragment`,
    );
    expect(fragment.status).toBe(200);
    const html = await fragment.text();
    expect(html).toContain("Judge configuration");
    expect(html).toContain("deepseek/deepseek-v4.1-flash-1017");
    expect(html).toContain('class="judge-config-edit"');
  });

  it("probes the job-declared judge alongside the main provider", async () => {
    installProviderMock(() => providerJson({ id: "resp_unused", status: "queued" }));

    const jobId = nextJobId("job_operator_health");
    const created = await postJob(jobId, {
      config: {
        model: "gpt-6-astra",
        judge: {
          enabled: true,
          provider: "openai",
          apiRoot: "https://api.openai.com/v1",
          secretName: "OPENAI_API_KEY",
          model: "gpt-6.1-sol",
          transport: "responses",
          historyMode: "stateless",
          fileDeliveryMode: "inline",
          includePrior: false,
          maxGradeThreshold: 80,
          developerPrompt: "",
          injectOnFail: true,
          injectOnPass: false,
        },
      },
      initialTurns: [],
    });
    expect(created.status).toBe(201);
    trackJobId(jobId);

    const response = await mainWorker.fetch(
      `https://${APP_HOST}/api/health?jobId=${encodeURIComponent(jobId)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as HealthBody;

    expect(body.main.models.modelPresent).toBe(true);
    expect(body.judge).not.toBeNull();
    expect(body.judge?.ok).toBe(true);
    expect(body.judge?.models.modelPresent).toBe(true);
  });
});

describe("operator API fragment recovery and guard regressions", () => {
  it("renders recovery controls and the persisted error code for a failed job", async () => {
    installProviderMock(() =>
      providerJson(
        { error: { code: "invalid_request_error", message: "model not available" } },
        400,
      ),
    );

    // Reuses the hostile-title convention from the list-fragment escaping test.
    const hostileTitle = '<img src=x onerror="alert(1)">';
    const jobId = nextJobId("job_operator_fragment_failed");
    const created = await postJob(jobId, { title: hostileTitle });
    expect(created.status).toBe(201);
    trackJobId(jobId);
    await waitForJobStatus(jobId, ["failed"]);

    const response = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/fragment`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();

    expect(html).toContain("Resume Job");
    expect(html).toContain("Retry Turn");
    expect(html).toContain("Download JSONL");
    expect(html).toContain("Inspect JSONL");
    expect(html).toContain('<code class="job-error-code">invalid_request_error</code>');

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("renders Pause Job for a running job and Resume Job once paused", async () => {
    installProviderMock(() => providerJson({ id: "resp_pause_view", status: "queued" }));

    const jobId = nextJobId("job_operator_fragment_pause");
    const created = await postJob(jobId);
    expect(created.status).toBe(201);
    trackJobId(jobId);
    await waitForJobStatus(jobId, ["running"]);

    const running = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/fragment`,
    );
    expect(running.status).toBe(200);
    const runningHtml = await running.text();
    expect(runningHtml).toContain("Pause Job");
    expect(runningHtml).not.toContain("Resume Job");

    const paused = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/pause`, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(paused.status).toBe(200);

    const held = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`);
    expect(held.status).toBe(200);
    const heldHtml = await held.text();
    expect(heldHtml).toContain("Resume Job");
    expect(heldHtml).not.toContain("Pause Job");
  });

  it("renders the external response anchor and any active response in the job fragment", async () => {
    installProviderMock(() =>
      providerJson({ id: "resp_queued_external", status: "queued" }),
    );

    const jobId = nextJobId("job_operator_fragment_anchor");
    const created = await postJob(jobId, {
      initialPreviousResponseId: "resp_external_http",
      initialTurns: [],
    });
    expect(created.status).toBe(201);
    trackJobId(jobId);

    const createdBody = (await created.json()) as JobStateBody;
    expect(createdBody.job.lastAcceptedResponseId).toBe("resp_external_http");

    const response = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/${jobId}/fragment`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain('class="job-detail-anchor"');
    expect(html).toContain(
      'Initial response: <span class="response-id">resp_external_http</span>',
    );

    const readBack = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}`);
    expect(readBack.status).toBe(200);
    const readBackBody = (await readBack.json()) as JobStateBody;
    const activeResponseId = readBackBody.activeAttempt?.responseId ?? null;
    if (activeResponseId !== null) {
      expect(html).toContain("Active response:");
      expect(html).toContain(activeResponseId);
    }
  });

  it("rejects path-like job ids and cross-site health probes before probing providers", async () => {
    const calls = installProviderMock(() =>
      providerJson({ id: "resp_unused", status: "queued" }),
    );

    const pathLike = await mainWorker.fetch(
      `https://${APP_HOST}/api/health?jobId=a%2Fb`,
    );
    expect(pathLike.status).toBe(400);
    const pathLikeBody = (await pathLike.json()) as ErrorBody;
    expect(pathLikeBody.error.code).toBe("invalid_job_id");

    const crossSite = await mainWorker.fetch(`https://${APP_HOST}/api/health`, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const crossSiteBody = (await crossSite.json()) as ErrorBody;
    expect(crossSiteBody.error.code).toBe("cross_site_forbidden");

    expect(calls).toHaveLength(0);
  });
});