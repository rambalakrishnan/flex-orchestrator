// Covers: 11, 12, 13, 14, 15

import { describe, expect, it } from "vitest";
import {
  JUDGE_MAX_GRADE,
  JUDGE_OUTPUT_FIELD_NAMES,
  buildJudgeInstruction,
  buildJudgeRequest,
  classifyJudgeEvaluation,
  deriveFileVisibility,
  extractJudgeRawText,
  judgeBuildFailureOutcome,
  judgeConfigAdvisoryWarnings,
  judgeMissingSecretOutcome,
  parseJudgeOutput,
  resolvedContinuityMode,
} from "../../src/lib/judge.ts";
import type {
  BuildJudgeRequestParams,
  BuiltJudgeRequest,
  EnabledJudgeConfig,
  JudgeOutputParseResult,
  JudgeRequestBuildOutcome,
} from "../../src/lib/judge.ts";
import type {
  JudgeFileManifestEntry,
  TokenUsageRecord,
  ValidatedJudgeOutput,
} from "../../src/types.ts";
import {
  PROXY_JUDGE_API_ROOT,
  applicableFile,
  chatCompletionsChainedJudge,
  chatCompletionsJudge,
  chatCompletionsPassthroughJudge,
  enabledJudgeConfig,
  inlineChainedJudge,
  metaInlineJudge,
  openAiJudge,
  openRouterJudge,
  priorAcceptedOutput,
} from "../fixtures/judge.ts";

const BASE_BUILD_PARAMS: BuildJudgeRequestParams = {
  config: openAiJudge(),
  judgeCallId: "jc_1",
  jobId: "job_1",
  attemptId: "att_1",
  turnIndex: 2,
  candidateText: "candidate deliverable text",
  previousJudgeResponseId: null,
  applicableFiles: [],
  priorAcceptedOutputs: [],
};

function build(
  config: EnabledJudgeConfig,
  overrides: Partial<BuildJudgeRequestParams> = {},
): JudgeRequestBuildOutcome {
  return buildJudgeRequest({ ...BASE_BUILD_PARAMS, config, ...overrides });
}

function expectBuilt(outcome: JudgeRequestBuildOutcome): BuiltJudgeRequest {
  if (outcome.kind !== "built") {
    throw new Error(`expected a built request, got ${outcome.kind}: ${outcome.message}`);
  }
  return outcome.request;
}

function expectUnencodable(
  outcome: JudgeRequestBuildOutcome,
): Extract<JudgeRequestBuildOutcome, { kind: "unencodable_contract" }> {
  if (outcome.kind !== "unencodable_contract") {
    throw new Error(`expected an unencodable contract, got ${outcome.kind}`);
  }
  return outcome;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

type ParseFailureReason = Extract<JudgeOutputParseResult, { ok: false }>["reason"];

function parseOk(rawText: string): ValidatedJudgeOutput {
  const result = parseJudgeOutput(rawText);
  if (!result.ok) {
    throw new Error(`expected valid judge output, got ${result.reason}: ${result.message}`);
  }
  return result.output;
}

function parseFail(rawText: string): ParseFailureReason {
  const result = parseJudgeOutput(rawText);
  if (result.ok) {
    throw new Error(`expected judge output to be rejected: ${rawText}`);
  }
  // Pure parser: a rejection carries no output payload, so nothing can be
  // written from it.
  expect("output" in result).toBe(false);
  return result.reason;
}

function judgeOutputJson(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    verdict: "PASS",
    grade: 90,
    comment: "Acceptable deliverable.",
    tag_agreement: true,
    file_visibility: true,
    ...overrides,
  });
}

function newJudgeOutputJson(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    verdict: "YES",
    grade: "B",
    comment: "Acceptable deliverable.",
    tag_matches_expected_step: true,
    file_visibility: true,
    ...overrides,
  });
}

const VALID_JUDGE_OUTPUT_JSON = judgeOutputJson();

const TEST_USAGE: TokenUsageRecord = {
  inputTokens: 900,
  cachedInputTokens: 100,
  outputTokens: 120,
  reasoningTokens: 40,
  totalTokens: 1020,
  contextTier: "standard",
  estimatedCostUsd: 0.001,
  pricingKnown: true,
};

const COMPLETE_MANIFEST: readonly JudgeFileManifestEntry[] = [
  { fileId: "file_a", filename: "file_a.txt", byteSize: 3, status: "delivered_now" },
  {
    fileId: "file_b",
    filename: "file_b.txt",
    byteSize: 4,
    status: "inherited",
  },
];

