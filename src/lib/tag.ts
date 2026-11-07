/**
 * Tags — `src/lib/tag.ts`
 *
 * Deliverable text normalization, completion/continuation tag formatting,
 * and structural classification per docs/ARCHITECTURE.md (§7) and src/types.ts.
 *
 * Key invariants:
 * 1. Dependency DAG: imports ONLY from `src/constants.ts` and `src/types.ts`.
 * 2. Structural acceptance requires non-empty retained deliverable text.
 *    Output that becomes empty after normalization and completion-marker
 *    removal is classified as `empty_output` (`"empty"`, `"whitespace_only"`,
 *    or `"marker_only"`), even when a syntactically valid completion tag
 *    is present. An apparent valid completion tag never makes an empty
 *    candidate judgeable.
 * 3. Canonical completion tags (`<TURN_COMPLETE turn="N" />`,
 *    `<TURN_COMPLETE turn="N"></TURN_COMPLETE>`, `[[TURN_COMPLETE:N]]`) and
 *    continuation tags (`<TURN_CONTINUE turn="N" />`,
 *    `<TURN_CONTINUE turn="N"></TURN_CONTINUE>`, `[[TURN_CONTINUE:N]]`) are
 *    parsed for non-negative integer turn indices `N`.
 * 4. Malformed or conflicting markers return `malformed_tag`; missing markers
 *    return `missing_tag`; mismatched turn indices return `wrong_index`.
 */

import type { StructuralClassification, TurnIndex } from "../types";

/** Parameters accepted by `classifyCandidateOutput`. */
export interface ClassifyCandidateOutputParams {
  readonly rawOutputText: string | null | undefined;
  readonly expectedTurnIndex: TurnIndex;
  readonly providerStatus?: "completed" | "incomplete" | "failed" | "cancelled";
  readonly refusalText?: string | null;
}

type ParsedMarkerKind = "terminal" | "continuation";

interface ParsedValidMarker {
  readonly status: "valid";
  readonly kind: ParsedMarkerKind;
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

/**
 * Broad scanner matching any XML-style `<TURN_COMPLETE...>` / `</TURN_COMPLETE...>` /
 * `<TURN_CONTINUE...>` / `</TURN_CONTINUE...>` (including unclosed tags to end-of-line/input)
 * or bracket-style `[[TURN_COMPLETE...]]` / `[[TURN_CONTINUE...]]` (including unclosed `[[TURN_...`).
 */
const MARKER_CANDIDATE_PATTERN =
  /<\/?TURN_(?:COMPLETE|CONTINUE)\b(?:[^<>]*>\s*<\/TURN_(?:COMPLETE|CONTINUE)\s*>|[^<>]*>|[^\r\n]*)|\[\[\s*TURN_(?:COMPLETE|CONTINUE)\b(?:\s*:[^\]\r\n]*\]\]|[^\r\n]*)/gi;

/**
 * Valid XML-style marker pattern:
 * - `<TURN_COMPLETE turn="N" />` or `<TURN_COMPLETE turn='N'>`
 * - `<TURN_COMPLETE turn="N"></TURN_COMPLETE>`
 * - `<TURN_CONTINUE turn="N" />` or `<TURN_CONTINUE turn="N"></TURN_CONTINUE>`
 */
const XML_MARKER_EXACT_PATTERN =
  /^<(TURN_COMPLETE|TURN_CONTINUE)\s+turn\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))\s*(?:\/>|>\s*<\/\1\s*>|(?=>)>$)/;

/**
 * Valid bracket-style marker pattern:
 * - `[[TURN_COMPLETE:N]]`
 * - `[[TURN_CONTINUE:N]]`
 */
const BRACKET_MARKER_EXACT_PATTERN =
  /^\[\[\s*(TURN_COMPLETE|TURN_CONTINUE)\s*:\s*([^\]]*?)\s*\]\]$/;

/**
 * Formats the canonical terminal completion tag for `turnIndex`:
 * `<TURN_COMPLETE turn="${turnIndex}" />`.
 */
export function formatCompletionTag(turnIndex: TurnIndex): string {
  return `<TURN_COMPLETE turn="${turnIndex}" />`;
}

