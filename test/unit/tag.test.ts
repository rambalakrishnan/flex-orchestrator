// Covers: 9

import { describe, expect, it } from "vitest";

import {
  TRAILING_CONTENT_WARNING,
  classifyCandidateOutcome,
  classifyCandidateOutput,
  formatCompletionTag,
  isJudgeableClassification,
  normalizeDeliverableText,
} from "../../src/lib/tag.ts";
import type {
  CandidateOutcome,
  ClassifyCandidateOutputParams,
} from "../../src/lib/tag.ts";

const TERMINAL_1 = "<!-- TURN_END:1 -->";

describe("canonical tag formatting", () => {
  it("formats the canonical HTML-comment terminal marker", () => {
    expect(formatCompletionTag(1)).toBe(TERMINAL_1);
    expect(formatCompletionTag(42)).toBe("<!-- TURN_END:42 -->");
  });
});

describe("normalizeDeliverableText", () => {
  it("normalizes line endings, strips trailing horizontal whitespace, and trims blank lines", () => {
    expect(normalizeDeliverableText("\r\nfoo \t\r\n\r\nbar\t\r")).toBe(
      "foo\n\nbar",
    );
  });

  it("returns an empty string for blank-only text", () => {
    expect(normalizeDeliverableText("  \n\t\n ")).toBe("");
  });
});

describe("empty_output classification", () => {
  it.each([
    ["empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ])("classifies %s as empty_output/empty", (_label, rawOutputText) => {
    const outcome = classifyCandidateOutcome({
      rawOutputText,
      expectedTurnIndex: 1,
    });
    expect(outcome.classification).toEqual({
      kind: "empty_output",
      reason: "empty",
    });
    expect(outcome.structuralStatus).toBe("empty_output");
    expect(outcome.judgeRequired).toBe(false);
    expect(outcome.turnStatus).toBe("failed");
    expect(outcome.attemptStatus).toBe("failed");
  });

  it.each(["   ", "\n\n", "\t"])(
    "classifies whitespace-only %j as empty_output/whitespace_only",
    (rawOutputText) => {
      const outcome = classifyCandidateOutcome({
        rawOutputText,
        expectedTurnIndex: 1,
      });
      expect(outcome.classification).toEqual({
        kind: "empty_output",
        reason: "whitespace_only",
      });
      expect(outcome.judgeRequired).toBe(false);
    },
  );

  it("classifies marker-only output as empty_output/marker_only even with a valid marker", () => {
    for (const rawOutputText of [
      TERMINAL_1,
      formatCompletionTag(1),
    ]) {
      const outcome = classifyCandidateOutcome({
        rawOutputText,
        expectedTurnIndex: 1,
      });
      expect(outcome.classification).toEqual({
        kind: "empty_output",
        reason: "marker_only",
      });
      expect(outcome.structuralStatus).toBe("empty_output");
      expect(outcome.judgeRequired).toBe(false);
    }
  });
});

describe("terminal classification", () => {
  it("classifies retained deliverable text followed by the marker as terminal", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `foo${TERMINAL_1}`,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "terminal",
      turnIndex: 1,
      normalizedText: "foo",
      rawTag: TERMINAL_1,
    });
  });

  it("classifies an unanchored multi-line deliverable as terminal with normalized text", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `  line one  \r\n\r\nline two\t\r\n${TERMINAL_1}`,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "terminal",
      turnIndex: 1,
      normalizedText: "  line one\n\nline two",
      rawTag: TERMINAL_1,
    });
  });

  it("recognizes a marker split across continuation chunks once the cumulative text is joined", () => {
    const cumulative = ["foo<", "!-- TURN_END:1 -->"].join("");
    const classification = classifyCandidateOutput({
      rawOutputText: cumulative,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "terminal",
      turnIndex: 1,
      normalizedText: "foo",
      rawTag: TERMINAL_1,
    });
  });

  it("reports terminal as judgeable", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `foo${TERMINAL_1}`,
      expectedTurnIndex: 1,
    });
    expect(isJudgeableClassification(classification)).toBe(true);
  });
});