const INCOMPLETE_MANIFEST: readonly JudgeFileManifestEntry[] = [
  ...COMPLETE_MANIFEST,
  {
    fileId: "file_c",
    filename: "file_c.txt",
    byteSize: 0,
    status: "withheld",
    reason: "inline_bytes_missing",
  },
];

describe("declared-capability handling (item 11)", () => {
  it("warns on Chat Completions + chained and encodes no invented stateful field", () => {
    const config = chatCompletionsChainedJudge();

    expect(judgeConfigAdvisoryWarnings(config).join("\n")).toContain(
      "Chat Completions has no stateful response-history mechanism",
    );
    expect(resolvedContinuityMode(config)).toBe("stateless");

    const built = expectBuilt(build(config, { previousJudgeResponseId: "resp_never_used" }));
    const body = JSON.parse(built.requestBody) as Record<string, unknown>;

    // Declared transport shape only: no continuity fields were invented.
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "response_format"]);
    expect(built.requestBody).not.toContain("previous_response_id");
    expect(built.requestBody).not.toContain('"store"');
    expect(built.requestBody).not.toContain('"include"');
    expect(built.requestBody).not.toContain("reasoning");
    // The declaration is preserved verbatim in the audit shape.
    expect(built.historyMode).toBe("chained");
    expect(built.transport).toBe("chat_completions");
  });

  it("permits passthrough against a non-OpenAI API root", () => {
    const config = enabledJudgeConfig({
      apiRoot: PROXY_JUDGE_API_ROOT,
      fileDeliveryMode: "passthrough",
      historyMode: "chained",
    });

    const built = expectBuilt(
      build(config, { applicableFiles: [applicableFile("file_proxy")] }),
    );

    expect(built.requestBody).toContain('"file_id":"file_proxy"');
    expect(built.requestBody).not.toContain('"previous_response_id"');
    expect(built.manifest[0]).toMatchObject({
      fileId: "file_proxy",
      status: "delivered_now",
    });
  });

  it("returns an unencodable contract with no request body for Chat Completions passthrough", () => {
    const config = chatCompletionsPassthroughJudge();

    const outcome = expectUnencodable(
      build(config, { applicableFiles: [applicableFile("file_x")] }),
    );

    expect(outcome.reason).toBe("chat_completions_passthrough");
    expect(outcome.message.length).toBeGreaterThan(0);
    // Nothing was dropped onto the wire: there is no request at all.
    expect("request" in outcome).toBe(false);
    expect("requestBody" in outcome).toBe(false);
    expect(outcome.manifest).toHaveLength(1);
    expect(outcome.manifest[0]?.status).toBe("withheld");
    expect(outcome.manifest[0]?.reason).toBe("chat_completions_passthrough_unsupported");
    expect(outcome.advisoryWarnings.join("\n")).toContain("passthrough");
  });
});

describe("Chat Completions content shape", () => {
  function chatUserContent(body: string): readonly Record<string, unknown>[] {
    const parsed = JSON.parse(body) as {
      readonly messages: readonly {
        readonly role: string;
        readonly content: unknown;
      }[];
    };
    const user = parsed.messages.find((message) => message.role === "user");
    if (!user || !Array.isArray(user.content)) {
      throw new Error("expected an array user content block");
    }
    return user.content as readonly Record<string, unknown>[];
  }

  it("encodes the candidate as a text part, never Responses-style parts", () => {
    const built = expectBuilt(build(chatCompletionsJudge()));

    expect(built.requestBody).not.toContain('"input_text"');
    expect(built.requestBody).not.toContain('"input_file"');
    expect(chatUserContent(built.requestBody)).toEqual([
      { type: "text", text: "candidate deliverable text" },
    ]);
  });

  it("embeds inline UTF-8 files as fenced text parts and marks them delivered", () => {
    const built = expectBuilt(
      build(chatCompletionsJudge(), {
        applicableFiles: [
          applicableFile("file_a", {
            filename: "notes.md",
            bytes: new TextEncoder().encode("# Notes"),
          }),
        ],
      }),
    );

    const parts = chatUserContent(built.requestBody);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toEqual({
      type: "text",
      text: '<file name="notes.md">\n# Notes\n</file>',
    });
    expect(built.manifest).toMatchObject([
      { fileId: "file_a", status: "delivered_now" },
    ]);
  });

  it("withholds non-UTF-8 inline files with an explicit reason instead of mangling them", () => {
    const built = expectBuilt(
      build(chatCompletionsJudge(), {
        applicableFiles: [
          applicableFile("file_bin", {
            filename: "blob.bin",
            mimeType: "application/octet-stream",
            bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
          }),
        ],
      }),
    );

    expect(chatUserContent(built.requestBody)).toEqual([
      { type: "text", text: "candidate deliverable text" },
    ]);
    expect(built.manifest).toMatchObject([
      { fileId: "file_bin", status: "withheld", reason: "inline_bytes_not_utf8" },
    ]);
    expect(deriveFileVisibility(built.manifest)).toBe(false);
  });

  it("withholds inline files missing bytes instead of sending an empty part", () => {
    const built = expectBuilt(
      build(chatCompletionsJudge(), {
        applicableFiles: [applicableFile("file_missing")],
      }),
    );

    expect(chatUserContent(built.requestBody)).toEqual([
      { type: "text", text: "candidate deliverable text" },
    ]);
    expect(built.manifest).toMatchObject([
      { fileId: "file_missing", status: "withheld", reason: "inline_bytes_missing" },
    ]);
  });
});


