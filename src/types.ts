/**
 * CoreTypes — `src/types.ts`
 *
 * Shared configuration, state, and wire data types for flex-orchestrator.
 *
 * Invariants & Runtime Boundaries:
 * - Every wire type crossing a Durable Object RPC boundary MUST be structured-cloneable
 *   (`string | number | boolean | null | undefined | ArrayBuffer | Uint8Array | Array | plain object`).
 * - NEVER use `class` instances with methods, `Function`, `Promise`, `Symbol`, `WeakMap`, `WeakSet`,
 *   or Node.js `Buffer` in RPC wire types.
 * - Binary payloads use `ArrayBuffer` or `Uint8Array` (never `Buffer`).
 * - Numeric IDs, byte counts, token counts, and epoch-millisecond timestamps use `number`
 *   (safe within 52-bit IEEE 754 integer precision; never `bigint`).
 * - Variant outcomes and responses use discriminated unions (`kind`) for exhaustive narrowing without casts.
 */

// ============================================================================
// 1. Identifiers & Primitives
// ============================================================================

export type JobId = string;

/**
 * Sequential turn position within a job. Strictly 1-based (`>= 1`): the first turn is `1`,
 * and `0` is invalid.
 */
export type TurnIndex = number;
export type AttemptId = string;
export type JudgeCallId = string;
export type FileId = string;
export type ResponseId = string;
export type WebhookEventId = string;
export type IdempotencyKey = string;

/** Epoch milliseconds (fits safely in 52-bit JS number). */
export type EpochMs = number;

/** Epoch seconds (fits safely in 52-bit JS number). */
export type EpochSeconds = number;

/** Binary payload safe across structuredClone / Durable Object RPC. */
export type BinaryPayload = ArrayBuffer | Uint8Array;

// ============================================================================
// 2. Generation Configuration & Model Metadata
// ============================================================================

/** Explicit cache TTL selection per architecture & README. */
export type CacheTtl = "30m" | "12h" | "nocache";

/** OpenAI Responses reasoning effort levels. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** Service tier for generation requests (always "flex" in background mode). */
export type ServiceTier = "flex";

/** Reasoning continuity mode shared between generation and judge adapters. */
export type ContinuityMode = "stateful" | "stateless";

/** Continuity anchor for stateful Responses chaining. */
export interface ContinuityAnchor {
  readonly previous_response_id: ResponseId;
}

/** Shared reasoning continuity payload spread into canonical requests. */
export type ReasoningContinuityPayload =
  | { readonly previous_response_id: ResponseId; readonly store: true }
  | { readonly store: true }
  | { readonly store?: boolean; readonly include?: readonly string[] };

/** Verified generation model profile (no guessed limits or fallback profile for unknown models). */
export interface GenerationModelProfile {
  readonly id: string;
  readonly label: string;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly longContextThresholdTokens: number;
  readonly supportsReasoningEffort: readonly ReasoningEffort[];
  readonly supportsWebSearch: boolean;
  readonly pricing: ModelPricing;
}

export interface ModelPricing {
  readonly standardInputPerMillionUsd: number;
  readonly standardCachedInputPerMillionUsd: number;
  readonly standardOutputPerMillionUsd: number;
  readonly longContextInputPerMillionUsd: number;
  readonly longContextCachedInputPerMillionUsd: number;
  readonly longContextOutputPerMillionUsd: number;
}

// ============================================================================
// 3. Judge Configuration & Evaluation Contract
// ============================================================================

export type JudgeTransport = "responses" | "chat_completions";
export type JudgeHistoryMode = "chained" | "stateless";
export type JudgeFileDeliveryMode = "passthrough" | "inline";

/** Discriminated union for job judge configuration (enabled vs disabled). */
export type JudgeConfig =
  | {
      readonly enabled: false;
    }
  | {
      readonly enabled: true;
      readonly provider: string;
      readonly apiRoot: string;
      readonly secretName: string;
      readonly model: string;
      readonly transport: JudgeTransport;
      readonly historyMode: JudgeHistoryMode;
      readonly fileDeliveryMode: JudgeFileDeliveryMode;
      readonly includePrior: boolean;
      /**
       * Minimum acceptable numeric grade (A=90, B=80, C=70, D=60, F=50). The
       * field name is retained for compatibility; a numeric grade at or above
       * this threshold passes the grade gate.
       */
      readonly maxGradeThreshold: number;
      /**
       * Inject the judge's critique comment into the retry prompt when the
       * verdict is FAIL. Defaults to `true` for persisted configurations that
       * predate this flag.
       */
      readonly injectOnFail: boolean;
      /**
       * Inject the judge's critique comment into the continuation prompt when
       * the verdict is PASS. Defaults to `false` for persisted configurations
       * that predate this flag.
       */
      readonly injectOnPass: boolean;
      /**
       * Developer context delivered to the judge as a developer-role message.
       * Judge developer files are attached to that same developer message on every judge call.
       */
      readonly developerPrompt: string;
    };