describe("trailing_content classification", () => {
  it("classifies leading text plus trailing bytes as trailing_content", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `foo${TERMINAL_1}bar`,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "trailing_content",
      turnIndex: 1,
      normalizedText: "foo",
      rawTag: TERMINAL_1,
      trailingText: "bar",
    });
    expect(isJudgeableClassification(classification)).toBe(false);
  });

  it("classifies marker-then-text as trailing_content with empty retained text", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `${TERMINAL_1}foo`,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "trailing_content",
      turnIndex: 1,
      normalizedText: "",
      rawTag: TERMINAL_1,
      trailingText: "foo",
    });
  });

  it("trims trailing bytes but does not normalize them into the deliverable", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `foo${TERMINAL_1}\n  bar baz  \n`,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "trailing_content",
      turnIndex: 1,
      normalizedText: "foo",
      rawTag: TERMINAL_1,
      trailingText: "bar baz",
    });
  });
});

describe("wrong_index, missing_tag, and malformed_tag classification", () => {
  it("classifies a valid marker for a different turn as wrong_index", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: `foo<!-- TURN_END:2 -->`,
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "wrong_index",
      expectedTurnIndex: 1,
      actualTurnIndex: 2,
      normalizedText: "foo",
      rawTag: "<!-- TURN_END:2 -->",
    });
    expect(isJudgeableClassification(classification)).toBe(false);
  });

  it("classifies text without a marker as missing_tag", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: "hello",
      expectedTurnIndex: 1,
    });
    expect(classification).toEqual({
      kind: "missing_tag",
      normalizedText: "hello",
    });
  });

  it.each([
    ["zero index", "<!-- TURN_END:0 -->", "Invalid positive integer"],
    ["negative index", "<!-- TURN_END:-1 -->", "Invalid positive integer"],
    ["non-integer index", "<!-- TURN_END:1.5 -->", "Invalid positive integer"],
    ["non-numeric index", "<!-- TURN_END:abc -->", "Invalid positive integer"],
    ["unclosed marker", "<!-- TURN_END", "Unclosed turn marker"],
    ["unknown marker name", "<!-- TURN_DONE:1 -->", "Malformed turn marker"],
    ["missing index", "<!-- TURN_END -->", "Malformed turn marker"],
    [
      "conflicting markers",
      `foo<!-- TURN_END:1 --><!-- TURN_END:2 -->`,
      "Conflicting turn markers",
    ],
  ])("classifies %s as malformed_tag", (_label, rawOutputText, reasonFragment) => {
    const classification = classifyCandidateOutput({
      rawOutputText,
      expectedTurnIndex: 1,
    });
    expect(classification.kind).toBe("malformed_tag");
    if (classification.kind === "malformed_tag") {
      expect(classification.reason).toContain(reasonFragment);
    }
    expect(isJudgeableClassification(classification)).toBe(false);
  });

  it("normalizes the deliverable text surrounding malformed markers", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: "  foo  \n<!-- TURN_END:0 -->\n  bar  ",
      expectedTurnIndex: 1,
    });
    expect(classification.kind).toBe("malformed_tag");
    if (classification.kind === "malformed_tag") {
      expect(classification.normalizedText).toBe("  foo\n\n  bar");
    }
  });
});

