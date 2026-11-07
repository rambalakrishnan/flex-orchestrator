/**
 * Judge — `src/lib/judge.ts`
 *
 * Declared-provider judge adapters, file manifest construction, and exactly
 * five-field result validation per `README.md` §Provider Configurations and
 * `docs/TESTING.md` items 11-15.
 *
 * Invariants:
 * - The adapter performs no runtime capability detection or silent substitution.
 *   Declared contracts are encoded as declared; inconsistent declarations emit
 *   advisory warnings, and an unencodable contract yields an explicit failure
 *   instead of a stripped request.
 * - A stateful (chained) Responses request may introduce a file once and inherit
 *   it on later calls; stateless requests attach applicable files to the turns
 *   represented in their explicit context and deduplicate within the request.
 * - `file_visibility` coverage is derived from the manifest, not from
 *   `delivered_now` alone.
 * - Judge output accepts exactly verdict, grade, comment, tag agreement, and
 *   boolean file visibility. No other fields are accepted.
 */

import { ARTIFACT_ROW_GUARD_BYTES } from "../constants.ts";
import type {
  AttemptId,
  FileId,
  IdempotencyKey,
  JobId,
  JudgeCallId,
  JudgeConfig,
  JudgeEvaluationOutcome,
  JudgeFileDeliveryMode,
  JudgeFileManifestEntry,
  JudgeHistoryMode,
  JudgeTransport,
  ResponseId,
  TokenUsageRecord,
  TurnIndex,
  ValidatedJudgeOutput,
} from "../types.ts";
import { judgeHistoryToContinuityMode, reasoningContinuityPayload } from "./continuity.ts";

/** Exact five accepted judge output fields. */
export const JUDGE_OUTPUT_FIELD_NAMES = [
  "verdict",
  "grade",
  "comment",
  "tag_agreement",
  "file_visibility",
] as const;

/** Marker emitted by Chat Completions providers that support JSON mode. */
export const JUDGE_MAX_GRADE = 100;

export type EnabledJudgeConfig = Extract<JudgeConfig, { readonly enabled: true }>;

/** An applicable file plus (for inline delivery) its exact bytes. */
export interface JudgeApplicableFile {
  readonly fileId: FileId;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly bytes?: Uint8Array | ArrayBuffer | null;
  /** True when an earlier stateful judge call already introduced this file. */
  readonly alreadyIntroduced?: boolean;
}

export interface PriorAcceptedOutput {
  readonly turnIndex: TurnIndex;
  readonly deliverableText: string;
  readonly attachmentFileIds: readonly FileId[];
}

export interface BuildJudgeRequestParams {
  readonly config: EnabledJudgeConfig;
  readonly judgeCallId: JudgeCallId;
  readonly jobId: JobId;
  readonly attemptId: AttemptId;
  readonly turnIndex: TurnIndex;
  readonly candidateText: string;
  readonly previousJudgeResponseId: ResponseId | null;
  readonly applicableFiles: readonly JudgeApplicableFile[];
  readonly priorAcceptedOutputs?: readonly PriorAcceptedOutput[];
}

export interface BuiltJudgeRequest {
  readonly transport: JudgeTransport;
  readonly historyMode: JudgeHistoryMode;
  readonly fileDeliveryMode: JudgeFileDeliveryMode;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestBody: string;
  readonly requestBytes: Uint8Array;
  readonly manifest: readonly JudgeFileManifestEntry[];
  readonly advisoryWarnings: readonly string[];
}

export type JudgeRequestBuildOutcome =
  | { readonly kind: "built"; readonly request: BuiltJudgeRequest }
  | {
      readonly kind: "unencodable_contract";
      readonly reason:
        | "chat_completions_passthrough"
        | "inline_bytes_missing"
        | "artifact_guard_exceeded";
      readonly message: string;
      readonly manifest: readonly JudgeFileManifestEntry[];
      readonly advisoryWarnings: readonly string[];
    };

const utf8Encoder = new TextEncoder();

/**
 * Advisory warnings for declared contracts that cannot fully honor every
 * declared capability. These never change what the request encodes.
 */
