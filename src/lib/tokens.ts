/**
 * Tokens — `src/lib/tokens.ts`
 *
 * Token projection, admission, and usage aggregation per
 * `docs/ARCHITECTURE.md` §16 (`Tokens → ProviderIO, Contracts`) and
 * `docs/TESTING.md` item 22.
 *
 * Invariants:
 * - Unknown models receive no guessed limits and are rejected at admission.
 * - Long-context classification uses the full request input token count
 *   (including cached input) and is strictly *above* 272,000 tokens.
 * - Usage is recorded once per call; missing usage and unknown pricing remain
 *   explicit (`null` cost) rather than estimated.
 */

import { LONG_CONTEXT_INPUT_TOKENS_THRESHOLD, getVerifiedGenerationModel } from "../constants.ts";
import type {
  ContextTier,
  MarginalTokenPreviewResponse,
  TokenAdmissionOutcome,
  TokenUsageRecord,
  UsageAggregate,
} from "../types.ts";

/** Field name of the shared long-context threshold (for diagnostics/tests). */
export const LONG_CONTEXT_THRESHOLD_TOKENS = LONG_CONTEXT_INPUT_TOKENS_THRESHOLD;

function requireFiniteCount(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`${label} must be a finite non-negative integer (got ${String(value)})`);
  }
  return value;
}

/**
 * Classifies a request by full input token count.
 *
 * The long-context tier applies only when the count is strictly greater than
 * 272,000; 272,000 itself remains standard.
 */
export function computeContextTier(inputTokens: number): ContextTier {
  const tokens = requireFiniteCount(inputTokens, "inputTokens");
  return tokens > LONG_CONTEXT_INPUT_TOKENS_THRESHOLD ? "long_context" : "standard";
}