describe("provider, cancellation, incomplete, and refusal precedence", () => {
  const POISONED_MARKER = "<!-- TURN_END:0 -->";

  it("provider failure wins over tag parsing and never requires the judge", () => {
    const params: ClassifyCandidateOutputParams = {
      rawOutputText: POISONED_MARKER,
      expectedTurnIndex: 1,
      providerStatus: "failed",
    };
    expect(classifyCandidateOutput(params)).toEqual({
      kind: "provider_failed",
    });
    const outcome = classifyCandidateOutcome(params);
    expect(outcome.structuralStatus).toBe("provider_failed");
    expect(outcome.turnStatus).toBe("failed");
    expect(outcome.attemptStatus).toBe("failed");
    expect(outcome.judgeRequired).toBe(false);
  });

  it("cancellation wins over tag parsing and never requires the judge", () => {
    const params: ClassifyCandidateOutputParams = {
      rawOutputText: `foo${TERMINAL_1}`,
      expectedTurnIndex: 1,
      providerStatus: "cancelled",
    };
    expect(classifyCandidateOutput(params)).toEqual({ kind: "cancelled" });
    const outcome = classifyCandidateOutcome(params);
    expect(outcome.structuralStatus).toBe("cancelled");
    expect(outcome.turnStatus).toBe("cancelled");
    expect(outcome.attemptStatus).toBe("cancelled");
    expect(outcome.judgeRequired).toBe(false);
  });

  it("incomplete provider status wins over tag parsing and never requires the judge", () => {
    const params: ClassifyCandidateOutputParams = {
      rawOutputText: `foo${TERMINAL_1}`,
      expectedTurnIndex: 1,
      providerStatus: "incomplete",
    };
    expect(classifyCandidateOutput(params)).toEqual({ kind: "incomplete" });
    const outcome = classifyCandidateOutcome(params);
    expect(outcome.structuralStatus).toBe("incomplete");
    expect(outcome.turnStatus).toBe("running");
    expect(outcome.attemptStatus).toBe("incomplete");
    expect(outcome.judgeRequired).toBe(false);
  });

  it("a non-empty refusal wins over tag parsing and never requires the judge", () => {
    const params: ClassifyCandidateOutputParams = {
      rawOutputText: `foo${TERMINAL_1}`,
      expectedTurnIndex: 1,
      refusalText: "  I cannot help with that.  ",
    };
    expect(classifyCandidateOutput(params)).toEqual({
      kind: "refusal",
      refusalText: "I cannot help with that.",
    });
    const outcome = classifyCandidateOutcome(params);
    expect(outcome.structuralStatus).toBe("refusal");
    expect(outcome.turnStatus).toBe("paused_review");
    expect(outcome.attemptStatus).toBe("refused");
    expect(outcome.judgeRequired).toBe(false);
  });

  it("a whitespace-only refusal does not take precedence", () => {
    const classification = classifyCandidateOutput({
      rawOutputText: "",
      expectedTurnIndex: 1,
      refusalText: "   \n\t ",
    });
    expect(classification).toEqual({
      kind: "empty_output",
      reason: "empty",
    });
  });
});

