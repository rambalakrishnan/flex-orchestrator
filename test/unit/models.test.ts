// Covers: 7, 22

import { describe, expect, it } from "vitest";
import {
  LONG_CONTEXT_INPUT_TOKENS_THRESHOLD,
  VERIFIED_GENERATION_MODELS,
  getVerifiedGenerationModel,
} from "../../src/constants.ts";
import { evaluateTokenAdmission } from "../../src/lib/tokens.ts";
import type {
  ReasoningEffortLevel,
  VerifiedGenerationModelMetadata,
} from "../../src/constants.ts";
import type { TokenAdmissionOutcome } from "../../src/types.ts";

const NEW_MODEL_IDS = [
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-luna",
] as const;

const PRIOR_MODEL_IDS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3",
  "o4-mini",
] as const;

const EXPECTED_CACHE_TTLS = ["30m", "12h", "24h", "nocache"] as const;

const NEW_MODEL_SHARED_LIMITS = {
  contextWindowTokens: 1_050_000,
  maxInputTokens: 922_000,
  maxOutputTokens: 128_000,
  defaultMaxOutputTokens: 128_000,
  longContextThresholdTokens: 272_000,
  supportsFlexBackground: true,
  supportsWebSearch: true,
  supportsStatefulContinuity: true,
} as const;

