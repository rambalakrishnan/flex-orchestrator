/**
 * Generation — `src/lib/dispatch.ts`
 *
 * Canonical generation request construction, dispatch classification, and
 * persisted capacity backoff per `docs/ARCHITECTURE.md` §6 and
 * `docs/TESTING.md` items 7 and 10.
 *
 * Invariants:
 * - The exact UTF-8 bytes produced here are what an attempt stores and sends.
 * - Authorization headers are resolved at call time and never part of the body.
 * - `background: true` and `service_tier: "flex"` are always present; there is no
 *   standard-tier fallback.
 * - Continuity and cache fields come from the shared helpers in
 *   `src/lib/continuity.ts`; this module never re-implements that rule.
 * - Turn indices are strictly 1-based integers; request builders reject
 *   anything else with a `RangeError`.
 * - Flex capacity allows at most five sends per attempt with persisted
 *   exponential backoff; ambiguous dispatches pause for a fresh attempt/key.
 */

import {
  FLEX_CAPACITY_BACKOFF_BASE_MS,
  FLEX_CAPACITY_BACKOFF_MAX_MS,
  GENERATION_SERVICE_TIER,
  MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT,
} from "../constants.ts";
import type {
  CacheTtl,
  ContinuityAnchor,
  DispatchOutcome,
  FileId,
  IdempotencyKey,
  JobId,
  ReasoningEffort,
  ResponseId,
  TurnIndex,
} from "../types.ts";
import { cachePayload, reasoningContinuityPayload } from "./continuity.ts";
import { assertTurnIndex } from "./guards.ts";

/** Canonical terminal completion marker for a given turn index. */
export const COMPLETION_MARKER_FORMAT = "<!-- TURN_END:{turnIndex} -->";

/**
 * Developer instruction placed inside `input` (never the deprecated
 * top-level `instructions` field).
 *
 * The model signals only completion. Provider token caps surface as an
 * incomplete response (`capped`) and are continued by the orchestrator with a
 * new attempt; there is no intermediate pause marker.
 */
export function buildDeveloperInstruction(turnIndex: TurnIndex): string {
  const complete = COMPLETION_MARKER_FORMAT.replace("{turnIndex}", String(turnIndex));
  return [
    `You are producing turn ${turnIndex} of a sequential writing job.`,
    "Return only the deliverable text for this turn.",
    `When the turn is complete, end your output with ${complete}.`,
    "Emit no other marker.",
  ].join(" ");
}

/** Instruction appended for continuation attempts within the same turn. */
export function buildContinuationInstruction(turnIndex: TurnIndex): string {
  return [
    `Continue turn ${turnIndex} from exactly where the previous response stopped.`,
    "Do not repeat earlier text or restate the prompt.",
    `End with ${COMPLETION_MARKER_FORMAT.replace("{turnIndex}", String(turnIndex))} when the turn is complete.`,
  ].join(" ");
}

export type GenerationAttemptKind = "initial" | "continuation" | "auto_retry" | "manual_retry";

/** A prior accepted turn supplied as context for a fresh (unanchored) request. */
export interface PriorAcceptedTurn {
  readonly turnIndex: TurnIndex;
  readonly deliverableText: string;
  readonly attachmentFileIds: readonly FileId[];
}

export interface BuildGenerationInputParams {
  readonly turnIndex: TurnIndex;
  readonly promptText: string;
  readonly attachmentFileIds: readonly FileId[];
  readonly attemptKind: GenerationAttemptKind;
  readonly previousResponseId: ResponseId | null;
  readonly priorAcceptedTurns?: readonly PriorAcceptedTurn[];
  /** Job developer context placed in the developer message after the instruction. */
  readonly developerPrompt?: string;
  /** Developer files attached to that same developer message on every attempt. */
  readonly developerFileIds?: readonly FileId[];
}

export type GenerationInputItem = Readonly<Record<string, unknown>>;

/**
 * Builds the canonical Responses `input` array.
 *
 * - Developer instruction is a `developer` message inside `input`; the job
 *   developer prompt and developer files are appended to that same message
 *   (instruction first, then the prompt block, then one `input_file` item per
 *   deduplicated developer file ID).
 * - Prior accepted turns are replayed as `assistant` messages only when the
 *   request is unanchored (`previousResponseId === null`); an anchored request
 *   inherits that context through `previous_response_id`.
 * - The current turn is one `user` message containing its prompt text followed
 *   by one `input_file` content item per attached file ID. Turn attachments
 *   never merge with the developer files.
 * - Continuation attempts append a continuation directive to that user message
 *   instead of restating the prompt.
 */
