/**
 * Continuity — `src/lib/continuity.ts`
 *
 * Shared OpenAI Responses reasoning-continuity and explicit prompt-cache
 * retention payload builders per `docs/ARCHITECTURE.md` §6 and §16.
 *
 * Invariants:
 * - Dependency DAG: imports ONLY from `src/constants.ts` and `src/types.ts`.
 * - Generation and judge Responses adapters share a single canonical
 *   reasoning-continuity rule (`reasoningContinuityPayload`).
 * - Stateful continuity (`mode === "stateful"`) always includes `store: true`
 *   and attaches `previous_response_id` only when a non-empty anchor is provided.
 * - Stateless continuity (`mode === "stateless"`) returns `{ store: false }`
 *   and never sends `previous_response_id`.
 * - Cache selection (`cachePayload`) is explicit across `"30m" | "12h" | "nocache"`.
 */

import { CACHE_TTL_CHOICES } from "../constants";
import type {
  CacheTtl,
  ContinuityAnchor,
  ContinuityMode,
  JudgeHistoryMode,
  ReasoningContinuityPayload,
  ResponseId,
} from "../types";

/**
 * Extracts and normalizes a trimmed non-empty `previous_response_id` from
 * an optional `ContinuityAnchor` or raw string anchor. Returns `null` when
 * absent or whitespace-only.
 */
export function resolvePreviousResponseId(
  anchor?: ContinuityAnchor | string | null,
): ResponseId | null {
  if (anchor === null || anchor === undefined) {
    return null;
  }
  const raw =
    typeof anchor === "string" ? anchor : anchor.previous_response_id;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Builds the canonical Responses reasoning-continuity fields spread into
 * generation and judge requests (`...reasoningContinuityPayload(mode, anchor)`).
 *
 * - When `mode === "stateful"`: extracts `previousResponseId` from `anchor`.
 *   If non-empty trimmed string, returns `{ previous_response_id: previousResponseId, store: true }`;
 *   otherwise returns `{ store: true }`.
 * - When `mode === "stateless"`: returns `{ store: false, include: ["reasoning.encrypted_content"] }`
 *   (encrypted reasoning content preserves reasoning across stateless calls) and never sends
 *   `previous_response_id`.
 */
export function reasoningContinuityPayload(
  mode: ContinuityMode,
  anchor?: ContinuityAnchor | string | null,
): ReasoningContinuityPayload {
  if (mode === "stateful") {
    const previousResponseId = resolvePreviousResponseId(anchor);
    if (previousResponseId !== null) {
      return {
        previous_response_id: previousResponseId,
        store: true,
      };
    }
    return {
      store: true,
    };
  }

  return {
    store: false,
    include: ["reasoning.encrypted_content"],
  };
}

/**
 * Maps a declared `JudgeHistoryMode` (`"chained" | "stateless"`) to the
 * shared `ContinuityMode` (`"stateful" | "stateless"`).
 */
export function judgeHistoryToContinuityMode(
  historyMode: JudgeHistoryMode,
): ContinuityMode {
  return historyMode === "chained" ? "stateful" : "stateless";
}

/**
 * Type guard verifying whether an arbitrary string is a valid `CacheTtl` choice.
 */
export function isCacheTtl(value: string): value is CacheTtl {
  return (CACHE_TTL_CHOICES as readonly string[]).includes(value);
}

/**
 * Maps explicit cache selection (`"30m" | "12h" | "nocache"`) to the
 * canonical request payload fields (`...cachePayload(job.cache_ttl)` per §6).
 *
 * Uses the current Responses `prompt_cache_options` object. `30m`/`12h`
 * select the minimum cache lifetime; `nocache` selects explicit mode with no
 * breakpoints, which disables prompt caching. The deprecated
 * `prompt_cache_retention` field only accepts `in_memory`/`24h` and is never
 * emitted.
 */
export function cachePayload(
  cacheTtl: CacheTtl,
): Readonly<Record<string, unknown>> {
  if (cacheTtl === "nocache") {
    return {
      prompt_cache_options: { mode: "explicit" },
    };
  }
  return {
    prompt_cache_options: { ttl: cacheTtl },
  };
}