export type JudgeVerdict = "PASS" | "FAIL";

/** Five-field validated judge output per README & §8. */
export interface ValidatedJudgeOutput {
  readonly verdict: JudgeVerdict;
  readonly grade: number;
  readonly comment: string;
  readonly tag_agreement: boolean;
  readonly file_visibility: boolean;
}

/**
 * Discriminated union for judge evaluation outcome.
 * Avoids optional-field bags so callers narrow cleanly on `kind`.
 */
export type JudgeEvaluationOutcome =
  | {
      readonly kind: "evaluated";
      readonly judgeCallId: JudgeCallId;
      readonly output: ValidatedJudgeOutput;
      readonly responseId: ResponseId | null;
      readonly advisoryWarnings: readonly string[];
      readonly usage: TokenUsageRecord | null;
    }
  | {
      readonly kind: "unknown";
      readonly judgeCallId: JudgeCallId | null;
      readonly reason:
        | "unencodable_contract"
        | "provider_error"
        | "invalid_response_shape"
        | "artifact_guard_exceeded"
        | "missing_secret";
      readonly message: string;
      readonly advisoryWarnings: readonly string[];
    }
  | {
      readonly kind: "skipped";
      readonly reason: "judge_disabled";
    };

/** Judge file manifest entry status across applicable files. */
export type FileManifestStatus = "delivered_now" | "inherited" | "withheld";

export interface JudgeFileManifestEntry {
  readonly fileId: FileId;
  readonly filename: string;
  readonly byteSize: number;
  readonly status: FileManifestStatus;
  readonly reason?: string;
}

// ============================================================================
// 4. Structural Classification & Tag Parsing
// ============================================================================

/**
 * Discriminated union for candidate structural classification (§7, §8A)
 * and terminal vs continuation responses (Trap 3.3).
 */
export type StructuralClassification =
  | {
      readonly kind: "terminal";
      readonly turnIndex: TurnIndex;
      readonly normalizedText: string;
      readonly rawTag: string;
    }
  | {
      readonly kind: "empty_output";
      readonly reason: "empty" | "whitespace_only" | "marker_only";
    }
  | {
      readonly kind: "wrong_index";
      readonly expectedTurnIndex: TurnIndex;
      readonly actualTurnIndex: TurnIndex;
      readonly normalizedText: string;
      readonly rawTag: string;
    }
  | {
      readonly kind: "malformed_tag";
      readonly reason: string;
      readonly normalizedText: string;
    }
  | {
      readonly kind: "missing_tag";
      readonly normalizedText: string;
    }
  | {
      readonly kind: "trailing_content";
      readonly turnIndex: TurnIndex;
      readonly normalizedText: string;
      readonly rawTag: string;
      readonly trailingText: string;
    }
  | {
      readonly kind: "provider_failed";
    }
  | {
      readonly kind: "cancelled";
    }
  | {
      readonly kind: "incomplete";
    }
  | {
      readonly kind: "refusal";
      readonly refusalText: string;
    };

// ============================================================================
// 5. Job, Turn, Attempt, and Work State
// ============================================================================

export type JobStatus =
  | "created"
  | "ready"
  | "running"
  | "paused_review"
  | "paused_dispatch"
  | "paused_storage"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type TurnStatus =
  | "pending"
  | "running"
  | "awaiting_judge"
  | "paused_review"
  | "accepted"
  | "accepted_with_warning"
  | "failed"
  | "cancelled";

export type AttemptStatus =
  | "prepared"
  | "dispatching"
  | "dispatched"
  | "capacity_backoff"
  | "ambiguous_dispatch"
  | "completed"
  | "failed"
  | "cancelled"
  | "refused"
  | "incomplete"
  | "capacity_exhausted";