interface PricingTierExpectation {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

interface NewModelCase {
  readonly id: (typeof NEW_MODEL_IDS)[number];
  readonly supportedReasoningEfforts: readonly ReasoningEffortLevel[];
  readonly standardPricing: PricingTierExpectation;
  readonly longContextPricing: PricingTierExpectation;
}

const NEW_MODEL_CASES: NewModelCase[] = [
  {
    id: "gpt-6-astra",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    standardPricing: {
      inputUsdPerMillion: 10.0,
      cachedInputUsdPerMillion: 1.0,
      outputUsdPerMillion: 50.0,
    },
    longContextPricing: {
      inputUsdPerMillion: 20.0,
      cachedInputUsdPerMillion: 2.0,
      outputUsdPerMillion: 75.0,
    },
  },
  {
    id: "gpt-6.1-sol",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    standardPricing: {
      inputUsdPerMillion: 2.0,
      cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 10.0,
    },
    longContextPricing: {
      inputUsdPerMillion: 4.0,
      cachedInputUsdPerMillion: 0.2,
      outputUsdPerMillion: 15.0,
    },
  },
  {
    id: "gpt-6.1-terra",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    standardPricing: {
      inputUsdPerMillion: 1.0,
      cachedInputUsdPerMillion: 0.05,
      outputUsdPerMillion: 5.0,
    },
    longContextPricing: {
      inputUsdPerMillion: 2.0,
      cachedInputUsdPerMillion: 0.1,
      outputUsdPerMillion: 7.5,
    },
  },
  {
    id: "gpt-6-luna",
    supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    standardPricing: {
      inputUsdPerMillion: 0.1,
      cachedInputUsdPerMillion: 0.01,
      outputUsdPerMillion: 0.5,
    },
    longContextPricing: {
      inputUsdPerMillion: 0.2,
      cachedInputUsdPerMillion: 0.02,
      outputUsdPerMillion: 0.75,
    },
  },
];

function requireProfile(modelId: string): VerifiedGenerationModelMetadata {
  const profile = VERIFIED_GENERATION_MODELS[modelId];
  if (!profile) {
    throw new Error(`Expected verified generation model metadata for ${modelId}`);
  }
  return profile;
}

function rejectionReason(outcome: TokenAdmissionOutcome): string {
  if (outcome.kind !== "rejected") {
    throw new Error(`Expected a rejection but admission was ${outcome.kind}`);
  }
  return outcome.reason;
}

describe("VERIFIED_GENERATION_MODELS", () => {
  it("exposes exactly the four new ids plus the five prior ones", () => {
    expect(LONG_CONTEXT_INPUT_TOKENS_THRESHOLD).toBe(272_000);
    expect(Object.keys(VERIFIED_GENERATION_MODELS).sort()).toEqual(
      [...PRIOR_MODEL_IDS, ...NEW_MODEL_IDS].sort(),
    );

    for (const id of [...PRIOR_MODEL_IDS, ...NEW_MODEL_IDS]) {
      expect(requireProfile(id).id).toBe(id);
    }
  });

  it.each(NEW_MODEL_CASES)(
    "pins the shared token limits for $id",
    ({ id }) => {
      const profile = requireProfile(id);

      expect(profile.contextWindowTokens).toBe(
        NEW_MODEL_SHARED_LIMITS.contextWindowTokens,
      );
      expect(profile.maxInputTokens).toBe(NEW_MODEL_SHARED_LIMITS.maxInputTokens);
      expect(profile.maxOutputTokens).toBe(
        NEW_MODEL_SHARED_LIMITS.maxOutputTokens,
      );
      expect(profile.defaultMaxOutputTokens).toBe(
        NEW_MODEL_SHARED_LIMITS.defaultMaxOutputTokens,
      );
      expect(profile.longContextThresholdTokens).toBe(
        NEW_MODEL_SHARED_LIMITS.longContextThresholdTokens,
      );
      expect(profile.longContextThresholdTokens).toBe(
        LONG_CONTEXT_INPUT_TOKENS_THRESHOLD,
      );
      expect(profile.supportsFlexBackground).toBe(true);
      expect(profile.supportsWebSearch).toBe(true);
      expect(profile.supportsStatefulContinuity).toBe(true);
      expect(profile.supportedCacheTtls).toEqual([...EXPECTED_CACHE_TTLS]);
    },
  );

  it.each(NEW_MODEL_CASES)(
    "pins the standard and long-context pricing for $id",
    ({ id, standardPricing, longContextPricing }) => {
      const profile = requireProfile(id);

      expect(profile.standardPricing).toEqual(standardPricing);
      expect(profile.longContextPricing).toEqual(longContextPricing);
    },
  );

  it.each(NEW_MODEL_CASES)(
    "pins supported reasoning efforts for $id",
    ({ id, supportedReasoningEfforts }) => {
      const profile = requireProfile(id);

      expect(profile.supportedReasoningEfforts).toEqual(
        supportedReasoningEfforts,
      );
      expect(supportedReasoningEfforts).toContain(profile.defaultReasoningEffort);
    },
  );
});

describe("getVerifiedGenerationModel", () => {
  it("returns the verified profile for a known id", () => {
    const profile = getVerifiedGenerationModel("gpt-6-astra");

    expect(profile).toBe(VERIFIED_GENERATION_MODELS["gpt-6-astra"]);
    expect(profile?.id).toBe("gpt-6-astra");
    expect(profile?.displayName).toBe("GPT-6 Astra");
  });

  it("returns undefined for an unknown id without guessing a profile", () => {
    expect(getVerifiedGenerationModel("gpt-6-unknown")).toBeUndefined();
    expect(getVerifiedGenerationModel("")).toBeUndefined();
    expect(getVerifiedGenerationModel("constructor")).toBeUndefined();
  });
});

describe("evaluateTokenAdmission against gpt-6-astra", () => {
  const ASTRA = "gpt-6-astra";

  it("admits 922,000 input plus 128,000 output at the exact context window", () => {
    const outcome = evaluateTokenAdmission({
      model: ASTRA,
      projectedInputTokens: 922_000,
      maxOutputTokens: 128_000,
    });

    expect(outcome).toEqual({
      kind: "admitted",
      projectedInputTokens: 922_000,
      maxAllowedInputTokens: 922_000,
      maxOutputTokens: 128_000,
      contextTier: "long_context",
    });
  });

  it("rejects 922,001 input at the maximum input limit", () => {
    const outcome = evaluateTokenAdmission({
      model: ASTRA,
      projectedInputTokens: 922_001,
      maxOutputTokens: 128_000,
    });

    expect(rejectionReason(outcome)).toBe("context_window_exceeded");
    if (outcome.kind === "rejected") {
      expect(outcome.projectedInputTokens).toBe(922_001);
      expect(outcome.maxAllowedInputTokens).toBe(922_000);
    }
  });

  it("rejects a requested output limit of 128,001", () => {
    const outcome = evaluateTokenAdmission({
      model: ASTRA,
      projectedInputTokens: 1_000,
      maxOutputTokens: 128_001,
    });

    expect(rejectionReason(outcome)).toBe("output_limit_exceeded");
    if (outcome.kind === "rejected") {
      expect(outcome.projectedInputTokens).toBe(1_000);
      expect(outcome.maxAllowedInputTokens).toBe(922_000);
    }
  });

  it("admits 272,001 input as long context, below the 922,000 input limit", () => {
    const outcome = evaluateTokenAdmission({
      model: ASTRA,
      projectedInputTokens: 272_001,
      maxOutputTokens: 128_000,
    });

    expect(outcome).toEqual({
      kind: "admitted",
      projectedInputTokens: 272_001,
      maxAllowedInputTokens: 922_000,
      maxOutputTokens: 128_000,
      contextTier: "long_context",
    });
  });

  it("retains the prior-model 272,000 maximum input boundary", () => {
    const outcome = evaluateTokenAdmission({
      model: "gpt-5",
      projectedInputTokens: 272_001,
      maxOutputTokens: 128_000,
    });

    expect(rejectionReason(outcome)).toBe("context_window_exceeded");
    if (outcome.kind === "rejected") {
      expect(outcome.projectedInputTokens).toBe(272_001);
      expect(outcome.maxAllowedInputTokens).toBe(272_000);
    }
  });
});