describe("history-aware file delivery (item 12)", () => {
  it("attaches a file on stateful call 1 and omits it as inherited on call 2", () => {
    const config = openAiJudge();

    const first = expectBuilt(
      build(config, {
        previousJudgeResponseId: null,
        applicableFiles: [applicableFile("file_a", { alreadyIntroduced: false })],
      }),
    );
    expect(first.requestBody).toContain('"file_id":"file_a"');
    expect(first.requestBody.split('"file_id":"file_a"').length - 1).toBe(1);
    expect(first.manifest).toHaveLength(1);
    expect(first.manifest[0]?.status).toBe("delivered_now");
    expect(first.requestBody).not.toContain("previous_response_id");

    const second = expectBuilt(
      build(config, {
        previousJudgeResponseId: "resp_prev",
        applicableFiles: [applicableFile("file_a", { alreadyIntroduced: true })],
      }),
    );
    expect(second.requestBody).toContain('"previous_response_id":"resp_prev"');
    expect(second.requestBody).not.toContain("file_a");
    expect(second.manifest[0]?.status).toBe("inherited");
    expect(countOccurrences(second.requestBody, '"type":"input_file"')).toBe(0);
  });

  it("re-attaches the file when the prior call failed before response-ID commit", () => {
    const config = openAiJudge();
    const file = applicableFile("file_retry", { alreadyIntroduced: false });

    // Chain was never established, so the file must be sent again.
    const retry = expectBuilt(
      build(config, {
        previousJudgeResponseId: null,
        applicableFiles: [file],
      }),
    );

    expect(retry.requestBody).toContain('"file_id":"file_retry"');
    expect(retry.requestBody).not.toContain("previous_response_id");
    expect(retry.manifest[0]?.status).toBe("delivered_now");

    // Once the response ID is committed, persisted chain state governs: the
    // file is inherited rather than re-sent.
    const afterCommit = expectBuilt(
      build(config, {
        previousJudgeResponseId: "resp_committed",
        applicableFiles: [applicableFile("file_retry", { alreadyIntroduced: true })],
      }),
    );
    expect(afterCommit.requestBody).toContain('"previous_response_id":"resp_committed"');
    expect(afterCommit.requestBody).not.toContain("file_retry");
    expect(afterCommit.manifest[0]?.status).toBe("inherited");
  });

  it("includes prior accepted text once for stateless includePrior", () => {
    const config = openRouterJudge({ includePrior: true });

    const built = expectBuilt(
      build(config, {
        turnIndex: 3,
        applicableFiles: [
          applicableFile("file_shared", { bytes: new Uint8Array([1, 2, 3]) }),
        ],
        priorAcceptedOutputs: [
          priorAcceptedOutput(1, "prior deliverable one", ["file_shared"]),
          priorAcceptedOutput(2, "prior deliverable two", []),
          priorAcceptedOutput(3, "same-turn output must be excluded", []),
          priorAcceptedOutput(4, "future-turn output must be excluded", []),
        ],
      }),
    );

    expect(countOccurrences(built.requestBody, "prior deliverable one")).toBe(1);
    expect(countOccurrences(built.requestBody, "prior deliverable two")).toBe(1);
    expect(built.requestBody).not.toContain("same-turn output must be excluded");
    expect(built.requestBody).not.toContain("future-turn output must be excluded");
    // The file for the prior accepted-output block appears exactly once.
    expect(countOccurrences(built.requestBody, '"type":"input_file"')).toBe(1);
  });

  it("deduplicates duplicate file IDs across turns within one request", () => {
    const config = openRouterJudge();
    const bytes = new Uint8Array([9, 9, 9]);

    const built = expectBuilt(
      build(config, {
        applicableFiles: [
          applicableFile("file_dup", { bytes }),
          applicableFile("file_dup", { bytes }),
        ],
      }),
    );

    expect(countOccurrences(built.requestBody, '"type":"input_file"')).toBe(1);
    expect(countOccurrences(built.requestBody, '"file_data"')).toBe(1);
  });
});