export function buildGenerationInput(
  params: BuildGenerationInputParams,
): readonly GenerationInputItem[] {
  assertTurnIndex(params.turnIndex, "buildGenerationInput");

  const developerContent: Record<string, unknown>[] = [
    { type: "input_text", text: buildDeveloperInstruction(params.turnIndex) },
  ];

  const developerPrompt = params.developerPrompt;
  if (developerPrompt !== undefined && developerPrompt.trim().length > 0) {
    developerContent.push({ type: "input_text", text: developerPrompt });
  }

  const seenDeveloperFileIds = new Set<FileId>();
  for (const fileId of params.developerFileIds ?? []) {
    if (fileId.length === 0 || seenDeveloperFileIds.has(fileId)) {
      continue;
    }
    seenDeveloperFileIds.add(fileId);
    developerContent.push({ type: "input_file", file_id: fileId });
  }

  const items: GenerationInputItem[] = [
    {
      type: "message",
      role: "developer",
      content: developerContent,
    },
  ];

  if (params.previousResponseId === null && params.priorAcceptedTurns) {
    for (const prior of params.priorAcceptedTurns) {
      if (prior.turnIndex >= params.turnIndex) {
        continue;
      }
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: prior.deliverableText }],
      });
    }
  }

  const userContent: Record<string, unknown>[] = [
    {
      type: "input_text",
      text:
        params.attemptKind === "continuation"
          ? buildContinuationInstruction(params.turnIndex)
          : params.promptText,
    },
  ];

  const seenFileIds = new Set<FileId>();
  for (const fileId of params.attachmentFileIds) {
    if (fileId.length === 0 || seenFileIds.has(fileId)) {
      continue;
    }
    seenFileIds.add(fileId);
    userContent.push({ type: "input_file", file_id: fileId });
  }

  items.push({ type: "message", role: "user", content: userContent });
  return items;
}

export interface CanonicalGenerationRequestParams {
  readonly jobId: JobId;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxOutputTokens: number;
  readonly cacheTtl: CacheTtl;
  readonly webSearch: boolean;
  readonly turnIndex: TurnIndex;
  readonly attemptNumber: number;
  readonly continuationIndex: number;
  readonly attemptKind: GenerationAttemptKind;
  readonly promptText: string;
  readonly attachmentFileIds: readonly FileId[];
  readonly previousResponseId: ResponseId | null;
  readonly priorAcceptedTurns?: readonly PriorAcceptedTurn[];
  readonly developerPrompt?: string;
  readonly developerFileIds?: readonly FileId[];
}

export interface CanonicalGenerationRequest {
  readonly idempotencyKey: IdempotencyKey;
  readonly requestBody: string;
  readonly requestBytes: Uint8Array;
  readonly inputItems: readonly GenerationInputItem[];
}

const utf8Encoder = new TextEncoder();

/**
 * Builds a stable idempotency key from job, turn, attempt, and continuation
 * indices. Retries of the same attempt reuse the key; a new attempt index
 * produces a new key.
 */
export function buildGenerationIdempotencyKey(params: {
  readonly jobId: JobId;
  readonly turnIndex: TurnIndex;
  readonly attemptNumber: number;
  readonly continuationIndex: number;
}): IdempotencyKey {
  return `${params.jobId}:t${params.turnIndex}:a${params.attemptNumber}:c${params.continuationIndex}`;
}

/**
 * Produces the canonical §6 generation request object, its exact serialized
 * UTF-8 body, and the stable idempotency key.
 */
export function buildCanonicalGenerationRequest(
  params: CanonicalGenerationRequestParams,
): CanonicalGenerationRequest {
  assertTurnIndex(params.turnIndex, "buildCanonicalGenerationRequest");

  const anchor: ContinuityAnchor | null =
    params.previousResponseId === null
      ? null
      : { previous_response_id: params.previousResponseId };

  const inputItems = buildGenerationInput({
    turnIndex: params.turnIndex,
    promptText: params.promptText,
    attachmentFileIds: params.attachmentFileIds,
    attemptKind: params.attemptKind,
    previousResponseId: params.previousResponseId,
    priorAcceptedTurns: params.priorAcceptedTurns,
    developerPrompt: params.developerPrompt,
    developerFileIds: params.developerFileIds,
  });

  const requestObject: Record<string, unknown> = {
    model: params.model,
    background: true,
    service_tier: GENERATION_SERVICE_TIER,
    ...reasoningContinuityPayload("stateful", anchor),
    reasoning: { effort: params.reasoningEffort },
    max_output_tokens: params.maxOutputTokens,
    ...cachePayload(params.cacheTtl),
    ...(params.webSearch ? { tools: [{ type: "web_search" }] } : {}),
    input: inputItems,
  };

  const requestBody = JSON.stringify(requestObject);
  return {
    idempotencyKey: buildGenerationIdempotencyKey({
      jobId: params.jobId,
      turnIndex: params.turnIndex,
      attemptNumber: params.attemptNumber,
      continuationIndex: params.continuationIndex,
    }),
    requestBody,
    requestBytes: utf8Encoder.encode(requestBody),
    inputItems,
  };
}