describe("classifyCandidateOutcome mapping table", () => {
  interface MappingCase {
    readonly label: string;
    readonly params: ClassifyCandidateOutputParams;
    readonly structuralStatus: CandidateOutcome["structuralStatus"];
    readonly turnStatus: CandidateOutcome["turnStatus"];
    readonly attemptStatus: CandidateOutcome["attemptStatus"];
    readonly judgeRequired: boolean;
    readonly warnings: readonly string[];
    readonly classificationKind: CandidateOutcome["classification"]["kind"];
  }

  const CASES: readonly MappingCase[] = [
    {
      label: "provider failed",
      params: { rawOutputText: "x", expectedTurnIndex: 1, providerStatus: "failed" },
      structuralStatus: "provider_failed",
      turnStatus: "failed",
      attemptStatus: "failed",
      judgeRequired: false,
      warnings: [],
      classificationKind: "provider_failed",
    },
    {
      label: "cancelled",
      params: { rawOutputText: "x", expectedTurnIndex: 1, providerStatus: "cancelled" },
      structuralStatus: "cancelled",
      turnStatus: "cancelled",
      attemptStatus: "cancelled",
      judgeRequired: false,
      warnings: [],
      classificationKind: "cancelled",
    },
    {
      label: "incomplete",
      params: { rawOutputText: "x", expectedTurnIndex: 1, providerStatus: "incomplete" },
      structuralStatus: "incomplete",
      turnStatus: "running",
      attemptStatus: "incomplete",
      judgeRequired: false,
      warnings: [],
      classificationKind: "incomplete",
    },
    {
      label: "refusal",
      params: { rawOutputText: "x", expectedTurnIndex: 1, refusalText: "no" },
      structuralStatus: "refusal",
      turnStatus: "paused_review",
      attemptStatus: "refused",
      judgeRequired: false,
      warnings: [],
      classificationKind: "refusal",
    },
    {
      label: "terminal",
      params: { rawOutputText: `foo${TERMINAL_1}`, expectedTurnIndex: 1 },
      structuralStatus: "valid",
      turnStatus: "awaiting_judge",
      attemptStatus: "completed",
      judgeRequired: true,
      warnings: [],
      classificationKind: "terminal",
    },
    {
      label: "trailing_content with retained text",
      params: { rawOutputText: `foo${TERMINAL_1}bar`, expectedTurnIndex: 1 },
      structuralStatus: "trailing_content",
      turnStatus: "awaiting_judge",
      attemptStatus: "completed",
      judgeRequired: true,
      warnings: [TRAILING_CONTENT_WARNING],
      classificationKind: "trailing_content",
    },
    {
      label: "trailing_content without retained text",
      params: { rawOutputText: `${TERMINAL_1}bar`, expectedTurnIndex: 1 },
      structuralStatus: "trailing_content",
      turnStatus: "failed",
      attemptStatus: "completed",
      judgeRequired: false,
      warnings: [TRAILING_CONTENT_WARNING],
      classificationKind: "trailing_content",
    },
    {
      label: "empty_output",
      params: { rawOutputText: "", expectedTurnIndex: 1 },
      structuralStatus: "empty_output",
      turnStatus: "failed",
      attemptStatus: "failed",
      judgeRequired: false,
      warnings: [],
      classificationKind: "empty_output",
    },
    {
      label: "wrong_index",
      params: { rawOutputText: `foo<!-- TURN_END:2 -->`, expectedTurnIndex: 1 },
      structuralStatus: "wrong_index",
      turnStatus: "failed",
      attemptStatus: "failed",
      judgeRequired: false,
      warnings: [],
      classificationKind: "wrong_index",
    },
    {
      label: "missing_tag",
      params: { rawOutputText: "foo", expectedTurnIndex: 1 },
      structuralStatus: "missing_tag",
      turnStatus: "failed",
      attemptStatus: "failed",
      judgeRequired: false,
      warnings: [],
      classificationKind: "missing_tag",
    },
    {
      label: "malformed_tag",
      params: { rawOutputText: "<!-- TURN_END:0 -->", expectedTurnIndex: 1 },
      structuralStatus: "malformed_tag",
      turnStatus: "failed",
      attemptStatus: "failed",
      judgeRequired: false,
      warnings: [],
      classificationKind: "malformed_tag",
    },
  ];

  it.each(CASES)("$label maps to the fixed status table", (mappingCase) => {
    const outcome = classifyCandidateOutcome(mappingCase.params);
    expect(outcome.classification.kind).toBe(mappingCase.classificationKind);
    expect(outcome.structuralStatus).toBe(mappingCase.structuralStatus);
    expect(outcome.turnStatus).toBe(mappingCase.turnStatus);
    expect(outcome.attemptStatus).toBe(mappingCase.attemptStatus);
    expect(outcome.judgeRequired).toBe(mappingCase.judgeRequired);
    expect(outcome.warnings).toEqual(mappingCase.warnings);
  });
});

describe("classifyCandidateOutcome turn index validation", () => {
  it.each([0, -1, -42, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws RangeError for expectedTurnIndex %d",
    (expectedTurnIndex) => {
      expect(() =>
        classifyCandidateOutcome({
          rawOutputText: "foo",
          expectedTurnIndex,
        }),
      ).toThrow(RangeError);
    },
  );

  it("accepts a positive integer turn index", () => {
    expect(() =>
      classifyCandidateOutcome({ rawOutputText: "foo", expectedTurnIndex: 3 }),
    ).not.toThrow();
  });
});

describe("isJudgeableClassification", () => {
  it("rejects non-terminal classifications", () => {
    expect(
      isJudgeableClassification(
        classifyCandidateOutput({
          rawOutputText: "foo",
          expectedTurnIndex: 1,
        }),
      ),
    ).toBe(false);
    expect(
      isJudgeableClassification(
        classifyCandidateOutput({
          rawOutputText: "foo<!-- TURN_END:2 -->",
          expectedTurnIndex: 1,
        }),
      ),
    ).toBe(false);
  });

  it("rejects terminal classifications without retained text", () => {
    const markerOnly = classifyCandidateOutput({
      rawOutputText: TERMINAL_1,
      expectedTurnIndex: 1,
    });
    expect(markerOnly.kind).toBe("empty_output");
    expect(isJudgeableClassification(markerOnly)).toBe(false);
  });
});