export interface JobConfig {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxOutputTokens: number;
  readonly cacheTtl: CacheTtl;
  readonly webSearch: boolean;
  /**
   * Developer context delivered as a developer-role message. The developer
   * files are attached to that same developer message on every generation attempt.
   */
  readonly developerPrompt: string;
  /** Developer files attached to the developer-role message on every generation attempt. */
  readonly developerFileIds: readonly FileId[];
  readonly maxContinuations: number;
  readonly maxAutoRetries: number;
  readonly judge: JudgeConfig;
}

export interface BranchProvenance {
  readonly parentJobId: JobId;
  readonly forkTurnIndex: TurnIndex;
  readonly parentRevision: number;
  readonly branchedAtMs: EpochMs;
}

export interface JobRecord {
  readonly jobId: JobId;
  readonly title: string;
  readonly status: JobStatus;
  readonly revision: number;
  readonly config: JobConfig;
  readonly currentTurnIndex: TurnIndex;
  readonly continuationsUsed: number;
  readonly autoRetriesUsed: number;
  readonly acceptedTurnCount: number;
  readonly lastAcceptedResponseId: ResponseId | null;
  readonly lastJudgeResponseId: ResponseId | null;
  readonly branchProvenance: BranchProvenance | null;
  readonly supersededByJobId: JobId | null;
  readonly warningMessages: readonly string[];
  readonly errorMessage: string | null;
  readonly createdAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

export interface TurnPromptSpec {
  readonly turnIndex: TurnIndex;
  readonly promptText: string;
  readonly attachmentFileIds: readonly FileId[];
}

export interface TurnRecord {
  readonly jobId: JobId;
  readonly turnIndex: TurnIndex;
  readonly status: TurnStatus;
  readonly promptText: string;
  readonly attachmentFileIds: readonly FileId[];
  readonly continuationsUsed: number;
  readonly activeAttemptId: AttemptId | null;
  readonly acceptedAttemptId: AttemptId | null;
  readonly acceptedDeliverableBytes: number | null;
  readonly marginalInputTokens: number | null;
  readonly acceptedResponseId: ResponseId | null;
  readonly judgeCallId: JudgeCallId | null;
  readonly warningMessages: readonly string[];
  readonly revision: number;
  readonly createdAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

export interface AttemptRecord {
  readonly attemptId: AttemptId;
  readonly jobId: JobId;
  readonly turnIndex: TurnIndex;
  readonly attemptNumber: number;
  readonly continuationIndex: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly status: AttemptStatus;
  readonly responseId: ResponseId | null;
  readonly capacitySendCount: number;
  readonly nextCapacityRetryAtMs: EpochMs | null;
  readonly fallbackPollCount: number;
  readonly nextFallbackPollAtMs: EpochMs | null;
  readonly structuralKind: StructuralClassification["kind"] | null;
  readonly providerErrorCode: string | null;
  readonly providerErrorMessage: string | null;
  readonly refusalMessage: string | null;
  readonly requestByteLength: number;
  readonly responseByteLength: number | null;
  readonly deliverableByteLength: number | null;
  readonly usage: TokenUsageRecord | null;
  readonly revision: number;
  readonly createdAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

export interface JudgeCallRecord {
  readonly judgeCallId: JudgeCallId;
  readonly jobId: JobId;
  readonly turnIndex: TurnIndex;
  readonly attemptId: AttemptId;
  readonly provider: string;
  readonly model: string;
  readonly transport: JudgeTransport;
  readonly historyMode: JudgeHistoryMode;
  readonly fileDeliveryMode: JudgeFileDeliveryMode;
  readonly responseId: ResponseId | null;
  readonly status: "pending" | "completed" | "unknown" | "failed";
  readonly output: ValidatedJudgeOutput | null;
  readonly unknownReason: string | null;
  readonly unknownMessage: string | null;
  readonly advisoryWarnings: readonly string[];
  readonly fileManifest: readonly JudgeFileManifestEntry[];
  readonly requestByteLength: number;
  readonly responseByteLength: number | null;
  readonly usage: TokenUsageRecord | null;
  readonly revision: number;
  readonly createdAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

// ============================================================================
// 6. Token Counting, Admission, and Usage Accounting
// ============================================================================

export type ContextTier = "standard" | "long_context";

export interface TokenUsageRecord {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly contextTier: ContextTier;
  readonly estimatedCostUsd: number | null;
  readonly pricingKnown: boolean;
}

export interface UsageAggregate {
  readonly generationCalls: number;
  readonly judgeCalls: number;
  readonly missingUsageCalls: number;
  readonly unknownPricingCalls: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly totalEstimatedCostUsd: number | null;
}

export type TokenAdmissionOutcome =
  | {
      readonly kind: "admitted";
      readonly projectedInputTokens: number;
      readonly maxAllowedInputTokens: number;
      readonly maxOutputTokens: number;
      readonly contextTier: ContextTier;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "unknown_model"
        | "context_window_exceeded"
        | "output_limit_exceeded"
        | "artifact_guard_exceeded";
      readonly projectedInputTokens: number | null;
      readonly maxAllowedInputTokens: number | null;
      readonly message: string;
    };

export interface MarginalTokenPreviewRequest {
  readonly jobId?: JobId;
  readonly model: string;
  readonly promptText: string;
  readonly attachmentFileIds: readonly FileId[];
  readonly maxOutputTokens: number;
  readonly reasoningEffort: ReasoningEffort;
  readonly webSearch: boolean;
  /** Developer context counted as a developer-role message in the preview request. */
  readonly developerPrompt?: string;
  /** Developer files attached to the developer-role message in the preview request. */
  readonly developerFileIds?: readonly FileId[];
}

export interface MarginalTokenPreviewResponse {
  readonly model: string;
  readonly marginalInputTokens: number;
  readonly projectedTotalInputTokens: number;
  readonly contextTier: ContextTier;
  readonly admission: TokenAdmissionOutcome;
}

// ============================================================================
// 7. Provider Dispatch & Webhook Routing Types
// ============================================================================

export type OpenAIWebhookEventType =
  | "response.completed"
  | "response.cancelled"
  | "response.failed"
  | "response.incomplete";

export interface VerifiedWebhookEvent {
  readonly webhookId: WebhookEventId;
  readonly timestampSeconds: EpochSeconds;
  readonly eventType: OpenAIWebhookEventType;
  readonly responseId: ResponseId;
  readonly rawPayload: ArrayBuffer;
  readonly receivedAtMs: EpochMs;
}

export type DispatchOutcome =
  | {
      readonly kind: "dispatched";
      readonly responseId: ResponseId;
      readonly status: "queued" | "in_progress" | "completed";
      readonly rawResponseBytes: ArrayBuffer;
    }
  | {
      readonly kind: "capacity_unavailable";
      readonly statusCode: number;
      readonly retryAfterMs: number | null;
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

export type ProviderResponseRetrieval =
  | {
      readonly kind: "still_running";
      readonly responseId: ResponseId;
      readonly status: "queued" | "in_progress";
    }
  | {
      readonly kind: "settled";
      readonly responseId: ResponseId;
      readonly status: "completed" | "incomplete" | "failed" | "cancelled";
      readonly outputText: string | null;
      readonly refusalText: string | null;
      readonly errorCode: string | null;
      readonly errorMessage: string | null;
      readonly usage: TokenUsageRecord | null;
      readonly rawResponseBytes: ArrayBuffer;
    };

export interface ResponseRouteMapping {
  readonly responseId: ResponseId;
  readonly jobId: JobId;
  readonly attemptId: AttemptId;
  readonly turnIndex: TurnIndex;
  readonly registeredAtMs: EpochMs;
  readonly settledAtMs: EpochMs | null;
}

export type InboxDeliveryState = "pending" | "delivered" | "unmatched" | "duplicate";

export interface WebhookInboxRecord {
  readonly webhookId: WebhookEventId;
  readonly responseId: ResponseId;
  readonly eventType: OpenAIWebhookEventType;
  readonly state: InboxDeliveryState;
  readonly targetJobId: JobId | null;
  readonly deliveryAttempts: number;
  readonly nextRetryAtMs: EpochMs | null;
  readonly receivedAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

// ============================================================================
// 8. File Catalogue, Uploads, and Retention (RegistryDO)
// ============================================================================

export type FileUploadIntentStatus = "pending" | "completed" | "failed" | "cleaned_up";

export interface FileCatalogueRecord {
  readonly fileId: FileId;
  readonly sha256Hex: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly activeJobRefCount: number;
  readonly uploadedAtMs: EpochMs;
  readonly lastReferencedAtMs: EpochMs;
  readonly deletedFromProviderAtMs: EpochMs | null;
}

export interface FileUploadIntentRecord {
  readonly intentId: string;
  readonly sha256Hex: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly status: FileUploadIntentStatus;
  readonly fileId: FileId | null;
  readonly createdAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

export type FileUploadResult =
  | {
      readonly kind: "uploaded";
      readonly file: FileCatalogueRecord;
      readonly deduplicated: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly code: "file_too_large" | "invalid_multipart" | "unsupported_input" | "provider_error";
      readonly message: string;
    };

// ============================================================================
// 9. Pagination, Branching, and Export Wire Contracts
// ============================================================================

export interface CursorPageRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface BranchTurnSnapshot {
  readonly turn: TurnRecord;
  readonly acceptedDeliverable: ArrayBuffer | null;
  readonly attempts: readonly AttemptRecord[];
  readonly judgeCalls: readonly JudgeCallRecord[];
}

/**
 * Complete snapshot consumed in a single local transaction during branch initialization.
 * Bounded to 8,000,000 encoded bytes.
 */
export interface BranchSnapshot {
  readonly parentJob: JobRecord;
  readonly forkTurnIndex: TurnIndex;
  readonly turns: readonly BranchTurnSnapshot[];
  readonly referencedFileIds: readonly FileId[];
  readonly encodedByteLength: number;
  readonly capturedAtMs: EpochMs;
}

export type BranchCreationOutcome =
  | {
      readonly kind: "created";
      readonly branchJobId: JobId;
      readonly parentSuperseded: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "parent_not_quiescent"
        | "snapshot_too_large"
        | "file_protection_failed"
        | "invalid_fork_turn";
      readonly message: string;
    };

export interface ExportHighWaterMarks {
  readonly startingRevision: number;
  readonly maxTurnIndex: TurnIndex;
  readonly maxAttemptId: AttemptId | null;
  readonly maxJudgeCallId: JudgeCallId | null;
  readonly capturedAtMs: EpochMs;
}

export interface MissingArtifactMarker {
  readonly artifactKind: "generation_request" | "generation_response" | "deliverable" | "judge_request" | "judge_response";
  readonly ownerId: string;
  readonly reason: "not_recorded" | "omitted_or_missing";
}

// ============================================================================
// 10. Alarm Scheduling & Obligation Types
// ============================================================================

export type AlarmObligationKind =
  | "capacity_backoff"
  | "fallback_poll"
  | "webhook_inbox_retry"
  | "file_retention_sweep"
  | "upload_intent_cleanup";

export interface AlarmObligation {
  readonly kind: AlarmObligationKind;
  readonly dueAtMs: EpochMs;
  readonly targetId?: string;
}

export type FallbackPollScheduleDecision =
  | {
      readonly kind: "schedule";
      readonly probeNumber: number;
      readonly delayMs: number;
      readonly dueAtMs: EpochMs;
    }
  | {
      readonly kind: "exhausted";
      readonly probeCount: number;
    };

// ============================================================================
// 11. Durable Object RPC Wire Interfaces
// ============================================================================

export interface CreateJobCommand {
  readonly jobId: JobId;
  readonly title: string;
  readonly config: JobConfig;
  readonly initialTurns: readonly TurnPromptSpec[];
}

export interface AppendTurnCommand {
  readonly promptText: string;
  readonly attachmentFileIds: readonly FileId[];
}

export type OperatorReviewDecision =
  | { readonly kind: "accept_with_warning"; readonly note?: string }
  | { readonly kind: "manual_retry" }
  | { readonly kind: "cancel_job"; readonly reason?: string };

export interface JobSummaryItem {
  readonly jobId: JobId;
  readonly title: string;
  readonly status: JobStatus;
  readonly model: string;
  readonly currentTurnIndex: TurnIndex;
  readonly acceptedTurnCount: number;
  readonly totalEstimatedCostUsd: number | null;
  readonly createdAtMs: EpochMs;
  readonly updatedAtMs: EpochMs;
}

export interface JobStateResponse {
  readonly job: JobRecord;
  readonly turns: readonly TurnRecord[];
  readonly activeAttempt: AttemptRecord | null;
  readonly usage: UsageAggregate;
  readonly pollIntervalMs: number;
}

export type WebhookIngressReceipt =
  | {
      readonly kind: "accepted";
      readonly webhookId: WebhookEventId;
      readonly duplicate: boolean;
      readonly matchedJobId: JobId | null;
    }
  | {
      readonly kind: "rejected";
      readonly statusCode: 400 | 401 | 403 | 413;
      readonly message: string;
    };

// ============================================================================
// 12. Standard HTTP API Error & Envelope Types
// ============================================================================

export interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  };
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: ApiErrorPayload["error"] };