export function judgeConfigAdvisoryWarnings(config: EnabledJudgeConfig): readonly string[] {
  const warnings: string[] = [];

  if (config.transport === "chat_completions" && config.historyMode === "chained") {
    warnings.push(
      "Chat Completions has no stateful response-history mechanism; the declared chained history cannot be sent and the request is stateless.",
    );
  }

  if (config.transport === "chat_completions" && config.fileDeliveryMode === "passthrough") {
    warnings.push(
      "Chat Completions has no file-id passthrough mechanism; declared passthrough file delivery is unencodable.",
    );
  }

  if (config.fileDeliveryMode === "inline" && config.historyMode === "chained") {
    warnings.push(
      "Inline file delivery with chained history attaches each applicable file once; later calls inherit its context instead of resending bytes.",
    );
  }

  if (config.transport === "chat_completions" && config.fileDeliveryMode === "inline") {
    warnings.push(
      "Chat Completions inline file delivery encodes file bytes into message content; capability detection is not performed.",
    );
  }

  return warnings;
}

/** The effective continuity mode a request actually encodes. */
export function resolvedContinuityMode(config: EnabledJudgeConfig): "stateful" | "stateless" {
  if (config.transport === "chat_completions") {
    // Chat Completions cannot carry Responses continuity fields.
    return "stateless";
  }
  return judgeHistoryToContinuityMode(config.historyMode);
}

/** Base64 encoding without Node buffers. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Human-readable judge instruction embedding the expected turn and output contract. */
export function buildJudgeInstruction(params: {
  readonly turnIndex: TurnIndex;
  readonly expectedTagIndex: TurnIndex;
  readonly maxGrade: number;
}): string {
  return [
    "Evaluate the candidate deliverable for the declared turn.",
    `Expected turn index: ${params.expectedTagIndex}.`,
    "Reply with a single JSON object containing exactly these five fields:",
    `"verdict" ("PASS" or "FAIL"), "grade" (integer 0-${params.maxGrade}), "comment" (non-empty string), "tag_agreement" (boolean), "file_visibility" (boolean).`,
    "Do not include any other fields, prose, or markdown fences.",
  ].join(" ");
}

function buildManifest(params: {
  readonly config: EnabledJudgeConfig;
  readonly applicableFiles: readonly JudgeApplicableFile[];
  readonly deliveredNow: ReadonlySet<FileId>;
  readonly effectiveHistory: "stateful" | "stateless";
  readonly withheldReasons: ReadonlyMap<FileId, string>;
}): readonly JudgeFileManifestEntry[] {
  const manifest: JudgeFileManifestEntry[] = [];
  for (const file of params.applicableFiles) {
    if (params.deliveredNow.has(file.fileId)) {
      manifest.push({
        fileId: file.fileId,
        filename: file.filename,
        byteSize: file.byteSize,
        status: "delivered_now",
      });
      continue;
    }
    const reason = params.withheldReasons.get(file.fileId);
    if (reason !== undefined) {
      manifest.push({
        fileId: file.fileId,
        filename: file.filename,
        byteSize: file.byteSize,
        status: "withheld",
        reason,
      });
      continue;
    }
    if (params.effectiveHistory === "stateful" && file.alreadyIntroduced === true) {
      manifest.push({
        fileId: file.fileId,
        filename: file.filename,
        byteSize: file.byteSize,
        status: "inherited",
      });
      continue;
    }
    manifest.push({
      fileId: file.fileId,
      filename: file.filename,
      byteSize: file.byteSize,
      status: "withheld",
      reason: "not_included_in_declared_context",
    });
  }
  return manifest;
}

/** Complete applicable-file coverage: no manifest entry is withheld. */
export function deriveFileVisibility(manifest: readonly JudgeFileManifestEntry[]): boolean {
  return manifest.every((entry) => entry.status !== "withheld");
}

function buildJudgeFileContentItems(params: {
  readonly config: EnabledJudgeConfig;
  readonly files: readonly JudgeApplicableFile[];
}): readonly Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const file of params.files) {
    if (params.config.fileDeliveryMode === "passthrough") {
      items.push({ type: "input_file", file_id: file.fileId });
      continue;
    }
    const bytes = file.bytes
      ? file.bytes instanceof Uint8Array
        ? file.bytes
        : new Uint8Array(file.bytes)
      : null;
    if (bytes === null) {
      continue;
    }
    items.push({
      type: "input_file",
      filename: file.filename,
      file_data: `data:${file.mimeType || "application/octet-stream"};base64,${encodeBase64(bytes)}`,
    });
  }
  return items;
}

/**
 * Builds a judge request for the declared transport, history, and file-delivery
 * modes. Returns an explicit unencodable outcome when the declaration cannot be
 * represented, rather than sending a stripped request.
 */
