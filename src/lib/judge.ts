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
  JudgeVerdict,
  ResponseId,
  TokenUsageRecord,
  TurnIndex,
  ValidatedJudgeOutput,
} from "../types.ts";
import { judgeHistoryToContinuityMode, reasoningContinuityPayload } from "./continuity.ts";

/** Exact five accepted judge output fields in the current wire shape. */
export const JUDGE_OUTPUT_FIELD_NAMES = [
  "verdict",
  "grade",
  "comment",
  "tag_matches_expected_step",
  "file_visibility",
] as const;

/** Legacy tag-agreement key accepted from previously prompted judge models. */
export const JUDGE_LEGACY_TAG_FIELD_NAME = "tag_agreement";

/** Marker emitted by Chat Completions providers that support JSON mode. */
export const JUDGE_MAX_GRADE = 100;

/** Letter grades normalized to the numeric 0-100 scale. */
const JUDGE_LETTER_GRADES: Readonly<Record<string, number>> = {
  A: 95,
  B: 85,
  C: 75,
  D: 65,
  F: 50,
};

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
  /** Verbatim turn-end marker bytes observed by the structural classifier, or null when none was recorded. */
  readonly observedTag: string | null;
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
const utf8StrictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

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
  readonly observedTag: string | null;
}): string {
  const tagEvidence =
    params.observedTag === null
      ? "No turn-end marker was recorded for this candidate; report \"tag_matches_expected_step\" as false."
      : `The turn-end marker observed on this candidate was: ${params.observedTag} Report "tag_matches_expected_step" as true only if that quoted marker is exactly <!-- TURN_END:${params.expectedTagIndex} -->.`;
  return `Evaluate the candidate deliverable for the declared turn. Expected turn index: ${params.expectedTagIndex}. ${tagEvidence} Reply with a single JSON object containing exactly these five fields: "verdict" ("YES" or "NO"), "grade" ("A", "B", "C", "D", or "F"), "comment" (non-empty string), "tag_matches_expected_step" (boolean), "file_visibility" (boolean). Do not include any other fields, prose, or markdown fences.`;
}

