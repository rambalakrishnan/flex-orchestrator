// Covers: 7, 10

import { describe, expect, it } from "vitest";

import {
  FLEX_CAPACITY_BACKOFF_BASE_MS,
  FLEX_CAPACITY_BACKOFF_MAX_MS,
  GENERATION_SERVICE_TIER,
  MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT,
} from "../../src/constants.ts";
import {
  COMPLETION_MARKER_FORMAT,
  DEVELOPER_INSTRUCTION,
  REANCHOR_REPLAY_TURNS,
  shouldReanchorHistory,
  applyRetryAfter,
  buildCanonicalGenerationRequest,
  buildGenerationIdempotencyKey,
  buildGenerationInput,
  classifyDispatchResult,
  computeCapacityBackoffMs,
  type DispatchDecision,
} from "../../src/lib/dispatch.ts";
import { reasoningContinuityPayload } from "../../src/lib/continuity.ts";
import type { DispatchOutcome } from "../../src/types.ts";
import {
  ANCHOR_RESPONSE_ID,
  BASE_JOB_ID,
  BASE_MAX_OUTPUT_TOKENS,
  BASE_MODEL,
  BASE_PROMPT_TEXT,
  BASE_TURN_INDEX,
  CANONICAL_ATTACHMENT_FILE_IDS,
  DEVELOPER_PROMPT_TEXT,
  PRIOR_ACCEPTED_TURNS,
  anchoredGenerationRequestParams,
  baseGenerationRequestParams,
  cacheGenerationRequestParams,
  continuationGenerationRequestParams,
  developerContextGenerationRequestParams,
  fileAttachmentGenerationRequestParams,
  parseBody,
  priorAcceptedTurnsGenerationRequestParams,
  webSearchGenerationRequestParams,
} from "../fixtures/requests.ts";