export function buildJudgeRequest(params: BuildJudgeRequestParams): JudgeRequestBuildOutcome {
  const config = params.config;
  const advisoryWarnings = judgeConfigAdvisoryWarnings(config);

  if (config.transport === "chat_completions" && config.fileDeliveryMode === "passthrough") {
    return {
      kind: "unencodable_contract",
      reason: "chat_completions_passthrough",
      message: "Chat Completions has no file-id passthrough mechanism",
      manifest: buildManifest({
        config,
        applicableFiles: params.applicableFiles,
        deliveredNow: new Set<FileId>(),
        effectiveHistory: "stateless",
        withheldReasons: new Map(
          params.applicableFiles.map((file) => [
            file.fileId,
            "chat_completions_passthrough_unsupported",
          ]),
        ),
      }),
      advisoryWarnings,
    };
  }

  const effectiveHistory = resolvedContinuityMode(config);
  const previousResponseId = effectiveHistory === "stateful" ? params.previousJudgeResponseId : null;

  const deliveredNowIds = new Set<FileId>();
  const withheldReasons = new Map<FileId, string>();
  const toDeliver: JudgeApplicableFile[] = [];

  for (const file of params.applicableFiles) {
    if (config.fileDeliveryMode === "inline" && !file.bytes) {
      withheldReasons.set(file.fileId, "inline_bytes_missing");
      continue;
    }
    if (effectiveHistory === "stateful" && file.alreadyIntroduced === true) {
      continue;
    }
    if (deliveredNowIds.has(file.fileId)) {
      continue;
    }
    deliveredNowIds.add(file.fileId);
    toDeliver.push(file);
  }

  const manifest = buildManifest({
    config,
    applicableFiles: params.applicableFiles,
    deliveredNow: deliveredNowIds,
    effectiveHistory,
    withheldReasons,
  });

  const continuityAnchor =
    previousResponseId === null ? null : { previous_response_id: previousResponseId };
  const continuity =
    effectiveHistory === "stateful"
      ? reasoningContinuityPayload("stateful", continuityAnchor)
      : reasoningContinuityPayload("stateless", null);

  const instruction = buildJudgeInstruction({
    turnIndex: params.turnIndex,
    expectedTagIndex: params.turnIndex,
    maxGrade: Math.min(JUDGE_MAX_GRADE, Math.max(0, Math.trunc(config.maxGradeThreshold))),
  });

  const fileItems = buildJudgeFileContentItems({ config, files: toDeliver });

  const contextMessages: Record<string, unknown>[] = [];
  if (config.historyMode === "stateless" && config.includePrior) {
    for (const prior of params.priorAcceptedOutputs ?? []) {
      if (prior.turnIndex >= params.turnIndex) {
        continue;
      }
      contextMessages.push({
        role: "assistant",
        content: prior.deliverableText,
      });
    }
  }

  const userContent: Record<string, unknown>[] = [
    { type: "input_text", text: params.candidateText },
    ...fileItems,
  ];

  const idempotencyKey: IdempotencyKey = `${params.jobId}:j${params.turnIndex}:${params.judgeCallId}`;

  let requestObject: Record<string, unknown>;
  if (config.transport === "responses") {
    requestObject = {
      model: config.model,
      ...continuity,
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: instruction }],
        },
        ...contextMessages,
        {
          type: "message",
          role: "user",
          content: userContent,
        },
      ],
      text: { format: { type: "json_object" } },
    };
  } else {
    requestObject = {
      model: config.model,
      messages: [
        { role: "developer", content: instruction },
        ...contextMessages.map((message) => ({
          role: "assistant",
          content: message.content,
        })),
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
    };
  }

  const requestBody = JSON.stringify(requestObject);
  const requestBytes = utf8Encoder.encode(requestBody);
  if (requestBytes.byteLength > ARTIFACT_ROW_GUARD_BYTES) {
    return {
      kind: "unencodable_contract",
      reason: "artifact_guard_exceeded",
      message: `Judge request is ${requestBytes.byteLength} bytes, exceeding the ${ARTIFACT_ROW_GUARD_BYTES}-byte artifact guard`,
      manifest,
      advisoryWarnings,
    };
  }

  return {
    kind: "built",
    request: {
      transport: config.transport,
      historyMode: config.historyMode,
      fileDeliveryMode: config.fileDeliveryMode,
      idempotencyKey,
      requestBody,
      requestBytes,
      manifest,
      advisoryWarnings,
    },
  };
}

