/**
 * Fixed project limits, platform-fixed behavioral bounds, compatibility contract,
 * and verified generation-model metadata for flex-orchestrator.
 *
 * NOTE: Incoming Worker HTTP request body size ceilings (100 MB Free/Pro,
 * 200 MB Business, up to 5 GB Enterprise) depend on the Cloudflare zone plan
 * rather than the Workers plan and are intentionally not hard-coded here.
 */

// ---------------------------------------------------------------------------
// 1. Compatibility Contract (Cross 4)
// ---------------------------------------------------------------------------

/**
 * Workers runtime compatibility contract documented for review visibility.
 * Changes to `wrangler.toml` compatibility settings must remain aligned with
 * the assumptions in `HttpHelpers` and `SignatureAuth`.
 */
export const COMPATIBILITY = {
  /** Workers compatibility date configured in wrangler.toml. */
  COMPATIBILITY_DATE: "2026-11-01",
  /**
   * Whether `request.signal` abort propagation on incoming requests is enabled
   * via the `enable_request_signal` compatibility flag.
   */
  ENABLE_REQUEST_SIGNAL: false,
  /**
   * Whether `nodejs_compat` is required. This Worker relies strictly on standard
   * Web APIs (`crypto.subtle`, `TextEncoder`, Web Streams) and Workers bindings.
   */
  NODEJS_COMPAT: false,
} as const;

// ---------------------------------------------------------------------------
// 2. Storage, Artifact, Upload, and Pagination Limits
// ---------------------------------------------------------------------------

/**
 * Project-enforced guard on every individual artifact BLOB/text field and every
 * resulting SQLite row (1,500,000 bytes).
 *
 * IMPORTANT: This is NOT the Cloudflare Durable Object SQLite hard ceiling
 * (which is 2 MB / 2,097,152 bytes). The 1,500,000-byte guard leaves ~500 KB of
 * headroom for bounded control metadata and diagnostics sharing the row.
 * Oversized artifacts must fail explicitly and never be silently truncated.
 */
export const ARTIFACT_ROW_GUARD_BYTES = 1_500_000 as const;

/** Alias for `ARTIFACT_ROW_GUARD_BYTES` used by schema and artifact validators. */
export const ARTIFACT_GUARD_BYTES = ARTIFACT_ROW_GUARD_BYTES;

/** Alias for `ARTIFACT_ROW_GUARD_BYTES` for row-level size budget checks. */
export const ROW_GUARD_BYTES = ARTIFACT_ROW_GUARD_BYTES;

/**
 * Platform-fixed Durable Object SQLite maximum string, BLOB, or row size (2 MB).
 * Documented for reference only; application logic must enforce `ARTIFACT_ROW_GUARD_BYTES`.
 */
export const PLATFORM_SQLITE_MAX_ROW_BYTES = 2_097_152 as const;

/**
 * Platform-fixed Durable Object isolate memory ceiling (128 MB shared across
 * all DO instances on the same isolate).
 */
export const PLATFORM_ISOLATE_MEMORY_BYTES = 134_217_728 as const;

/**
 * Maximum allowed client file upload size (16,000,000 bytes).
 * Multipart parsing, buffering, and hashing must remain bounded to this limit.
 */
export const MAX_FILE_UPLOAD_BYTES = 16_000_000 as const;

/** Alias for `MAX_FILE_UPLOAD_BYTES`. */
export const FILE_UPLOAD_LIMIT_BYTES = MAX_FILE_UPLOAD_BYTES;

/**
 * Maximum encoded size of a branch initialization snapshot (8,000,000 bytes).
 */
export const MAX_BRANCH_SNAPSHOT_BYTES = 8_000_000 as const;

/** Alias for `MAX_BRANCH_SNAPSHOT_BYTES`. */
export const BRANCH_SNAPSHOT_LIMIT_BYTES = MAX_BRANCH_SNAPSHOT_BYTES;

/**
 * Default bounded JSON control-payload limit for ordinary API requests (262,144 bytes).
 */
export const DEFAULT_MAX_JSON_BODY_BYTES = 262_144 as const;

/** Minimum page size for primary-key cursor pagination. */
export const LIST_PAGE_LIMIT_MIN = 1 as const;

/** Maximum page size for primary-key cursor pagination (omits BLOBs). */
export const LIST_PAGE_LIMIT_MAX = 100 as const;

/** Default page size for primary-key cursor pagination when unspecified. */
export const LIST_PAGE_LIMIT_DEFAULT = 50 as const;

/** Default file retention window in seconds (7 days) when env string is unparsed. */
export const DEFAULT_FILE_RETENTION_SECONDS = 604_800 as const;

