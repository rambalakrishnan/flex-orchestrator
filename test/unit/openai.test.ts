// Covers: 7, 22

import { describe, expect, it } from "vitest";

import { countResponsesInputTokens } from "../../src/lib/openai.ts";

const CANONICAL_PAYLOAD: Readonly<Record<string, unknown>> = {
  model: "gpt-6-astra",
  background: true,
  service_tier: "flex",
  store: true,
  reasoning: { effort: "high" },
  max_output_tokens: 128_000,
  prompt_cache_retention: "12h",
  tools: [{ type: "web_search" }],
  input: [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    },
  ],
};

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