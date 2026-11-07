/**
 * Tags — `src/lib/tag.ts`
 *
 * Deliverable text normalization, completion tag formatting, and structural
 * classification per docs/ARCHITECTURE.md (§7) and src/types.ts.
 *
 * Canonical completion dialect (HTML comments, positive 1-based turn indices):
 * - terminal marker: `<!-- TURN_END:n -->`
 * There is no intermediate pause marker: output that hits a provider token cap
 * is reported as an incomplete/capped response and continued by the orchestrator.
 *
 * Key invariants:
 * 1. Dependency DAG: imports from `src/constants.ts`, `src/types.ts`, and the
 *    pure `src/lib/guards.ts` turn-index validator.
 * 2. Structural acceptance requires non-empty retained deliverable text.
 *    Output that becomes empty after normalization and marker removal is
 *    `empty_output` (`"empty"`, `"whitespace_only"`, or `"marker_only"`), even
 *    when a syntactically valid completion marker is present. An apparent
 *    valid completion marker never makes an empty candidate judgeable.
 * 3. Precedence is fixed: provider failure, cancellation, incomplete provider
 *    responses, and refusal handling take precedence over tag parsing, and
 *    `empty_output` never reaches the judge.
 * 4. Malformed or conflicting markers return `malformed_tag`; missing markers
 *    return `missing_tag`; mismatched turn indices return `wrong_index`; text
 *    after a valid marker returns `trailing_content` (the trailing bytes are
 *    retained for diagnostics but never become the deliverable).
 */

import { assertTurnIndex } from "./guards.ts";
import type {
  AttemptStatus,
  StructuralClassification,
  TurnIndex,
  TurnStatus,
} from "../types.ts";

/** Provider-reported terminal status for a generation response. */
export type CandidateProviderStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

/** Parameters accepted by `classifyCandidateOutput` and `classifyCandidateOutcome`. */
export interface ClassifyCandidateOutputParams {
  readonly rawOutputText: string | null | undefined;
  readonly expectedTurnIndex: TurnIndex;
  readonly providerStatus?: CandidateProviderStatus;
  readonly refusalText?: string | null;
}

interface ParsedValidMarker {
  readonly status: "valid";
  readonly turnIndex: TurnIndex;
  readonly rawTag: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

interface ParsedMalformedMarker {
  readonly status: "malformed";
  readonly reason: string;
  readonly rawTag: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

type ParsedMarkerOccurrence = ParsedValidMarker | ParsedMalformedMarker;

/** Full classification produced by `classifyCandidateOutput`. */
export type CandidateClassification = StructuralClassification;

/** Structural status assigned to a classified candidate. */
export type CandidateOutcomeStatus =
  | "valid"
  | "trailing_content"
  | "empty_output"
  | "missing_tag"
  | "wrong_index"
  | "malformed_tag"
  | "refusal"
  | "incomplete"
  | "provider_failed"
  | "cancelled";

/** Unified adapter result consumed by JobDO orchestration. */
export interface CandidateOutcome {
  readonly classification: CandidateClassification;
  readonly structuralStatus: CandidateOutcomeStatus;
  readonly turnStatus: TurnStatus;
  readonly attemptStatus: AttemptStatus;
  readonly judgeRequired: boolean;
  readonly warnings: readonly string[];
}

/** Warning emitted when deliverable text follows a valid completion marker. */
export const TRAILING_CONTENT_WARNING = "trailing_content_truncated";

/**
 * Matches the opening of a canonical turn marker comment, including
 * unclosed and unknown `TURN_*` markers, so malformed markers are reported
 * instead of silently leaking into the deliverable.
 */
const TURN_MARKER_START_PATTERN = /<!--\s*TURN_/gi;

/**
 * Marker body pattern: ` TURN_END:n ` with optional whitespace around the colon.
 * Unknown `TURN_*` bodies (including the retired `TURN_CONTINUE`) are malformed.
 */
const TURN_MARKER_BODY_PATTERN = /^\s*TURN_END\s*:\s*(\S+)\s*$/i;

/**
 * Formats the canonical terminal completion marker for `turnIndex`:
 * `<!-- TURN_END:${turnIndex} -->`.
 */
export function formatCompletionTag(turnIndex: TurnIndex): string {
  return `<!-- TURN_END:${turnIndex} -->`;
}

/**
 * Normalizes raw deliverable text:
 * 1. Normalizes CRLF (`\r\n`) and CR (`\r`) line endings to LF (`\n`).
 * 2. Strips trailing horizontal whitespace (`[ \t]+`) from every line.
 * 3. Trims leading and trailing blank lines (lines that are empty after step 2).
 */
export function normalizeDeliverableText(rawText: string): string {
  if (rawText.length === 0) {
    return "";
  }

  const lfText = rawText.replace(/\r\n?/g, "\n");
  const lines = lfText.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined) {
      lines[i] = line.replace(/[ \t]+$/g, "");
    }
  }