/**
 * Computes the persisted exponential backoff for the next Flex capacity send.
 *
 * `sendsCompleted` is the number of sends already made for the attempt.
 * Returns `null` once the five-send budget is exhausted.
 */
export function computeCapacityBackoffMs(sendsCompleted: number): number | null {
  if (!Number.isFinite(sendsCompleted)) {
    return null;
  }
  const completed = Math.max(0, Math.trunc(sendsCompleted));
  if (completed >= MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT) {
    return null;
  }
  const delay = FLEX_CAPACITY_BACKOFF_BASE_MS * 2 ** completed;
  return Math.min(delay, FLEX_CAPACITY_BACKOFF_MAX_MS);
}

/** Additional deferral requested by the provider, bounded below by our backoff. */
export function applyRetryAfter(
  backoffMs: number | null,
  retryAfterMs: number | null,
): number | null {
  if (backoffMs === null) {
    return null;
  }
  if (retryAfterMs === null || retryAfterMs < 0 || !Number.isFinite(retryAfterMs)) {
    return backoffMs;
  }
  return Math.max(backoffMs, retryAfterMs);
}

export type DispatchDecision =
  | {
      readonly kind: "dispatched";
      readonly responseId: ResponseId;
      readonly status: "queued" | "in_progress" | "completed";
    }
  | {
      readonly kind: "retry_capacity";
      readonly sendNumber: number;
      readonly sendsCompleted: number;
      readonly delayMs: number;
      readonly dueAtMs: number;
      readonly message: string;
    }
  | {
      readonly kind: "capacity_exhausted";
      readonly sends: number;
      readonly message: string;
    }
  | {
      readonly kind: "ambiguous_dispatch";
      readonly reason: "network_error" | "timeout" | "unparseable_response" | "server_5xx";
      readonly message: string;
    }
  | {
      readonly kind: "terminal_error";
      readonly statusCode: number;
      readonly errorCode: string | null;
      readonly message: string;
    };

export interface ClassifyDispatchParams {
  readonly outcome: DispatchOutcome;
  /** Sends already completed for this attempt *before* this outcome. */
  readonly sendsCompleted: number;
  readonly nowMs: number;
}

/**
 * Maps a ProviderIO dispatch outcome onto the attempt state machine.
 *
 * Capacity unavailability consumes a send from the five-send budget and yields
 * a persisted retry deadline; a fifth capacity failure exhausts the budget and
 * the caller pauses for manual recovery. Ambiguous dispatches never retry the
 * same attempt/key automatically.
 */
export function classifyDispatchResult(params: ClassifyDispatchParams): DispatchDecision {
  const outcome = params.outcome;
  const sendsCompleted = Math.max(0, Math.trunc(params.sendsCompleted));

  switch (outcome.kind) {
    case "dispatched":
      return {
        kind: "dispatched",
        responseId: outcome.responseId,
        status: outcome.status,
      };

    case "capacity_unavailable": {
      const sends = sendsCompleted + 1;
      if (sends >= MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT) {
        return {
          kind: "capacity_exhausted",
          sends,
          message: outcome.message,
        };
      }
      const delayMs = applyRetryAfter(
        computeCapacityBackoffMs(sends),
        outcome.retryAfterMs,
      ) as number;
      return {
        kind: "retry_capacity",
        sendNumber: sends + 1,
        sendsCompleted: sends,
        delayMs,
        dueAtMs: params.nowMs + delayMs,
        message: outcome.message,
      };
    }

    case "ambiguous_dispatch":
      return {
        kind: "ambiguous_dispatch",
        reason: outcome.reason,
        message: outcome.message,
      };

    case "terminal_error":
      return {
        kind: "terminal_error",
        statusCode: outcome.statusCode,
        errorCode: outcome.errorCode,
        message: outcome.message,
      };
  }
}