const NOW_MS = 1_700_000_000_000;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: false,
  ignoreBOM: false,
});

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function asItems(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a JSON array.`);
  }
  const items: readonly unknown[] = value;
  return items.map((item, index) => asRecord(item, `${label}[${index}]`));
}

function firstContentItem(item: Record<string, unknown>, label: string): Record<string, unknown> {
  return asRecord(asItems(item.content, `${label}.content`)[0], `${label}.content[0]`);
}

function assistantMessages(items: readonly Record<string, unknown>[]) {
  return items.filter((item) => item.role === "assistant");
}

function requestBodyOf(params: Parameters<typeof buildCanonicalGenerationRequest>[0]) {
  const request = buildCanonicalGenerationRequest(params);
  return { request, body: parseBody(request.requestBody) };
}

describe("canonical generation request body (§7)", () => {
  it("stores the exact UTF-8 bytes that serialize the request body", () => {
    const { request } = requestBodyOf(baseGenerationRequestParams());

    expect(utf8Decoder.decode(request.requestBytes)).toBe(request.requestBody);
    expect(utf8Encoder.encode(request.requestBody)).toEqual(request.requestBytes);
    expect(request.requestBytes.byteLength).toBe(
      utf8Encoder.encode(request.requestBody).byteLength,
    );
  });

  it("round-trips the serialized body through a stable JSON parse", () => {
    const { request, body } = requestBodyOf(baseGenerationRequestParams());

    expect(parseBody(request.requestBody)).toEqual(body);
    expect(parseBody(utf8Decoder.decode(request.requestBytes))).toEqual(body);
    expect(JSON.stringify(body)).toBe(request.requestBody);
  });

  it("uses Flex background Responses with explicit reasoning effort", () => {
    const { body } = requestBodyOf(baseGenerationRequestParams());

    expect(body.model).toBe(BASE_MODEL);
    expect(body.background).toBe(true);
    expect(body.service_tier).toBe("flex");
    expect(body.service_tier).toBe(GENERATION_SERVICE_TIER);
    expect(body.reasoning).toEqual({ effort: "medium" });
    expect(body.max_output_tokens).toBe(BASE_MAX_OUTPUT_TOKENS);
  });

  it("places developer messages in input and never at the top-level instructions field", () => {
    const { body } = requestBodyOf(developerContextGenerationRequestParams());
    const input = asItems(body.input, "input");

    expect(Object.keys(body)).not.toContain("instructions");
    expect("instructions" in body).toBe(false);
    expect(input).toHaveLength(2);

    const developer = asRecord(input[0], "input[0]");
    expect(developer.type).toBe("message");
    expect(developer.role).toBe("developer");
    expect(asItems(developer.content, "developer.content")).toEqual([
      { type: "input_text", text: DEVELOPER_INSTRUCTION },
      { type: "input_text", text: DEVELOPER_PROMPT_TEXT },
    ]);

    const { request, body: parsedBody } = requestBodyOf(
      developerContextGenerationRequestParams(),
    );
    expect(request.inputItems).toEqual(asItems(parsedBody.input, "input"));
  });

  it("keeps the constant instruction when the job has no developer prompt", () => {
    const { body } = requestBodyOf(baseGenerationRequestParams());
    const input = asItems(body.input, "input");

    expect(input).toHaveLength(2);
    expect(input[0]?.role).toBe("developer");
    expect(asItems(asRecord(input[0], "input[0]").content, "developer.content")).toEqual([
      { type: "input_text", text: DEVELOPER_INSTRUCTION },
    ]);
  });

  it("puts the prompt text in the user message with no attachments by default", () => {
    const { body } = requestBodyOf(baseGenerationRequestParams());
    const user = asRecord(asItems(body.input, "input")[1], "input[1]");

    expect(user.type).toBe("message");
    expect(user.role).toBe("user");
    const content = asItems(user.content, "user.content");
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "input_text", text: BASE_PROMPT_TEXT });
  });

  it("includes previous_response_id only when anchored and keeps store true", () => {
    const unanchored = requestBodyOf(baseGenerationRequestParams()).body;
    expect("previous_response_id" in unanchored).toBe(false);
    expect(unanchored.store).toBe(true);
    expect("include" in unanchored).toBe(false);

    const anchored = requestBodyOf(anchoredGenerationRequestParams()).body;
    expect(anchored.previous_response_id).toBe(ANCHOR_RESPONSE_ID);
    expect(anchored.store).toBe(true);
    expect("include" in anchored).toBe(false);
  });

  it("selects prompt cache lifetime explicitly and disables it for nocache", () => {
    for (const cacheTtl of ["30m", "12h"] as const) {
      const { body } = requestBodyOf(cacheGenerationRequestParams(cacheTtl));
      expect(body.prompt_cache_options).toEqual({ ttl: cacheTtl });
      expect("prompt_cache_retention" in body).toBe(false);
    }

    const { body } = requestBodyOf(cacheGenerationRequestParams("nocache"));
    expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
    expect("prompt_cache_retention" in body).toBe(false);
  });

  it("consumes the shared continuity payload verbatim", () => {
    for (const params of [
      baseGenerationRequestParams(),
      anchoredGenerationRequestParams(),
    ]) {
      const { body } = requestBodyOf(params);
      const observed: Record<string, unknown> = { store: body.store };
      if ("previous_response_id" in body) {
        observed.previous_response_id = body.previous_response_id;
      }

      expect(observed).toEqual(
        reasoningContinuityPayload(
          "stateful",
          params.previousResponseId === null
            ? null
            : { previous_response_id: params.previousResponseId },
        ),
      );
      expect("include" in body).toBe(false);
    }
  });

  it("adds tools only when web search is enabled", () => {
    const withoutSearch = requestBodyOf(baseGenerationRequestParams()).body;
    expect("tools" in withoutSearch).toBe(false);

    const withSearch = requestBodyOf(webSearchGenerationRequestParams()).body;
    expect(withSearch.tools).toEqual([{ type: "web_search" }]);
    expect(withSearch.background).toBe(true);
    expect(withSearch.service_tier).toBe("flex");
  });

  it("attaches one input_file per deduplicated file id", () => {
    const fileIds = [...CANONICAL_ATTACHMENT_FILE_IDS, ...CANONICAL_ATTACHMENT_FILE_IDS];
    const { body } = requestBodyOf(
      fileAttachmentGenerationRequestParams(fileIds),
    );
    const input = asItems(body.input, "input");
    const user = asRecord(input[input.length - 1], "user");
    const content = asItems(user.content, "user.content");

    expect(content[0]).toEqual({ type: "input_text", text: BASE_PROMPT_TEXT });
    expect(content.slice(1)).toEqual([
      { type: "input_file", file_id: "file_lighthouse_map" },
      { type: "input_file", file_id: "file_harbor_log" },
    ]);
    expect(content.filter((item) => item.type === "input_file")).toHaveLength(
      CANONICAL_ATTACHMENT_FILE_IDS.length,
    );
  });

  it("replaces the prompt text with the continuation directive on continuation attempts", () => {
    const { body } = requestBodyOf(continuationGenerationRequestParams());
    const user = asRecord(asItems(body.input, "input")[1], "user");
    const text = firstContentItem(user, "user").text;

    expect(typeof text).toBe("string");
    expect(text).toContain(
      `Continue turn ${BASE_TURN_INDEX} from exactly where the previous response stopped.`,
    );
    expect(text).toContain(`<!-- TURN_END:${BASE_TURN_INDEX} -->`);
    expect(text).not.toContain("TURN_CONTINUE");
    expect(text).not.toContain("<TURN_COMPLETE");
    expect(text).not.toContain("<TURN_CONTINUE");
    expect(text).not.toContain(BASE_PROMPT_TEXT);
    expect(body.previous_response_id).toBe(ANCHOR_RESPONSE_ID);
    expect(body.background).toBe(true);
  });

  it("replays prior accepted turns as assistant messages only when unanchored", () => {
    const { body } = requestBodyOf(priorAcceptedTurnsGenerationRequestParams());
    const input = asItems(body.input, "input");
    const assistants = assistantMessages(input);

    expect(input[0]?.role).toBe("developer");
    expect(input[input.length - 1]?.role).toBe("user");
    expect(assistants).toHaveLength(PRIOR_ACCEPTED_TURNS.length);
    expect(assistants.map((item) => firstContentItem(item, "assistant"))).toEqual(
      PRIOR_ACCEPTED_TURNS.map((prior) => ({
        type: "output_text",
        text: prior.deliverableText,
      })),
    );
    expect("previous_response_id" in body).toBe(false);

    const anchored = requestBodyOf(
      priorAcceptedTurnsGenerationRequestParams({
        previousResponseId: ANCHOR_RESPONSE_ID,
      }),
    );
    expect(assistantMessages(asItems(anchored.body.input, "input"))).toHaveLength(0);
    expect(anchored.body.previous_response_id).toBe(ANCHOR_RESPONSE_ID);
  });

  it("never stores authorization material in the request body", () => {
    const variants = [
      baseGenerationRequestParams(),
      anchoredGenerationRequestParams(),
      webSearchGenerationRequestParams(),
      continuationGenerationRequestParams(),
      priorAcceptedTurnsGenerationRequestParams(),
      fileAttachmentGenerationRequestParams(CANONICAL_ATTACHMENT_FILE_IDS),
    ];

    for (const params of variants) {
      const request = buildCanonicalGenerationRequest(params);
      const lowered = request.requestBody.toLowerCase();
      expect(lowered).not.toContain("authorization");
      expect(lowered).not.toContain("bearer ");
      expect(lowered).not.toContain("api_key");
      expect(lowered).not.toContain("api-key");
    }
  });
});

describe("developer context in the developer message (§6)", () => {
  function developerContentOf(params: Parameters<typeof buildCanonicalGenerationRequest>[0]) {
    const { body } = requestBodyOf(params);
    const input = asItems(body.input, "input");
    const developer = asRecord(input[0], "input[0]");
    return { input, developer, content: asItems(developer.content, "developer.content") };
  }

  it("keeps developer files out of the developer message and attaches them to the user message", () => {
    const { content, input } = developerContentOf(developerContextGenerationRequestParams());

    expect(content).toEqual([
      { type: "input_text", text: DEVELOPER_INSTRUCTION },
      { type: "input_text", text: DEVELOPER_PROMPT_TEXT },
    ]);
    expect(content.map((item) => item.type)).toEqual(["input_text", "input_text"]);

    const user = asRecord(input[input.length - 1], "user");
    expect(asItems(user.content, "user.content")).toEqual([
      { type: "input_text", text: BASE_PROMPT_TEXT },
      { type: "input_file", file_id: "file_style_guide" },
      { type: "input_file", file_id: "file_world_bible" },
    ]);
  });

  it("serializes the developer context on initial and continuation attempts alike", () => {
    const initial = developerContentOf(developerContextGenerationRequestParams());
    expect(initial.content).toHaveLength(2);

    const continuation = developerContentOf(
      developerContextGenerationRequestParams({
        attemptKind: "continuation",
        continuationIndex: 1,
        previousResponseId: ANCHOR_RESPONSE_ID,
      }),
    );
    expect(continuation.content).toEqual(initial.content);
    expect(continuation.content[0]).toEqual({
      type: "input_text",
      text: DEVELOPER_INSTRUCTION,
    });
    expect(continuation.content[1]).toEqual({
      type: "input_text",
      text: DEVELOPER_PROMPT_TEXT,
    });

    const user = asRecord(
      continuation.input[continuation.input.length - 1],
      "user",
    );
    const userContent = asItems(user.content, "user.content");
    expect(userContent[0]).toEqual({
      type: "input_text",
      text: expect.stringContaining("Continue turn"),
    });
    expect(userContent.filter((item) => item.type === "input_file")).toEqual([
      { type: "input_file", file_id: "file_style_guide" },
      { type: "input_file", file_id: "file_world_bible" },
    ]);
  });

  it("keeps only the constant instruction for empty or whitespace-only developer context", () => {
    for (const params of [
      baseGenerationRequestParams(),
      baseGenerationRequestParams({ developerFileIds: [] }),
      baseGenerationRequestParams({ developerPrompt: "   \n\t " }),
      baseGenerationRequestParams({ developerPrompt: "   ", developerFileIds: [""] }),
    ]) {
      const { content } = developerContentOf(params);
      expect(content).toEqual([{ type: "input_text", text: DEVELOPER_INSTRUCTION }]);
    }
  });

  it("keeps the developer message byte-identical across turns and attempts", () => {
    const developerMessageOf = (
      params: Parameters<typeof buildCanonicalGenerationRequest>[0],
    ): Record<string, unknown> => {
      const { body } = requestBodyOf(params);
      const input = asItems(body.input, "input");
      const developer = input.find((item) => item.role === "developer");
      if (developer === undefined) {
        throw new Error("Expected a developer message.");
      }
      return developer;
    };

    const turnOne = developerMessageOf(
      developerContextGenerationRequestParams({ turnIndex: 1 }),
    );
    for (const turnIndex of [2, 3, 4]) {
      expect(
        developerMessageOf(developerContextGenerationRequestParams({ turnIndex })),
      ).toEqual(turnOne);
    }
    expect(
      developerMessageOf(
        developerContextGenerationRequestParams({
          attemptKind: "continuation",
          continuationIndex: 1,
          previousResponseId: ANCHOR_RESPONSE_ID,
        }),
      ),
    ).toEqual(turnOne);
  });

  it("deduplicates developer file ids in order on the user message", () => {
    const { content, input } = developerContentOf(
      baseGenerationRequestParams({
        developerPrompt: DEVELOPER_PROMPT_TEXT,
        developerFileIds: [
          "file_style_guide",
          "file_style_guide",
          "",
          "file_world_bible",
          "file_style_guide",
        ],
      }),
    );

    expect(content).toEqual([
      { type: "input_text", text: DEVELOPER_INSTRUCTION },
      { type: "input_text", text: DEVELOPER_PROMPT_TEXT },
    ]);

    const user = asRecord(input[input.length - 1], "user");
    expect(asItems(user.content, "user.content")).toEqual([
      { type: "input_text", text: BASE_PROMPT_TEXT },
      { type: "input_file", file_id: "file_style_guide" },
      { type: "input_file", file_id: "file_world_bible" },
    ]);
  });

  it("deduplicates developer and turn files together on the user message", () => {
    const { content, input } = developerContentOf(
      developerContextGenerationRequestParams({
        attachmentFileIds: [
          "file_style_guide",
          "file_harbor_log",
          "file_harbor_log",
        ],
      }),
    );

    expect(content.filter((item) => item.type === "input_file")).toHaveLength(0);

    const user = asRecord(input[input.length - 1], "user");
    expect(asItems(user.content, "user.content")).toEqual([
      { type: "input_text", text: BASE_PROMPT_TEXT },
      { type: "input_file", file_id: "file_style_guide" },
      { type: "input_file", file_id: "file_world_bible" },
      { type: "input_file", file_id: "file_harbor_log" },
    ]);
  });

  it("carries the developer context in the serialized request bytes", () => {
    const request = buildCanonicalGenerationRequest(
      developerContextGenerationRequestParams(),
    );
    const serialized = utf8Decoder.decode(request.requestBytes);

    expect(serialized).toBe(request.requestBody);
    expect(serialized).toContain(DEVELOPER_PROMPT_TEXT);
    expect(serialized).toContain("file_style_guide");
    expect(serialized).toContain("file_world_bible");
  });
});

describe("canonical marker dialect", () => {
  it("exports comment-style markers with a {turnIndex} placeholder", () => {
    expect(COMPLETION_MARKER_FORMAT).toBe("<!-- TURN_END:{turnIndex} -->");
    expect(COMPLETION_MARKER_FORMAT.replace("{turnIndex}", "3")).toBe("<!-- TURN_END:3 -->");
  });

  it("never emits angle-bracket or bracket marker forms", () => {
    const { body } = requestBodyOf(continuationGenerationRequestParams());
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain("<TURN_COMPLETE");
    expect(serialized).not.toContain("<TURN_CONTINUE");
    expect(serialized).not.toContain("[[TURN_");
  });
});

describe("1-based turn index enforcement (§7)", () => {
  const INVALID_TURN_INDICES = [0, -1, 1.5] as const;

  it("rejects non-1-based turn indices when building generation input", () => {
    for (const turnIndex of INVALID_TURN_INDICES) {
      expect(() =>
        buildGenerationInput({
          turnIndex,
          promptText: BASE_PROMPT_TEXT,
          attachmentFileIds: [],
          attemptKind: "initial",
          previousResponseId: null,
        }),
      ).toThrow(RangeError);
    }
  });

  it("rejects non-1-based turn indices when building the canonical request", () => {
    for (const turnIndex of INVALID_TURN_INDICES) {
      expect(() =>
        buildCanonicalGenerationRequest(baseGenerationRequestParams({ turnIndex })),
      ).toThrow(RangeError);
    }
  });

  it("accepts turn index 1 for both builders", () => {
    const items = buildGenerationInput({
      turnIndex: 1,
      promptText: BASE_PROMPT_TEXT,
      attachmentFileIds: [],
      attemptKind: "initial",
      previousResponseId: null,
    });

    expect(items[0]?.role).toBe("developer");
    expect(items[items.length - 1]?.role).toBe("user");

    const request = buildCanonicalGenerationRequest(
      baseGenerationRequestParams({ turnIndex: 1 }),
    );
    expect(request.idempotencyKey).toBe(`${BASE_JOB_ID}:t1:a1:c0`);
    const body = parseBody(request.requestBody);
    expect(asItems(body.input, "input")).toHaveLength(2);
  });

  it("accepts every integer turn index above one", () => {
    for (const turnIndex of [2, 3, 10]) {
      const request = buildCanonicalGenerationRequest(
        baseGenerationRequestParams({ turnIndex }),
      );
      expect(request.idempotencyKey).toBe(`${BASE_JOB_ID}:t${turnIndex}:a1:c0`);
    }
  });
});

describe("generation idempotency keys (§7)", () => {
  it("reuses the same key and identical bytes when an attempt is sent again", () => {
    const params = baseGenerationRequestParams();
    const first = buildCanonicalGenerationRequest(params);
    const second = buildCanonicalGenerationRequest(params);

    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.requestBody).toBe(second.requestBody);
    expect(first.requestBytes).toEqual(second.requestBytes);
    expect(first.idempotencyKey).toBe(buildGenerationIdempotencyKey(params));
    expect(first.idempotencyKey).toBe(`${BASE_JOB_ID}:t1:a1:c0`);
  });

  it("derives a new key from a new attempt index", () => {
    const attemptOne = buildCanonicalGenerationRequest(baseGenerationRequestParams());
    const attemptTwo = buildCanonicalGenerationRequest(
      baseGenerationRequestParams({ attemptNumber: 2 }),
    );

    expect(attemptTwo.idempotencyKey).not.toBe(attemptOne.idempotencyKey);
    expect(attemptTwo.idempotencyKey).toBe(`${BASE_JOB_ID}:t1:a2:c0`);
    // Attempt identity lives in the key; the request body stays byte-identical.
    expect(attemptTwo.requestBytes).toEqual(attemptOne.requestBytes);
  });

  it("derives a new key from a continuation-index bump", () => {
    const initial = buildCanonicalGenerationRequest(baseGenerationRequestParams());
    const continuation = buildCanonicalGenerationRequest(
      continuationGenerationRequestParams(),
    );

    expect(continuation.idempotencyKey).not.toBe(initial.idempotencyKey);
    expect(continuation.idempotencyKey).toBe(`${BASE_JOB_ID}:t1:a1:c1`);
  });

  it("includes job and turn identity in the key", () => {
    const base = buildGenerationIdempotencyKey({
      jobId: BASE_JOB_ID,
      turnIndex: BASE_TURN_INDEX,
      attemptNumber: 1,
      continuationIndex: 0,
    });
    const otherJob = buildGenerationIdempotencyKey({
      jobId: "job_2",
      turnIndex: BASE_TURN_INDEX,
      attemptNumber: 1,
      continuationIndex: 0,
    });
    const otherTurn = buildGenerationIdempotencyKey({
      jobId: BASE_JOB_ID,
      turnIndex: BASE_TURN_INDEX + 1,
      attemptNumber: 1,
      continuationIndex: 0,
    });

    expect(otherJob).not.toBe(base);
    expect(otherTurn).not.toBe(base);
    expect(base).toBe("job_1:t1:a1:c0");
    expect(otherJob).toBe("job_2:t1:a1:c0");
    expect(otherTurn).toBe("job_1:t2:a1:c0");
  });
});

describe("Flex capacity backoff (§10)", () => {
  it("persists bounded exponential backoff for sends zero through four", () => {
    expect(FLEX_CAPACITY_BACKOFF_BASE_MS).toBe(5_000);
    expect(FLEX_CAPACITY_BACKOFF_MAX_MS).toBe(80_000);
    expect(computeCapacityBackoffMs(0)).toBe(5_000);
    expect(computeCapacityBackoffMs(1)).toBe(10_000);
    expect(computeCapacityBackoffMs(2)).toBe(20_000);
    expect(computeCapacityBackoffMs(3)).toBe(40_000);
    expect(computeCapacityBackoffMs(4)).toBe(80_000);
  });

  it("returns null once the five-send attempt budget is exhausted", () => {
    expect(computeCapacityBackoffMs(5)).toBeNull();
    expect(computeCapacityBackoffMs(6)).toBeNull();
    expect(computeCapacityBackoffMs(Number.POSITIVE_INFINITY)).toBeNull();
    expect(computeCapacityBackoffMs(Number.NaN)).toBeNull();
  });

  it("never exceeds the configured backoff ceiling within the send budget", () => {
    const firstSend = computeCapacityBackoffMs(0);
    expect(firstSend).not.toBeNull();
    for (let sendsCompleted = 0; sendsCompleted < MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT; sendsCompleted += 1) {
      const delay = computeCapacityBackoffMs(sendsCompleted);
      if (delay !== null) {
        expect(delay).toBeGreaterThanOrEqual(firstSend ?? 0);
        expect(delay).toBeLessThanOrEqual(FLEX_CAPACITY_BACKOFF_MAX_MS);
      }
    }
  });

  it("takes the larger of our backoff and the provider Retry-After value", () => {
    expect(applyRetryAfter(5_000, null)).toBe(5_000);
    expect(applyRetryAfter(5_000, 0)).toBe(5_000);
    expect(applyRetryAfter(5_000, 12_000)).toBe(12_000);
    expect(applyRetryAfter(10_000, 5_000)).toBe(10_000);
    expect(applyRetryAfter(5_000, -1)).toBe(5_000);
    expect(applyRetryAfter(5_000, Number.NaN)).toBe(5_000);
    expect(applyRetryAfter(5_000, Number.POSITIVE_INFINITY)).toBe(5_000);
    expect(applyRetryAfter(null, 60_000)).toBeNull();
    expect(applyRetryAfter(null, null)).toBeNull();
  });
});

const CAPACITY_OUTCOME: DispatchOutcome = {
  kind: "capacity_unavailable",
  statusCode: 429,
  retryAfterMs: null,
  message: "Flex capacity unavailable",
};

describe("dispatch classification (§10)", () => {
  it("maps a dispatched outcome without altering the response status", () => {
    for (const status of ["queued", "in_progress", "completed"] as const) {
      const decision = classifyDispatchResult({
        outcome: {
          kind: "dispatched",
          responseId: "resp_dispatch_1",
          status,
          rawResponseBytes: new ArrayBuffer(0),
        },
        sendsCompleted: 0,
        nowMs: NOW_MS,
      });

      expect(decision).toEqual({
        kind: "dispatched",
        responseId: "resp_dispatch_1",
        status,
      });
    }
  });

  it("schedules a persisted retry deadline from computed backoff", () => {
    const decision = classifyDispatchResult({
      outcome: CAPACITY_OUTCOME,
      sendsCompleted: 0,
      nowMs: NOW_MS,
    });

    expect(decision).toEqual({
      kind: "retry_capacity",
      sendNumber: 2,
      sendsCompleted: 1,
      delayMs: 10_000,
      dueAtMs: NOW_MS + 10_000,
      message: "Flex capacity unavailable",
    });
  });

  it("raises the delay to the provider Retry-After when it is larger", () => {
    const decision = classifyDispatchResult({
      outcome: { ...CAPACITY_OUTCOME, retryAfterMs: 90_000 },
      sendsCompleted: 0,
      nowMs: NOW_MS,
    });

    expect(decision.kind).toBe("retry_capacity");
    if (decision.kind !== "retry_capacity") {
      throw new Error("Expected retry_capacity");
    }
    expect(decision.delayMs).toBe(90_000);
    expect(decision.dueAtMs).toBe(NOW_MS + 90_000);
  });

  it("keeps our backoff when Retry-After is smaller", () => {
    const decision = classifyDispatchResult({
      outcome: { ...CAPACITY_OUTCOME, retryAfterMs: 1_000 },
      sendsCompleted: 3,
      nowMs: NOW_MS,
    });

    expect(decision.kind).toBe("retry_capacity");
    if (decision.kind !== "retry_capacity") {
      throw new Error("Expected retry_capacity");
    }
    expect(decision.delayMs).toBe(80_000);
    expect(decision.dueAtMs).toBe(NOW_MS + 80_000);
  });

  it("allows exactly five capacity sends per attempt before pausing", () => {
    const decisions: DispatchDecision[] = [];
    for (
      let sendsCompleted = 0;
      sendsCompleted < MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT;
      sendsCompleted += 1
    ) {
      decisions.push(
        classifyDispatchResult({
          outcome: CAPACITY_OUTCOME,
          sendsCompleted,
          nowMs: NOW_MS,
        }),
      );
    }

    expect(MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT).toBe(5);
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "retry_capacity",
      "retry_capacity",
      "retry_capacity",
      "retry_capacity",
      "capacity_exhausted",
    ]);
    expect(decisions[4]).toEqual({
      kind: "capacity_exhausted",
      sends: 5,
      message: "Flex capacity unavailable",
    });
  });

  it("classifies every ambiguous provider reason without scheduling an automatic retry", () => {
    for (const reason of [
      "network_error",
      "timeout",
      "unparseable_response",
      "server_5xx",
    ] as const) {
      const decision = classifyDispatchResult({
        outcome: {
          kind: "ambiguous_dispatch",
          reason,
          message: `ambiguous: ${reason}`,
        },
        sendsCompleted: 0,
        nowMs: NOW_MS,
      });

      expect(decision).toEqual({
        kind: "ambiguous_dispatch",
        reason,
        message: `ambiguous: ${reason}`,
      });
      expect("dueAtMs" in decision).toBe(false);
    }
  });

  it("passes terminal provider errors through with their status and code", () => {
    const decision = classifyDispatchResult({
      outcome: {
        kind: "terminal_error",
        statusCode: 400,
        errorCode: "invalid_request_error",
        message: "Invalid request body",
      },
      sendsCompleted: 2,
      nowMs: NOW_MS,
    });

    expect(decision).toEqual({
      kind: "terminal_error",
      statusCode: 400,
      errorCode: "invalid_request_error",
      message: "Invalid request body",
    });
  });
});

describe("bounded-history re-anchoring", () => {
  it("holds the chain below the model's long-context threshold", () => {
    expect(shouldReanchorHistory("gpt-6-astra", 229_002)).toBe(false);
    expect(shouldReanchorHistory("gpt-6-astra", 272_000)).toBe(false);
  });

  it("breaks the chain once frozen input crosses the threshold", () => {
    expect(shouldReanchorHistory("gpt-6-astra", 272_001)).toBe(true);
    expect(shouldReanchorHistory("gpt-6-astra", 345_917)).toBe(true);
  });

  it("falls back to a fraction of max input for models without a tier", () => {
    // o3: 200k max input, no long-context tier → 160k threshold.
    expect(shouldReanchorHistory("o3", 160_000)).toBe(false);
    expect(shouldReanchorHistory("o3", 160_001)).toBe(true);
  });

  it("never re-anchors on missing counts or unknown models", () => {
    expect(shouldReanchorHistory("gpt-6-astra", null)).toBe(false);
    expect(shouldReanchorHistory("gpt-6-astra", -1)).toBe(false);
    expect(shouldReanchorHistory("not-a-model", 999_999_999)).toBe(false);
  });

  it("pins the replay window at two recent turns", () => {
    expect(REANCHOR_REPLAY_TURNS).toBe(2);
  });
});