  let firstNonBlank = 0;
  while (firstNonBlank < lines.length && lines[firstNonBlank] === "") {
    firstNonBlank += 1;
  }

  if (firstNonBlank === lines.length) {
    return "";
  }

  let lastNonBlank = lines.length - 1;
  while (lastNonBlank > firstNonBlank && lines[lastNonBlank] === "") {
    lastNonBlank -= 1;
  }

  return lines.slice(firstNonBlank, lastNonBlank + 1).join("\n");
}

/**
 * Parses a strict positive integer turn index (`1`, `2`, ...). Returns `null`
 * for empty values, non-digits, negative/zero values, and values exceeding
 * `Number.MAX_SAFE_INTEGER`.
 */
function parsePositiveTurnIndex(rawValue: string): TurnIndex | null {
  if (!/^\d+$/.test(rawValue)) {
    return null;
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}

/**
 * Classifies one raw marker comment as valid or malformed with an explicit
 * diagnostic reason.
 */
function parseMarkerCandidate(
  rawTag: string,
  startIndex: number,
  endIndex: number,
): ParsedMarkerOccurrence {
  const body = rawTag.slice(4, rawTag.length - 3);
  const bodyMatch = TURN_MARKER_BODY_PATTERN.exec(body);
  if (bodyMatch === null) {
    return {
      status: "malformed",
      reason: `Malformed turn marker: ${rawTag}`,
      rawTag,
      startIndex,
      endIndex,
    };
  }

  const turnIndex = parsePositiveTurnIndex(bodyMatch[1] ?? "");
  if (turnIndex === null) {
    return {
      status: "malformed",
      reason: `Invalid positive integer turn index in marker: ${rawTag}`,
      rawTag,
      startIndex,
      endIndex,
    };
  }

  return {
    status: "valid",
    turnIndex,
    rawTag,
    startIndex,
    endIndex,
  };
}

/**
 * Scans `text` for all canonical turn marker comments (valid, malformed, or
 * unclosed) in document order.
 */
function scanMarkerOccurrences(text: string): ParsedMarkerOccurrence[] {
  const occurrences: ParsedMarkerOccurrence[] = [];

  TURN_MARKER_START_PATTERN.lastIndex = 0;
  let match = TURN_MARKER_START_PATTERN.exec(text);
  while (match !== null) {
    const startIndex = match.index;
    const contentStart = startIndex + match[0].length;
    const closeIndex = text.indexOf("-->", contentStart);

    if (closeIndex === -1) {
      const rawTag = text.slice(startIndex);
      occurrences.push({
        status: "malformed",
        reason: `Unclosed turn marker: ${rawTag}`,
        rawTag,
        startIndex,
        endIndex: text.length,
      });
      break;
    }

    const endIndex = closeIndex + 3;
    occurrences.push(
      parseMarkerCandidate(text.slice(startIndex, endIndex), startIndex, endIndex),
    );

    TURN_MARKER_START_PATTERN.lastIndex = endIndex;
    match = TURN_MARKER_START_PATTERN.exec(text);
  }

  return occurrences;
}

/**
 * Removes every marker occurrence from `text`, joining the remaining pieces.
 */
function stripMarkerOccurrences(
  text: string,
  occurrences: readonly ParsedMarkerOccurrence[],
): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const occurrence of occurrences) {
    if (occurrence.startIndex > cursor) {
      pieces.push(text.slice(cursor, occurrence.startIndex));
    }
    cursor = occurrence.endIndex;
  }
  if (cursor < text.length) {
    pieces.push(text.slice(cursor));
  }
  return pieces.join("");
}