// ---------------------------------------------------------------------------
// 3. Execution, Recovery, Polling, and Webhook Timing Budgets
// ---------------------------------------------------------------------------

/**
 * Cumulative automatic continuations permitted per turn, fixed at job creation.
 */
export const MAX_AUTO_CONTINUATIONS_PER_TURN = 3 as const;

/**
 * Cumulative automatic full retries permitted per turn, fixed at job creation.
 * Manual retry does not reset automatic recovery counters.
 */
export const MAX_AUTO_FULL_RETRIES = 1 as const;

/**
 * Maximum Flex capacity sends permitted per generation attempt with persisted
 * exponential backoff.
 */
export const MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT = 5 as const;

/**
 * Base delay in milliseconds for project-level Flex capacity send exponential backoff.
 */
export const FLEX_CAPACITY_BACKOFF_BASE_MS = 5_000 as const;

/**
 * Maximum delay in milliseconds for project-level Flex capacity send exponential backoff.
 */
export const FLEX_CAPACITY_BACKOFF_MAX_MS = 300_000 as const;

/**
 * Fallback polling schedule intervals in milliseconds:
 * 1st probe after 5 minutes, 2nd probe 1 minute later, subsequent probes every 5 minutes.
 */
export const FALLBACK_POLL_FIRST_DELAY_MS = 300_000 as const;
export const FALLBACK_POLL_SECOND_DELAY_MS = 60_000 as const;
export const FALLBACK_POLL_STEADY_DELAY_MS = 300_000 as const;

/** Ordered fallback polling schedule steps in milliseconds: [5m, 1m, 5m]. */
export const FALLBACK_POLL_SCHEDULE_MS = [
  FALLBACK_POLL_FIRST_DELAY_MS,
  FALLBACK_POLL_SECOND_DELAY_MS,
  FALLBACK_POLL_STEADY_DELAY_MS,
] as const;

/**
 * Maximum number of fallback poll probes per active attempt before failing/pausing.
 */
export const MAX_FALLBACK_POLL_PROBES = 24 as const;

/** Alias for `MAX_FALLBACK_POLL_PROBES`. */
export const FALLBACK_POLL_MAX_PROBES = MAX_FALLBACK_POLL_PROBES;

/**
 * Standard Webhooks delivery-timestamp tolerance in seconds (300 seconds / 5 minutes).
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300 as const;

/**
 * Browser active-work state polling interval in milliseconds (12 seconds).
 */
export const BROWSER_POLL_INTERVAL_MS = 12_000 as const;

/** Browser active-work state polling interval in seconds (12 seconds). */
export const BROWSER_POLL_INTERVAL_SECONDS = 12 as const;

// ---------------------------------------------------------------------------
// 4. Platform-Fixed Durable Object & Worker Runtime Bounds (Non-Tunable)
// ---------------------------------------------------------------------------

/**
 * PLATFORM-FIXED (NON-TUNABLE): Maximum automatic retries performed by the
 * Cloudflare Durable Objects runtime when `alarm()` throws. There is no API
 * to raise or configure this budget; handlers must reschedule before exhausting it.
 */
export const PLATFORM_ALARM_MAX_RETRIES = 6 as const;

/** Alias for `PLATFORM_ALARM_MAX_RETRIES` (platform-fixed, non-tunable). */
export const ALARM_MAX_RETRIES = PLATFORM_ALARM_MAX_RETRIES;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Initial backoff delay in milliseconds (2 seconds)
 * used by Cloudflare Durable Objects when retrying a failed `alarm()` invocation.
 */
export const PLATFORM_ALARM_RETRY_BASE_DELAY_MS = 2_000 as const;

/** Alias for `PLATFORM_ALARM_RETRY_BASE_DELAY_MS` (platform-fixed, non-tunable). */
export const ALARM_RETRY_BASE_DELAY_MS = PLATFORM_ALARM_RETRY_BASE_DELAY_MS;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Hard 30-second timeout applied by the runtime
 * to `state.blockConcurrencyWhile()` callbacks. Exceeding this resets the Durable
 * Object. Slow migrations must be split rather than attempting to raise this value.
 */
export const PLATFORM_BLOCK_CONCURRENCY_TIMEOUT_MS = 30_000 as const;

/** Alias for `PLATFORM_BLOCK_CONCURRENCY_TIMEOUT_MS` (platform-fixed, non-tunable). */
export const MIGRATION_LOCK_TIMEOUT_MS = PLATFORM_BLOCK_CONCURRENCY_TIMEOUT_MS;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Maximum wall-clock execution time (15 minutes)
 * for a single Durable Object `alarm()` invocation.
 */
export const PLATFORM_ALARM_MAX_WALL_TIME_MS = 900_000 as const;