describe("manifest and file_visibility (item 13)", () => {
  it("distinguishes delivered_now, inherited, and withheld files", () => {
    const config = inlineChainedJudge();

    const built = expectBuilt(
      build(config, {
        applicableFiles: [
          applicableFile("file_new", { bytes: new Uint8Array([1]) }),
          applicableFile("file_inherited", {
            bytes: new Uint8Array([2]),
            alreadyIntroduced: true,
          }),
          applicableFile("file_missing"),
        ],
      }),
    );

    const byFileId = new Map(built.manifest.map((entry) => [entry.fileId, entry]));
    expect(byFileId.get("file_new")?.status).toBe("delivered_now");
    expect(byFileId.get("file_inherited")?.status).toBe("inherited");
    expect(byFileId.get("file_missing")?.status).toBe("withheld");
    expect(byFileId.get("file_missing")?.reason).toBe("inline_bytes_missing");
    expect(built.requestBody).not.toContain("file_missing");
    expect(deriveFileVisibility(built.manifest)).toBe(false);
  });

  it("withholds an inline file without bytes with an explicit reason", () => {
    const built = expectBuilt(
      build(metaInlineJudge(), {
        applicableFiles: [applicableFile("file_nobytes")],
      }),
    );

    expect(built.manifest).toEqual([
      {
        fileId: "file_nobytes",
        filename: "file_nobytes.txt",
        byteSize: 0,
        status: "withheld",
        reason: "inline_bytes_missing",
      },
    ]);
    expect(deriveFileVisibility(built.manifest)).toBe(false);
  });

  it("reports true visibility when every applicable file is delivered", () => {
    const built = expectBuilt(
      build(openRouterJudge(), {
        applicableFiles: [
          applicableFile("file_one", { bytes: new Uint8Array([1]) }),
          applicableFile("file_two", { bytes: new Uint8Array([2]) }),
        ],
      }),
    );

    expect(built.manifest.every((entry) => entry.status === "delivered_now")).toBe(true);
    expect(deriveFileVisibility(built.manifest)).toBe(true);
  });

  it("derives visibility from the manifest, not from delivered_now alone", () => {
    const inheritedOnly: readonly JudgeFileManifestEntry[] = [
      { fileId: "file_inherited", filename: "file_inherited.txt", byteSize: 2, status: "inherited" },
    ];
    expect(deriveFileVisibility(inheritedOnly)).toBe(true);

    const inheritedAndDelivered: readonly JudgeFileManifestEntry[] = [
      ...inheritedOnly,
      { fileId: "file_new", filename: "file_new.txt", byteSize: 2, status: "delivered_now" },
    ];
    expect(deriveFileVisibility(inheritedAndDelivered)).toBe(true);

    const withWithheld: readonly JudgeFileManifestEntry[] = [
      ...inheritedAndDelivered,
      { fileId: "file_x", filename: "file_x.txt", byteSize: 0, status: "withheld", reason: "inline_bytes_missing" },
    ];
    expect(deriveFileVisibility(withWithheld)).toBe(false);
  });
});

