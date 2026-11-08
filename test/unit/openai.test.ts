// Covers: 7, 22

import { describe, expect, it } from "vitest";

import {
  countResponsesInputTokens,
  dispatchResponsesCreate,
  listProviderModels,
  retrieveProviderResponse,
} from "../../src/lib/openai.ts";
import { HttpError } from "../../src/http.ts";

const CANONICAL_PAYLOAD: Readonly<Record<string, unknown>> = {
  model: "gpt-6-astra",
  background: true,
  service_tier: "flex",
  store: true,
  reasoning: { effort: "high" },
  max_output_tokens: 128_000,
  prompt_cache_options: { ttl: "12h" },
  tools: [{ type: "web_search" }],
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ],
};

const utf8Encoder = new TextEncoder();

async function captureHttpError(run: () => Promise<unknown>): Promise<HttpError> {
  try {
    await run();
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      return err;
    }
    throw err;
  }
  throw new Error("Expected the provider call to throw an HttpError");
}

describe("countResponsesInputTokens", () => {
  it("projects the canonical body onto fields accepted by /responses/input_tokens", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const result = await countResponsesInputTokens({
      apiKey: "sk-test",
      payload: CANONICAL_PAYLOAD,
      fetchImpl: async (_input, init) => {
        const raw = init?.body;
        expect(raw).toBeInstanceOf(ArrayBuffer);
        capturedBody = JSON.parse(
          new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
            raw as ArrayBuffer,
          ),
        ) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ object: "response.input_tokens", input_tokens: 42 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result).toEqual({ inputTokens: 42 });
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["input", "model", "reasoning", "tools"]);
    for (const rejected of [
      "background",
      "service_tier",
      "store",
      "include",
      "max_output_tokens",
      "prompt_cache_retention",
      "prompt_cache_options",
    ]) {
      expect(body).not.toHaveProperty(rejected);
    }
    expect(body.input).toEqual(CANONICAL_PAYLOAD.input);
  });

  it("keeps allowed optional fields and omits absent ones", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    await countResponsesInputTokens({
      apiKey: "sk-test",
      payload: {
        model: "gpt-6-luna",
        input: "hello",
        previous_response_id: "resp_1",
        instructions: "be terse",
        truncation: "auto",
      },
      fetchImpl: async (_input, init) => {
        capturedBody = JSON.parse(
          new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
            init?.body as ArrayBuffer,
          ),
        ) as Record<string, unknown>;
        return new Response(JSON.stringify({ input_tokens: 3 }), { status: 200 });
      },
    });

    expect(capturedBody).toEqual({
      model: "gpt-6-luna",
      input: "hello",
      previous_response_id: "resp_1",
      instructions: "be terse",
      truncation: "auto",
    });
  });

  it("surfaces provider failures instead of returning a fabricated count", async () => {
    await expect(
      countResponsesInputTokens({
        apiKey: "sk-test",
        payload: CANONICAL_PAYLOAD,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ error: { code: "unsupported_parameter", message: "bad field" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("listProviderModels", () => {
  it("lists model identifiers from the provider with bearer auth", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;

    const result = await listProviderModels({
      apiKey: "sk-test",
      fetchImpl: async (input, init) => {
        capturedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        capturedAuth = new Headers(init?.headers).get("authorization");
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "gpt-6-astra" }, { id: "gpt-6-luna" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(result.modelIds).toEqual(["gpt-6-astra", "gpt-6-luna"]);
    expect(capturedUrl).toBe("https://api.openai.com/v1/models");
    expect(capturedAuth).toBe("Bearer sk-test");
  });

  it("throws an HttpError carrying the provider status and error code", async () => {
    await expect(
      listProviderModels({
        apiKey: "sk-test",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: { code: "invalid_api_key", message: "Incorrect API key provided" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("rejects a 2xx body without a valid data array", async () => {
    await expect(
      listProviderModels({
        apiKey: "sk-test",
        fetchImpl: async () =>
          new Response(JSON.stringify({ object: "list" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "invalid_models_response",
    });
  });

  it("rejects entries whose id is not a non-empty string", async () => {
    await expect(
      listProviderModels({
        apiKey: "sk-test",
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ id: 7 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toMatchObject({
      status: 502,
      code: "invalid_models_response",
    });
  });
});

describe("dispatchResponsesCreate credential redaction", () => {
  it("redacts an sk-shaped key echoed by the provider", async () => {
    const apiKey = "sk-super-secret";

    const outcome = await dispatchResponsesCreate({
      apiKey,
      idempotencyKey: "idem-redaction-1",
      requestBytes: utf8Encoder.encode("{}"),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_api_key",
              message: "Incorrect API key provided: sk-super-secret",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    if (outcome.kind !== "terminal_error") {
      throw new Error(`Expected terminal_error, received ${outcome.kind}`);
    }
    expect(outcome.statusCode).toBe(400);
    expect(outcome.errorCode).toBe("invalid_api_key");
    expect(outcome.message).toContain("[redacted]");
    expect(outcome.message).not.toContain(apiKey);
  });

  it("redacts a non-OpenAI-shaped exact key echoed by the provider", async () => {
    const apiKey = "test-key-123456789";

    const outcome = await dispatchResponsesCreate({
      apiKey,
      idempotencyKey: "idem-redaction-2",
      requestBytes: utf8Encoder.encode("{}"),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "invalid_api_key",
              message: `Incorrect API key provided: ${apiKey}`,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    if (outcome.kind !== "terminal_error") {
      throw new Error(`Expected terminal_error, received ${outcome.kind}`);
    }
    expect(outcome.message).toContain("[redacted]");
    expect(outcome.message).not.toContain(apiKey);
  });

  it("drops an oversized provider error code and bounds the error message", async () => {
    const outcome = await dispatchResponsesCreate({
      apiKey: "test-key-123456789",
      idempotencyKey: "idem-redaction-3",
      requestBytes: utf8Encoder.encode("{}"),
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "c".repeat(200),
              message: "m".repeat(5_000),
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    });

    if (outcome.kind !== "terminal_error") {
      throw new Error(`Expected terminal_error, received ${outcome.kind}`);
    }
    expect(outcome.errorCode).toBeNull();
    expect(outcome.message.length).toBeLessThanOrEqual(2_003);
    expect(outcome.message.endsWith("...")).toBe(true);
  });
});

describe("retrieveProviderResponse credential redaction", () => {
  it("redacts an echoed key in the thrown HttpError", async () => {
    const apiKey = "test-key-123456789";

    const error = await captureHttpError(() =>
      retrieveProviderResponse({
        apiKey,
        responseId: "resp_redaction",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "invalid_api_key",
                message: `Incorrect API key provided: ${apiKey}`,
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      }),
    );

    expect(error.status).toBe(400);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(apiKey);
  });
});

describe("listProviderModels credential redaction", () => {
  it("redacts an echoed key in the thrown HttpError", async () => {
    const apiKey = "test-key-123456789";

    const error = await captureHttpError(() =>
      listProviderModels({
        apiKey,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "invalid_api_key",
                message: `Incorrect API key provided: ${apiKey}`,
              },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      }),
    );

    expect(error.status).toBe(401);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(apiKey);
  });
});