/**
 * Performs structural classification on a candidate generation output per §7,
 * with fixed precedence: provider failure, cancellation, incomplete provider
 * responses, and refusal handling all take precedence over marker parsing.
 *
 * Marker dialect: `<!-- TURN_END:n -->` for positive integer `n`. Any other
 * `TURN_*` marker body (including the retired `TURN_CONTINUE`) is malformed.
 */
export function classifyCandidateOutput(
  params: ClassifyCandidateOutputParams,
): CandidateClassification {
  const { expectedTurnIndex, providerStatus, rawOutputText, refusalText } = params;

  if (providerStatus === "failed") {
    return { kind: "provider_failed" };
  }
  if (providerStatus === "cancelled") {
    return { kind: "cancelled" };
  }
  if (providerStatus === "incomplete") {
    return { kind: "incomplete" };
  }

  const trimmedRefusal = refusalText?.trim() ?? "";
  if (trimmedRefusal.length > 0) {
    return { kind: "refusal", refusalText: trimmedRefusal };
  }

  if (
    rawOutputText === null ||
    rawOutputText === undefined ||
    rawOutputText.length === 0
  ) {
    return { kind: "empty_output", reason: "empty" };
  }

  if (rawOutputText.trim().length === 0) {
    return { kind: "empty_output", reason: "whitespace_only" };
  }

  const occurrences = scanMarkerOccurrences(rawOutputText);

  if (occurrences.length === 0) {
    return {
      kind: "missing_tag",
      normalizedText: normalizeDeliverableText(rawOutputText),
    };
  }

  const malformedOccurrence = occurrences.find(
    (occurrence): occurrence is ParsedMalformedMarker =>
      occurrence.status === "malformed",
  );
  if (malformedOccurrence !== undefined) {
    return {
      kind: "malformed_tag",
      reason: malformedOccurrence.reason,
      normalizedText: normalizeDeliverableText(
        stripMarkerOccurrences(rawOutputText, occurrences),
      ),
    };
  }

  const validOccurrences = occurrences.filter(
    (occurrence): occurrence is ParsedValidMarker =>
      occurrence.status === "valid",
  );
  const firstMarker = validOccurrences[0];
  if (firstMarker === undefined) {
    return {
      kind: "missing_tag",
      normalizedText: normalizeDeliverableText(rawOutputText),
    };
  }

  if (validOccurrences.length > 1) {
    const conflicting = validOccurrences.find(
      (marker) => marker.turnIndex !== firstMarker.turnIndex,
    );
    return {
      kind: "malformed_tag",
      reason:
        conflicting === undefined
          ? `Multiple turn markers found: "${firstMarker.rawTag}"`
          : `Conflicting turn markers: "${firstMarker.rawTag}" vs "${conflicting.rawTag}"`,
      normalizedText: normalizeDeliverableText(
        stripMarkerOccurrences(rawOutputText, occurrences),
      ),
    };
  }

  const normalizedText = normalizeDeliverableText(
    rawOutputText.slice(0, firstMarker.startIndex),
  );

  if (firstMarker.turnIndex !== expectedTurnIndex) {
    return {
      kind: "wrong_index",
      expectedTurnIndex,
      actualTurnIndex: firstMarker.turnIndex,
      normalizedText,
      rawTag: firstMarker.rawTag,
    };
  }

  const trailingText = rawOutputText.slice(firstMarker.endIndex).trim();
  if (trailingText.length > 0) {
    return {
      kind: "trailing_content",
      turnIndex: expectedTurnIndex,
      normalizedText,
      rawTag: firstMarker.rawTag,
      trailingText,
    };
  }

  // §7 invariant: output that becomes empty after normalization and marker
  // removal is `empty_output` (`reason: "marker_only"`), even when a valid
  // marker was present.
  if (normalizedText.length === 0) {
    return { kind: "empty_output", reason: "marker_only" };
  }

  return {
    kind: "terminal",
    turnIndex: expectedTurnIndex,
    normalizedText,
    rawTag: firstMarker.rawTag,
  };
}