/**
 * PLATFORM-FIXED (NON-TUNABLE): Maximum tail lifetime (30 seconds) for
 * `ctx.waitUntil()` after the HTTP response has been returned.
 */
export const PLATFORM_WAIT_UNTIL_MAX_TAIL_MS = 30_000 as const;

// ---------------------------------------------------------------------------
// 5. OpenAI Responses, Files API, Webhook, and Token Constants
// ---------------------------------------------------------------------------

/**
 * Full request input token threshold (including cached input tokens) above
 * which a request is classified as long-context (272,000 tokens).
 */
export const LONG_CONTEXT_INPUT_TOKENS_THRESHOLD = 272_000 as const;

/** Required service tier for all generation dispatches; never falls back to standard. */
export const GENERATION_SERVICE_TIER = "flex" as const;

/** Required purpose for client-submitted Files API uploads. */
export const OPENAI_FILE_UPLOAD_PURPOSE = "user_data" as const;

/** Explicit cache retention selections supported by job configuration. */
export const CACHE_TTL_CHOICES = ["30m", "12h", "24h", "nocache"] as const;
export type CacheTtlChoice = (typeof CACHE_TTL_CHOICES)[number];

/** Supported reasoning effort levels for generation models. */
export const REASONING_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

/** OpenAI webhook event types subscribed to and handled by RouterDO. */
export const OPENAI_WEBHOOK_EVENT_TYPES = [
  "response.completed",
  "response.cancelled",
  "response.failed",
  "response.incomplete",
] as const;
export type OpenAIWebhookEventType = (typeof OPENAI_WEBHOOK_EVENT_TYPES)[number];

/** Webhook endpoint pathname served exclusively on the configured `env.HOOKS_HOST`. */
export const WEBHOOK_OPENAI_PATH = "/openai" as const;

/** Canonical singleton Durable Object names for global coordinators. */
export const REGISTRY_DO_NAME = "global-registry" as const;
export const ROUTER_DO_NAME = "global-router" as const;

// ---------------------------------------------------------------------------
// 6. Judge Configuration Reference Constants
// ---------------------------------------------------------------------------

export const JUDGE_TRANSPORTS = ["responses", "chat_completions"] as const;
export type JudgeTransport = (typeof JUDGE_TRANSPORTS)[number];

export const JUDGE_HISTORY_MODES = ["chained", "stateless"] as const;
export type JudgeHistoryMode = (typeof JUDGE_HISTORY_MODES)[number];

export const JUDGE_FILE_DELIVERY_MODES = ["passthrough", "inline"] as const;
export type JudgeFileDeliveryMode = (typeof JUDGE_FILE_DELIVERY_MODES)[number];

/** Exact five required output fields validated on every judge response. */
export const JUDGE_OUTPUT_FIELDS = [
  "verdict",
  "grade",
  "comment",
  "tag_agreement",
  "file_visibility",
] as const;

// ---------------------------------------------------------------------------
// 7. Verified Generation-Model Metadata
// ---------------------------------------------------------------------------

/**
 * Per-million-token pricing tier in USD.
 */
