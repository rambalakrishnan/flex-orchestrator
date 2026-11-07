// Judge provider fixtures for `src/lib/judge.ts` (README.md §Provider Configurations).
//
// Every factory returns an operator-declared judge contract. The adapter is
// operator-authoritative, so these fixtures only mirror the README reference
// rows plus the inconsistent declarations that must warn or produce an
// unencodable outcome.

import type {
  EnabledJudgeConfig,
  JudgeApplicableFile,
  PriorAcceptedOutput,
} from "../../src/lib/judge.ts";
import type { FileId, TurnIndex } from "../../src/types.ts";

/** Canonical OpenAI API root. */
export const OPENAI_JUDGE_API_ROOT = "https://api.openai.com/v1";

/** Non-OpenAI passthrough root: a proxy that can forward to the Files API. */
export const PROXY_JUDGE_API_ROOT = "https://proxy.internal/v1";

/** Meta judge root used by the README reference row. */
export const META_JUDGE_API_ROOT = "https://api.meta.internal/v1";

/** OpenRouter judge root used by the README reference row. */
export const OPENROUTER_JUDGE_API_ROOT = "https://openrouter.ai/api/v1";

/**
 * Builds a declared enabled judge config. Defaults describe the README
 * OpenAI row (Responses / Chained / Passthrough); overrides replace any
 * declared capability.
 */
export function enabledJudgeConfig(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return {
    enabled: true,
    provider: "openai",
    apiRoot: OPENAI_JUDGE_API_ROOT,
    secretName: "OPENAI_API_KEY",
    model: "gpt-5-judge",
    transport: "responses",
    historyMode: "chained",
    fileDeliveryMode: "passthrough",
    includePrior: false,
    maxGradeThreshold: 100,
    ...overrides,
  };
}

/** README row: OpenAI — Responses / Chained / Passthrough. */
export function openAiJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return enabledJudgeConfig({ provider: "openai", ...overrides });
}

/** README row: Meta — Responses / Chained / Passthrough. */
export function metaPassthroughJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return enabledJudgeConfig({
    provider: "meta",
    apiRoot: META_JUDGE_API_ROOT,
    fileDeliveryMode: "passthrough",
    ...overrides,
  });
}

/** README row: Meta — Responses / Chained / Inline. */
export function metaInlineJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return enabledJudgeConfig({
    provider: "meta",
    apiRoot: META_JUDGE_API_ROOT,
    fileDeliveryMode: "inline",
    ...overrides,
  });
}

/** README row: OpenRouter — Responses / Stateless / Inline. */
export function openRouterJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return enabledJudgeConfig({
    provider: "openrouter",
    apiRoot: OPENROUTER_JUDGE_API_ROOT,
    model: "openrouter/judge-model",
    historyMode: "stateless",
    fileDeliveryMode: "inline",
    ...overrides,
  });
}

/** README row: any provider — Chat Completions / Stateless / Inline. */
export function chatCompletionsJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return enabledJudgeConfig({
    provider: "chat-completions",
    transport: "chat_completions",
    historyMode: "stateless",
    fileDeliveryMode: "inline",
    ...overrides,
  });
}

/**
 * Inconsistent declaration: Chat Completions has no stateful response-history
 * mechanism, so `chained` can only warn and encode stateless.
 */
export function chatCompletionsChainedJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return chatCompletionsJudge({ historyMode: "chained", ...overrides });
}

/**
 * Inconsistent declaration: Chat Completions has no file-id passthrough
 * mechanism, so the contract is unencodable.
 */
export function chatCompletionsPassthroughJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return chatCompletionsJudge({ fileDeliveryMode: "passthrough", ...overrides });
}

/**
 * Inconsistent declaration: Responses with chained history and inline file
 * delivery. Encodable, but each file can only be introduced once.
 */
export function inlineChainedJudge(
  overrides: Partial<EnabledJudgeConfig> = {},
): EnabledJudgeConfig {
  return openAiJudge({ fileDeliveryMode: "inline", ...overrides });
}

/** All README reference configurations. */
export const README_JUDGE_CONFIGS: readonly EnabledJudgeConfig[] = [
  openAiJudge(),
  metaPassthroughJudge(),
  metaInlineJudge(),
  openRouterJudge(),
  chatCompletionsJudge(),
];

/** Declarations that are inconsistent (warn) or unencodable. */
export const INCONSISTENT_JUDGE_CONFIGS: readonly EnabledJudgeConfig[] = [
  chatCompletionsChainedJudge(),
  chatCompletionsPassthroughJudge(),
  inlineChainedJudge(),
];

/** Overrides accepted by {@link applicableFile}. */
export interface ApplicableFileOverrides {
  readonly filename?: string;
  readonly mimeType?: string;
  readonly byteSize?: number;
  readonly bytes?: Uint8Array | ArrayBuffer | null;
  readonly alreadyIntroduced?: boolean;
}

/**
 * Builds an applicable judge file. `bytes` is optional (passthrough does not
 * need it; inline delivery requires it). `alreadyIntroduced` marks a file an
 * earlier stateful judge call already attached.
 */
export function applicableFile(
  fileId: FileId,
  overrides: ApplicableFileOverrides = {},
): JudgeApplicableFile {
  const bytes = overrides.bytes;
  const byteSize =
    overrides.byteSize ??
    (bytes === undefined || bytes === null
      ? 0
      : bytes instanceof Uint8Array
        ? bytes.byteLength
        : bytes.byteLength);
  return {
    fileId,
    filename: overrides.filename ?? `${fileId}.txt`,
    mimeType: overrides.mimeType ?? "text/plain",
    byteSize,
    ...(bytes === undefined ? {} : { bytes }),
    ...(overrides.alreadyIntroduced === undefined
      ? {}
      : { alreadyIntroduced: overrides.alreadyIntroduced }),
  };
}

/** Builds a prior accepted-output block for stateless `includePrior` context. */
export function priorAcceptedOutput(
  turnIndex: TurnIndex,
  deliverableText: string,
  attachmentFileIds: readonly FileId[] = [],
): PriorAcceptedOutput {
  return { turnIndex, deliverableText, attachmentFileIds };
}