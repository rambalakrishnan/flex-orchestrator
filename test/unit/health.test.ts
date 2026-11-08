// Covers: operator diagnostics (`GET /api/health`, `GET /api/health?jobId=`).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENAI_STATUS_SUMMARY_URL,
  fetchOpenAIStatusSummary,
  handleHealthRequest,
} from "../../src/handlers/health.ts";
import type { HealthResponse } from "../../src/handlers/health.ts";
import type { JobConfig, JobStateResponse } from "../../src/types.ts";
import { enabledJudgeConfig } from "../fixtures/judge.ts";

const APP_URL = "https://app.test";

interface FetchRouteContext {
  readonly url: string;
  readonly init: RequestInit;
  readonly authorization: string | null;
}

type FetchHandler = (context: FetchRouteContext) => Response | Promise<Response>;

function stubFetch(handler: FetchHandler): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const requestInit = init ?? {};
      return handler({
        url,
        init: requestInit,
        authorization: new Headers(requestInit.headers).get("authorization"),
      });
    }),
  );
  return calls;
}

function statusSummaryResponse(
  indicator: string,
  description: string,
): Response {
  return new Response(
    JSON.stringify({
      page: { id: "openai", name: "OpenAI" },
      status: { indicator, description },
      components: [{ name: "API", status: indicator === "none" ? "operational" : "degraded" }],
      incidents: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function modelsResponse(modelIds: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: modelIds.map((id) => ({ id, object: "model" })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function jobConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    model: "gpt-6-astra",
    reasoningEffort: "high",
    maxOutputTokens: 32_000,
    cacheTtl: "12h",
    webSearch: false,
    developerPrompt: "",
    developerFileIds: [],
    maxContinuations: 3,
    maxAutoRetries: 1,
    judge: { enabled: false },
    ...overrides,
  };
}

function jobState(config: JobConfig): JobStateResponse {
  return {
    job: { jobId: "job_1", title: "Health job", config },
    turns: [],
    activeAttempt: null,
    usage: {
      totalInputTokens: 0,
      totalCachedInputTokens: 0,
      totalOutputTokens: 0,
      totalReasoningTokens: 0,
      totalEstimatedCostUsd: null,
    },
    pollIntervalMs: 12_000,
  } as unknown as JobStateResponse;
}

function healthEnv(
  options: {
    readonly state?: JobStateResponse | null;
    readonly secrets?: Readonly<Record<string, string>>;
    readonly stateError?: Error;
  } = {},
): Env {
  const state = options.state ?? null;
  return {
    OPENAI_API_KEY: "sk-main",
    ...options.secrets,
    JOB_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        getState: async (): Promise<JobStateResponse | null> => {
          if (options.stateError) {
            throw options.stateError;
          }
          return state;
        },
      }),
    },
  } as unknown as Env;
}

function healthRequest(
  path = "/api/health",
  method = "GET",
  headers: Record<string, string> = {},
): Request {
  return new Request(`${APP_URL}${path}`, { method, headers });
}

async function readHealthResponse(response: Response): Promise<HealthResponse> {
  expect(response.status).toBe(200);
  return (await response.json()) as HealthResponse;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenAIStatusSummary", () => {
  it("extracts only the indicator and description from the public summary", async () => {
    const summary = await fetchOpenAIStatusSummary({
      fetchImpl: async (input) => {
        expect(String(input)).toBe(OPENAI_STATUS_SUMMARY_URL);
        return statusSummaryResponse("minor", "Partially Degraded Service");
      },
    });

    expect(summary).toEqual({
      indicator: "minor",
      description: "Partially Degraded Service",
    });
  });

  it("throws a sanitized HttpError for a non-2xx status", async () => {
    await expect(
      fetchOpenAIStatusSummary({
        fetchImpl: async () =>
          new Response("provider outage details", {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
      }),
    ).rejects.toMatchObject({
      status: 503,
      code: "status_summary_failed",
    });
  });

  it("rejects a body without a valid status indicator", async () => {
    await expect(
      fetchOpenAIStatusSummary({
        fetchImpl: async () =>
          new Response(JSON.stringify({ status: { description: "missing indicator" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "invalid_status_summary",
    });
  });
});

describe("handleHealthRequest", () => {
  it("returns the main probe only when no job is requested", async () => {
    const calls = stubFetch(({ url }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      return modelsResponse(["gpt-6-astra", "gpt-6-luna"]);
    });

    const body = await readHealthResponse(await handleHealthRequest(healthRequest(), healthEnv()));

    expect(body.judge).toBeNull();
    expect(body.main.ok).toBe(true);
    expect(body.main.error).toBeNull();
    expect(body.main.status).toEqual({
      indicator: "none",
      description: "All Systems Operational",
    });
    expect(body.main.models).toEqual({
      ok: true,
      count: 2,
      modelPresent: null,
      error: null,
    });
    expect(body.main.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.checkedAtMs).toBe("number");
    expect(calls).toHaveLength(2);
  });

  it("reports a model-list failure without echoing raw provider bodies or secrets", async () => {
    stubFetch(({ url }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_api_key",
            message: "Incorrect API key provided: sk-super-secret",
            type: "invalid_request_error",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });

    const body = await readHealthResponse(await handleHealthRequest(healthRequest(), healthEnv()));

    expect(body.main.ok).toBe(false);
    expect(body.main.models.ok).toBe(false);
    expect(body.main.models.count).toBe(0);
    expect(body.main.models.modelPresent).toBeNull();
    expect(body.main.error).toContain("Models unavailable");
    expect(body.main.error).toContain("[redacted]");
    expect(body.main.error).not.toContain("sk-super-secret");
    expect(body.main.error).not.toContain("invalid_request_error");
  });

  it("reports an unavailable status page as a failed probe", async () => {
    stubFetch(({ url }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return new Response("upstream exploded", { status: 502 });
      }
      return modelsResponse(["gpt-6-astra"]);
    });

    const body = await readHealthResponse(await handleHealthRequest(healthRequest(), healthEnv()));

    expect(body.main.ok).toBe(false);
    expect(body.main.status).toBeNull();
    expect(body.main.models.ok).toBe(true);
    expect(body.main.error).toContain("OpenAI status unavailable");
    expect(body.main.error).toContain("HTTP 502");
  });

  it("returns a skipped judge probe when the job has no enabled judge", async () => {
    stubFetch(({ url }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      return modelsResponse(["gpt-6-astra"]);
    });

    const state = jobState(jobConfig());
    const body = await readHealthResponse(
      await handleHealthRequest(healthRequest("/api/health?jobId=job_1"), healthEnv({ state })),
    );

    expect(body.main.ok).toBe(true);
    expect(body.main.models.modelPresent).toBe(true);
    expect(body.judge).not.toBeNull();
    expect(body.judge).toMatchObject({
      ok: true,
      skipped: true,
      latencyMs: 0,
      status: null,
      error: null,
    });
  });

  it("probes an enabled non-OpenAI judge without consulting the OpenAI status page again", async () => {
    let judgeAuthorization: string | null = null;

    const calls = stubFetch(({ url, authorization }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      if (url === "https://api.openai.com/v1/models") {
        return modelsResponse(["gpt-6-astra"]);
      }
      judgeAuthorization = authorization;
      return modelsResponse(["judge-model-1"]);
    });

    const judge = enabledJudgeConfig({
      apiRoot: "https://judge.internal/v1",
      secretName: "JUDGE_KEY",
      model: "judge-model-1",
    });
    const state = jobState(jobConfig({ judge }));
    const body = await readHealthResponse(
      await handleHealthRequest(
        healthRequest("/api/health?jobId=job_1"),
        healthEnv({ state, secrets: { JUDGE_KEY: "sk-judge" } }),
      ),
    );

    expect(body.judge).not.toBeNull();
    expect(body.judge).toMatchObject({
      ok: true,
      status: null,
      models: { ok: true, count: 1, modelPresent: true, error: null },
      error: null,
    });
    if (body.judge !== null) {
      expect("skipped" in body.judge).toBe(false);
    }
    expect(judgeAuthorization).toBe("Bearer sk-judge");
    expect(calls.filter((url) => url === OPENAI_STATUS_SUMMARY_URL)).toHaveLength(1);
  });

  it("includes OpenAI status for an OpenAI-rooted judge", async () => {
    const calls = stubFetch(({ url, authorization }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      if (authorization === "Bearer sk-judge") {
        return modelsResponse(["judge-model-1"]);
      }
      return modelsResponse(["gpt-6-astra"]);
    });

    const judge = enabledJudgeConfig({
      apiRoot: "https://api.openai.com/v1",
      secretName: "JUDGE_KEY",
      model: "judge-model-1",
    });
    const state = jobState(jobConfig({ judge }));
    const body = await readHealthResponse(
      await handleHealthRequest(
        healthRequest("/api/health?jobId=job_1"),
        healthEnv({ state, secrets: { JUDGE_KEY: "sk-judge" } }),
      ),
    );

    expect(body.judge).not.toBeNull();
    if (body.judge !== null) {
      expect(body.judge.status).toEqual({
        indicator: "none",
        description: "All Systems Operational",
      });
      expect(body.judge.models.modelPresent).toBe(true);
      expect(body.judge.ok).toBe(true);
    }
    expect(calls.filter((url) => url === OPENAI_STATUS_SUMMARY_URL)).toHaveLength(2);
  });

  it("does not consult the OpenAI status page for a lookalike judge host", async () => {
    const calls = stubFetch(({ url, authorization }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      if (authorization === "Bearer sk-main") {
        return modelsResponse(["gpt-6-astra"]);
      }
      return modelsResponse(["judge-model-1"]);
    });

    const judge = enabledJudgeConfig({
      apiRoot: "https://api.openai.com.proxy.internal/v1",
      secretName: "JUDGE_KEY",
      model: "judge-model-1",
    });
    const state = jobState(jobConfig({ judge }));
    const body = await readHealthResponse(
      await handleHealthRequest(
        healthRequest("/api/health?jobId=job_1"),
        healthEnv({ state, secrets: { JUDGE_KEY: "sk-judge" } }),
      ),
    );

    expect(body.judge).not.toBeNull();
    expect(body.judge).toMatchObject({
      ok: true,
      status: null,
      models: { ok: true, count: 1, modelPresent: true, error: null },
      error: null,
    });
    if (body.judge !== null) {
      expect("skipped" in body.judge).toBe(false);
    }
    expect(calls.filter((url) => url === OPENAI_STATUS_SUMMARY_URL)).toHaveLength(1);
    expect(calls).toContain("https://api.openai.com.proxy.internal/v1/models");
  });

  it("reports a missing judge secret as a probe failure", async () => {
    stubFetch(({ url }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      if (url === "https://api.openai.com/v1/models") {
        return modelsResponse(["gpt-6-astra"]);
      }
      return modelsResponse(["judge-model-1"]);
    });

    const judge = enabledJudgeConfig({
      apiRoot: "https://judge.internal/v1",
      secretName: "MISSING_JUDGE_KEY",
      model: "judge-model-1",
    });
    const state = jobState(jobConfig({ judge }));
    const body = await readHealthResponse(
      await handleHealthRequest(healthRequest("/api/health?jobId=job_1"), healthEnv({ state })),
    );

    expect(body.judge).not.toBeNull();
    if (body.judge !== null) {
      expect(body.judge.ok).toBe(false);
      expect(body.judge.models.ok).toBe(false);
      expect(body.judge.error).toContain("Missing or empty Worker secret binding");
      expect(body.judge.error).not.toContain("MISSING_JUDGE_KEY");
      expect(body.judge.error).not.toContain("OPENAI_API_KEY");
    }
  });

  it("does not echo the configured binding name for an empty judge secret", async () => {
    stubFetch(({ url }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      return modelsResponse(["judge-model-1"]);
    });

    const judge = enabledJudgeConfig({
      apiRoot: "https://judge.internal/v1",
      secretName: "OPENAI_API_KEY",
      model: "judge-model-1",
    });
    const state = jobState(jobConfig({ judge }));
    const body = await readHealthResponse(
      await handleHealthRequest(
        healthRequest("/api/health?jobId=job_1"),
        healthEnv({ state, secrets: { OPENAI_API_KEY: "" } }),
      ),
    );

    expect(body.judge).not.toBeNull();
    if (body.judge !== null) {
      expect(body.judge.models.ok).toBe(false);
      expect(body.judge.models.error).toContain("Missing or empty Worker secret binding");
      expect(body.judge.models.error).not.toContain("OPENAI_API_KEY");
    }
  });

  it("redacts the resolved judge secret and sk-shaped material from a models error", async () => {
    const judgeSecret = "judge-secret-abc-123456";
    const leakedKey = "sk-other-live-secret-987654";

    stubFetch(({ url, authorization }) => {
      if (url === OPENAI_STATUS_SUMMARY_URL) {
        return statusSummaryResponse("none", "All Systems Operational");
      }
      if (authorization === "Bearer sk-main") {
        return modelsResponse(["gpt-6-astra"]);
      }
      return new Response(
        JSON.stringify({
          error: {
            code: "invalid_api_key",
            message: `Incorrect API key provided: ${judgeSecret} (${leakedKey})`,
            type: "invalid_request_error",
          },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    });

    const judge = enabledJudgeConfig({
      apiRoot: "https://judge.internal/v1",
      secretName: "JUDGE_KEY",
      model: "judge-model-1",
    });
    const state = jobState(jobConfig({ judge }));
    const body = await readHealthResponse(
      await handleHealthRequest(
        healthRequest("/api/health?jobId=job_1"),
        healthEnv({ state, secrets: { JUDGE_KEY: judgeSecret } }),
      ),
    );

    expect(body.judge).not.toBeNull();
    if (body.judge !== null) {
      expect(body.judge.models.ok).toBe(false);
      expect(body.judge.models.error).toContain("[redacted]");
      expect(body.judge.models.error).not.toContain(judgeSecret);
      expect(body.judge.models.error).not.toContain(leakedKey);
      expect(body.judge.models.error).not.toContain("sk-");
      expect(body.judge.error).toContain("[redacted]");
      expect(body.judge.error).not.toContain(judgeSecret);
    }
  });

  it("returns 400 for a job id that is not path-safe", async () => {
    const calls = stubFetch(() => modelsResponse([]));

    const response = await handleHealthRequest(
      healthRequest("/api/health?jobId=a/b"),
      healthEnv(),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_job_id");
    expect(calls).toHaveLength(0);
  });

  it("rejects cross-site probes for both the main and job-scoped routes", async () => {
    const calls = stubFetch(() => modelsResponse([]));

    for (const path of ["/api/health", "/api/health?jobId=job_1"]) {
      const response = await handleHealthRequest(
        healthRequest(path, "GET", { "sec-fetch-site": "cross-site" }),
        healthEnv(),
      );

      expect(response.status).toBe(403);
      const payload = (await response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("cross_site_forbidden");
    }

    expect(calls).toHaveLength(0);
  });

  it("returns 404 when the requested job does not exist", async () => {
    const calls = stubFetch(() => modelsResponse([]));

    const response = await handleHealthRequest(
      healthRequest("/api/health?jobId=missing"),
      healthEnv(),
    );

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-GET methods", async () => {
    const response = await handleHealthRequest(healthRequest("/api/health", "POST"), healthEnv());

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("rejects unsupported query parameters", async () => {
    const response = await handleHealthRequest(
      healthRequest("/api/health?jobId=job_1&verbose=1"),
      healthEnv(),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("unsupported_query_parameter");
  });

  it("returns 502 when the job state RPC fails", async () => {
    const response = await handleHealthRequest(
      healthRequest("/api/health?jobId=job_1"),
      healthEnv({ stateError: new Error("durable object unavailable") }),
    );

    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("job_state_unavailable");
  });

  it("serves only the exact health path", async () => {
    const response = await handleHealthRequest(healthRequest("/api/health/extra"), healthEnv());
    expect(response.status).toBe(404);
  });
});