export interface TokenPricingTierUsdPerMillion {
  readonly inputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

/**
 * Verified capability, token limit, and pricing metadata for an allowed
 * OpenAI Responses Flex generation model. Unknown models receive no guessed
 * limits or fallback profile.
 */
export interface VerifiedGenerationModelMetadata {
  /** Canonical model identifier sent in the OpenAI Responses request. */
  readonly id: string;
  /** Human-readable display label for the UI. */
  readonly displayName: string;
  /** Maximum total context window in tokens (input + output). */
  readonly contextWindowTokens: number;
  /** Maximum total input tokens permitted in a single request. */
  readonly maxInputTokens: number;
  /** Maximum `max_output_tokens` value permitted for this model. */
  readonly maxOutputTokens: number;
  /** Default `max_output_tokens` pre-populated in the UI. */
  readonly defaultMaxOutputTokens: number;
  /** Input token threshold above which long-context pricing applies (`null` if flat). */
  readonly longContextThresholdTokens: number | null;
  /** Supported `reasoning.effort` levels for this model. */
  readonly supportedReasoningEfforts: readonly ReasoningEffortLevel[];
  /** Default `reasoning.effort` level for this model. */
  readonly defaultReasoningEffort: ReasoningEffortLevel;
  /** Whether the model supports `service_tier: "flex"` with `background: true`. */
  readonly supportsFlexBackground: true;
  /** Whether the model supports the built-in `{ type: "web_search" }` tool. */
  readonly supportsWebSearch: boolean;
  /** Whether the model supports stateful reasoning continuity (`previous_response_id`). */
  readonly supportsStatefulContinuity: boolean;
  /** Supported explicit cache retention choices. */
  readonly supportedCacheTtls: readonly CacheTtlChoice[];
  /** Standard pricing tier (for input tokens <= `longContextThresholdTokens`). */
  readonly standardPricing: TokenPricingTierUsdPerMillion;
  /** Long-context pricing tier (for input tokens > `longContextThresholdTokens`, or `null` if N/A). */
  readonly longContextPricing: TokenPricingTierUsdPerMillion | null;
}

/**
 * Authoritative registry of verified generation models.
 * Unknown models are rejected at admission/validation and never receive guessed limits.
 */
export const VERIFIED_GENERATION_MODELS: Readonly<
  Record<string, VerifiedGenerationModelMetadata>
> = {
  "gpt-5": {
    id: "gpt-5",
    displayName: "GPT-5",
    contextWindowTokens: 400_000,
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 32_768,
    longContextThresholdTokens: LONG_CONTEXT_INPUT_TOKENS_THRESHOLD,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    supportsFlexBackground: true,
    supportsWebSearch: true,
    supportsStatefulContinuity: true,
    supportedCacheTtls: ["30m", "12h", "24h", "nocache"],
    standardPricing: {
      inputUsdPerMillion: 0.625,
      cachedInputUsdPerMillion: 0.0625,
      outputUsdPerMillion: 5.0,
    },
    longContextPricing: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 7.5,
    },
  },
  "gpt-5-mini": {
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    contextWindowTokens: 400_000,
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 16_384,
    longContextThresholdTokens: LONG_CONTEXT_INPUT_TOKENS_THRESHOLD,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    supportsFlexBackground: true,
    supportsWebSearch: true,
    supportsStatefulContinuity: true,
    supportedCacheTtls: ["30m", "12h", "24h", "nocache"],
    standardPricing: {
      inputUsdPerMillion: 0.125,
      cachedInputUsdPerMillion: 0.0125,
      outputUsdPerMillion: 1.0,
    },
    longContextPricing: null,
  },
  "gpt-5-nano": {
    id: "gpt-5-nano",
    displayName: "GPT-5 Nano",
    contextWindowTokens: 400_000,
    maxInputTokens: 272_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 8_192,
    longContextThresholdTokens: LONG_CONTEXT_INPUT_TOKENS_THRESHOLD,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "low",
    supportsFlexBackground: true,
    supportsWebSearch: false,
    supportsStatefulContinuity: true,
    supportedCacheTtls: ["30m", "12h", "24h", "nocache"],
    standardPricing: {
      inputUsdPerMillion: 0.025,
      cachedInputUsdPerMillion: 0.0025,
      outputUsdPerMillion: 0.2,
    },
    longContextPricing: null,
  },
  "o3": {
    id: "o3",
    displayName: "o3",
    contextWindowTokens: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 100_000,
    defaultMaxOutputTokens: 32_768,
    longContextThresholdTokens: null,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "high",
    supportsFlexBackground: true,
    supportsWebSearch: true,
    supportsStatefulContinuity: true,
    supportedCacheTtls: ["30m", "12h", "24h", "nocache"],
    standardPricing: {
      inputUsdPerMillion: 1.0,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 4.0,
    },
    longContextPricing: null,
  },
  "o4-mini": {
    id: "o4-mini",
    displayName: "o4-mini",
    contextWindowTokens: 200_000,
    maxInputTokens: 200_000,
    maxOutputTokens: 100_000,
    defaultMaxOutputTokens: 16_384,
    longContextThresholdTokens: null,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    supportsFlexBackground: true,
    supportsWebSearch: true,
    supportsStatefulContinuity: true,
    supportedCacheTtls: ["30m", "12h", "24h", "nocache"],
    standardPricing: {
      inputUsdPerMillion: 0.55,
      cachedInputUsdPerMillion: 0.138,
      outputUsdPerMillion: 2.2,
    },
    longContextPricing: null,
  },
} as const;

/** Ordered list of verified generation model identifiers. */
export const VERIFIED_GENERATION_MODEL_IDS = Object.freeze(
  Object.keys(VERIFIED_GENERATION_MODELS),
);

/**
 * Look up verified generation-model metadata by exact model ID.
 * Returns `undefined` for unknown models — never substitutes a fallback profile.
 */
export function getVerifiedGenerationModel(
  modelId: string,
): VerifiedGenerationModelMetadata | undefined {
  return Object.prototype.hasOwnProperty.call(VERIFIED_GENERATION_MODELS, modelId)
    ? VERIFIED_GENERATION_MODELS[modelId]
    : undefined;
}

/**
 * Type guard checking whether `modelId` is a verified generation model.
 */
export function isVerifiedGenerationModel(modelId: string): boolean {
  return getVerifiedGenerationModel(modelId) !== undefined;
}