describe("judge output shape (item 14)", () => {
  it("accepts exactly the five fields with correct types", () => {
    const output = parseOk(VALID_JUDGE_OUTPUT_JSON);

    expect(JUDGE_OUTPUT_FIELD_NAMES).toEqual([
      "verdict",
      "grade",
      "comment",
      "tag_matches_expected_step",
      "file_visibility",
    ]);
    expect(JUDGE_MAX_GRADE).toBe(100);
    expect(output).toEqual({
      verdict: "PASS",
      grade: 90,
      comment: "Acceptable deliverable.",
      tag_agreement: true,
      file_visibility: true,
    });
  });

  it("rejects missing and extra fields", () => {
    // 4 fields: no grade.
    expect(
      parseFail(
        JSON.stringify({
          verdict: "PASS",
          comment: "ok",
          tag_agreement: true,
          file_visibility: true,
        }),
      ),
    ).toBe("invalid_response_shape");

    // 6 fields.
    expect(parseFail(judgeOutputJson({ notes: "extra" }))).toBe("invalid_response_shape");

    // Extra property alongside the exact five.
    expect(parseFail(judgeOutputJson({ confidence: 0.9 }))).toBe(
      "invalid_response_shape",
    );
  });

  it("rejects wrong field types", () => {
    expect(parseFail(judgeOutputJson({ grade: "90" }))).toBe("invalid_response_shape");
    expect(parseFail(judgeOutputJson({ tag_agreement: "true" }))).toBe(
      "invalid_response_shape",
    );
    expect(parseFail(judgeOutputJson({ file_visibility: 1 }))).toBe(
      "invalid_response_shape",
    );
    expect(parseFail(judgeOutputJson({ comment: "" }))).toBe("invalid_response_shape");
    expect(parseFail(judgeOutputJson({ comment: "   " }))).toBe(
      "invalid_response_shape",
    );
    expect(parseFail(newJudgeOutputJson({ tag_matches_expected_step: "true" }))).toBe(
      "invalid_response_shape",
    );
  });

  it("rejects out-of-range and non-integer grades", () => {
    expect(parseFail(judgeOutputJson({ grade: 101 }))).toBe("invalid_response_shape");
    expect(parseFail(judgeOutputJson({ grade: -1 }))).toBe("invalid_response_shape");
    expect(parseFail(judgeOutputJson({ grade: 1.5 }))).toBe("invalid_response_shape");
    expect(parseFail(judgeOutputJson({ grade: "G" }))).toBe("invalid_response_shape");
    expect(parseOk(judgeOutputJson({ grade: 0 })).grade).toBe(0);
    expect(parseOk(judgeOutputJson({ grade: 100 })).grade).toBe(100);
  });

  it("normalizes the new YES/NO verdict and letter-grade wire shape", () => {
    const output = parseOk(newJudgeOutputJson());

    expect(output).toEqual({
      verdict: "PASS",
      grade: 85,
      comment: "Acceptable deliverable.",
      tag_agreement: true,
      file_visibility: true,
    });

    expect(parseOk(newJudgeOutputJson({ verdict: "NO" })).verdict).toBe("FAIL");

    const letterGrades = [
      ["A", 95],
      ["B", 85],
      ["C", 75],
      ["D", 65],
      ["F", 50],
    ] as const;
    for (const [letter, numeric] of letterGrades) {
      const candidate = parseOk(newJudgeOutputJson({ grade: letter }));
      expect(candidate.grade).toBe(numeric);
    }
  });

  it("accepts lowercase verdicts and letter grades", () => {
    expect(parseOk(judgeOutputJson({ verdict: "pass" })).verdict).toBe("PASS");
    expect(parseOk(judgeOutputJson({ verdict: "fail" })).verdict).toBe("FAIL");

    const lower = parseOk(
      newJudgeOutputJson({ verdict: "no", grade: "a" }),
    );
    expect(lower.verdict).toBe("FAIL");
    expect(lower.grade).toBe(95);
    expect(parseOk(newJudgeOutputJson({ grade: "c" })).grade).toBe(75);
  });

  it("rejects mixed legacy and current tag keys", () => {
    // Both tag keys present: six fields, so the exact five-field contract fails.
    expect(
      parseFail(newJudgeOutputJson({ tag_agreement: true })),
    ).toBe("invalid_response_shape");

    // Both tag keys plus a missing required field: still rejected.
    expect(
      parseFail(
        JSON.stringify({
          verdict: "YES",
          grade: "A",
          tag_matches_expected_step: true,
          tag_agreement: true,
          file_visibility: true,
        }),
      ),
    ).toBe("invalid_response_shape");

    // Neither tag key: primary-key set mismatch is rejected.
    expect(
      parseFail(
        JSON.stringify({
          verdict: "YES",
          grade: "A",
          comment: "ok",
          file_visibility: true,
        }),
      ),
    ).toBe("invalid_response_shape");
  });

  it("rejects invalid JSON and empty output, purely", () => {
    expect(parseFail("{ not-json")).toBe("invalid_json");
    expect(parseFail("")).toBe("empty_output");
    expect(parseFail("   ")).toBe("empty_output");
    expect(parseFail("[]")).toBe("invalid_response_shape");

    // Parsing is pure: repeated calls produce identical results and nothing is
    // persisted or mutated in the process.
    const once = parseJudgeOutput(VALID_JUDGE_OUTPUT_JSON);
    const twice = parseJudgeOutput(VALID_JUDGE_OUTPUT_JSON);
    expect(once).toEqual(twice);
    expect(parseJudgeOutput("{ broken")).toEqual(parseJudgeOutput("{ broken"));
  });
});

