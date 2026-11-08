// Covers: 1, 2, 16

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// cloudflare:workers does not model the test worker's default export in this typing context.
const mainWorker = (exports as unknown as { readonly default: Fetcher }).default;

const APP_ORIGIN = "https://app.test";
const APP_HOST = "app.test";
const HOOKS_HOST = "hooks.test";

function createJobCommand(jobId: string, title = "Routing smoke job"): Record<string, unknown> {
  return {
    jobId,
    title,
    config: {
      model: "gpt-5",
      reasoningEffort: "high",
      maxOutputTokens: 32_768,
      cacheTtl: "12h",
      webSearch: false,
      maxContinuations: 3,
      maxAutoRetries: 1,
      judge: { enabled: false },
      developerPrompt: "",
      developerFileIds: [],
    },
    initialTurns: [
      { turnIndex: 1, promptText: "Write the first section.", attachmentFileIds: [] },
    ],
  };
}

async function postJob(jobId: string, title?: string): Promise<Response> {
  return mainWorker.fetch(`https://${APP_HOST}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP_ORIGIN },
    body: JSON.stringify(createJobCommand(jobId, title)),
  });
}

describe("server-rendered fragments", () => {
  it("serves the job list fragment as HTML", async () => {
    const jobId = `job_fragment_list_${Date.now()}`;
    expect((await postJob(jobId)).status).toBe(201);

    const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/fragment`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('class="job-card"');
    expect(html).toContain(jobId);
  });

  it("serves the job-detail fragment and 404s missing jobs", async () => {
    const jobId = `job_fragment_detail_${Date.now()}`;
    expect((await postJob(jobId)).status).toBe(201);

    const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await response.text();
    expect(html).toContain("Routing smoke job");
    expect(html).toContain(jobId);
    expect(html).toContain("Turns");
    expect(html).toContain("Attempts");
    expect(html).toContain("Judge calls");

    const missing = await mainWorker.fetch(
      `https://${APP_HOST}/api/jobs/job_missing_fragment/fragment`,
    );
    expect(missing.status).toBe(404);
  });

  it("accepts a GPT-6 Astra job with developer context and high reasoning", async () => {
    const jobId = `job_astra_${Date.now()}`;
    const created = await mainWorker.fetch(`https://${APP_HOST}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN },
      body: JSON.stringify({
        jobId,
        title: "Routing smoke job",
        config: {
          model: "gpt-6-astra",
          reasoningEffort: "xhigh",
          maxOutputTokens: 128_000,
          cacheTtl: "12h",
          webSearch: false,
          maxContinuations: 3,
          maxAutoRetries: 1,
          developerPrompt: "Shared developer context.",
          developerFileIds: [],
          judge: { enabled: false },
        },
        initialTurns: [
          { turnIndex: 1, promptText: "Write the first section.", attachmentFileIds: [] },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      job: { config: { model: string; reasoningEffort: string; developerPrompt: string } };
    };
    expect(body.job.config).toMatchObject({
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
      developerPrompt: "Shared developer context.",
    });

    const list = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/fragment`);
    expect(await list.text()).toContain("gpt-6-astra");
  });

  it("escapes untrusted job metadata in the server-rendered fragment", async () => {
    const jobId = `job_fragment_escape_${Date.now()}`;
    const hostileTitle = '<img src=x onerror="alert(1)">';
    expect((await postJob(jobId, hostileTitle)).status).toBe(201);

    const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}/fragment`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain("&lt;img");
  });

  it("serves static assets on non-API paths", async () => {
    const css = await mainWorker.fetch(`https://${APP_HOST}/app.css`);
    expect(css.status).toBe(200);
    expect((await css.text()).length).toBeGreaterThan(0);

    const javascript = await mainWorker.fetch(`https://${APP_HOST}/app.js`);
    expect(javascript.status).toBe(200);
    expect((await javascript.text()).length).toBeGreaterThan(0);
  });
});

describe("worker hostname routing", () => {
  it("serves only POST /openai on the hooks host", async () => {
    const wrongPath = await mainWorker.fetch(`https://${HOOKS_HOST}/api/jobs`);
    expect(wrongPath.status).toBe(404);

    const unsigned = await mainWorker.fetch(`https://${HOOKS_HOST}/openai`, {
      method: "POST",
      body: JSON.stringify({ id: "evt_1", type: "response.completed", data: { id: "resp_1" } }),
      headers: { "content-type": "application/json" },
    });
    expect([400, 401].includes(unsigned.status)).toBe(true);
  });

  it("rejects state-changing application requests without an Origin", async () => {
    const response = await mainWorker.fetch(`https://${APP_HOST}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createJobCommand("job_no_origin")),
    });
    expect(response.status).toBe(403);
  });

  it("creates a job through JobDO, publishes it, and reads it back", async () => {
    const jobId = `job_routing_${Date.now()}`;
    const created = await postJob(jobId);
    expect(created.status).toBe(201);

    const createdBody = (await created.json()) as {
      job: { jobId: string; status: string; currentTurnIndex: number };
    };
    expect(createdBody.job.jobId).toBe(jobId);
    expect(createdBody.job.currentTurnIndex).toBe(1);

    const read = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/${jobId}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { job: { jobId: string } };
    expect(readBody.job.jobId).toBe(jobId);

    const listed = await mainWorker.fetch(`https://${APP_HOST}/api/jobs?limit=10`);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: Array<{ jobId: string }>; hasMore: boolean };
    expect(page.items.some((item) => item.jobId === jobId)).toBe(true);
  });

  it("returns 404 for unknown job ids and unknown API paths", async () => {
    const missing = await mainWorker.fetch(`https://${APP_HOST}/api/jobs/job_does_not_exist`);
    expect(missing.status).toBe(404);

    const unknownPath = await mainWorker.fetch(`https://${APP_HOST}/api/nope`);
    expect(unknownPath.status).toBe(404);
  });
});