/**
 * Formats the canonical continuation tag for `turnIndex`:
 * `<TURN_CONTINUE turn="${turnIndex}" />`.
 */
export function formatContinuationTag(turnIndex: TurnIndex): string {
  return `<TURN_CONTINUE turn="${turnIndex}" />`;
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
 * Parses a strict non-negative integer turn index (`0`, `1`, `2`, ...).
 * Returns `null` if the string is empty, contains non-digits, is negative,
 * or exceeds `Number.MAX_SAFE_INTEGER`.
 */
function parseNonNegativeTurnIndex(rawValue: string): TurnIndex | null {
  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

/**
 * Classifies a single matched marker substring as either a valid completion/continuation
 * marker or a malformed marker with an explicit diagnostic reason.
 */
function parseMarkerCandidate(
  rawTag: string,
  startIndex: number,
  endIndex: number,
): ParsedMarkerOccurrence {
  if (rawTag.startsWith("<")) {
    const xmlMatch = XML_MARKER_EXACT_PATTERN.exec(rawTag);
    if (xmlMatch === null) {
      return {
        status: "malformed",
        reason: `Malformed XML turn marker: ${rawTag}`,
        rawTag,
        startIndex,
        endIndex,
      };
    }

    const tagName = xmlMatch[1];
    const rawAttr = xmlMatch[2] ?? xmlMatch[3] ?? xmlMatch[4] ?? "";
    const turnIndex = parseNonNegativeTurnIndex(rawAttr);
    if (turnIndex === null) {
      return {
        status: "malformed",
        reason: `Invalid non-negative integer turn attribute in marker: ${rawTag}`,
        rawTag,
        startIndex,
        endIndex,
      };
    }

    const kind: ParsedMarkerKind =
      tagName === "TURN_COMPLETE" ? "terminal" : "continuation";
    return {
      status: "valid",
      kind,
      turnIndex,
      rawTag,
      startIndex,
      endIndex,
    };
  }

  const bracketMatch = BRACKET_MARKER_EXACT_PATTERN.exec(rawTag);
  if (bracketMatch === null) {
    return {
      status: "malformed",
      reason: `Malformed bracket turn marker: ${rawTag}`,
      rawTag,
      startIndex,
      endIndex,
    };
  }

  const tagName = bracketMatch[1];
  const rawAttr = bracketMatch[2] ?? "";
  const turnIndex = parseNonNegativeTurnIndex(rawAttr);
  if (turnIndex === null) {
    return {
      status: "malformed",
      reason: `Invalid non-negative integer turn index in bracket marker: ${rawTag}`,
      rawTag,
      startIndex,
      endIndex,
    };
  }

  const kind: ParsedMarkerKind =
    tagName === "TURN_COMPLETE" ? "terminal" : "continuation";
  return {
    status: "valid",
    kind,
    turnIndex,
    rawTag,
    startIndex,
    endIndex,
  };
}

/**
 * Scans `text` for all completion/continuation marker occurrences (valid or malformed)
 * and builds the marker-stripped string.
 */
function extractMarkersAndStripText(text: string): {
  readonly occurrences: readonly ParsedMarkerOccurrence[];
  readonly strippedText: string;
} {
  const occurrences: ParsedMarkerOccurrence[] = [];
  const pieces: string[] = [];
  let cursor = 0;

  MARKER_CANDIDATE_PATTERN.lastIndex = 0;
  let match = MARKER_CANDIDATE_PATTERN.exec(text);
  while (match !== null) {
    const rawTag = match[0];
    const startIndex = match.index;
    const endIndex = startIndex + rawTag.length;

    if (startIndex > cursor) {
      pieces.push(text.slice(cursor, startIndex));
    }
    occurrences.push(parseMarkerCandidate(rawTag, startIndex, endIndex));
    cursor = endIndex;

    match = MARKER_CANDIDATE_PATTERN.exec(text);
  }

  if (cursor < text.length) {
    pieces.push(text.slice(cursor));
  }

  return {
    occurrences,
    strippedText: pieces.join(""),
  };
}

/**
 * Performs structural classification on a candidate generation output per §7:
 * - Empty input (`null`, `undefined`, `""`) -> `{ kind: "empty_output", reason: "empty" }`
 * - Whitespace-only input -> `{ kind: "empty_output", reason: "whitespace_only" }`
 * - Valid marker(s) with no remaining deliverable text after normalization ->
 *   `{ kind: "empty_output", reason: "marker_only" }` (§7 invariant: an apparent
 *   valid completion tag never makes an empty candidate judgeable)
 * - Malformed or conflicting markers -> `{ kind: "malformed_tag", reason, normalizedText }`
 * - No marker present -> `{ kind: "missing_tag", normalizedText }`
 * - Valid marker with `actualTurnIndex !== expectedTurnIndex` ->
 *   `{ kind: "wrong_index", expectedTurnIndex, actualTurnIndex, normalizedText, rawTag }`
 * - Valid continuation marker matching `expectedTurnIndex` ->
 *   `{ kind: "continuation", turnIndex: expectedTurnIndex, normalizedText, rawTag }`
 * - Valid completion marker matching `expectedTurnIndex` with non-empty deliverable ->
 *   `{ kind: "terminal", turnIndex: expectedTurnIndex, normalizedText, rawTag }`
 */
export function classifyCandidateOutput(
  params: ClassifyCandidateOutputParams,
): StructuralClassification {
  const { rawOutputText, expectedTurnIndex } = params;

  if (
    rawOutputText === null ||
    rawOutputText === undefined ||
    rawOutputText.length === 0
  ) {
    return {
      kind: "empty_output",
      reason: "empty",
    };
  }

  if (rawOutputText.trim().length === 0) {
    return {
      kind: "empty_output",
      reason: "whitespace_only",
    };
  }

  const { occurrences, strippedText } =
    extractMarkersAndStripText(rawOutputText);
  const normalizedText = normalizeDeliverableText(strippedText);

  if (occurrences.length === 0) {
    if (normalizedText.length === 0) {
      return {
        kind: "empty_output",
        reason: "whitespace_only",
      };
    }
    return {
      kind: "missing_tag",
      normalizedText,
    };
  }

  for (const occurrence of occurrences) {
    if (occurrence.status === "malformed") {
      return {
        kind: "malformed_tag",
        reason: occurrence.reason,
        normalizedText,
      };
    }
  }

  // All occurrences are syntactically valid markers. Check for conflicts across multiple markers.
  const firstMarker = occurrences[0] as ParsedValidMarker;
  for (let i = 1; i < occurrences.length; i += 1) {
    const current = occurrences[i] as ParsedValidMarker;
    if (
      current.kind !== firstMarker.kind ||
      current.turnIndex !== firstMarker.turnIndex
    ) {
      return {
        kind: "malformed_tag",
        reason: `Conflicting turn markers: "${firstMarker.rawTag}" vs "${current.rawTag}"`,
        normalizedText,
      };
    }
  }

  // §7 invariant: Output that becomes empty after normalization and marker removal
  // is `empty_output` (`reason: "marker_only"`), even when a valid tag was present.
  if (normalizedText.length === 0) {
    return {
      kind: "empty_output",
      reason: "marker_only",
    };
  }

  if (firstMarker.turnIndex !== expectedTurnIndex) {
    return {
      kind: "wrong_index",
      expectedTurnIndex,
      actualTurnIndex: firstMarker.turnIndex,
      normalizedText,
      rawTag: firstMarker.rawTag,
    };
  }

  if (firstMarker.kind === "continuation") {
    return {
      kind: "continuation",
      turnIndex: expectedTurnIndex,
      normalizedText,
      rawTag: firstMarker.rawTag,
    };
  }

  return {
    kind: "terminal",
    turnIndex: expectedTurnIndex,
    normalizedText,
    rawTag: firstMarker.rawTag,
  };
}

/**
 * Type guard verifying whether a `StructuralClassification` is a judgeable
 * terminal candidate with non-empty normalized deliverable text.
 */
export function isJudgeableClassification(
  classification: StructuralClassification,
): classification is Extract<
  StructuralClassification,
  { readonly kind: "terminal" }
> {
  return (
    classification.kind === "terminal" &&
    classification.normalizedText.length > 0
  );
}