describe("judge audit records (item 15)", () => {
  it("exposes the full audit shape with instruction, model, and turn index", () => {
    const built = expectBuilt(
      build(openAiJudge(), {
        turnIndex: 7,
        applicableFiles: [applicableFile("file_audit")],
      }),
    );

    expect(built.transport).toBe("responses");
    expect(built.historyMode).toBe("chained");
    expect(built.fileDeliveryMode).toBe("passthrough");
    expect(built.idempotencyKey).toBe("job_1:j7:jc_1");
    expect(built.requestBody).toContain('"model":"gpt-5-judge"');
    expect(built.requestBody).toContain("Evaluate the candidate deliverable");
    expect(built.requestBody).toContain("Expected turn index: 7");
    for (const fieldName of JUDGE_OUTPUT_FIELD_NAMES) {
      expect(built.requestBody).toContain(fieldName);
    }

    expect(built.requestBytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(built.requestBytes)).toBe(
      built.requestBody,
    );
    expect(built.requestBytes.byteLength).toBe(
      new TextEncoder().encode(built.requestBody).byteLength,
    );
  });

  it("embeds inline base64 bytes and never a Node Buffer", () => {
    const built = expectBuilt(
      build(openRouterJudge(), {
        applicableFiles: [
          applicableFile("file_b64", { bytes: new Uint8Array([1, 2, 3]) }),
        ],
      }),
    );

    expect(built.requestBody).toContain("data:text/plain;base64,AQID");
    expect(built.requestBody).not.toContain("Buffer");

    // Stateless Responses includes encrypted reasoning content and no anchor.
    const body = JSON.parse(built.requestBody) as Record<string, unknown>;
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.store).toBe(false);
    expect("previous_response_id" in body).toBe(false);
  });

  it("rejects an inline request exceeding the artifact guard", () => {
    // Base64 inflates 3 bytes to 4 chars: 1,125,000 bytes encode to exactly
    // 1,500,000 chars, so any JSON envelope exceeds the guard. One cheap
    // allocation, no string payloads.
    const largeBytes = new Uint8Array(1_125_000);

    const outcome = expectUnencodable(
      build(openRouterJudge(), {
        applicableFiles: [applicableFile("file_large", { bytes: largeBytes })],
      }),
    );

    expect(outcome.reason).toBe("artifact_guard_exceeded");
    expect(outcome.message).toContain("1500000");
    expect("request" in outcome).toBe(false);
  });
});