/**
 * Unified adapter mapping a `classifyCandidateOutput` classification onto the
 * turn/attempt/structural statuses and judge requirement used by JobDO.
 *
 * @throws RangeError when `expectedTurnIndex` is not an integer >= 1.
 */
export function classifyCandidateOutcome(
  params: ClassifyCandidateOutputParams,
): CandidateOutcome {
  const { expectedTurnIndex } = params;
  assertTurnIndex(expectedTurnIndex, "expectedTurnIndex");

  const classification = classifyCandidateOutput(params);

  switch (classification.kind) {
    case "provider_failed":
      return {
        classification,
        structuralStatus: "provider_failed",
        turnStatus: "failed",
        attemptStatus: "failed",
        judgeRequired: false,
        warnings: [],
      };
    case "cancelled":
      return {
        classification,
        structuralStatus: "cancelled",
        turnStatus: "cancelled",
        attemptStatus: "cancelled",
        judgeRequired: false,
        warnings: [],
      };
    case "incomplete":
      return {
        classification,
        structuralStatus: "incomplete",
        turnStatus: "running",
        attemptStatus: "incomplete",
        judgeRequired: false,
        warnings: [],
      };
    case "refusal":
      return {
        classification,
        structuralStatus: "refusal",
        turnStatus: "paused_review",
        attemptStatus: "refused",
        judgeRequired: false,
        warnings: [],
      };
    case "terminal":
      return {
        classification,
        structuralStatus: "valid",
        turnStatus: "awaiting_judge",
        attemptStatus: "completed",
        judgeRequired: true,
        warnings: [],
      };
    case "trailing_content": {
      const judgeRequired = classification.normalizedText.length > 0;
      return {
        classification,
        structuralStatus: "trailing_content",
        turnStatus: judgeRequired ? "awaiting_judge" : "failed",
        attemptStatus: "completed",
        judgeRequired,
        warnings: [TRAILING_CONTENT_WARNING],
      };
    }
    case "empty_output":
      return {
        classification,
        structuralStatus: "empty_output",
        turnStatus: "failed",
        attemptStatus: "failed",
        judgeRequired: false,
        warnings: [],
      };
    case "wrong_index":
      return {
        classification,
        structuralStatus: "wrong_index",
        turnStatus: "failed",
        attemptStatus: "failed",
        judgeRequired: false,
        warnings: [],
      };
    case "missing_tag":
      return {
        classification,
        structuralStatus: "missing_tag",
        turnStatus: "failed",
        attemptStatus: "failed",
        judgeRequired: false,
        warnings: [],
      };
    case "malformed_tag":
      return {
        classification,
        structuralStatus: "malformed_tag",
        turnStatus: "failed",
        attemptStatus: "failed",
        judgeRequired: false,
        warnings: [],
      };
  }
}

/**
 * Type guard verifying whether a classification is a judgeable terminal
 * candidate with non-empty normalized deliverable text.
 */
export function isJudgeableClassification(
  classification: CandidateClassification,
): classification is Extract<
  StructuralClassification,
  { readonly kind: "terminal" }
> {
  return (
    classification.kind === "terminal" &&
    classification.normalizedText.length > 0
  );
}