export interface TokenAdmissionParams {
  readonly model: string;
  readonly projectedInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Evaluates whether a projected request fits the verified model profile.
 *
 * Rejections are explicit and never substitute a guessed profile:
 * - `unknown_model` — model absent from `VERIFIED_GENERATION_MODELS`.
 * - `context_window_exceeded` — input alone exceeds `maxInputTokens`, or
 *   input + requested output exceeds `contextWindowTokens`.
 * - `output_limit_exceeded` — `maxOutputTokens` is not positive or exceeds the
 *   model's `maxOutputTokens`.
 */
export function evaluateTokenAdmission(params: TokenAdmissionParams): TokenAdmissionOutcome {
  const projectedInputTokens = Number.isFinite(params.projectedInputTokens)
    ? Math.trunc(params.projectedInputTokens)
    : Number.NaN;

  const profile = getVerifiedGenerationModel(params.model);
  if (!profile) {
    return {
      kind: "rejected",
      reason: "unknown_model",
      projectedInputTokens: Number.isFinite(projectedInputTokens) ? projectedInputTokens : null,
      maxAllowedInputTokens: null,
      message: `Unknown generation model: ${params.model}`,
    };
  }

  if (!Number.isFinite(params.projectedInputTokens) || params.projectedInputTokens < 0) {
    return {
      kind: "rejected",
      reason: "context_window_exceeded",
      projectedInputTokens: null,
      maxAllowedInputTokens: profile.maxInputTokens,
      message: `Projected input tokens must be a finite non-negative number (got ${String(
        params.projectedInputTokens,
      )})`,
    };
  }

  if (
    !Number.isFinite(params.maxOutputTokens) ||
    params.maxOutputTokens < 1 ||
    !Number.isInteger(params.maxOutputTokens)
  ) {
    return {
      kind: "rejected",
      reason: "output_limit_exceeded",
      projectedInputTokens,
      maxAllowedInputTokens: profile.maxInputTokens,
      message: `maxOutputTokens must be a positive integer (got ${String(params.maxOutputTokens)})`,
    };
  }

  if (params.maxOutputTokens > profile.maxOutputTokens) {
    return {
      kind: "rejected",
      reason: "output_limit_exceeded",
      projectedInputTokens,
      maxAllowedInputTokens: profile.maxInputTokens,
      message: `maxOutputTokens ${params.maxOutputTokens} exceeds model limit ${profile.maxOutputTokens}`,
    };
  }

  if (projectedInputTokens > profile.maxInputTokens) {
    return {
      kind: "rejected",
      reason: "context_window_exceeded",
      projectedInputTokens,
      maxAllowedInputTokens: profile.maxInputTokens,
      message: `Projected input ${projectedInputTokens} exceeds model input limit ${profile.maxInputTokens}`,
    };
  }

  if (projectedInputTokens + params.maxOutputTokens > profile.contextWindowTokens) {
    return {
      kind: "rejected",
      reason: "context_window_exceeded",
      projectedInputTokens,
      maxAllowedInputTokens: Math.max(0, profile.contextWindowTokens - params.maxOutputTokens),
      message: `Projected input ${projectedInputTokens} plus max output ${params.maxOutputTokens} exceeds context window ${profile.contextWindowTokens}`,
    };
  }

  return {
    kind: "admitted",
    projectedInputTokens,
    maxAllowedInputTokens: profile.maxInputTokens,
    maxOutputTokens: params.maxOutputTokens,
    contextTier: computeContextTier(projectedInputTokens),
  };
}

function sumTokens(records: readonly TokenUsageRecord[], field: keyof TokenUsageRecord): number {
  let total = 0;
  for (const record of records) {
    const value = record[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value;
    }
  }
  return total;
}

export interface AggregateUsageParams {
  readonly generationUsage: readonly (TokenUsageRecord | null)[];
  readonly judgeUsage: readonly (TokenUsageRecord | null)[];
}

/**
 * Aggregates recorded per-call usage without inventing values.
 *
 * Costs are split by pipeline. Calls whose usage was not returned count as
 * `missingUsageCalls`. Calls with `pricingKnown: false` count as
 * `unknownPricingCalls`; each pipeline's cost line nulls only on its own
 * unknown pricing, so an unpriced judge model never poisons the generation
 * total. `totalEstimatedCostUsd` is the combined sum, null unless both lines
 * are known.
 */
export function aggregateUsage(params: AggregateUsageParams): UsageAggregate {
  const generationUsage = params.generationUsage;
  const judgeUsage = params.judgeUsage;
  const knownGeneration = generationUsage.filter(
    (record): record is TokenUsageRecord => record !== null,
  );
  const knownJudge = judgeUsage.filter(
    (record): record is TokenUsageRecord => record !== null,
  );
  const allKnown = [...knownGeneration, ...knownJudge];

  const missingUsageCalls =
    generationUsage.length -
    knownGeneration.length +
    (judgeUsage.length - knownJudge.length);

  const unknownGenerationPricingCalls = knownGeneration.filter(
    (record) => !record.pricingKnown,
  ).length;
  const unknownJudgePricingCalls = knownJudge.filter(
    (record) => !record.pricingKnown,
  ).length;
  const unknownPricingCalls = unknownGenerationPricingCalls + unknownJudgePricingCalls;

  const sumCost = (records: readonly TokenUsageRecord[]): number =>
    records.reduce((total, record) => total + (record.estimatedCostUsd ?? 0), 0);
  const generationCostUsd =
    unknownGenerationPricingCalls > 0 ? null : sumCost(knownGeneration);
  const judgeCostUsd = unknownJudgePricingCalls > 0 ? null : sumCost(knownJudge);

  return {
    generationCalls: generationUsage.length,
    judgeCalls: judgeUsage.length,
    missingUsageCalls,
    unknownPricingCalls,
    unknownJudgePricingCalls,
    inputTokens: sumTokens(allKnown, "inputTokens"),
    cachedInputTokens: sumTokens(allKnown, "cachedInputTokens"),
    outputTokens: sumTokens(allKnown, "outputTokens"),
    reasoningTokens: sumTokens(allKnown, "reasoningTokens"),
    totalTokens: sumTokens(allKnown, "totalTokens"),
    judgeTokens: sumTokens(knownJudge, "totalTokens"),
    totalEstimatedCostUsd:
      generationCostUsd === null || judgeCostUsd === null
        ? null
        : generationCostUsd + judgeCostUsd,
    generationCostUsd,
    judgeCostUsd,
  };
}

export interface MarginalTokenPreviewParams {
  readonly model: string;
  readonly marginalInputTokens: number;
  readonly priorTotalInputTokens: number;
  readonly maxOutputTokens: number;
}

/**
 * Projects a next-call input count and evaluates admission against the model profile.
 */
export function buildMarginalTokenPreview(
  params: MarginalTokenPreviewParams,
): MarginalTokenPreviewResponse {
  const marginalInputTokens = Number.isFinite(params.marginalInputTokens)
    ? Math.max(0, Math.trunc(params.marginalInputTokens))
    : 0;
  const priorTotalInputTokens = Number.isFinite(params.priorTotalInputTokens)
    ? Math.max(0, Math.trunc(params.priorTotalInputTokens))
    : 0;
  const projectedTotalInputTokens = marginalInputTokens + priorTotalInputTokens;

  return {
    model: params.model,
    marginalInputTokens,
    projectedTotalInputTokens,
    contextTier: computeContextTier(projectedTotalInputTokens),
    admission: evaluateTokenAdmission({
      model: params.model,
      projectedInputTokens: projectedTotalInputTokens,
      maxOutputTokens: params.maxOutputTokens,
    }),
  };
}