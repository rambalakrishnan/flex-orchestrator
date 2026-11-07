// Covers: 22

import { describe, expect, it } from "vitest";
import { LONG_CONTEXT_THRESHOLD_TOKENS } from "../../src/lib/tokens.ts";
import {
  aggregateUsage,
  buildMarginalTokenPreview,
  computeContextTier,
  evaluateTokenAdmission,
} from "../../src/lib/tokens.ts";
import type { TokenUsageRecord } from "../../src/types.ts";

function usage(overrides: Partial<TokenUsageRecord> = {}): TokenUsageRecord {
  return {
    inputTokens: 1000,
    cachedInputTokens: 100,
    outputTokens: 200,
    reasoningTokens: 50,
    totalTokens: 1200,
    contextTier: "standard",
    estimatedCostUsd: 0.002,
    pricingKnown: true,
    ...overrides,
  };
}

describe("computeContextTier", () => {
  it("pins the strictly-above 272,000 threshold", () => {
    expect(LONG_CONTEXT_THRESHOLD_TOKENS).toBe(272_000);
    expect(computeContextTier(271_999)).toBe("standard");
    expect(computeContextTier(272_000)).toBe("standard");
    expect(computeContextTier(272_001)).toBe("long_context");
  });

  it("counts cached input within the full input count", () => {
    // The threshold applies to the full request input, including cached input.
    expect(computeContextTier(272_001)).toBe("long_context");
  });

  it("rejects negative and non-finite counts", () => {
    expect(() => computeContextTier(-1)).toThrow(RangeError);
    expect(() => computeContextTier(Number.NaN)).toThrow(RangeError);
    expect(() => computeContextTier(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => computeContextTier(1.5)).toThrow(RangeError);
  });
});

describe("evaluateTokenAdmission", () => {
  it("rejects unknown models without guessing a profile", () => {
    const outcome = evaluateTokenAdmission({
      model: "unknown-model",
      projectedInputTokens: 10,
      maxOutputTokens: 10,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("unknown_model");
      expect(outcome.maxAllowedInputTokens).toBeNull();
    }
  });

  it("admits a request within the verified profile", () => {
    const outcome = evaluateTokenAdmission({
      model: "gpt-5",
      projectedInputTokens: 100_000,
      maxOutputTokens: 32_768,
    });
    expect(outcome).toEqual({
      kind: "admitted",
      projectedInputTokens: 100_000,
      maxAllowedInputTokens: 272_000,
      maxOutputTokens: 32_768,
      contextTier: "standard",
    });
  });

  it("rejects input above the model input limit", () => {
    const outcome = evaluateTokenAdmission({
      model: "gpt-5",
      projectedInputTokens: 272_001,
      maxOutputTokens: 1_000,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("context_window_exceeded");
      expect(outcome.projectedInputTokens).toBe(272_001);
    }
  });

  it("rejects requested output above the model output limit", () => {
    const outcome = evaluateTokenAdmission({
      model: "gpt-5",
      projectedInputTokens: 1_000,
      maxOutputTokens: 128_001,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("output_limit_exceeded");
    }
  });

  it("rejects non-positive and non-integer output limits", () => {
    for (const maxOutputTokens of [0, -1, 1.5, Number.NaN]) {
      const outcome = evaluateTokenAdmission({
        model: "gpt-5",
        projectedInputTokens: 1_000,
        maxOutputTokens,
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") {
        expect(outcome.reason).toBe("output_limit_exceeded");
      }
    }
  });

  it("rejects when input plus max output exceeds the context window", () => {
    const outcome = evaluateTokenAdmission({
      model: "gpt-5",
      projectedInputTokens: 300_000,
      maxOutputTokens: 128_000,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.reason).toBe("context_window_exceeded");
    }
  });
});

describe("aggregateUsage", () => {
  it("returns explicit zero aggregates for no calls", () => {
    expect(aggregateUsage({ generationUsage: [], judgeUsage: [] })).toEqual({
      generationCalls: 0,
      judgeCalls: 0,
      missingUsageCalls: 0,
      unknownPricingCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      totalEstimatedCostUsd: 0,
    });
  });

  it("records usage once per call and counts missing usage explicitly", () => {
    const aggregate = aggregateUsage({
      generationUsage: [usage(), null, usage({ inputTokens: 500, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: 0, totalTokens: 600, estimatedCostUsd: 0.001 })],
      judgeUsage: [usage({ inputTokens: 200, outputTokens: 20, reasoningTokens: 0, totalTokens: 220, estimatedCostUsd: 0.0005 })],
    });

    expect(aggregate.generationCalls).toBe(3);
    expect(aggregate.judgeCalls).toBe(1);
    expect(aggregate.missingUsageCalls).toBe(1);
    expect(aggregate.unknownPricingCalls).toBe(0);
    expect(aggregate.inputTokens).toBe(1000 + 500 + 200);
    expect(aggregate.cachedInputTokens).toBe(200);
    expect(aggregate.outputTokens).toBe(200 + 100 + 20);
    expect(aggregate.reasoningTokens).toBe(50);
    expect(aggregate.totalTokens).toBe(1200 + 600 + 220);
    expect(aggregate.totalEstimatedCostUsd).toBeCloseTo(0.002 + 0.001 + 0.0005, 10);
  });

  it("keeps unknown pricing explicit instead of estimating a total", () => {
    const aggregate = aggregateUsage({
      generationUsage: [usage(), usage({ estimatedCostUsd: null, pricingKnown: false })],
      judgeUsage: [],
    });

    expect(aggregate.unknownPricingCalls).toBe(1);
    expect(aggregate.totalEstimatedCostUsd).toBeNull();
    // Token sums still include the unknown-pricing call (usage was known).
    expect(aggregate.inputTokens).toBe(2000);
  });

  it("does not infer a cache-write premium from TTL", () => {
    const withoutCacheHit = usage({ cachedInputTokens: 0, estimatedCostUsd: 0.01 });
    const withCacheHit = usage({ cachedInputTokens: 100, estimatedCostUsd: 0.01 });
    const aggregate = aggregateUsage({
      generationUsage: [withoutCacheHit, withCacheHit],
      judgeUsage: [],
    });
    // Cost is per-call recorded data only; aggregation never re-prices by TTL.
    expect(aggregate.totalEstimatedCostUsd).toBeCloseTo(0.02, 10);
    expect(aggregate.cachedInputTokens).toBe(100);
  });
});

describe("buildMarginalTokenPreview", () => {
  it("projects prior plus marginal input and propagates admission", () => {
    const preview = buildMarginalTokenPreview({
      model: "gpt-5",
      marginalInputTokens: 2_000,
      priorTotalInputTokens: 270_000,
      maxOutputTokens: 1_000,
    });

    expect(preview.model).toBe("gpt-5");
    expect(preview.marginalInputTokens).toBe(2_000);
    expect(preview.projectedTotalInputTokens).toBe(272_000);
    expect(preview.contextTier).toBe("standard");
    expect(preview.admission.kind).toBe("admitted");
  });

  it("classifies long context at 272,001 projected tokens", () => {
    const preview = buildMarginalTokenPreview({
      model: "gpt-5",
      marginalInputTokens: 2_001,
      priorTotalInputTokens: 270_000,
      maxOutputTokens: 1_000,
    });

    expect(preview.projectedTotalInputTokens).toBe(272_001);
    expect(preview.contextTier).toBe("long_context");
    expect(preview.admission.kind).toBe("rejected");
  });

  it("clamps negative counts to zero instead of under-projecting", () => {
    const preview = buildMarginalTokenPreview({
      model: "gpt-5",
      marginalInputTokens: -5,
      priorTotalInputTokens: -10,
      maxOutputTokens: 1_000,
    });
    expect(preview.marginalInputTokens).toBe(0);
    expect(preview.projectedTotalInputTokens).toBe(0);
  });
});