export type JudgeOutputParseResult =
  | { readonly ok: true; readonly output: ValidatedJudgeOutput }
  | {
      readonly ok: false;
      readonly reason: "empty_output" | "invalid_json" | "invalid_response_shape";
      readonly message: string;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the exact five-field judge output. Extra fields, wrong types,
 * missing fields, out-of-range grades, and empty comments are rejected before
 * any database write.
 */
export function parseJudgeOutput(rawText: string): JudgeOutputParseResult {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty_output", message: "Judge returned empty output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "invalid_json", message: "Judge output was not valid JSON" };
  }

  if (!isPlainRecord(parsed)) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: "Judge output must be a JSON object",
    };
  }

  const keys = Object.keys(parsed).sort();
  const expectedKeys = [...JUDGE_OUTPUT_FIELD_NAMES].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: `Judge output must contain exactly ${JUDGE_OUTPUT_FIELD_NAMES.join(", ")}; received ${keys.join(", ") || "(none)"}`,
    };
  }

  const verdict = parsed.verdict;
  if (verdict !== "PASS" && verdict !== "FAIL") {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: 'verdict must be "PASS" or "FAIL"',
    };
  }

  const grade = parsed.grade;
  if (typeof grade !== "number" || !Number.isInteger(grade) || grade < 0 || grade > JUDGE_MAX_GRADE) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: `grade must be an integer between 0 and ${JUDGE_MAX_GRADE}`,
    };
  }

  const comment = parsed.comment;
  if (typeof comment !== "string" || comment.trim().length === 0) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: "comment must be a non-empty string",
    };
  }

  const tagAgreement = parsed.tag_agreement;
  if (typeof tagAgreement !== "boolean") {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: "tag_agreement must be a boolean",
    };
  }

  const fileVisibility = parsed.file_visibility;
  if (typeof fileVisibility !== "boolean") {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: "file_visibility must be a boolean",
    };
  }

  return {
    ok: true,
    output: {
      verdict,
      grade,
      comment,
      tag_agreement: tagAgreement,
      file_visibility: fileVisibility,
    },
  };
}

/**
 * Extracts the judge's text payload from a provider response envelope.
 * Supports Responses output text and Chat Completions message content.
 */
export function extractJudgeRawText(
  payload: unknown,
  transport: JudgeTransport,
): string | null {
  if (!isPlainRecord(payload)) {
    return null;
  }

  if (transport === "chat_completions") {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return null;
    }
    const first = choices[0];
    if (!isPlainRecord(first) || !isPlainRecord(first.message)) {
      return null;
    }
    const content = first.message.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (isPlainRecord(part) && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
      return parts.length > 0 ? parts.join("") : null;
    }
    return null;
  }

  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }
  if (Array.isArray(payload.output)) {
    const parts: string[] = [];
    for (const item of payload.output) {
      if (!isPlainRecord(item) || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (isPlainRecord(part) && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

export interface ClassifyJudgeEvaluationParams {
  readonly judgeCallId: JudgeCallId;
  readonly parse: JudgeOutputParseResult;
  readonly manifest: readonly JudgeFileManifestEntry[];
  readonly responseId: ResponseId | null;
  readonly usage: TokenUsageRecord | null;
  readonly providerErrorMessage?: string | null;
}

/**
 * Maps a provider response into the judge evaluation outcome.
 *
 * Provider infrastructure failures and unparsable shapes produce `unknown`
 * (accept-with-warning upstream); incomplete file coverage adds an advisory
 * warning without discarding the otherwise valid result.
 */
export function classifyJudgeEvaluation(
  params: ClassifyJudgeEvaluationParams,
): JudgeEvaluationOutcome {
  if (params.providerErrorMessage !== null && params.providerErrorMessage !== undefined) {
    return {
      kind: "unknown",
      judgeCallId: params.judgeCallId,
      reason: "provider_error",
      message: params.providerErrorMessage,
      advisoryWarnings: [],
    };
  }

  if (!params.parse.ok) {
    return {
      kind: "unknown",
      judgeCallId: params.judgeCallId,
      reason: params.parse.reason === "invalid_response_shape" ? "invalid_response_shape" : "provider_error",
      message: params.parse.message,
      advisoryWarnings: [],
    };
  }

  const advisoryWarnings: string[] = [];
  const derivedCoverage = deriveFileVisibility(params.manifest);
  if (!derivedCoverage) {
    advisoryWarnings.push(
      "Judge result covers an incomplete applicable-file set; the result is accepted with a coverage warning.",
    );
  }
  if (params.parse.output.file_visibility !== derivedCoverage) {
    advisoryWarnings.push(
      "Judge-reported file_visibility disagrees with the manifest-derived coverage; the manifest governs.",
    );
  }

  return {
    kind: "evaluated",
    judgeCallId: params.judgeCallId,
    output: params.parse.output,
    responseId: params.responseId,
    advisoryWarnings,
    usage: params.usage,
  };
}