describe("developer prompt composition", () => {
  const developerPrompt = "Judge strictly as a reviewer.";
  const generatedInstruction = buildJudgeInstruction({
    turnIndex: BASE_BUILD_PARAMS.turnIndex,
    expectedTagIndex: BASE_BUILD_PARAMS.turnIndex,
  });
  const composedInstruction = `${developerPrompt}\n\n${generatedInstruction}`;

  it("prefixes the Responses developer message with the declared developer prompt", () => {
    const built = expectBuilt(
      build(openRouterJudge({ developerPrompt })),
    );

    const body = JSON.parse(built.requestBody) as Record<string, unknown>;
    const input = body.input as Array<Record<string, unknown>>;
    const developerMessage = input[0];
    expect(developerMessage?.role).toBe("developer");
    const developerContent = developerMessage?.content as Array<Record<string, unknown>>;
    const developerText = developerContent[0]?.text as string;

    expect(developerText.startsWith(developerPrompt)).toBe(true);
    expect(developerText.startsWith(`${developerPrompt}\n\n`)).toBe(true);
    expect(developerText).toBe(composedInstruction);
    for (const fieldName of JUDGE_OUTPUT_FIELD_NAMES) {
      expect(developerText).toContain(fieldName);
    }

    // Stateless Responses continuity is untouched by the developer prompt.
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("prefixes the Chat Completions developer message with the declared developer prompt", () => {
    const built = expectBuilt(
      build(chatCompletionsJudge({ developerPrompt })),
    );

    const body = JSON.parse(built.requestBody) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    const developerMessage = messages[0];
    expect(developerMessage?.role).toBe("developer");

    const developerText = developerMessage?.content as string;
    expect(developerText.startsWith(developerPrompt)).toBe(true);
    expect(developerText.startsWith(`${developerPrompt}\n\n`)).toBe(true);
    expect(developerText).toBe(composedInstruction);
    for (const fieldName of JUDGE_OUTPUT_FIELD_NAMES) {
      expect(developerText).toContain(fieldName);
    }
  });
});

describe("judge instruction text", () => {
  it("requests the five-field YES/NO letter-grade shape with no numeric grade cap", () => {
    const instruction = buildJudgeInstruction({ turnIndex: 4, expectedTagIndex: 4 });

    expect(instruction).toBe(
      'Evaluate the candidate deliverable for the declared turn. Expected turn index: 4. Reply with a single JSON object containing exactly these five fields: "verdict" ("YES" or "NO"), "grade" ("A", "B", "C", "D", or "F"), "comment" (non-empty string), "tag_matches_expected_step" (boolean), "file_visibility" (boolean). Do not include any other fields, prose, or markdown fences.',
    );
    for (const fieldName of JUDGE_OUTPUT_FIELD_NAMES) {
      expect(instruction).toContain(`"${fieldName}"`);
    }
    expect(instruction).not.toContain("tag_agreement");
    expect(instruction).not.toContain("maxGrade");
    expect(instruction).not.toContain("0-100");
    expect(instruction).not.toContain(String(JUDGE_MAX_GRADE));
    expect(instruction).not.toContain("PASS");
    expect(instruction).not.toContain("FAIL");
  });

  it("embeds the generated instruction verbatim in the built request", () => {
    const built = expectBuilt(build(openAiJudge(), { turnIndex: 4 }));

    const request = JSON.parse(built.requestBody) as {
      readonly input: readonly {
        readonly role?: string;
        readonly content?: readonly { readonly type?: string; readonly text?: string }[];
      }[];
    };
    const developerMessage = request.input.find(
      (item) => item.role === "developer",
    );
    expect(developerMessage).toBeDefined();
    expect(developerMessage?.content?.[0]?.text).toBe(
      buildJudgeInstruction({ turnIndex: 4, expectedTagIndex: 4 }),
    );
  });
});

describe("extraction and outcome classification", () => {
  it("extracts Responses output_text and Chat Completions message content", () => {
    expect(
      extractJudgeRawText({ output_text: VALID_JUDGE_OUTPUT_JSON }, "responses"),
    ).toBe(VALID_JUDGE_OUTPUT_JSON);

    expect(
      extractJudgeRawText(
        {
          output: [
            {
              content: [
                { type: "output_text", text: '{"verdict":' },
                { type: "output_text", text: '"PASS"}' },
              ],
            },
          ],
        },
        "responses",
      ),
    ).toBe('{"verdict":"PASS"}');

    expect(
      extractJudgeRawText(
        { choices: [{ message: { content: VALID_JUDGE_OUTPUT_JSON } }] },
        "chat_completions",
      ),
    ).toBe(VALID_JUDGE_OUTPUT_JSON);

    expect(extractJudgeRawText({ choices: [] }, "chat_completions")).toBeNull();
    expect(extractJudgeRawText("not-an-object", "responses")).toBeNull();
  });

  it("maps provider errors and parse failures to unknown", () => {
    const parsed = parseJudgeOutput(VALID_JUDGE_OUTPUT_JSON);
    const providerError = classifyJudgeEvaluation({
      judgeCallId: "jc_1",
      parse: parsed,
      manifest: COMPLETE_MANIFEST,
      responseId: null,
      usage: null,
      providerErrorMessage: "upstream judge failure",
    });
    expect(providerError).toEqual({
      kind: "unknown",
      judgeCallId: "jc_1",
      reason: "provider_error",
      message: "upstream judge failure",
      advisoryWarnings: [],
    });

    const shapeFailure = classifyJudgeEvaluation({
      judgeCallId: "jc_2",
      parse: parseJudgeOutput('{"verdict":"PASS"}'),
      manifest: COMPLETE_MANIFEST,
      responseId: null,
      usage: null,
    });
    expect(shapeFailure.kind).toBe("unknown");
    if (shapeFailure.kind !== "unknown") throw new Error("expected unknown outcome");
    expect(shapeFailure.reason).toBe("invalid_response_shape");
    expect(shapeFailure.advisoryWarnings).toEqual([]);

    const jsonFailure = classifyJudgeEvaluation({
      judgeCallId: "jc_3",
      parse: parseJudgeOutput("{ broken"),
      manifest: COMPLETE_MANIFEST,
      responseId: null,
      usage: null,
    });
    expect(jsonFailure.kind).toBe("unknown");
  });

  it("evaluates with a coverage warning when the manifest is incomplete", () => {
    const parsed = parseJudgeOutput(VALID_JUDGE_OUTPUT_JSON);
    if (!parsed.ok) throw new Error("expected valid parse");

    const evaluated = classifyJudgeEvaluation({
      judgeCallId: "jc_1",
      parse: parsed,
      manifest: INCOMPLETE_MANIFEST,
      responseId: "resp_judge_1",
      usage: TEST_USAGE,
    });

    expect(evaluated.kind).toBe("evaluated");
    if (evaluated.kind !== "evaluated") throw new Error("expected evaluated outcome");
    // The judge output is preserved; the missing coverage is only advisory.
    expect(evaluated.output).toEqual(parsed.output);
    expect(evaluated.responseId).toBe("resp_judge_1");
    expect(evaluated.usage).toBe(TEST_USAGE);
    // Incomplete coverage is the only advisory; the manifest governs visibility.
    expect(evaluated.advisoryWarnings).toHaveLength(1);
    expect(evaluated.advisoryWarnings[0]).toContain("coverage warning");
  });

  it("evaluates complete coverage with no warnings", () => {
    const parsed = parseJudgeOutput(VALID_JUDGE_OUTPUT_JSON);
    if (!parsed.ok) throw new Error("expected valid parse");

    const evaluated = classifyJudgeEvaluation({
      judgeCallId: "jc_1",
      parse: parsed,
      manifest: COMPLETE_MANIFEST,
      responseId: "resp_judge_2",
      usage: TEST_USAGE,
    });

    expect(evaluated.kind).toBe("evaluated");
    if (evaluated.kind !== "evaluated") throw new Error("expected evaluated outcome");
    expect(evaluated.advisoryWarnings).toEqual([]);
  });
});

describe("failure outcome helpers", () => {
  it("does not accept a built outcome as a failure outcome", () => {
    const built = expectBuilt(build(openAiJudge()));
    // @ts-expect-error -- a built request carries no unencodable contract reason
    const notAFailure: Parameters<typeof judgeBuildFailureOutcome>[0]["outcome"] = built;
    expect(notAFailure).toBe(built);
  });

  it("maps an unencodable chat_completions passthrough contract to unencodable_contract", () => {
    const outcome = expectUnencodable(build(chatCompletionsPassthroughJudge()));
    const failure = judgeBuildFailureOutcome({ judgeCallId: "jc_1", outcome });

    expect(failure).toEqual({
      kind: "unknown",
      judgeCallId: "jc_1",
      reason: "unencodable_contract",
      message: "Chat Completions has no file-id passthrough mechanism",
      advisoryWarnings: outcome.advisoryWarnings,
    });
    if (failure.kind !== "unknown") {
      throw new Error("expected unknown failure outcome");
    }
    expect(failure.advisoryWarnings.length).toBeGreaterThan(0);
  });

  it("maps an artifact guard overflow to artifact_guard_exceeded", () => {
    const synthetic: Extract<JudgeRequestBuildOutcome, { readonly kind: "unencodable_contract" }> = {
      kind: "unencodable_contract",
      reason: "artifact_guard_exceeded",
      message: "Judge request is 1500001 bytes, exceeding the 1500000-byte artifact guard",
      manifest: COMPLETE_MANIFEST,
      advisoryWarnings: ["advisory warning"],
    };

    expect(judgeBuildFailureOutcome({ judgeCallId: "jc_2", outcome: synthetic })).toEqual({
      kind: "unknown",
      judgeCallId: "jc_2",
      reason: "artifact_guard_exceeded",
      message: "Judge request is 1500001 bytes, exceeding the 1500000-byte artifact guard",
      advisoryWarnings: ["advisory warning"],
    });
  });

  it("maps a missing secret to missing_secret and preserves a null judge call id", () => {
    expect(judgeMissingSecretOutcome({ judgeCallId: null, secretName: "JUDGE_KEY" })).toEqual({
      kind: "unknown",
      judgeCallId: null,
      reason: "missing_secret",
      message: "Judge secret binding is missing or empty: JUDGE_KEY",
      advisoryWarnings: [],
    });
  });
});