// Deterministic fixtures for canonical generation requests (`docs/TESTING.md` items 7 and 8).
//
// Fixtures only describe `CanonicalGenerationRequestParams` inputs plus small
// parsing helpers. Tests always build the request through
// `buildCanonicalGenerationRequest` so byte-level assertions run against the
// real serializer instead of a fixture-local reimplementation of it.

import type {
  CanonicalGenerationRequestParams,
  PriorAcceptedTurn,
} from "../../src/lib/dispatch.ts";
import type { CacheTtl, FileId, ReasoningEffort } from "../../src/types.ts";

/** Job identifier shared by every generation-request fixture. */
export const BASE_JOB_ID = "job_1";

/** Generation model used by default fixtures. */
export const BASE_MODEL = "gpt-5";

/** Reasoning effort used by default fixtures. */
export const BASE_REASONING_EFFORT: ReasoningEffort = "medium";

/** Output-token ceiling used by default fixtures. */
export const BASE_MAX_OUTPUT_TOKENS = 32_768;

/** Explicit cache selection used by default fixtures. */
export const BASE_CACHE_TTL: CacheTtl = "12h";

/** Turn index used by default fixtures. */
export const BASE_TURN_INDEX = 1;

/** Prompt text used by default fixtures. */
export const BASE_PROMPT_TEXT =
  "Write the opening paragraph of a story about a lighthouse keeper who finds a message in a bottle.";

/** Stateful continuity anchor used by anchored fixtures. */
export const ANCHOR_RESPONSE_ID = "resp_anchor_turn1";

/** Attachment file IDs used by the file-attachment fixture. */
export const CANONICAL_ATTACHMENT_FILE_IDS: readonly FileId[] = [
  "file_lighthouse_map",
  "file_harbor_log",
];

/** Prior accepted turns replayed into unanchored requests. */
export const PRIOR_ACCEPTED_TURNS: readonly PriorAcceptedTurn[] = [
  {
    turnIndex: 0,
    deliverableText: "Accepted turn 0: the keeper opens the bottle.",
    attachmentFileIds: [],
  },
  {
    turnIndex: 1,
    deliverableText: "Accepted turn 1: the message names a sunken ship.",
    attachmentFileIds: ["file_lighthouse_map"],
  },
];

/** Builds the canonical generation-request params every fixture derives from. */
export function baseGenerationRequestParams(
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return {
    jobId: BASE_JOB_ID,
    model: BASE_MODEL,
    reasoningEffort: BASE_REASONING_EFFORT,
    maxOutputTokens: BASE_MAX_OUTPUT_TOKENS,
    cacheTtl: BASE_CACHE_TTL,
    webSearch: false,
    turnIndex: BASE_TURN_INDEX,
    attemptNumber: 1,
    continuationIndex: 0,
    attemptKind: "initial",
    promptText: BASE_PROMPT_TEXT,
    attachmentFileIds: [],
    previousResponseId: null,
    ...overrides,
  };
}

/** Stateful, anchored request params (`previous_response_id` present). */
export function anchoredGenerationRequestParams(
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return baseGenerationRequestParams({
    previousResponseId: ANCHOR_RESPONSE_ID,
    ...overrides,
  });
}

/** Request params with the web-search tool enabled. */
export function webSearchGenerationRequestParams(
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return baseGenerationRequestParams({ webSearch: true, ...overrides });
}

/** Request params for one explicit cache selection. */
export function cacheGenerationRequestParams(
  cacheTtl: CacheTtl,
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return baseGenerationRequestParams({ cacheTtl, ...overrides });
}

/** Continuation-attempt params inside the same turn (chained from the anchor). */
export function continuationGenerationRequestParams(
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return baseGenerationRequestParams({
    attemptKind: "continuation",
    continuationIndex: 1,
    previousResponseId: ANCHOR_RESPONSE_ID,
    ...overrides,
  });
}

/** Unanchored params that replay prior accepted turns as assistant messages. */
export function priorAcceptedTurnsGenerationRequestParams(
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return baseGenerationRequestParams({
    turnIndex: 2,
    previousResponseId: null,
    priorAcceptedTurns: PRIOR_ACCEPTED_TURNS,
    ...overrides,
  });
}

/** Params attaching the supplied file IDs (callers may pass duplicates). */
export function fileAttachmentGenerationRequestParams(
  fileIds: readonly FileId[],
  overrides: Partial<CanonicalGenerationRequestParams> = {},
): CanonicalGenerationRequestParams {
  return baseGenerationRequestParams({ attachmentFileIds: fileIds, ...overrides });
}

/**
 * Parses a serialized canonical request body for structural assertions.
 * Byte-fidelity assertions must use `requestBytes` (or the raw `requestBody`
 * string) instead of this helper.
 */
export function parseBody(requestBody: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(requestBody);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "Canonical generation request body must serialize to a JSON object.",
    );
  }
  return parsed as Record<string, unknown>;
}