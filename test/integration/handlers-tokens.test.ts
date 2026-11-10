// Covers: 7, 22

import { exports } from "cloudflare:workers";
import { abortAllDurableObjects, reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

// cloudflare:workers does not model the test worker's default export in this typing context.
const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;

const APP_HOST = "app.test";
const PREVIEW_URL = `https://${APP_HOST}/api/tokens/preview`;
const COUNT_URL = "https://api.openai.com/v1/responses/input_tokens";

const GENERATION_ONLY_FIELDS = [
  '"background"',
  '"service_tier"',
  '"max_output_tokens"',
  '"prompt_cache_retention"',
  '"prompt_cache_options"',
] as const;

interface PreviewAdmission {
  readonly kind: string;
  readonly reason?: string;
  readonly projectedInputTokens?: number | null;
  readonly maxAllowedInputTokens?: number | null;
  readonly contextTier?: string;
}

interface PreviewResponseBody {
  readonly model: string;
  readonly marginalInputTokens: number;
  readonly projectedTotalInputTokens: number;
  readonly contextTier: string;
  readonly admission: PreviewAdmission;
}

interface CapturedCountCall {
  readonly method: string;
  readonly url: string;
  readonly bodyBytes: Uint8Array;
}

const utf8Decoder = new TextDecoder("utf-8");

function toBodyBytes(body: unknown): Uint8Array {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body.slice(0));
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    );
  }
  return new Uint8Array(0);
}

/** Stubs outbound fetch; only the OpenAI count endpoint is served, by hostname. */
interface CountMock {
  readonly calls: CapturedCountCall[];
  readonly fetchMock: Mock;
}
function installCountMock(inputTokens: number): CountMock {
  const calls: CapturedCountCall[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(url).hostname !== "api.openai.com") {
        throw new Error(`Unexpected outbound fetch: ${url}`);
      }
      if (!url.endsWith("/responses/input_tokens")) {
        throw new Error(`Unexpected provider call: ${url}`);
      }
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url,
        bodyBytes: toBodyBytes(init?.body),
      });
      return new Response(JSON.stringify({ input_tokens: inputTokens }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function previewRequestBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: "gpt-6-astra",
    promptText: "turn prompt",
    developerPrompt: "dev context",
    developerFileIds: [],
    attachmentFileIds: [],
    maxOutputTokens: 1000,
    reasoningEffort: "medium",
    webSearch: false,
    ...overrides,
  };
}

async function postPreview(
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly json: PreviewResponseBody }> {
  const response = await mainWorker.fetch(PREVIEW_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as PreviewResponseBody;
  return { status: response.status, json };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
  await abortAllDurableObjects();
});

describe("handlers tokens preview", () => {
  it("omits generation-only fields from the count request bytes", async () => {
    const { calls } = installCountMock(1234);

    const { status, json } = await postPreview(previewRequestBody());

    expect(status).toBe(200);
    expect(json.marginalInputTokens).toBe(1234);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(COUNT_URL);
    expect(call.bodyBytes.length).toBeGreaterThan(0);

    const bodyText = utf8Decoder.decode(call.bodyBytes);
    for (const field of GENERATION_ONLY_FIELDS) {
      expect(bodyText).not.toContain(field);
    }
    expect(bodyText).toContain('"model"');
    expect(bodyText).toContain('"input"');
  });

  it("projects the mocked provider input tokens into the preview response", async () => {
    installCountMock(98765);

    const { status, json } = await postPreview(previewRequestBody());

    expect(status).toBe(200);
    expect(json.model).toBe("gpt-6-astra");
    expect(json.marginalInputTokens).toBe(98765);
    expect(json.projectedTotalInputTokens).toBe(98765);
    expect(json.admission.kind).toBe("admitted");
    expect(json.admission.projectedInputTokens).toBe(98765);
  });

  it("rejects an unknown model without calling the provider", async () => {
    const { fetchMock } = installCountMock(555);

    const { status, json } = await postPreview(
      previewRequestBody({ model: "not-a-real-model-xyz" }),
    );

    expect(status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(json.marginalInputTokens).toBe(0);
    expect(json.projectedTotalInputTokens).toBe(0);
    expect(json.admission.kind).toBe("rejected");
    expect(json.admission.reason).toBe("unknown_model");
    expect(json.admission.maxAllowedInputTokens).toBeNull();
  });

  it.each([
    { inputTokens: 271_999, contextTier: "standard" },
    { inputTokens: 272_000, contextTier: "standard" },
    { inputTokens: 272_001, contextTier: "long_context" },
  ])(
    "classifies $inputTokens provider input tokens (cached input included) as $contextTier",
    async ({ inputTokens, contextTier }) => {
      installCountMock(inputTokens);

      const { status, json } = await postPreview(previewRequestBody());

      expect(status).toBe(200);
      // The provider count already covers the full pending payload including
      // cached input, so the preview projects it verbatim with no subtraction.
      expect(json.marginalInputTokens).toBe(inputTokens);
      expect(json.projectedTotalInputTokens).toBe(inputTokens);
      expect(json.contextTier).toBe(contextTier);
      expect(json.admission.kind).toBe("admitted");
      expect(json.admission.contextTier).toBe(contextTier);
    },
  );
});