function buildManifest(params: {
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
 * Encodes inline files for Chat Completions, which has no file-reference
 * mechanism: each file becomes a fenced text part. Files without bytes or
 * with non-UTF-8 bytes cannot be represented faithfully and are reported
 * back for manifest withholding instead of being mangled or dropped
 * silently.
 */
function buildChatFileContentItems(params: {
  readonly files: readonly JudgeApplicableFile[];
}): {
  readonly items: readonly Record<string, unknown>[];
  readonly withheldReasons: ReadonlyMap<FileId, string>;
} {
  const items: Record<string, unknown>[] = [];
  const withheldReasons = new Map<FileId, string>();
  for (const file of params.files) {
    const bytes = file.bytes
      ? file.bytes instanceof Uint8Array
        ? file.bytes
        : new Uint8Array(file.bytes)
      : null;
    if (bytes === null) {
      withheldReasons.set(file.fileId, "inline_bytes_missing");
      continue;
    }
    let text: string;
    try {
      text = utf8StrictDecoder.decode(bytes);
    } catch {
      withheldReasons.set(file.fileId, "inline_bytes_not_utf8");
      continue;
    }
    items.push({
      type: "text",
      text: `<file name="${file.filename}">\n${text}\n</file>`,
    });
  }
  return { items, withheldReasons };
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

  const continuityAnchor =
    previousResponseId === null ? null : { previous_response_id: previousResponseId };
  const continuity =
    effectiveHistory === "stateful"
      ? reasoningContinuityPayload("stateful", continuityAnchor)
      : reasoningContinuityPayload("stateless", null);

  const generatedInstruction = buildJudgeInstruction({
    turnIndex: params.turnIndex,
    expectedTagIndex: params.turnIndex,
    observedTag: params.observedTag,
  });
  const trimmedDeveloperPrompt = config.developerPrompt.trim();
  const instruction =
    trimmedDeveloperPrompt.length > 0
      ? `${trimmedDeveloperPrompt}\n\n${generatedInstruction}`
      : generatedInstruction;

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

  const manifestBase = {
    applicableFiles: params.applicableFiles,
    effectiveHistory,
  };

  let fileItems: readonly Record<string, unknown>[];
  let userContent: Record<string, unknown>[];
  let manifest: readonly JudgeFileManifestEntry[];
  if (config.transport === "chat_completions") {
    const chatFiles = buildChatFileContentItems({ files: toDeliver });
    for (const [fileId, reason] of chatFiles.withheldReasons) {
      withheldReasons.set(fileId, reason);
      deliveredNowIds.delete(fileId);
    }
    fileItems = chatFiles.items;
    userContent = [{ type: "text", text: params.candidateText }, ...fileItems];
    manifest = buildManifest({
      ...manifestBase,
      deliveredNow: deliveredNowIds,
      withheldReasons,
    });
  } else {
    fileItems = buildJudgeFileContentItems({ config, files: toDeliver });
    userContent = [{ type: "input_text", text: params.candidateText }, ...fileItems];
    manifest = buildManifest({
      ...manifestBase,
      deliveredNow: deliveredNowIds,
      withheldReasons,
    });
  }

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

/**
 * Maps an unencodable judge request contract onto an explicit `unknown`
 * evaluation outcome, so no caller falls through to a stripped request.
 */
export function judgeBuildFailureOutcome(params: {
  readonly judgeCallId: JudgeCallId | null;
  readonly outcome: Extract<JudgeRequestBuildOutcome, { readonly kind: "unencodable_contract" }>;
}): JudgeEvaluationOutcome {
  return {
    kind: "unknown",
    judgeCallId: params.judgeCallId,
    reason:
      params.outcome.reason === "artifact_guard_exceeded"
        ? "artifact_guard_exceeded"
        : "unencodable_contract",
    message: params.outcome.message,
    advisoryWarnings: params.outcome.advisoryWarnings,
  };
}

/**
 * Maps a missing or empty judge secret binding onto an explicit `unknown`
 * evaluation outcome without touching the declared request contract.
 */
export function judgeMissingSecretOutcome(params: {
  readonly judgeCallId: JudgeCallId | null;
  readonly secretName: string;
}): JudgeEvaluationOutcome {
  return {
    kind: "unknown",
    judgeCallId: params.judgeCallId,
    reason: "missing_secret",
    message: `Judge secret binding is missing or empty: ${params.secretName}`,
    advisoryWarnings: [],
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

/** Accepts PASS/FAIL or YES/NO case-insensitively and normalizes to PASS/FAIL. */
function normalizeVerdict(value: unknown): JudgeVerdict | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.toUpperCase()) {
    case "PASS":
    case "YES":
      return "PASS";
    case "FAIL":
    case "NO":
      return "FAIL";
    default:
      return null;
  }
}

/**
 * Accepts an integer 0-100 or a letter A-F case-insensitively and normalizes
 * to the numeric 0-100 scale (A=95, B=85, C=75, D=65, F=50).
 */
function normalizeGrade(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > JUDGE_MAX_GRADE) {
      return null;
    }
    return value;
  }
  if (typeof value === "string") {
    const mapped = JUDGE_LETTER_GRADES[value.toUpperCase()];
    return mapped === undefined ? null : mapped;
  }
  return null;
}

/**
 * Validates the exact five-field judge output. The tag-agreement field accepts
 * the current `tag_matches_expected_step` key or the legacy `tag_agreement`
 * key. Verdicts normalize from YES/NO or PASS/FAIL, letter grades normalize to
 * the numeric 0-100 scale, and extra fields, wrong types, missing fields,
 * out-of-range grades, and empty comments are rejected before any database
 * write.
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
  const allowedKeys: ReadonlySet<string> = new Set<string>([
    ...JUDGE_OUTPUT_FIELD_NAMES,
    JUDGE_LEGACY_TAG_FIELD_NAME,
  ]);
  const hasCurrentTagKey = Object.prototype.hasOwnProperty.call(
    parsed,
    "tag_matches_expected_step",
  );
  const hasLegacyTagKey = Object.prototype.hasOwnProperty.call(
    parsed,
    JUDGE_LEGACY_TAG_FIELD_NAME,
  );

  if (
    keys.length !== JUDGE_OUTPUT_FIELD_NAMES.length ||
    !keys.every((key) => allowedKeys.has(key)) ||
    hasCurrentTagKey === hasLegacyTagKey
  ) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: `Judge output must contain exactly five fields: verdict, grade, comment, tag_matches_expected_step (or legacy tag_agreement), file_visibility; received ${keys.join(", ") || "(none)"}`,
    };
  }

  const verdict = normalizeVerdict(parsed.verdict);
  if (verdict === null) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: 'verdict must be "PASS"/"FAIL" or "YES"/"NO"',
    };
  }

  const grade = normalizeGrade(parsed.grade);
  if (grade === null) {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: `grade must be an integer between 0 and ${JUDGE_MAX_GRADE}, or one of the letters A, B, C, D, F`,
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

  const tagAgreement = Object.prototype.hasOwnProperty.call(
    parsed,
    "tag_matches_expected_step",
  )
    ? parsed.tag_matches_expected_step
    : parsed[JUDGE_LEGACY_TAG_FIELD_NAME];
  if (typeof tagAgreement !== "boolean") {
    return {
      ok: false,
      reason: "invalid_response_shape",
      message: "tag_matches_expected_step (or legacy tag_agreement) must be a boolean",
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

  return {
    kind: "evaluated",
    judgeCallId: params.judgeCallId,
    output: params.parse.output,
    responseId: params.responseId,
    advisoryWarnings,
    usage: params.usage,
  };
}