/**
 * JobDO (`src/do/job-do.ts`) — per-job execution-state owner.
 *
 * Sole writer of `jobs`, `turns`, `turn_candidates`, `generation_attempts`,
 * `attempt_response_artifacts`, `judge_calls`, `durable_work`, `job_files`, and
 * `branch_lineage`. All SQLite work is synchronous; external provider and
 * RouterDO/RegistryDO calls happen only after a durable prepare record commits.
 *
 * Boot scaffold: migrations run synchronously in the constructor.
 */

import { DurableObject } from "cloudflare:workers";
import {
  BROWSER_POLL_INTERVAL_MS,
  MAX_AUTO_CONTINUATIONS_PER_TURN,
  MAX_AUTO_FULL_RETRIES,
  MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT,
  REGISTRY_DO_NAME,
  ROUTER_DO_NAME,
  getVerifiedGenerationModel,
} from "../constants.ts";
import {
  getBranchLineage,
  getJob,
  markBranchActivationFlags,
  insertBranchLineage,
  insertJob,
  listJobFiles,
  markFileIntroducedInJudgeCall,
  requireJob,
  updateJobStatusAndRevision,
  upsertJobFiles,
} from "../db/jobs.ts";
import {
  acceptTurnCandidate,
  getTurnCandidateDeliverableBlob,
  getTurnCandidateDeliverableText,
  getTurnCandidateSummary,
  getTurnPromptBlob,
  getTurnPromptText,
  getTurnSummary,
  insertTurn,
  insertTurnCandidate,
  listTurnCandidateSummaries,
  listTurnSummaries,
  updateTurnStatus,
} from "../db/turns.ts";
import {
  captureExportHighWaterMarks,
  completeJudgeCall,
  deleteDurableWork,
  getAttemptResponseArtifactBlob,
  getEarliestDurableWorkDueAtMs,
  getGenerationAttemptRequestBlob,
  getGenerationAttemptSummary,
  getJudgeCallRequestBlob,
  getJudgeCallSummary,
  insertGenerationAttempt,
  insertJudgeCall,
  listDueDurableWork,
  listGenerationAttemptSummaries,
  listJudgeCallSummaries,
  putAttemptResponseArtifact,
  updateGenerationAttemptState,
  upsertDurableWork,
} from "../db/attempts.ts";
import {
  migrateJobDoSchema,
  StorageFullError,
  withSqlErrorMapping,
  type BranchLineageRow,
  type DurableWorkRow,
  type GenerationAttemptSummaryRow,
  type JobFileRow,
  type JobRow,
  type JudgeCallSummaryRow,
  type SchemaSqlStorage,
  type SchemaTransactionalStorage,
  type TurnCandidateSummaryRow,
  type TurnSummaryRow,
} from "../db/schema.ts";
import { now } from "../lib/clock.ts";
import {
  buildCanonicalGenerationRequest,
  classifyDispatchResult,
  type GenerationAttemptKind,
  type PriorAcceptedTurn,
} from "../lib/dispatch.ts";
import {
  buildJudgeRequest,
  classifyJudgeEvaluation,
  encodeBase64,
  extractJudgeRawText,
  judgeBuildFailureOutcome,
  judgeMissingSecretOutcome,
  parseJudgeOutput,
  type EnabledJudgeConfig,
  type JudgeRequestBuildOutcome,
  type PriorAcceptedOutput,
} from "../lib/judge.ts";
import {
  cancelProviderResponse,
  dispatchResponsesCreate,
  resolveEnvSecret,
  retrieveProviderResponse,
} from "../lib/openai.ts";
import {
  classifyCandidateOutcome,
  type CandidateOutcome,
} from "../lib/tag.ts";
import { aggregateUsage } from "../lib/tokens.ts";
import {
  earliestDeadline,
  ensureAlarmNotLaterThan,
  getNextFallbackPollAt,
  hasRemainingFallbackProbes,
  runWithAlarmSafety,
} from "../lib/alarm.ts";
import {
  ArtifactGuardError,
  assertArtifactAndRowSize,
  assertBranchSnapshotSize,
  assertTurnIndex,
  clampPageLimit,
  measureByteLength,
} from "../lib/guards.ts";
import type {
  AppendTurnCommand,
  AttemptRecord,
  BranchCreationOutcome,
  BranchSnapshot,
  BranchTurnSnapshot,
  CreateJobCommand,
  CursorPage,
  CursorPageRequest,
  ExportHighWaterMarks,
  FileCatalogueRecord,
  FileId,
  JobConfig,
  JobId,
  JobRecord,
  JobStateResponse,
  JudgeCallRecord,
  JudgeConfig,
  JudgeEvaluationOutcome,
  JudgeFileDeliveryMode,
  JudgeFileManifestEntry,
  JudgeHistoryMode,
  JudgeTransport,
  OperatorReviewDecision,
  ProviderResponseRetrieval,
  ReasoningEffort,
  ResponseRouteMapping,
  StructuralClassification,
  TokenUsageRecord,
  TurnIndex,
  TurnRecord,
  UsageAggregate,
  VerifiedWebhookEvent,
} from "../types.ts";

// ============================================================================
// Shared constants & small utilities
// ============================================================================

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/** Attempt states that still own the job's single active execution slot. */
const IN_FLIGHT_ATTEMPT_STATUSES: ReadonlySet<GenerationAttemptSummaryRow["status"]> =
  new Set(["prepared", "dispatching", "dispatched", "capacity_backoff"]);

/** Job states from which no further automatic execution starts. */
const TERMINAL_JOB_STATUSES: ReadonlySet<JobRow["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

/** Stale in-flight work older than this is reconciled rather than re-sent. */
const WORK_CLAIM_STALE_MS = 120_000;

/** Delay before a durable dispatch intent can be reconciled by the alarm. */
const DISPATCH_WORK_DELAY_MS = 5_000;

const DISPATCH_WORK_SUFFIX = ":dispatch";
const POLL_WORK_SUFFIX = ":poll";

interface RegistryDoRpc {
  registerJob(summary: {
    readonly jobId: JobId;
    readonly title: string;
    readonly status: JobRow["status"];
    readonly model: string;
    readonly currentTurnIndex: TurnIndex;
    readonly acceptedTurnCount: number;
    readonly totalEstimatedCostUsd: number | null;
    readonly createdAtMs: number;
    readonly updatedAtMs: number;
  }): Promise<void>;
  updateJobIndexStatus(
    jobId: JobId,
    status: JobRow["status"],
    revision: number,
    currentTurnIndex: number,
    acceptedTurnCount: number,
  ): Promise<void>;
  protectJobFileRefs(jobId: JobId, fileIds: readonly FileId[]): Promise<void>;
  releaseJobFileRefs(jobId: JobId): Promise<void>;
  getFile(fileId: FileId): Promise<FileCatalogueRecord | null>;
}

interface RouterDoRpc {
  registerResponseRoute(mapping: ResponseRouteMapping): Promise<void>;
}

interface JobDoRpc {
  getState(): Promise<JobStateResponse | null>;
  supersedeParent(epoch: number, childId: string): Promise<boolean>;
}

interface GenerationDispatchPayload {
  readonly kind: "generation_dispatch";
  readonly attemptId: string;
}

interface GenerationPollPayload {
  readonly kind: "generation_poll";
  readonly attemptId: string;
}

interface JudgeDispatchPayload {
  readonly kind: "judge_dispatch";
  readonly judgeCallId: string;
  readonly attemptId: string;
}

type DurableWorkPayload = GenerationDispatchPayload | GenerationPollPayload | JudgeDispatchPayload;

interface AttemptDiagnostics {
  readonly branch_copy: boolean;
  readonly response_bytes: number | null;
  readonly deliverable_bytes: number | null;
  readonly structural_kind: StructuralClassification["kind"] | null;
  readonly provider_error_code: string | null;
  readonly provider_error_message: string | null;
  readonly refusal_message: string | null;
  readonly dispatch_started_at_ms: number | null;
  readonly settle_claimed_at_ms: number | null;
}

interface JudgeDiagnostics {
  readonly provider: string;
  readonly response_bytes: number | null;
  readonly unknown_reason: string | null;
  readonly unknown_message: string | null;
  readonly advisory_warnings: readonly string[];
  readonly started_at_ms: number | null;
}

interface PreparedAttempt {
  readonly attempt: GenerationAttemptSummaryRow;
}

interface SettlementClaim {
  readonly attempt: GenerationAttemptSummaryRow;
  readonly job: JobRow;
  readonly turn: TurnSummaryRow;
}

interface JudgeFileSelection {
  readonly files: readonly { readonly file: FileCatalogueRecord; readonly turnIndex: number; readonly alreadyIntroduced: boolean }[];
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseIsoMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readStringArray(raw: string): string[] {
  const parsed = tryParseJson(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const values: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      values.push(item);
    }
  }
  return values;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "none" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}

function isJudgeTransport(value: unknown): value is JudgeTransport {
  return value === "responses" || value === "chat_completions";
}

function isJudgeHistoryMode(value: unknown): value is JudgeHistoryMode {
  return value === "chained" || value === "stateless";
}

function isJudgeFileDeliveryMode(value: unknown): value is JudgeFileDeliveryMode {
  return value === "passthrough" || value === "inline";
}

function isStructuralKind(value: unknown): value is StructuralClassification["kind"] {
  return (
    value === "terminal" ||
    value === "trailing_content" ||
    value === "empty_output" ||
    value === "missing_tag" ||
    value === "wrong_index" ||
    value === "malformed_tag" ||
    value === "refusal" ||
    value === "incomplete" ||
    value === "provider_failed" ||
    value === "cancelled"
  );
}

function parseJudgeConfig(raw: string): JudgeConfig {
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) {
    throw new Error("jobs.judge_config_json must encode a JSON object");
  }
  if (parsed.enabled === false) {
    return { enabled: false };
  }
  if (parsed.enabled !== true) {
    throw new Error("jobs.judge_config_json enabled flag must be boolean");
  }
  if (parsed.developerPrompt !== undefined && typeof parsed.developerPrompt !== "string") {
    throw new Error("jobs.judge_config_json developerPrompt must be a string");
  }
  if (
    typeof parsed.provider !== "string" ||
    typeof parsed.apiRoot !== "string" ||
    typeof parsed.secretName !== "string" ||
    typeof parsed.model !== "string" ||
    !isJudgeTransport(parsed.transport) ||
    !isJudgeHistoryMode(parsed.historyMode) ||
    !isJudgeFileDeliveryMode(parsed.fileDeliveryMode) ||
    typeof parsed.includePrior !== "boolean" ||
    typeof parsed.maxGradeThreshold !== "number"
  ) {
    throw new Error("jobs.judge_config_json does not match the declared judge contract");
  }
  return {
    enabled: true,
    provider: parsed.provider,
    apiRoot: parsed.apiRoot,
    secretName: parsed.secretName,
    model: parsed.model,
    transport: parsed.transport,
    historyMode: parsed.historyMode,
    fileDeliveryMode: parsed.fileDeliveryMode,
    includePrior: parsed.includePrior,
    maxGradeThreshold: parsed.maxGradeThreshold,
    developerPrompt:
      typeof parsed.developerPrompt === "string" ? parsed.developerPrompt : "",
  };
}

function jobConfigFromRow(row: JobRow): JobConfig {
  if (!isReasoningEffort(row.reasoning_effort)) {
    throw new Error(`Invalid jobs.reasoning_effort: ${row.reasoning_effort}`);
  }
  return {
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    maxOutputTokens: row.max_output_tokens,
    cacheTtl: row.cache_ttl,
    webSearch: row.web_search === 1,
    developerPrompt: row.developer_prompt,
    developerFileIds: uniqueStrings(
      readStringArray(row.developer_file_ids_json).filter((id) => id.length > 0)
    ),
    maxContinuations: row.continuation_budget,
    maxAutoRetries: row.auto_retry_budget,
    judge: parseJudgeConfig(row.judge_config_json),
  };
}

function parseTokenUsage(raw: string | null): TokenUsageRecord | null {
  if (raw === null) {
    return null;
  }
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) {
    return null;
  }
  const contextTier = parsed.contextTier;
  const estimatedCostUsd = parsed.estimatedCostUsd;
  if (
    typeof parsed.inputTokens !== "number" ||
    typeof parsed.cachedInputTokens !== "number" ||
    typeof parsed.outputTokens !== "number" ||
    typeof parsed.reasoningTokens !== "number" ||
    typeof parsed.totalTokens !== "number" ||
    (contextTier !== "standard" && contextTier !== "long_context") ||
    (estimatedCostUsd !== null && typeof estimatedCostUsd !== "number") ||
    typeof parsed.pricingKnown !== "boolean"
  ) {
    return null;
  }
  return {
    inputTokens: parsed.inputTokens,
    cachedInputTokens: parsed.cachedInputTokens,
    outputTokens: parsed.outputTokens,
    reasoningTokens: parsed.reasoningTokens,
    totalTokens: parsed.totalTokens,
    contextTier,
    estimatedCostUsd,
    pricingKnown: parsed.pricingKnown,
  };
}

function emptyAttemptDiagnostics(): AttemptDiagnostics {
  return {
    branch_copy: false,
    response_bytes: null,
    deliverable_bytes: null,
    structural_kind: null,
    provider_error_code: null,
    provider_error_message: null,
    refusal_message: null,
    dispatch_started_at_ms: null,
    settle_claimed_at_ms: null,
  };
}

function parseAttemptDiagnostics(raw: string): AttemptDiagnostics {
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) {
    return emptyAttemptDiagnostics();
  }
  return {
    branch_copy: parsed.branch_copy === true,
    response_bytes:
      typeof parsed.response_bytes === "number" ? parsed.response_bytes : null,
    deliverable_bytes:
      typeof parsed.deliverable_bytes === "number" ? parsed.deliverable_bytes : null,
    structural_kind: isStructuralKind(parsed.structural_kind)
      ? parsed.structural_kind
      : null,
    provider_error_code:
      typeof parsed.provider_error_code === "string" ? parsed.provider_error_code : null,
    provider_error_message:
      typeof parsed.provider_error_message === "string"
        ? parsed.provider_error_message
        : null,
    refusal_message:
      typeof parsed.refusal_message === "string" ? parsed.refusal_message : null,
    dispatch_started_at_ms:
      typeof parsed.dispatch_started_at_ms === "number"
        ? parsed.dispatch_started_at_ms
        : null,
    settle_claimed_at_ms:
      typeof parsed.settle_claimed_at_ms === "number"
        ? parsed.settle_claimed_at_ms
        : null,
  };
}

function mergeAttemptDiagnostics(
  raw: string,
  patch: Partial<AttemptDiagnostics>
): string {
  const merged: AttemptDiagnostics = { ...parseAttemptDiagnostics(raw), ...patch };
  return JSON.stringify(merged);
}

function emptyJudgeDiagnostics(provider: string): JudgeDiagnostics {
  return {
    provider,
    response_bytes: null,
    unknown_reason: null,
    unknown_message: null,
    advisory_warnings: [],
    started_at_ms: null,
  };
}

function parseJudgeDiagnostics(raw: string, provider: string): JudgeDiagnostics {
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) {
    return emptyJudgeDiagnostics(provider);
  }
  const advisoryWarnings: string[] = [];
  if (Array.isArray(parsed.advisory_warnings)) {
    for (const warning of parsed.advisory_warnings) {
      if (typeof warning === "string") {
        advisoryWarnings.push(warning);
      }
    }
  }
  return {
    provider: typeof parsed.provider === "string" ? parsed.provider : provider,
    response_bytes:
      typeof parsed.response_bytes === "number" ? parsed.response_bytes : null,
    unknown_reason:
      typeof parsed.unknown_reason === "string" ? parsed.unknown_reason : null,
    unknown_message:
      typeof parsed.unknown_message === "string" ? parsed.unknown_message : null,
    advisory_warnings: advisoryWarnings,
    started_at_ms:
      typeof parsed.started_at_ms === "number" ? parsed.started_at_ms : null,
  };
}



function parseManifest(raw: string): readonly JudgeFileManifestEntry[] {
  const parsed = tryParseJson(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const entries: JudgeFileManifestEntry[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }
    if (
      typeof item.fileId !== "string" ||
      typeof item.filename !== "string" ||
      typeof item.byteSize !== "number" ||
      (item.status !== "delivered_now" &&
        item.status !== "inherited" &&
        item.status !== "withheld")
    ) {
      continue;
    }
    entries.push({
      fileId: item.fileId,
      filename: item.filename,
      byteSize: item.byteSize,
      status: item.status,
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    });
  }
  return entries;
}

function parseDurableWorkPayload(raw: string): DurableWorkPayload | null {
  const parsed = tryParseJson(raw);
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.kind === "generation_dispatch" && typeof parsed.attemptId === "string") {
    return { kind: "generation_dispatch", attemptId: parsed.attemptId };
  }
  if (parsed.kind === "generation_poll" && typeof parsed.attemptId === "string") {
    return { kind: "generation_poll", attemptId: parsed.attemptId };
  }
  if (
    parsed.kind === "judge_dispatch" &&
    typeof parsed.judgeCallId === "string" &&
    typeof parsed.attemptId === "string"
  ) {
    return {
      kind: "judge_dispatch",
      judgeCallId: parsed.judgeCallId,
      attemptId: parsed.attemptId,
    };
  }
  return null;
}

function classificationDeliverableText(outcome: CandidateOutcome): string | null {
  switch (outcome.classification.kind) {
    case "terminal":
    case "trailing_content":
    case "wrong_index":
    case "missing_tag":
    case "malformed_tag":
      return outcome.classification.normalizedText;
    default:
      return null;
  }
}

function classificationParsedTagIndex(outcome: CandidateOutcome): number | null {
  switch (outcome.classification.kind) {
    case "terminal":
    case "trailing_content":
      return outcome.classification.turnIndex;
    case "wrong_index":
      return outcome.classification.actualTurnIndex;
    default:
      return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}



async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hashBytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of hashBytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Measures a branch snapshot's encoded size without materializing a second copy
 * of every binary payload: metadata is JSON-encoded and binary payload bytes are
 * added separately.
 */
function measureBranchSnapshotBytes(snapshot: BranchSnapshot): number {
  let binaryBytes = 0;
  const projected = {
    parentJob: snapshot.parentJob,
    forkTurnIndex: snapshot.forkTurnIndex,
    turns: snapshot.turns.map((turn) => {
      if (turn.acceptedDeliverable !== null) {
        binaryBytes += turn.acceptedDeliverable.byteLength;
      }
      return {
        turn: turn.turn,
        acceptedDeliverable: null,
        attempts: turn.attempts,
        judgeCalls: turn.judgeCalls,
      };
    }),
    referencedFileIds: snapshot.referencedFileIds,
    encodedByteLength: 0,
    capturedAtMs: snapshot.capturedAtMs,
  };
  return measureByteLength(JSON.stringify(projected)) + binaryBytes;
}

/** Canonical, binary-safe serialization used only to hash a branch snapshot. */
function serializeBranchSnapshot(snapshot: BranchSnapshot): string {
  return JSON.stringify({
    parentJob: snapshot.parentJob,
    forkTurnIndex: snapshot.forkTurnIndex,
    turns: snapshot.turns.map((turn) => ({
      turn: turn.turn,
      acceptedDeliverable:
        turn.acceptedDeliverable === null
          ? null
          : encodeBase64(new Uint8Array(turn.acceptedDeliverable)),
      attempts: turn.attempts,
      judgeCalls: turn.judgeCalls,
    })),
    referencedFileIds: snapshot.referencedFileIds,
    encodedByteLength: snapshot.encodedByteLength,
    capturedAtMs: snapshot.capturedAtMs,
  });
}

function jobRowToRecord(row: JobRow, lineage: BranchLineageRow | null): JobRecord {
  return {
    jobId: row.job_id,
    title: row.title,
    status: row.status,
    revision: row.revision,
    config: jobConfigFromRow(row),
    currentTurnIndex: row.current_turn_index,
    continuationsUsed: row.continuations_used,
    autoRetriesUsed: row.auto_retries_used,
    acceptedTurnCount: row.accepted_turn_index,
    lastAcceptedResponseId: row.last_accepted_response_id,
    lastJudgeResponseId: row.last_judge_response_id,
    branchProvenance:
      row.parent_job_id === null || row.fork_turn_index === null
        ? null
        : {
            parentJobId: row.parent_job_id,
            forkTurnIndex: row.fork_turn_index,
            parentRevision: lineage === null ? row.revision : lineage.parent_revision,
            branchedAtMs:
              lineage === null ? parseIsoMs(row.created_at) : parseIsoMs(lineage.created_at),
          },
    supersededByJobId: null,
    warningMessages: readStringArray(row.warnings_json),
    errorMessage: row.last_error_detail,
    createdAtMs: parseIsoMs(row.created_at),
    updatedAtMs: parseIsoMs(row.updated_at),
  };
}

function attemptRowToRecord(
  row: GenerationAttemptSummaryRow,
  jobId: JobId,
  revision: number
): AttemptRecord {
  const diagnostics = parseAttemptDiagnostics(row.diagnostics_json);
  return {
    attemptId: row.attempt_id,
    jobId,
    turnIndex: row.turn_index,
    attemptNumber: row.attempt_number,
    continuationIndex: row.continuation_index,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    responseId: row.provider_response_id,
    capacitySendCount: row.capacity_sends,
    nextCapacityRetryAtMs: row.next_backoff_at_ms,
    fallbackPollCount: row.poll_probes,
    nextFallbackPollAtMs: row.next_poll_at_ms,
    structuralKind: diagnostics.structural_kind,
    providerErrorCode: diagnostics.provider_error_code,
    providerErrorMessage: diagnostics.provider_error_message,
    refusalMessage: diagnostics.refusal_message,
    requestByteLength: row.request_bytes,
    responseByteLength: diagnostics.response_bytes,
    deliverableByteLength: diagnostics.deliverable_bytes,
    usage: parseTokenUsage(row.usage_json),
    revision,
    createdAtMs: parseIsoMs(row.created_at),
    updatedAtMs: parseIsoMs(row.updated_at),
  };
}

function judgeCallRowToRecord(
  row: JudgeCallSummaryRow,
  jobId: JobId,
  revision: number
): JudgeCallRecord {
  const diagnostics = parseJudgeDiagnostics(row.diagnostics_json, "");
  const output =
    row.status === "completed" &&
    (row.verdict === "PASS" || row.verdict === "FAIL") &&
    row.grade !== null &&
    row.comment !== null &&
    row.tag_agreement !== null &&
    row.file_visibility !== null
      ? {
          verdict: row.verdict,
          grade: row.grade,
          comment: row.comment,
          tag_agreement: row.tag_agreement === 1,
          file_visibility: row.file_visibility === 1,
        }
      : null;
  return {
    judgeCallId: row.judge_call_id,
    jobId,
    turnIndex: row.turn_index,
    attemptId: row.attempt_id,
    provider: diagnostics.provider,
    model: row.model,
    transport: row.transport,
    historyMode: row.history_mode,
    fileDeliveryMode: row.file_delivery_mode,
    responseId: row.provider_response_id,
    status: row.status,
    output,
    unknownReason: diagnostics.unknown_reason,
    unknownMessage: diagnostics.unknown_message,
    advisoryWarnings: diagnostics.advisory_warnings,
    fileManifest: parseManifest(row.manifest_json),
    requestByteLength: row.request_bytes,
    responseByteLength: diagnostics.response_bytes,
    usage: parseTokenUsage(row.usage_json),
    revision,
    createdAtMs: parseIsoMs(row.created_at),
    updatedAtMs: parseIsoMs(row.updated_at),
  };
}

function turnRowToRecord(
  row: TurnSummaryRow,
  jobId: JobId,
  promptText: string,
  acceptedDeliverableBytes: number | null,
  judgeCallId: string | null,
  activeAttemptId: string | null,
  revision: number
): TurnRecord {
  return {
    jobId,
    turnIndex: row.turn_index,
    status: row.status,
    promptText,
    attachmentFileIds: readStringArray(row.attachment_file_ids_json),
    continuationsUsed: 0,
    activeAttemptId,
    acceptedAttemptId: row.accepted_attempt_id,
    acceptedDeliverableBytes,
    acceptedResponseId: row.accepted_response_id,
    judgeCallId,
    warningMessages: [],
    revision,
    createdAtMs: parseIsoMs(row.created_at),
    updatedAtMs: parseIsoMs(row.updated_at),
  };
}

// ============================================================================
// JobDO
// ============================================================================

export class JobDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Workers-types widens SqlStorage bindings; the schema adapter accepts the same values at runtime.
    const storage = ctx.storage as unknown as SchemaTransactionalStorage;
    migrateJobDoSchema(storage);
  }

  // --------------------------------------------------------------------------
  // Public RPC surface
  // --------------------------------------------------------------------------

  async createJob(command: CreateJobCommand): Promise<JobStateResponse> {
    this.validateCreateJobCommand(command);

    const existing = getJob(this.sql);
    if (existing !== null) {
      if (existing.job_id !== command.jobId) {
        throw new Error("JobDO already holds a different job record");
      }
      if (existing.status !== "created") {
        throw new Error(`Job already exists: ${command.jobId}`);
      }
    } else {
      const nowMs = now();
      const nowIso = toIso(nowMs);
      this.storage.transactionSync(() => {
        insertJob(this.sql, {
          job_id: command.jobId,
          title: command.title,
          status: "created",
          model: command.config.model,
          reasoning_effort: command.config.reasoningEffort,
          max_output_tokens: command.config.maxOutputTokens,
          cache_ttl: command.config.cacheTtl,
          web_search: command.config.webSearch ? 1 : 0,
          judge_config_json: JSON.stringify(command.config.judge),
          developer_prompt: command.config.developerPrompt,
          developer_file_ids_json: JSON.stringify(
            uniqueStrings(command.config.developerFileIds)
          ),
          continuation_budget: command.config.maxContinuations,
          continuations_used: 0,
          auto_retry_budget: command.config.maxAutoRetries,
          auto_retries_used: 0,
          manual_retries_used: 0,
          current_turn_index: 1,
          total_turns: Math.max(1, command.initialTurns.length),
          accepted_turn_index: 0,
          active_attempt_id: null,
          last_accepted_response_id: null,
          last_judge_response_id: null,
          parent_job_id: null,
          fork_turn_index: null,
          revision: 1,
          last_error_code: null,
          last_error_detail: null,
          warnings_json: "[]",
          usage_summary_json: "{}",
          created_at: nowIso,
          updated_at: nowIso,
        });
        for (const turn of command.initialTurns) {
          insertTurn(this.sql, {
            turnIndex: turn.turnIndex,
            prompt: turn.promptText,
            attachmentFileIdsJson: JSON.stringify(turn.attachmentFileIds),
            status: "pending",
            nowIso,
          });
        }
      });
    }

    const fileIds = uniqueStrings([
      ...this.collectCommandFileIds(command),
      ...command.config.developerFileIds,
    ]);
    if (fileIds.length > 0) {
      await this.registryStub().protectJobFileRefs(command.jobId, fileIds);
    }

    const readyAt = toIso(now());
    this.storage.transactionSync(() => {
      updateJobStatusAndRevision(this.sql, {
        jobId: command.jobId,
        status: "ready",
        updatedAt: readyAt,
      });
    });

    const readyRow = requireJob(this.sql, command.jobId);
    await this.registryStub().registerJob(this.jobSummaryFromRow(readyRow));
    await this.scheduleEarliestObligation();
    await this.startNextTurnIfEligible();

    return this.requireState();
  }

  async getState(): Promise<JobStateResponse | null> {
    const jobRow = getJob(this.sql);
    if (jobRow === null) {
      return null;
    }
    const lineage =
      jobRow.parent_job_id === null ? null : getBranchLineage(this.sql, jobRow.job_id);
    const job = jobRowToRecord(jobRow, lineage);
    const turns = this.buildTurnRecords(jobRow);
    const activeAttempt =
      jobRow.active_attempt_id === null
        ? null
        : (() => {
            const attempt = getGenerationAttemptSummary(this.sql, jobRow.active_attempt_id);
            return attempt === null
              ? null
              : attemptRowToRecord(attempt, jobRow.job_id, jobRow.revision);
          })();

    return {
      job,
      turns,
      activeAttempt,
      usage: this.computeUsageAggregate(),
      pollIntervalMs: BROWSER_POLL_INTERVAL_MS,
    };
  }

  async appendTurn(command: AppendTurnCommand): Promise<JobStateResponse> {
    const job = requireJob(this.sql);
    if (job.status === "failed" || job.status === "cancelled" || job.status === "superseded") {
      throw new Error(`Cannot append a turn to a ${job.status} job`);
    }
    if (typeof command.promptText !== "string") {
      throw new Error("AppendTurnCommand.promptText must be a string");
    }
    if (!Array.isArray(command.attachmentFileIds)) {
      throw new Error("AppendTurnCommand.attachmentFileIds must be an array");
    }

    const lastIndex = this.getLastTurnIndex();
    const nextIndex = lastIndex + 1;
    assertTurnIndex(nextIndex, "appendTurn.turnIndex");
    const nowMs = now();
    const nowIso = toIso(nowMs);
    const newFileIds = uniqueStrings(command.attachmentFileIds);
    if (newFileIds.length > 0) {
      await this.registryStub().protectJobFileRefs(job.job_id, newFileIds);
    }

    this.storage.transactionSync(() => {
      insertTurn(this.sql, {
        turnIndex: nextIndex,
        prompt: command.promptText,
        attachmentFileIdsJson: JSON.stringify(uniqueStrings(command.attachmentFileIds)),
        status: "pending",
        nowIso,
      });
      withSqlErrorMapping(() => {
        this.sql.exec(
          "UPDATE jobs SET total_turns = MAX(total_turns, ?) WHERE job_id = ?",
          nextIndex,
          job.job_id
        );
      });
      updateJobStatusAndRevision(this.sql, {
        jobId: job.job_id,
        status: job.status === "completed" ? "running" : job.status,
        updatedAt: nowIso,
      });
    });

    const updated = requireJob(this.sql, job.job_id);
    await this.publishAndSchedule(updated);

    if (updated.status === "ready" || updated.status === "running") {
      await this.startNextTurnIfEligible();
    }

    return this.requireState();
  }

  async applyOperatorDecision(decision: OperatorReviewDecision): Promise<JobStateResponse> {
    const job = requireJob(this.sql);
    switch (decision.kind) {
      case "accept_with_warning":
        await this.acceptPausedCandidateWithWarning(job, decision.note);
        break;
      case "manual_retry":
        await this.performManualRetry(job);
        break;
      case "cancel_job":
        await this.cancelJob(job, decision.reason);
        break;
    }
    return this.requireState();
  }

  async captureBranchSnapshot(
    forkTurnIndex: TurnIndex
  ): Promise<
    | BranchSnapshot
    | {
        kind: "rejected";
        reason: "parent_not_quiescent" | "snapshot_too_large" | "invalid_fork_turn";
        message: string;
      }
  > {
    assertTurnIndex(forkTurnIndex, "captureBranchSnapshot.forkTurnIndex");
    const job = requireJob(this.sql);

    if (forkTurnIndex > job.accepted_turn_index) {
      return {
        kind: "rejected",
        reason: "invalid_fork_turn",
        message: `Fork turn ${forkTurnIndex} is beyond the accepted anchor ${job.accepted_turn_index}`,
      };
    }

    if (!this.isJobQuiescent(job)) {
      return {
        kind: "rejected",
        reason: "parent_not_quiescent",
        message: "The parent job has in-flight execution work",
      };
    }

    const lineage =
      job.parent_job_id === null ? null : getBranchLineage(this.sql, job.job_id);
    const parentJob = jobRowToRecord(job, lineage);
    const referencedFileIds: FileId[] = [...readStringArray(job.developer_file_ids_json)];
    const turns: BranchTurnSnapshot[] = [];

    this.storage.transactionSync(() => {
      for (const summary of this.listAllTurnSummaries(forkTurnIndex)) {
        const promptText = getTurnPromptText(this.sql, summary.turn_index) ?? "";
        const deliverableBlob =
          summary.accepted_candidate_id === null
            ? null
            : getTurnCandidateDeliverableBlob(this.sql, summary.accepted_candidate_id);
        const attempts = this.listAllAttemptSummaries(summary.turn_index).map((attempt) =>
          attemptRowToRecord(attempt, job.job_id, job.revision)
        );
        const judgeCalls = this.listAllJudgeSummaries(summary.turn_index).map((call) =>
          judgeCallRowToRecord(call, job.job_id, job.revision)
        );
        const attachmentFileIds = readStringArray(summary.attachment_file_ids_json);
        referencedFileIds.push(...attachmentFileIds);
        const acceptingAttempt = summary.accepted_attempt_id;
        const acceptedCandidate =
          summary.accepted_candidate_id === null
            ? null
            : getTurnCandidateSummary(this.sql, summary.accepted_candidate_id);
        turns.push({
          turn: {
            ...turnRowToRecord(
              summary,
              job.job_id,
              promptText,
              deliverableBlob === null ? null : deliverableBlob.byteLength,
              judgeCalls.length > 0 ? judgeCalls[0]!.judgeCallId : null,
              acceptingAttempt !== null &&
                attempts.some((a) => a.attemptId === acceptingAttempt)
                ? acceptingAttempt
                : null,
              job.revision
            ),
            warningMessages:
              acceptedCandidate === null
                ? []
                : readStringArray(acceptedCandidate.warning_json),
          },
          acceptedDeliverable:
            deliverableBlob === null ? null : toArrayBuffer(deliverableBlob),
          attempts,
          judgeCalls,
        });
      }
    });

    const capturedAtMs = now();
    const snapshot: BranchSnapshot = {
      parentJob,
      forkTurnIndex,
      turns,
      referencedFileIds: uniqueStrings(referencedFileIds),
      encodedByteLength: 0,
      capturedAtMs,
    };
    const encodedByteLength = measureBranchSnapshotBytes(snapshot);
    try {
      assertBranchSnapshotSize(encodedByteLength, "captureBranchSnapshot");
    } catch (error) {
      if (error instanceof ArtifactGuardError) {
        return {
          kind: "rejected",
          reason: "snapshot_too_large",
          message: error.message,
        };
      }
      throw error;
    }

    return { ...snapshot, encodedByteLength };
  }

  async initializeBranch(snapshot: BranchSnapshot): Promise<BranchCreationOutcome> {
    try {
      assertBranchSnapshotSize(snapshot.encodedByteLength, "initializeBranch");
    } catch (error) {
      if (error instanceof ArtifactGuardError) {
        return { kind: "rejected", reason: "snapshot_too_large", message: error.message };
      }
      throw error;
    }

    if (
      !Number.isInteger(snapshot.forkTurnIndex) ||
      snapshot.forkTurnIndex < 1 ||
      snapshot.turns.length === 0 ||
      snapshot.turns.some(
        (turn, index) =>
          turn.turn.turnIndex !== index + 1 ||
          (turn.turn.status !== "accepted" &&
            turn.turn.status !== "accepted_with_warning") ||
          turn.acceptedDeliverable === null ||
          turn.turn.acceptedAttemptId === null ||
          turn.turn.acceptedResponseId === null
      )
    ) {
      return {
        kind: "rejected",
        reason: "invalid_fork_turn",
        message:
          "Branch snapshot turns must be a non-empty contiguous accepted 1-based prefix with candidate provenance",
      };
    }

    const existing = getJob(this.sql);
    let branchJobId: JobId;
    if (existing !== null) {
      if (
        existing.parent_job_id !== snapshot.parentJob.jobId ||
        existing.fork_turn_index !== snapshot.forkTurnIndex
      ) {
        return {
          kind: "rejected",
          reason: "invalid_fork_turn",
          message: "This JobDO already holds a different branch",
        };
      }
      const lineage = getBranchLineage(this.sql, existing.job_id);
      return {
        kind: "created",
        branchJobId: existing.job_id,
        parentSuperseded: lineage !== null && lineage.parent_superseded === 1,
      };
    }
    branchJobId = `${snapshot.parentJob.jobId}:branch:${snapshot.forkTurnIndex}:${snapshot.capturedAtMs}`;

    const parentState = await this.jobStub(snapshot.parentJob.jobId).getState();
    if (
      parentState === null ||
      parentState.job.revision !== snapshot.parentJob.revision ||
      !this.isQuiescentRecord(parentState)
    ) {
      return {
        kind: "rejected",
        reason: "parent_not_quiescent",
        message: "The parent job advanced or resumed before branch activation",
      };
    }

    try {
      await this.registryStub().protectJobFileRefs(branchJobId, snapshot.referencedFileIds);
    } catch (error) {
      return {
        kind: "rejected",
        reason: "file_protection_failed",
        message: describeError(error),
      };
    }

    const hashBytes = utf8Encoder.encode(serializeBranchSnapshot(snapshot));
    const snapshotSha256 = await sha256Hex(hashBytes);
    const nowMs = now();
    const nowIso = toIso(nowMs);
    const usageSummaryJson = JSON.stringify(this.usageFromSnapshot(snapshot));

    this.storage.transactionSync(() => {
      insertJob(this.sql, {
        job_id: branchJobId,
        title: snapshot.parentJob.title,
        status: "ready",
        model: snapshot.parentJob.config.model,
        reasoning_effort: snapshot.parentJob.config.reasoningEffort,
        max_output_tokens: snapshot.parentJob.config.maxOutputTokens,
        cache_ttl: snapshot.parentJob.config.cacheTtl,
        web_search: snapshot.parentJob.config.webSearch ? 1 : 0,
        judge_config_json: JSON.stringify(snapshot.parentJob.config.judge),
        developer_prompt: snapshot.parentJob.config.developerPrompt,
        developer_file_ids_json: JSON.stringify(
          uniqueStrings(snapshot.parentJob.config.developerFileIds)
        ),
        continuation_budget: snapshot.parentJob.config.maxContinuations,
        continuations_used: 0,
        auto_retry_budget: snapshot.parentJob.config.maxAutoRetries,
        auto_retries_used: 0,
        manual_retries_used: 0,
        current_turn_index: snapshot.forkTurnIndex,
        total_turns: snapshot.turns.length,
        accepted_turn_index: 0,
        active_attempt_id: null,
        last_accepted_response_id: null,
        last_judge_response_id: null,
        parent_job_id: snapshot.parentJob.jobId,
        fork_turn_index: snapshot.forkTurnIndex,
        revision: 1,
        last_error_code: null,
        last_error_detail: null,
        warnings_json: "[]",
        usage_summary_json: usageSummaryJson,
        created_at: nowIso,
        updated_at: nowIso,
      });

      for (const turnSnapshot of snapshot.turns) {
        const turn = turnSnapshot.turn;
        insertTurn(this.sql, {
          turnIndex: turn.turnIndex,
          prompt: turn.promptText,
          attachmentFileIdsJson: JSON.stringify(turn.attachmentFileIds),
          status: "pending",
          nowIso,
        });

        const deliverable = turnSnapshot.acceptedDeliverable;
        const acceptedAttemptId = turn.acceptedAttemptId;
        const acceptedResponseId = turn.acceptedResponseId;
        if (
          deliverable === null ||
          acceptedAttemptId === null ||
          acceptedResponseId === null
        ) {
          throw new Error(
            `Branch turn ${turn.turnIndex} is missing its accepted candidate provenance`
          );
        }

        const candidateId = `${branchJobId}:t${turn.turnIndex}:branch`;
        insertTurnCandidate(this.sql, {
          candidateId,
          turnIndex: turn.turnIndex,
          attemptId: acceptedAttemptId,
          structuralStatus: "valid",
          parsedTagIndex: turn.turnIndex,
          deliverable: new Uint8Array(deliverable),
          accepted: false,
          warningJson: JSON.stringify(turn.warningMessages),
          createdAt: nowIso,
        });

        const turnSummary = getTurnSummary(this.sql, turn.turnIndex);
        if (turnSummary === null) {
          throw new Error(`Branch turn ${turn.turnIndex} was not inserted`);
        }
        const metadataBytes =
          measureByteLength(turnSummary.attachment_file_ids_json) +
          measureByteLength(candidateId) +
          measureByteLength(acceptedAttemptId) +
          measureByteLength(acceptedResponseId);
        const { rowBytes: turnRowBytes } = assertArtifactAndRowSize(
          turnSummary.prompt_bytes,
          metadataBytes,
          "turns.row_bytes"
        );
        withSqlErrorMapping(() => {
          this.sql.exec(
            `UPDATE turns
             SET status = 'accepted',
                 accepted_candidate_id = ?,
                 accepted_attempt_id = ?,
                 accepted_response_id = ?,
                 accepted_with_warning = ?,
                 row_bytes = ?,
                 updated_at = ?
             WHERE turn_index = ?`,
            candidateId,
            acceptedAttemptId,
            acceptedResponseId,
            turn.status === "accepted_with_warning" ? 1 : 0,
            turnRowBytes,
            nowIso,
            turn.turnIndex
          );
          this.sql.exec(
            "UPDATE turn_candidates SET accepted = 1 WHERE candidate_id = ?",
            candidateId
          );
          this.sql.exec(
            `UPDATE jobs
             SET accepted_turn_index = MAX(accepted_turn_index, ?),
                 last_accepted_response_id = ?,
                 current_turn_index = ?,
                 revision = revision + 1,
                 updated_at = ?
             WHERE job_id = ?`,
            turn.turnIndex,
            acceptedResponseId,
            turn.turnIndex,
            nowIso,
            branchJobId
          );
        });
      }

      for (const turnSnapshot of snapshot.turns) {
        for (const [attemptIndex, attempt] of turnSnapshot.attempts.entries()) {
          const requestBody = JSON.stringify(attempt);
          const copiedKind =
            attempt.continuationIndex > 0 ? "continuation" : "initial";
          const copiedParentResponseId =
            copiedKind === "continuation" && attemptIndex > 0
              ? turnSnapshot.attempts[attemptIndex - 1]!.responseId
              : null;
          insertGenerationAttempt(this.sql, {
            attemptId: attempt.attemptId,
            turnIndex: attempt.turnIndex,
            attemptNumber: attempt.attemptNumber,
            continuationIndex: attempt.continuationIndex,
            kind: copiedKind,
            status: attempt.status,
            idempotencyKey: `${branchJobId}:${attempt.idempotencyKey}`,
            parentResponseId: copiedParentResponseId,
            requestBody,
            diagnosticsJson: JSON.stringify({
              branch_copy: true,
              structural_kind: attempt.structuralKind,
              response_bytes: attempt.responseByteLength,
              deliverable_bytes: attempt.deliverableByteLength,
              provider_error_code: attempt.providerErrorCode,
              provider_error_message: attempt.providerErrorMessage,
              refusal_message: attempt.refusalMessage,
            }),
            nowIso,
          });
          updateGenerationAttemptState(this.sql, {
            attemptId: attempt.attemptId,
            status: attempt.status,
            providerResponseId: attempt.responseId,
            capacitySends: attempt.capacitySendCount,
            nextBackoffAtMs: attempt.nextCapacityRetryAtMs,
            pollProbes: attempt.fallbackPollCount,
            nextPollAtMs: attempt.nextFallbackPollAtMs,
            usageJson: attempt.usage === null ? null : JSON.stringify(attempt.usage),
            diagnosticsJson: JSON.stringify({
              branch_copy: true,
              structural_kind: attempt.structuralKind,
              response_bytes: attempt.responseByteLength,
              deliverable_bytes: attempt.deliverableByteLength,
              provider_error_code: attempt.providerErrorCode,
              provider_error_message: attempt.providerErrorMessage,
              refusal_message: attempt.refusalMessage,
            }),
            nowIso,
          });
        }

        for (const judgeCall of turnSnapshot.judgeCalls) {
          const requestBody = JSON.stringify(judgeCall);
          insertJudgeCall(this.sql, {
            judgeCallId: judgeCall.judgeCallId,
            turnIndex: judgeCall.turnIndex,
            candidateId: `${branchJobId}:t${judgeCall.turnIndex}:branch`,
            attemptId: judgeCall.attemptId,
            transport: judgeCall.transport,
            historyMode: judgeCall.historyMode,
            fileDeliveryMode: judgeCall.fileDeliveryMode,
            model: judgeCall.model,
            previousJudgeResponseId: null,
            manifestJson: JSON.stringify(judgeCall.fileManifest),
            requestBody,
            diagnosticsJson: JSON.stringify({
              provider: judgeCall.provider,
              response_bytes: judgeCall.responseByteLength,
              unknown_reason: judgeCall.unknownReason,
              unknown_message: judgeCall.unknownMessage,
              advisory_warnings: judgeCall.advisoryWarnings,
            }),
            nowIso,
          });
          const output = judgeCall.output;
          if (output !== null) {
            completeJudgeCall(this.sql, {
              judgeCallId: judgeCall.judgeCallId,
              status: "completed",
              providerResponseId: judgeCall.responseId,
              verdict: output.verdict,
              grade: output.grade,
              comment: output.comment,
              tagAgreement: output.tag_agreement,
              fileVisibility: output.file_visibility,
              usageJson: judgeCall.usage === null ? null : JSON.stringify(judgeCall.usage),
              diagnosticsJson: JSON.stringify({
                provider: judgeCall.provider,
                response_bytes: judgeCall.responseByteLength,
                unknown_reason: null,
                unknown_message: null,
                advisory_warnings: judgeCall.advisoryWarnings,
              }),
              nowIso,
            });
          } else if (judgeCall.status !== "pending") {
            completeJudgeCall(this.sql, {
              judgeCallId: judgeCall.judgeCallId,
              status: judgeCall.status === "completed" ? "unknown" : judgeCall.status,
              providerResponseId: judgeCall.responseId,
              verdict: "UNKNOWN",
              grade: null,
              comment: null,
              tagAgreement: null,
              fileVisibility: null,
              usageJson: judgeCall.usage === null ? null : JSON.stringify(judgeCall.usage),
              diagnosticsJson: JSON.stringify({
                provider: judgeCall.provider,
                response_bytes: judgeCall.responseByteLength,
                unknown_reason: judgeCall.unknownReason,
                unknown_message: judgeCall.unknownMessage,
                advisory_warnings: judgeCall.advisoryWarnings,
              }),
              nowIso,
            });
          }
        }
      }

      insertBranchLineage(this.sql, {
        job_id: branchJobId,
        parent_job_id: snapshot.parentJob.jobId,
        parent_revision: snapshot.parentJob.revision,
        fork_turn_index: snapshot.forkTurnIndex,
        snapshot_bytes: snapshot.encodedByteLength,
        snapshot_sha256: snapshotSha256,
        files_protected: 1,
        parent_superseded: 1,
        created_at: nowIso,
      });
    });

    const parentSuperseded = await this.jobStub(snapshot.parentJob.jobId).supersedeParent(
      snapshot.parentJob.revision,
      branchJobId,
    );
    markBranchActivationFlags(this.sql, branchJobId, { parentSuperseded });

    const branchRow = requireJob(this.sql, branchJobId);
    await this.registryStub().registerJob(this.jobSummaryFromRow(branchRow));
    await this.scheduleEarliestObligation();

    return { kind: "created", branchJobId, parentSuperseded };
  }

  async receiveWebhookDelivery(event: VerifiedWebhookEvent): Promise<void> {
    const attempt = this.findAttemptByResponseId(event.responseId);
    if (attempt === null) {
      return;
    }
    const job = getJob(this.sql);
    if (job === null || job.status === "cancelled" || job.status === "superseded") {
      return;
    }
    if (attempt.status !== "dispatched" && attempt.status !== "dispatching") {
      // Duplicate or late deliveries retain RouterDO accounting without
      // reopening a settled execution decision.
      return;
    }
    await this.settleDispatchedAttempt(attempt.attempt_id);
  }

  async listTurns(
    request: CursorPageRequest & { maxTurnIndex?: TurnIndex }
  ): Promise<CursorPage<TurnSummaryRow>> {
    const limit = clampPageLimit(request.limit);
    const afterTurnIndex = parseNumberCursor(request.cursor, "listTurns.cursor");
    const raw = listTurnSummaries(this.sql, {
      afterTurnIndex,
      limit: limit < 100 ? limit + 1 : limit,
      maxTurnIndex:
        request.maxTurnIndex === undefined
          ? null
          : assertTurnIndex(request.maxTurnIndex, "listTurns.maxTurnIndex"),
    });
    const hasMore = raw.length > limit;
    const items = hasMore ? raw.slice(0, limit) : raw;
    return {
      items,
      nextCursor:
        hasMore && items.length > 0 ? String(items[items.length - 1]!.turn_index) : null,
      hasMore,
    };
  }

  async listAttempts(
    request: CursorPageRequest & { turnIndex?: TurnIndex }
  ): Promise<CursorPage<GenerationAttemptSummaryRow>> {
    const limit = clampPageLimit(request.limit);
    const afterAttemptId = parseStringCursor(request.cursor);
    const raw = listGenerationAttemptSummaries(this.sql, {
      turnIndex: request.turnIndex,
      afterAttemptId,
      limit: limit < 100 ? limit + 1 : limit,
    });
    const hasMore = raw.length > limit;
    const items = hasMore ? raw.slice(0, limit) : raw;
    return {
      items,
      nextCursor:
        hasMore && items.length > 0 ? items[items.length - 1]!.attempt_id : null,
      hasMore,
    };
  }

  async listJudgeCalls(
    request: CursorPageRequest & { turnIndex?: TurnIndex }
  ): Promise<CursorPage<JudgeCallSummaryRow>> {
    const limit = clampPageLimit(request.limit);
    const afterJudgeCallId = parseStringCursor(request.cursor);
    const raw = listJudgeCallSummaries(this.sql, {
      turnIndex: request.turnIndex,
      afterJudgeCallId,
      limit: limit < 100 ? limit + 1 : limit,
    });
    const hasMore = raw.length > limit;
    const items = hasMore ? raw.slice(0, limit) : raw;
    return {
      items,
      nextCursor:
        hasMore && items.length > 0 ? items[items.length - 1]!.judge_call_id : null,
      hasMore,
    };
  }

  async captureExportHighWaterMarks(): Promise<ExportHighWaterMarks> {
    return captureExportHighWaterMarks(this.sql);
  }

  async readArtifact(request: {
    kind:
      | "turn_prompt"
      | "candidate_deliverable"
      | "attempt_request"
      | "attempt_response"
      | "judge_request";
    id: string | number;
  }): Promise<{ bytes: ArrayBuffer } | null> {
    switch (request.kind) {
      case "turn_prompt": {
        const turnIndex = parseArtifactTurnIndex(request.id);
        const bytes = getTurnPromptBlob(this.sql, turnIndex);
        return bytes === null ? null : { bytes: toArrayBuffer(bytes) };
      }
      case "candidate_deliverable": {
        const id = parseArtifactStringId(request.id);
        const bytes = getTurnCandidateDeliverableBlob(this.sql, id);
        return bytes === null ? null : { bytes: toArrayBuffer(bytes) };
      }
      case "attempt_request": {
        const id = parseArtifactStringId(request.id);
        const bytes = getGenerationAttemptRequestBlob(this.sql, id);
        return bytes === null ? null : { bytes: toArrayBuffer(bytes) };
      }
      case "attempt_response": {
        const id = parseArtifactStringId(request.id);
        const bytes = getAttemptResponseArtifactBlob(this.sql, id);
        return bytes === null ? null : { bytes: toArrayBuffer(bytes) };
      }
      case "judge_request": {
        const id = parseArtifactStringId(request.id);
        const bytes = getJudgeCallRequestBlob(this.sql, id);
        return bytes === null ? null : { bytes: toArrayBuffer(bytes) };
      }
    }
  }

  // --------------------------------------------------------------------------
  // Platform alarm
  // --------------------------------------------------------------------------

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await runWithAlarmSafety(this.ctx.storage, alarmInfo, async () => {
      const dueWork = listDueDurableWork(this.sql, now(), 100);
      for (const work of dueWork) {
        await this.processDurableWork(work);
      }
      return this.nextAlarmDeadline();
    });
  }

  // --------------------------------------------------------------------------
  // Storage & binding helpers
  // --------------------------------------------------------------------------

  private get storage(): SchemaTransactionalStorage {
    return this.ctx.storage as unknown as SchemaTransactionalStorage;
  }

  private get sql(): SchemaSqlStorage {
    return this.storage.sql;
  }

  private registryStub(): RegistryDoRpc {
    const namespace = this.env.REGISTRY_DO;
    return namespace.get(namespace.idFromName(REGISTRY_DO_NAME)) as unknown as RegistryDoRpc;
  }

  private routerStub(): RouterDoRpc {
    const namespace = this.env.ROUTER_DO;
    return namespace.get(namespace.idFromName(ROUTER_DO_NAME)) as unknown as RouterDoRpc;
  }

  private jobStub(jobId: JobId): JobDoRpc {
    const namespace = this.env.JOB_DO;
    return namespace.get(namespace.idFromName(jobId)) as unknown as JobDoRpc;
  }

  private nextAlarmDeadline(): number | null {
    const workDue = getEarliestDurableWorkDueAtMs(this.sql);
    const job = getJob(this.sql);
    const attempt =
      job !== null && job.active_attempt_id !== null
        ? getGenerationAttemptSummary(this.sql, job.active_attempt_id)
        : null;
    return earliestDeadline([
      workDue,
      attempt === null ? null : attempt.next_backoff_at_ms,
      attempt === null ? null : attempt.next_poll_at_ms,
    ]);
  }

  private async scheduleEarliestObligation(): Promise<void> {
    const deadline = this.nextAlarmDeadline();
    if (deadline === null) {
      return;
    }
    await ensureAlarmNotLaterThan(this.ctx.storage, deadline);
  }

  private async publishAndSchedule(row: JobRow): Promise<void> {
    await this.publishJobIndex(row);
    await this.scheduleEarliestObligation();
  }

  private async publishJobIndex(row: JobRow): Promise<void> {
    await this.registryStub().updateJobIndexStatus(
      row.job_id,
      row.status,
      row.revision,
      row.current_turn_index,
      this.countAcceptedTurns(),
    );
  }

  // --------------------------------------------------------------------------
  // Command validation
  // --------------------------------------------------------------------------

  private validateCreateJobCommand(command: CreateJobCommand): void {
    if (typeof command.jobId !== "string" || command.jobId.trim().length === 0) {
      throw new Error("CreateJobCommand.jobId must be a non-empty string");
    }
    if (typeof command.title !== "string") {
      throw new Error("CreateJobCommand.title must be a string");
    }
    const config = command.config;
    const profile = getVerifiedGenerationModel(config.model);
    if (profile === undefined) {
      throw new Error(`Unknown generation model: ${config.model}`);
    }
    if (!isReasoningEffort(config.reasoningEffort)) {
      throw new Error(`Unsupported reasoning effort: ${String(config.reasoningEffort)}`);
    }
    if (!profile.supportedReasoningEfforts.includes(config.reasoningEffort)) {
      throw new Error(
        `Model ${profile.id} does not support reasoning effort ${config.reasoningEffort}; supported efforts: ${profile.supportedReasoningEfforts.join(", ")}`
      );
    }
    if (
      !Number.isInteger(config.maxOutputTokens) ||
      config.maxOutputTokens <= 0
    ) {
      throw new Error("CreateJobCommand.config.maxOutputTokens must be a positive integer");
    }
    if (config.maxOutputTokens > profile.maxOutputTokens) {
      throw new Error(
        `CreateJobCommand.config.maxOutputTokens ${config.maxOutputTokens} exceeds the ${profile.id} limit of ${profile.maxOutputTokens}`
      );
    }
    if (typeof config.developerPrompt !== "string") {
      throw new Error("CreateJobCommand.config.developerPrompt must be a string");
    }
    if (!Array.isArray(config.developerFileIds)) {
      throw new Error("CreateJobCommand.config.developerFileIds must be an array");
    }
    for (const fileId of config.developerFileIds) {
      if (typeof fileId !== "string" || fileId.length === 0) {
        throw new Error(
          "CreateJobCommand.config.developerFileIds must contain only non-empty strings"
        );
      }
    }
    if (
      config.cacheTtl !== "30m" &&
      config.cacheTtl !== "12h" &&
      config.cacheTtl !== "24h" &&
      config.cacheTtl !== "nocache"
    ) {
      throw new Error(`Unsupported cache TTL: ${String(config.cacheTtl)}`);
    }
    if (typeof config.webSearch !== "boolean") {
      throw new Error("CreateJobCommand.config.webSearch must be boolean");
    }
    if (config.maxContinuations !== MAX_AUTO_CONTINUATIONS_PER_TURN) {
      throw new Error(
        `Automatic continuation budget is fixed at ${MAX_AUTO_CONTINUATIONS_PER_TURN} per job`
      );
    }
    if (config.maxAutoRetries !== MAX_AUTO_FULL_RETRIES) {
      throw new Error(
        `Automatic full retry budget is fixed at ${MAX_AUTO_FULL_RETRIES} per job`
      );
    }
    if (!Array.isArray(command.initialTurns)) {
      throw new Error("CreateJobCommand.initialTurns must be an array");
    }
    command.initialTurns.forEach((turn: CreateJobCommand["initialTurns"][number], index) => {
      if (turn.turnIndex !== index + 1) {
        throw new Error(
          `CreateJobCommand initial turns must be sequential 1-based; expected ${index + 1}, got ${turn.turnIndex}`
        );
      }
      if (typeof turn.promptText !== "string") {
        throw new Error(`Initial turn ${turn.turnIndex} promptText must be a string`);
      }
      if (!Array.isArray(turn.attachmentFileIds)) {
        throw new Error(`Initial turn ${turn.turnIndex} attachmentFileIds must be an array`);
      }
    });
  }

  private collectCommandFileIds(command: CreateJobCommand): FileId[] {
    const fileIds: FileId[] = [];
    for (const turn of command.initialTurns) {
      fileIds.push(...turn.attachmentFileIds);
    }
    return uniqueStrings(fileIds);
  }

  // --------------------------------------------------------------------------
  // Collection helpers (sync, paged, BLOB-free)
  // --------------------------------------------------------------------------

  private getLastTurnIndex(): number {
    let last = 0;
    let afterTurnIndex: number | null = null;
    for (;;) {
      const page = listTurnSummaries(this.sql, { afterTurnIndex, limit: 100 });
      if (page.length === 0) {
        return last;
      }
      last = page[page.length - 1]!.turn_index;
      if (page.length < 100) {
        return last;
      }
      afterTurnIndex = last;
    }
  }

  private listAllTurnSummaries(maxTurnIndex: number | null): TurnSummaryRow[] {
    const result: TurnSummaryRow[] = [];
    let afterTurnIndex: number | null = null;
    for (;;) {
      const page = listTurnSummaries(this.sql, {
        afterTurnIndex,
        maxTurnIndex,
        limit: 100,
      });
      result.push(...page);
      if (page.length < 100) {
        return result;
      }
      afterTurnIndex = page[page.length - 1]!.turn_index;
    }
  }

  private listAcceptedTurnSummaries(maxTurnIndex: number): TurnSummaryRow[] {
    const result: TurnSummaryRow[] = [];
    let afterTurnIndex: number | null = null;
    for (;;) {
      const page = listTurnSummaries(this.sql, {
        afterTurnIndex,
        maxTurnIndex,
        statuses: ["accepted"],
        limit: 100,
      });
      result.push(...page);
      if (page.length < 100) {
        return result;
      }
      afterTurnIndex = page[page.length - 1]!.turn_index;
    }
  }

  private listAllAttemptSummaries(turnIndex?: number): GenerationAttemptSummaryRow[] {
    const result: GenerationAttemptSummaryRow[] = [];
    let afterAttemptId: string | null = null;
    for (;;) {
      const page = listGenerationAttemptSummaries(this.sql, {
        turnIndex,
        afterAttemptId,
        limit: 100,
      });
      result.push(...page);
      if (page.length < 100) {
        return result;
      }
      afterAttemptId = page[page.length - 1]!.attempt_id;
    }
  }

  private listAllJudgeSummaries(turnIndex?: number): JudgeCallSummaryRow[] {
    const result: JudgeCallSummaryRow[] = [];
    let afterJudgeCallId: string | null = null;
    for (;;) {
      const page = listJudgeCallSummaries(this.sql, {
        turnIndex,
        afterJudgeCallId,
        limit: 100,
      });
      result.push(...page);
      if (page.length < 100) {
        return result;
      }
      afterJudgeCallId = page[page.length - 1]!.judge_call_id;
    }
  }

  private listAllCandidateSummaries(turnIndex: number): TurnCandidateSummaryRow[] {
    const result: TurnCandidateSummaryRow[] = [];
    let afterCandidateId: string | null = null;
    for (;;) {
      const page = listTurnCandidateSummaries(this.sql, {
        turnIndex,
        afterCandidateId,
        limit: 100,
      });
      result.push(...page);
      if (page.length < 100) {
        return result;
      }
      afterCandidateId = page[page.length - 1]!.candidate_id;
    }
  }

  private listAllDurableWork(): DurableWorkRow[] {
    return listDueDurableWork(this.sql, Number.MAX_SAFE_INTEGER, 100);
  }

  private computeUsageAggregate(): UsageAggregate {
    const generationUsage = this.listAllAttemptSummaries().map((row) =>
      parseTokenUsage(row.usage_json)
    );
    const judgeUsage = this.listAllJudgeSummaries().map((row) =>
      parseTokenUsage(row.usage_json)
    );
    return aggregateUsage({ generationUsage, judgeUsage });
  }

  private usageFromSnapshot(snapshot: BranchSnapshot): UsageAggregate {
    const generationUsage: (TokenUsageRecord | null)[] = [];
    const judgeUsage: (TokenUsageRecord | null)[] = [];
    for (const turn of snapshot.turns) {
      for (const attempt of turn.attempts) {
        generationUsage.push(attempt.usage);
      }
      for (const call of turn.judgeCalls) {
        judgeUsage.push(call.usage);
      }
    }
    return aggregateUsage({ generationUsage, judgeUsage });
  }

  private buildTurnRecords(jobRow: JobRow): TurnRecord[] {
    const attemptsByTurn = new Map<number, GenerationAttemptSummaryRow[]>();
    for (const attempt of this.listAllAttemptSummaries()) {
      const list = attemptsByTurn.get(attempt.turn_index) ?? [];
      list.push(attempt);
      attemptsByTurn.set(attempt.turn_index, list);
    }
    const firstJudgeByTurn = new Map<number, string>();
    for (const call of this.listAllJudgeSummaries()) {
      if (!firstJudgeByTurn.has(call.turn_index)) {
        firstJudgeByTurn.set(call.turn_index, call.judge_call_id);
      }
    }

    const records: TurnRecord[] = [];
    for (const summary of this.listAllTurnSummaries(null)) {
      const promptText = getTurnPromptText(this.sql, summary.turn_index) ?? "";
      const acceptedCandidate =
        summary.accepted_candidate_id === null
          ? null
          : getTurnCandidateSummary(this.sql, summary.accepted_candidate_id);
      const attempts = attemptsByTurn.get(summary.turn_index) ?? [];
      const continuationCount = attempts.filter(
        (attempt) => attempt.kind === "continuation"
      ).length;
      let reportedCandidate = acceptedCandidate;
      if (reportedCandidate === null) {
        let latestAttemptNumber = -1;
        for (const candidate of this.listAllCandidateSummaries(summary.turn_index)) {
          const candidateAttempt = attempts.find(
            (attempt) => attempt.attempt_id === candidate.attempt_id
          );
          const candidateAttemptNumber =
            candidateAttempt === undefined ? 0 : candidateAttempt.attempt_number;
          if (candidateAttemptNumber >= latestAttemptNumber) {
            latestAttemptNumber = candidateAttemptNumber;
            reportedCandidate = candidate;
          }
        }
      }
      const record = turnRowToRecord(
        summary,
        jobRow.job_id,
        promptText,
        acceptedCandidate === null ? null : acceptedCandidate.deliverable_bytes,
        firstJudgeByTurn.get(summary.turn_index) ?? null,
        jobRow.active_attempt_id !== null &&
          attempts.some((attempt) => attempt.attempt_id === jobRow.active_attempt_id)
          ? jobRow.active_attempt_id
          : null,
        jobRow.revision
      );
      records.push({
        ...record,
        continuationsUsed: continuationCount,
        warningMessages:
          reportedCandidate === null ? [] : readStringArray(reportedCandidate.warning_json),
      });
    }
    return records;
  }

  private jobSummaryFromRow(row: JobRow): {
    jobId: JobId;
    title: string;
    status: JobRow["status"];
    model: string;
    currentTurnIndex: TurnIndex;
    acceptedTurnCount: number;
    totalEstimatedCostUsd: number | null;
    createdAtMs: number;
    updatedAtMs: number;
  } {
    const usage = this.computeUsageAggregate();
    return {
      jobId: row.job_id,
      title: row.title,
      status: row.status,
      model: row.model,
      currentTurnIndex: row.current_turn_index,
      acceptedTurnCount: this.countAcceptedTurns(),
      totalEstimatedCostUsd: usage.totalEstimatedCostUsd,
      createdAtMs: parseIsoMs(row.created_at),
      updatedAtMs: parseIsoMs(row.updated_at),
    };
  }

  private countAcceptedTurns(): number {
    const rows = this.sql
      .exec<{ total: number }>(
        "SELECT COUNT(*) AS total FROM turns WHERE status IN ('accepted', 'accepted_with_warning')",
      )
      .toArray();
    return rows[0]?.total ?? 0;
  }

  private async requireState(): Promise<JobStateResponse> {
    const state = await this.getState();
    if (state === null) {
      throw new Error("Job record not found");
    }
    return state;
  }

  /**
   * Called by a child branch on its parent. Supersedes the parent only when the
   * parent is still quiescent and its revision is exactly `epoch` (the revision
   * captured into the branch snapshot). Idempotent once superseded.
   */
  async supersedeParent(epoch: number, childId: string): Promise<boolean> {
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw new RangeError("epoch must be a positive safe integer");
    }
    if (typeof childId !== "string" || childId.trim().length === 0) {
      throw new Error("childId must be a non-empty string");
    }
    const branchJobId = childId;
    const job = getJob(this.sql);
    if (job === null) {
      return false;
    }
    if (job.status === "superseded") {
      return true;
    }
    const state = await this.getState();
    if (state === null || state.job.revision !== epoch || !this.isQuiescentRecord(state)) {
      return false;
    }

    const nowIso = toIso(now());
    const warnings = readStringArray(job.warnings_json);
    const marker = `superseded_by:${branchJobId}`;
    if (!warnings.includes(marker)) {
      warnings.push(marker);
    }

    this.storage.transactionSync(() => {
      updateJobStatusAndRevision(this.sql, {
        jobId: job.job_id,
        status: "superseded",
        activeAttemptId: null,
        warningsJson: JSON.stringify(warnings),
        updatedAt: nowIso,
      });
    });

    const updated = requireJob(this.sql, job.job_id);
    await this.publishAndSchedule(updated);
    return true;
  }

  private isJobQuiescent(job: JobRow): boolean {
    if (job.active_attempt_id !== null) {
      const attempt = getGenerationAttemptSummary(this.sql, job.active_attempt_id);
      if (attempt !== null && IN_FLIGHT_ATTEMPT_STATUSES.has(attempt.status)) {
        return false;
      }
    }
    return this.listAllDurableWork().length === 0;
  }

  private isQuiescentRecord(state: JobStateResponse): boolean {
    const active = state.activeAttempt;
    return active === null || !IN_FLIGHT_ATTEMPT_STATUSES.has(active.status);
  }

  private findAttemptByResponseId(
    responseId: string
  ): GenerationAttemptSummaryRow | null {
    let afterAttemptId: string | null = null;
    for (;;) {
      const page = listGenerationAttemptSummaries(this.sql, {
        afterAttemptId,
        limit: 100,
      });
      for (const attempt of page) {
        if (attempt.provider_response_id === responseId) {
          return attempt;
        }
      }
      if (page.length < 100) {
        return null;
      }
      afterAttemptId = page[page.length - 1]!.attempt_id;
    }
  }

  // --------------------------------------------------------------------------
  // Generation prepare / perform / reconcile
  // --------------------------------------------------------------------------

  private nextAttemptNumber(turnIndex: number): number {
    let max = 0;
    for (const attempt of this.listAllAttemptSummaries(turnIndex)) {
      if (attempt.attempt_number > max) {
        max = attempt.attempt_number;
      }
    }
    return max + 1;
  }

  private loadPriorAcceptedTurns(turnIndex: TurnIndex): PriorAcceptedTurn[] {
    if (turnIndex <= 1) {
      return [];
    }
    const prior: PriorAcceptedTurn[] = [];
    for (const summary of this.listAcceptedTurnSummaries(turnIndex - 1)) {
      if (summary.accepted_candidate_id === null) {
        continue;
      }
      const text = getTurnCandidateDeliverableText(
        this.sql,
        summary.accepted_candidate_id
      );
      if (text === null) {
        continue;
      }
      prior.push({
        turnIndex: summary.turn_index,
        deliverableText: text,
        attachmentFileIds: readStringArray(summary.attachment_file_ids_json),
      });
    }
    return prior;
  }

  private prepareGenerationAttempt(
    jobId: JobId,
    turnIndex: TurnIndex,
    kind: GenerationAttemptKind,
    continuationIndex: number,
    parentResponseId: string | null
  ): PreparedAttempt {
    const job = requireJob(this.sql, jobId);
    const turn = getTurnSummary(this.sql, turnIndex);
    if (turn === null) {
      throw new Error(`Turn not found: ${turnIndex}`);
    }
    if (turn.turn_index !== job.accepted_turn_index + 1) {
      throw new Error(
        `Turn ${turnIndex} cannot start before accepted anchor ${job.accepted_turn_index}`
      );
    }
    const attemptNumber = this.nextAttemptNumber(turnIndex);
    const promptText = getTurnPromptText(this.sql, turnIndex) ?? "";
    const attachmentFileIds = readStringArray(turn.attachment_file_ids_json);
    const priorAcceptedTurns = this.loadPriorAcceptedTurns(turnIndex);
    const anchor =
      kind === "continuation"
        ? parentResponseId
        : kind === "initial"
          ? job.last_accepted_response_id
          : null;
    const jobConfig = jobConfigFromRow(job);
    const canonical = buildCanonicalGenerationRequest({
      jobId: job.job_id,
      model: jobConfig.model,
      reasoningEffort: jobConfig.reasoningEffort,
      maxOutputTokens: jobConfig.maxOutputTokens,
      cacheTtl: jobConfig.cacheTtl,
      webSearch: jobConfig.webSearch,
      turnIndex,
      attemptNumber,
      continuationIndex,
      attemptKind: kind,
      promptText,
      attachmentFileIds,
      developerPrompt: jobConfig.developerPrompt,
      developerFileIds: jobConfig.developerFileIds,
      previousResponseId: anchor,
      priorAcceptedTurns: anchor === null ? priorAcceptedTurns : undefined,
    });

    const nowMs = now();
    const nowIso = toIso(nowMs);
    let inserted: GenerationAttemptSummaryRow | null = null;
    this.storage.transactionSync(() => {
      const currentJob = requireJob(this.sql, jobId);
      if (currentJob.active_attempt_id !== null) {
        const active = getGenerationAttemptSummary(
          this.sql,
          currentJob.active_attempt_id
        );
        if (active !== null && IN_FLIGHT_ATTEMPT_STATUSES.has(active.status)) {
          throw new Error(
            `Generation attempt ${active.attempt_id} is still ${active.status}`
          );
        }
      }
      inserted = insertGenerationAttempt(this.sql, {
        attemptId: `${jobId}:t${turnIndex}:a${attemptNumber}`,
        turnIndex,
        attemptNumber,
        continuationIndex,
        kind,
        status: "prepared",
        idempotencyKey: canonical.idempotencyKey,
        parentResponseId,
        requestBody: canonical.requestBytes,
        diagnosticsJson: JSON.stringify(emptyAttemptDiagnostics()),
        nowIso,
      });
      updateTurnStatus(this.sql, turnIndex, "running", nowIso);
      updateJobStatusAndRevision(this.sql, {
        jobId,
        status: "running",
        activeAttemptId: inserted.attempt_id,
        currentTurnIndex: turnIndex,
        updatedAt: nowIso,
      });
      upsertDurableWork(this.sql, {
        work_id: `${inserted.attempt_id}${DISPATCH_WORK_SUFFIX}`,
        kind: "capacity_backoff",
        attempt_id: inserted.attempt_id,
        turn_index: turnIndex,
        due_at_ms: nowMs + DISPATCH_WORK_DELAY_MS,
        payload_json: JSON.stringify({
          kind: "generation_dispatch",
          attemptId: inserted.attempt_id,
        }),
        created_at: nowIso,
      });
    });
    if (inserted === null) {
      throw new Error("Generation attempt insert did not complete");
    }
    return { attempt: inserted };
  }

  private async startGenerationAttempt(
    jobId: JobId,
    turnIndex: TurnIndex,
    kind: GenerationAttemptKind,
    continuationIndex: number,
    parentResponseId: string | null
  ): Promise<void> {
    const prepared = this.prepareGenerationAttempt(
      jobId,
      turnIndex,
      kind,
      continuationIndex,
      parentResponseId
    );
    const row = requireJob(this.sql, jobId);
    await this.publishAndSchedule(row);
    await this.performGenerationDispatch(prepared.attempt.attempt_id);
  }

  private async performGenerationDispatch(attemptId: string): Promise<void> {
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null) {
      return;
    }
    if (attempt.status !== "prepared" && attempt.status !== "capacity_backoff") {
      return;
    }
    const job = requireJob(this.sql);
    const nowMs = now();
    const nowIso = toIso(nowMs);
    this.storage.transactionSync(() => {
      updateGenerationAttemptState(this.sql, {
        attemptId,
        status: "dispatching",
        diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
          dispatch_started_at_ms: nowMs,
        }),
        nowIso,
      });
    });

    let apiKey: string;
    try {
      apiKey = resolveEnvSecret(this.env, "OPENAI_API_KEY");
    } catch (error) {
      await this.pauseForManualRecovery(
        job.job_id,
        attempt.turn_index,
        attemptId,
        "missing_provider_secret",
        describeError(error)
      );
      return;
    }

    const requestBytes = getGenerationAttemptRequestBlob(this.sql, attemptId);
    if (requestBytes === null) {
      await this.pauseStorage(job.job_id, attempt.turn_index, attemptId, "Missing generation request artifact");
      return;
    }

    let outcome;
    try {
      outcome = await dispatchResponsesCreate({
        apiKey,
        requestBytes,
        idempotencyKey: attempt.idempotency_key,
      });
    } catch (error) {
      await this.handleDispatchOutcome(attemptId, {
        kind: "ambiguous_dispatch",
        reason: "network_error",
        message: describeError(error),
      });
      return;
    }
    await this.handleDispatchOutcome(attemptId, outcome);
  }

  private async handleDispatchOutcome(
    attemptId: string,
    outcome: Awaited<ReturnType<typeof dispatchResponsesCreate>>
  ): Promise<void> {
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null) {
      return;
    }
    const job = requireJob(this.sql);
    const nowMs = now();
    const nowIso = toIso(nowMs);
    const decision = classifyDispatchResult({
      outcome,
      sendsCompleted: attempt.capacity_sends,
      nowMs,
    });

    switch (decision.kind) {
      case "dispatched": {
        let responseBytes: number | null = null;
        if (outcome.kind === "dispatched" && outcome.rawResponseBytes.byteLength > 0) {
          try {
            const artifact = putAttemptResponseArtifact(this.sql, {
              attemptId,
              turnIndex: attempt.turn_index,
              providerResponseId: decision.responseId,
              responseBody: outcome.rawResponseBytes,
              createdAt: nowIso,
            });
            responseBytes = artifact.response_bytes;
          } catch (error) {
            if (error instanceof ArtifactGuardError || error instanceof StorageFullError) {
              await this.pauseStorage(
                job.job_id,
                attempt.turn_index,
                attemptId,
                describeError(error)
              );
              return;
            }
            throw error;
          }
        }

        const nextPollAtMs = getNextFallbackPollAt(attempt.poll_probes, nowMs);
        this.storage.transactionSync(() => {
          updateGenerationAttemptState(this.sql, {
            attemptId,
            status: "dispatched",
            providerResponseId: decision.responseId,
            capacitySends: Math.min(
              MAX_FLEX_CAPACITY_SENDS_PER_ATTEMPT,
              attempt.capacity_sends + 1
            ),
            nextBackoffAtMs: null,
            nextPollAtMs,
            diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
              response_bytes: responseBytes,
              dispatch_started_at_ms: null,
              provider_error_code: null,
              provider_error_message: null,
            }),
            nowIso,
          });
          deleteDurableWork(this.sql, `${attemptId}${DISPATCH_WORK_SUFFIX}`);
          if (nextPollAtMs !== null) {
            upsertDurableWork(this.sql, {
              work_id: `${attemptId}${POLL_WORK_SUFFIX}`,
              kind: "fallback_poll",
              attempt_id: attemptId,
              turn_index: attempt.turn_index,
              due_at_ms: nextPollAtMs,
              payload_json: JSON.stringify({
                kind: "generation_poll",
                attemptId,
              }),
              created_at: nowIso,
            });
          }
        });

        try {
          await this.routerStub().registerResponseRoute({
            responseId: decision.responseId,
            jobId: job.job_id,
            attemptId,
            turnIndex: attempt.turn_index,
            registeredAtMs: nowMs,
            settledAtMs: null,
          });
        } catch (error) {
          // The fallback-poll alarm re-registers an unregistered route.
          const fresh = getGenerationAttemptSummary(this.sql, attemptId);
          if (fresh !== null) {
            this.storage.transactionSync(() => {
              updateGenerationAttemptState(this.sql, {
                attemptId,
                status: "dispatched",
                diagnosticsJson: mergeAttemptDiagnostics(fresh.diagnostics_json, {
                  provider_error_message: `route_registration_pending: ${describeError(error)}`,
                }),
                nowIso,
              });
            });
          }
        }

        const updated = updateJobStatusAndRevision(this.sql, {
          jobId: job.job_id,
          status: "running",
          activeAttemptId: attemptId,
          currentTurnIndex: attempt.turn_index,
          lastErrorCode: null,
          lastErrorDetail: null,
          updatedAt: nowIso,
        });
        await this.publishAndSchedule(updated);
        return;
      }

      case "retry_capacity": {
        this.storage.transactionSync(() => {
          updateGenerationAttemptState(this.sql, {
            attemptId,
            status: "capacity_backoff",
            capacitySends: decision.sendsCompleted,
            nextBackoffAtMs: decision.dueAtMs,
            diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
              provider_error_message: decision.message,
              dispatch_started_at_ms: null,
            }),
            nowIso,
          });
          upsertDurableWork(this.sql, {
            work_id: `${attemptId}${DISPATCH_WORK_SUFFIX}`,
            kind: "capacity_backoff",
            attempt_id: attemptId,
            turn_index: attempt.turn_index,
            due_at_ms: decision.dueAtMs,
            payload_json: JSON.stringify({
              kind: "generation_dispatch",
              attemptId,
            }),
            created_at: nowIso,
          });
        });
        await this.scheduleEarliestObligation();
        return;
      }

      case "capacity_exhausted":
        await this.pauseForManualRecovery(
          job.job_id,
          attempt.turn_index,
          attemptId,
          "capacity_exhausted",
          decision.message,
          "capacity_exhausted"
        );
        return;

      case "ambiguous_dispatch":
        await this.pauseForManualRecovery(
          job.job_id,
          attempt.turn_index,
          attemptId,
          "ambiguous_dispatch",
          decision.message,
          "ambiguous_dispatch"
        );
        return;

      case "terminal_error": {
        this.storage.transactionSync(() => {
          updateGenerationAttemptState(this.sql, {
            attemptId,
            status: "failed",
            nextBackoffAtMs: null,
            nextPollAtMs: null,
            diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
              provider_error_code: decision.errorCode,
              provider_error_message: decision.message,
              dispatch_started_at_ms: null,
            }),
            nowIso,
          });
          updateTurnStatus(this.sql, attempt.turn_index, "failed", nowIso);
          deleteDurableWork(this.sql, `${attemptId}${DISPATCH_WORK_SUFFIX}`);
          deleteDurableWork(this.sql, `${attemptId}${POLL_WORK_SUFFIX}`);
          updateJobStatusAndRevision(this.sql, {
            jobId: job.job_id,
            status: "failed",
            activeAttemptId: null,
            currentTurnIndex: attempt.turn_index,
            lastErrorCode: decision.errorCode ?? "dispatch_terminal_error",
            lastErrorDetail: decision.message,
            usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
            updatedAt: nowIso,
          });
        });
        const failedRow = requireJob(this.sql, job.job_id);
        await this.publishAndSchedule(failedRow);
        await this.registryStub().releaseJobFileRefs(job.job_id);
        return;
      }
    }
  }

  private async settleDispatchedAttempt(
    attemptId: string
  ): Promise<"settled" | "still_running" | "skipped"> {
    const claim = this.claimSettlement(attemptId);
    if (claim === null) {
      return "skipped";
    }
    const apiKey = resolveEnvSecret(this.env, "OPENAI_API_KEY");
    const responseId = claim.attempt.provider_response_id;
    if (responseId === null) {
      this.releaseSettlementClaim(attemptId, claim.attempt.diagnostics_json, "Missing provider response id");
      return "skipped";
    }

    let retrieval: ProviderResponseRetrieval;
    try {
      retrieval = await retrieveProviderResponse({ apiKey, responseId });
    } catch (error) {
      this.releaseSettlementClaim(
        attemptId,
        claim.attempt.diagnostics_json,
        describeError(error)
      );
      throw error;
    }

    if (retrieval.kind === "still_running") {
      this.releaseSettlementClaim(
        attemptId,
        claim.attempt.diagnostics_json,
        null
      );
      return "still_running";
    }

    await this.handleSettledResponse(claim, retrieval);
    return "settled";
  }

  private claimSettlement(attemptId: string): SettlementClaim | null {
    const job = getJob(this.sql);
    if (job === null) {
      return null;
    }
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null) {
      return null;
    }
    const nowMs = now();
    const diagnostics = parseAttemptDiagnostics(attempt.diagnostics_json);
    if (attempt.status === "dispatching") {
      if (
        diagnostics.settle_claimed_at_ms !== null &&
        nowMs - diagnostics.settle_claimed_at_ms < WORK_CLAIM_STALE_MS
      ) {
        return null;
      }
      if (
        diagnostics.dispatch_started_at_ms !== null &&
        nowMs - diagnostics.dispatch_started_at_ms < WORK_CLAIM_STALE_MS
      ) {
        return null;
      }
    } else if (attempt.status !== "dispatched") {
      return null;
    }
    const turn = getTurnSummary(this.sql, attempt.turn_index);
    if (turn === null) {
      return null;
    }
    const nowIso = toIso(nowMs);
    this.storage.transactionSync(() => {
      updateGenerationAttemptState(this.sql, {
        attemptId,
        status: "dispatching",
        diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
          settle_claimed_at_ms: nowMs,
        }),
        nowIso,
      });
    });
    const claimed = getGenerationAttemptSummary(this.sql, attemptId);
    if (claimed === null) {
      return null;
    }
    return { attempt: claimed, job, turn };
  }

  private releaseSettlementClaim(
    attemptId: string,
    diagnosticsJson: string,
    errorMessage: string | null
  ): void {
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null || attempt.status !== "dispatching") {
      return;
    }
    const nowIso = toIso(now());
    this.storage.transactionSync(() => {
      updateGenerationAttemptState(this.sql, {
        attemptId,
        status: "dispatched",
        diagnosticsJson: mergeAttemptDiagnostics(diagnosticsJson, {
          settle_claimed_at_ms: null,
          provider_error_message: errorMessage,
        }),
        nowIso,
      });
    });
  }

  private async handleSettledResponse(
    claim: SettlementClaim,
    retrieval: Extract<ProviderResponseRetrieval, { kind: "settled" }>
  ): Promise<void> {
    const job = requireJob(this.sql, claim.job.job_id);
    const attempt = claim.attempt;
    const turn = claim.turn;
    const nowMs = now();
    const nowIso = toIso(nowMs);

    let responseBytes: number | null = null;
    if (retrieval.rawResponseBytes.byteLength > 0) {
      try {
        const artifact = putAttemptResponseArtifact(this.sql, {
          attemptId: attempt.attempt_id,
          turnIndex: attempt.turn_index,
          providerResponseId: retrieval.responseId,
          responseBody: retrieval.rawResponseBytes,
          createdAt: nowIso,
        });
        responseBytes = artifact.response_bytes;
      } catch (error) {
        if (error instanceof ArtifactGuardError || error instanceof StorageFullError) {
          await this.pauseStorage(job.job_id, turn.turn_index, attempt.attempt_id, describeError(error));
          return;
        }
        throw error;
      }
    }

    const cumulative = this.assembleCumulativeText(attempt, retrieval.outputText ?? "");
    const outcome = classifyCandidateOutcome({
      rawOutputText: cumulative.text,
      expectedTurnIndex: attempt.turn_index,
      providerStatus:
        retrieval.status === "completed" ? "completed" : retrieval.status,
      refusalText: retrieval.refusalText,
    });
    const warnings = [...outcome.warnings];
    if (!cumulative.complete) {
      warnings.push("continuation_history_missing");
    }
    const deliverable = classificationDeliverableText(outcome);
    const deliverableBytes = deliverable === null ? 0 : measureByteLength(deliverable);

    let candidate: TurnCandidateSummaryRow;
    try {
      candidate = insertTurnCandidate(this.sql, {
        candidateId: `${attempt.attempt_id}:candidate`,
        turnIndex: attempt.turn_index,
        attemptId: attempt.attempt_id,
        structuralStatus: outcome.structuralStatus,
        parsedTagIndex: classificationParsedTagIndex(outcome),
        deliverable,
        accepted: false,
        warningJson: JSON.stringify(warnings),
        createdAt: nowIso,
      });
    } catch (error) {
      if (error instanceof ArtifactGuardError || error instanceof StorageFullError) {
        await this.pauseStorage(job.job_id, turn.turn_index, attempt.attempt_id, describeError(error));
        return;
      }
      throw error;
    }

    this.storage.transactionSync(() => {
      updateGenerationAttemptState(this.sql, {
        attemptId: attempt.attempt_id,
        status: outcome.attemptStatus,
        nextBackoffAtMs: null,
        nextPollAtMs: null,
        usageJson: retrieval.usage === null ? null : JSON.stringify(retrieval.usage),
        diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
          response_bytes: responseBytes,
          deliverable_bytes: deliverableBytes,
          structural_kind: outcome.classification.kind,
          provider_error_code: retrieval.errorCode,
          provider_error_message: retrieval.errorMessage,
          refusal_message: retrieval.refusalText,
          settle_claimed_at_ms: null,
        }),
        nowIso,
      });
      updateTurnStatus(this.sql, turn.turn_index, outcome.turnStatus, nowIso);
      deleteDurableWork(this.sql, `${attempt.attempt_id}${DISPATCH_WORK_SUFFIX}`);
      deleteDurableWork(this.sql, `${attempt.attempt_id}${POLL_WORK_SUFFIX}`);
    });

    await this.applyStructuralOutcome(job, attempt, outcome, candidate, warnings);
  }

  private assembleCumulativeText(
    attempt: GenerationAttemptSummaryRow,
    currentText: string
  ): { readonly text: string; readonly complete: boolean } {
    const segments: string[] = [];
    let complete = true;
    let parentResponseId = attempt.parent_response_id;
    const seen = new Set<string>();
    let hops = 0;
    while (parentResponseId !== null && hops < 100) {
      if (seen.has(parentResponseId)) {
        complete = false;
        break;
      }
      seen.add(parentResponseId);
      const ancestor = this.findAttemptByResponseId(parentResponseId);
      if (ancestor === null) {
        complete = false;
        break;
      }
      const blob = getAttemptResponseArtifactBlob(this.sql, ancestor.attempt_id);
      if (blob === null) {
        complete = false;
        break;
      }
      const payload = tryParseJson(utf8Decoder.decode(blob));
      const text = extractJudgeRawText(payload, "responses");
      if (text !== null) {
        segments.unshift(text);
      }
      parentResponseId = ancestor.parent_response_id;
      hops += 1;
    }
    return { text: `${segments.join("")}${currentText}`, complete };
  }

  private async applyStructuralOutcome(
    job: JobRow,
    attempt: GenerationAttemptSummaryRow,
    outcome: CandidateOutcome,
    candidate: TurnCandidateSummaryRow,
    warnings: readonly string[]
  ): Promise<void> {
    const turn = getTurnSummary(this.sql, attempt.turn_index);
    if (turn === null) {
      return;
    }

    switch (outcome.structuralStatus) {
      case "valid":
      case "trailing_content":
        if (outcome.judgeRequired) {
          await this.runJudge(job, turn, attempt, candidate, warnings, outcome.structuralStatus === "valid");
        } else {
          await this.failTurnAndJob(
            job,
            attempt,
            outcome.structuralStatus,
            "Structural classification produced no judgeable deliverable"
          );
        }
        return;

      case "empty_output":
        await this.retryOrFailEmptyOutput(job, attempt, outcome);
        return;

      case "incomplete":
        await this.continueOrFailIncomplete(job, attempt);
        return;

      case "refusal":
        await this.pauseForReview(
          job,
          attempt,
          "refusal",
          "Provider refusal requires operator review",
          null
        );
        return;

      case "cancelled":
        this.storage.transactionSync(() => {
          const nowIso = toIso(now());
          updateTurnStatus(this.sql, attempt.turn_index, "cancelled", nowIso);
          updateJobStatusAndRevision(this.sql, {
            jobId: job.job_id,
            status: "cancelled",
            activeAttemptId: null,
            currentTurnIndex: attempt.turn_index,
            lastErrorCode: "provider_cancelled",
            lastErrorDetail: "The provider response was cancelled",
            usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
            updatedAt: nowIso,
          });
        });
        await this.finishTerminalJob(job.job_id, "cancelled");
        return;

      case "provider_failed":
        await this.failTurnAndJob(
          job,
          attempt,
          "provider_failed",
          "Provider response failed"
        );
        return;

      case "wrong_index":
      case "missing_tag":
      case "malformed_tag":
        await this.failTurnAndJob(
          job,
          attempt,
          outcome.structuralStatus,
          `Structural classification failed: ${outcome.structuralStatus}`
        );
        return;
    }
  }

  private async retryOrFailEmptyOutput(
    job: JobRow,
    attempt: GenerationAttemptSummaryRow,
    outcome: CandidateOutcome
  ): Promise<void> {
    const reason =
      outcome.classification.kind === "empty_output"
        ? outcome.classification.reason
        : "empty";
    if (job.auto_retries_used < job.auto_retry_budget) {
      const nowIso = toIso(now());
      this.storage.transactionSync(() => {
        updateJobStatusAndRevision(this.sql, {
          jobId: job.job_id,
          status: "running",
          activeAttemptId: null,
          currentTurnIndex: attempt.turn_index,
          autoRetriesUsed: job.auto_retries_used + 1,
          lastErrorCode: "empty_output",
          lastErrorDetail: `Empty output (${reason}); starting a fresh run`,
          updatedAt: nowIso,
        });
      });
      const fresh = requireJob(this.sql, job.job_id);
      await this.publishAndSchedule(fresh);
      await this.startGenerationAttempt(
        fresh.job_id,
        attempt.turn_index,
        "auto_retry",
        0,
        null
      );
      return;
    }
    await this.failTurnAndJob(
      job,
      attempt,
      "empty_output",
      `Empty output (${reason}) and no automatic retry remains`
    );
  }

  private async continueOrFailIncomplete(
    job: JobRow,
    attempt: GenerationAttemptSummaryRow
  ): Promise<void> {
    const continuationBudget = Math.min(
      job.continuation_budget,
      MAX_AUTO_CONTINUATIONS_PER_TURN
    );
    if (
      attempt.provider_response_id !== null &&
      job.continuations_used < continuationBudget &&
      attempt.continuation_index < continuationBudget
    ) {
      const nowIso = toIso(now());
      this.storage.transactionSync(() => {
        updateJobStatusAndRevision(this.sql, {
          jobId: job.job_id,
          status: "running",
          activeAttemptId: null,
          currentTurnIndex: attempt.turn_index,
          continuationsUsed: job.continuations_used + 1,
          updatedAt: nowIso,
        });
      });
      const fresh = requireJob(this.sql, job.job_id);
      await this.publishAndSchedule(fresh);
      await this.startGenerationAttempt(
        fresh.job_id,
        attempt.turn_index,
        "continuation",
        attempt.continuation_index + 1,
        attempt.provider_response_id
      );
      return;
    }
    await this.failTurnAndJob(
      job,
      attempt,
      "incomplete",
      "Provider response remained incomplete and the continuation budget is exhausted"
    );
  }

  private async failTurnAndJob(
    job: JobRow,
    attempt: GenerationAttemptSummaryRow,
    code: string,
    message: string
  ): Promise<void> {
    this.storage.transactionSync(() => {
      const nowIso = toIso(now());
      updateTurnStatus(this.sql, attempt.turn_index, "failed", nowIso);
      deleteDurableWork(this.sql, `${attempt.attempt_id}${DISPATCH_WORK_SUFFIX}`);
      deleteDurableWork(this.sql, `${attempt.attempt_id}${POLL_WORK_SUFFIX}`);
      updateJobStatusAndRevision(this.sql, {
        jobId: job.job_id,
        status: "failed",
        activeAttemptId: null,
        currentTurnIndex: attempt.turn_index,
        lastErrorCode: code,
        lastErrorDetail: message,
        usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
        updatedAt: nowIso,
      });
    });
    const failedRow = requireJob(this.sql, job.job_id);
    await this.publishAndSchedule(failedRow);
    await this.registryStub().releaseJobFileRefs(job.job_id);
  }

  private async finishTerminalJob(
    jobId: JobId,
    status: "completed" | "cancelled" | "failed" | "superseded"
  ): Promise<void> {
    const row = requireJob(this.sql, jobId);
    if (row.status !== status) {
      const updated = updateJobStatusAndRevision(this.sql, {
        jobId,
        status,
        activeAttemptId: null,
        usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
        updatedAt: toIso(now()),
      });
      await this.publishAndSchedule(updated);
    } else {
      await this.publishAndSchedule(row);
    }
    await this.registryStub().releaseJobFileRefs(jobId);
  }

  private async pauseStorage(
    jobId: JobId,
    turnIndex: TurnIndex,
    attemptId: string,
    message: string
  ): Promise<void> {
    this.storage.transactionSync(() => {
      const nowIso = toIso(now());
      const attempt = getGenerationAttemptSummary(this.sql, attemptId);
      if (attempt !== null) {
        updateGenerationAttemptState(this.sql, {
          attemptId,
          status: "failed",
          nextBackoffAtMs: null,
          nextPollAtMs: null,
          diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
            provider_error_message: message,
            settle_claimed_at_ms: null,
          }),
          nowIso,
        });
      }
      updateTurnStatus(this.sql, turnIndex, "paused_review", nowIso);
      deleteDurableWork(this.sql, `${attemptId}${DISPATCH_WORK_SUFFIX}`);
      deleteDurableWork(this.sql, `${attemptId}${POLL_WORK_SUFFIX}`);
      updateJobStatusAndRevision(this.sql, {
        jobId,
        status: "paused_storage",
        activeAttemptId: null,
        currentTurnIndex: turnIndex,
        lastErrorCode: "artifact_guard_exceeded",
        lastErrorDetail: message,
        updatedAt: nowIso,
      });
    });
    const row = requireJob(this.sql, jobId);
    await this.publishAndSchedule(row);
  }

  private async pauseForManualRecovery(
    jobId: JobId,
    turnIndex: TurnIndex,
    attemptId: string,
    code: string,
    message: string,
    attemptStatus: "capacity_exhausted" | "ambiguous_dispatch" = "ambiguous_dispatch"
  ): Promise<void> {
    this.storage.transactionSync(() => {
      const nowIso = toIso(now());
      const attempt = getGenerationAttemptSummary(this.sql, attemptId);
      if (attempt !== null) {
        updateGenerationAttemptState(this.sql, {
          attemptId,
          status: attemptStatus,
          nextBackoffAtMs: null,
          nextPollAtMs: null,
          diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
            provider_error_message: message,
            dispatch_started_at_ms: null,
            settle_claimed_at_ms: null,
          }),
          nowIso,
        });
      }
      updateTurnStatus(this.sql, turnIndex, "paused_review", nowIso);
      deleteDurableWork(this.sql, `${attemptId}${DISPATCH_WORK_SUFFIX}`);
      deleteDurableWork(this.sql, `${attemptId}${POLL_WORK_SUFFIX}`);
      updateJobStatusAndRevision(this.sql, {
        jobId,
        status: "paused_dispatch",
        activeAttemptId: null,
        currentTurnIndex: turnIndex,
        lastErrorCode: code,
        lastErrorDetail: message,
        updatedAt: nowIso,
      });
    });
    const row = requireJob(this.sql, jobId);
    await this.publishAndSchedule(row);
  }

  private async pauseForReview(
    job: JobRow,
    attempt: GenerationAttemptSummaryRow,
    code: string,
    message: string,
    judgeResponseId: string | null
  ): Promise<void> {
    this.storage.transactionSync(() => {
      const nowIso = toIso(now());
      updateTurnStatus(this.sql, attempt.turn_index, "paused_review", nowIso);
      updateJobStatusAndRevision(this.sql, {
        jobId: job.job_id,
        status: "paused_review",
        activeAttemptId: null,
        currentTurnIndex: attempt.turn_index,
        ...(judgeResponseId === null
          ? {}
          : { lastJudgeResponseId: judgeResponseId }),
        lastErrorCode: code,
        lastErrorDetail: message,
        usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
        updatedAt: nowIso,
      });
    });
    const row = requireJob(this.sql, job.job_id);
    await this.publishAndSchedule(row);
  }

  // --------------------------------------------------------------------------
  // Judge pipeline
  // --------------------------------------------------------------------------

  private async loadJudgeApplicableFiles(
    turnIndex: TurnIndex,
    config: EnabledJudgeConfig
  ): Promise<JudgeFileSelection> {
    const relevantTurns: TurnIndex[] = [];
    if (config.historyMode === "stateless" && !config.includePrior) {
      relevantTurns.push(turnIndex);
    } else {
      for (let index = 1; index <= turnIndex; index += 1) {
        relevantTurns.push(index);
      }
    }

    const selections: { file: FileCatalogueRecord; turnIndex: number; alreadyIntroduced: boolean }[] = [];
    const seen = new Set<FileId>();
    for (const relevantTurn of relevantTurns) {
      const turn = getTurnSummary(this.sql, relevantTurn);
      if (turn === null) {
        continue;
      }
      const fileIds = readStringArray(turn.attachment_file_ids_json);
      const knownRows = listJobFiles(this.sql, {
        turnIndex: relevantTurn,
        limit: 100,
      });
      for (const fileId of fileIds) {
        if (seen.has(fileId)) {
          continue;
        }
        let row = knownRows.find((candidate) => candidate.file_id === fileId) ?? null;
        const catalogue = await this.registryStub().getFile(fileId);
        if (catalogue === null) {
          throw new Error(`Catalogued file not found: ${fileId}`);
        }
        if (row === null) {
          const fileRow: JobFileRow = {
            file_id: catalogue.fileId,
            turn_index: relevantTurn,
            filename: catalogue.filename,
            mime_type: catalogue.mimeType,
            byte_size: catalogue.byteSize,
            sha256: catalogue.sha256Hex,
            introduced_in_judge_call_id: null,
            created_at: toIso(now()),
          };
          upsertJobFiles(this.sql, [fileRow]);
          row = fileRow;
        }
        seen.add(fileId);
        selections.push({
          file: catalogue,
          turnIndex: relevantTurn,
          alreadyIntroduced: row.introduced_in_judge_call_id !== null,
        });
      }
    }
    return { files: selections };
  }

  private loadPriorAcceptedOutputs(turnIndex: TurnIndex): PriorAcceptedOutput[] {
    if (turnIndex <= 1) {
      return [];
    }
    const outputs: PriorAcceptedOutput[] = [];
    for (const summary of this.listAcceptedTurnSummaries(turnIndex - 1)) {
      if (summary.accepted_candidate_id === null) {
        continue;
      }
      const text = getTurnCandidateDeliverableText(this.sql, summary.accepted_candidate_id);
      if (text === null) {
        continue;
      }
      outputs.push({
        turnIndex: summary.turn_index,
        deliverableText: text,
        attachmentFileIds: readStringArray(summary.attachment_file_ids_json),
      });
    }
    return outputs;
  }

  private async runJudge(
    job: JobRow,
    turn: TurnSummaryRow,
    attempt: GenerationAttemptSummaryRow,
    candidate: TurnCandidateSummaryRow,
    structuralWarnings: readonly string[],
    allowAcceptance: boolean
  ): Promise<void> {
    const config = parseJudgeConfig(job.judge_config_json);
    if (!config.enabled) {
      if (allowAcceptance) {
        await this.acceptCandidate(
          job,
          turn,
          attempt,
          candidate,
          false,
          structuralWarnings,
          null
        );
      } else {
        await this.pauseForReview(
          job,
          attempt,
          "structural_review_required",
          "Structural classification requires operator review",
          null
        );
      }
      return;
    }

    const judgeCallId = `${attempt.attempt_id}:judge`;
    let judgeFiles: JudgeFileSelection;
    let built: JudgeRequestBuildOutcome;
    try {
      judgeFiles = await this.loadJudgeApplicableFiles(turn.turn_index, config);
      const priorAcceptedOutputs =
        config.historyMode === "stateless" && config.includePrior
          ? this.loadPriorAcceptedOutputs(turn.turn_index)
          : [];
      const candidateText = getTurnCandidateDeliverableText(
        this.sql,
        candidate.candidate_id
      ) ?? "";
      built = buildJudgeRequest({
        config,
        judgeCallId,
        jobId: job.job_id,
        attemptId: attempt.attempt_id,
        turnIndex: turn.turn_index,
        candidateText,
        previousJudgeResponseId:
          config.historyMode === "chained" ? job.last_judge_response_id : null,
        applicableFiles: judgeFiles.files.map((selection) => ({
          fileId: selection.file.fileId,
          filename: selection.file.filename,
          mimeType: selection.file.mimeType,
          byteSize: selection.file.byteSize,
          alreadyIntroduced: selection.alreadyIntroduced,
        })),
        priorAcceptedOutputs,
      });
    } catch (error) {
      await this.applyJudgeOutcome(
        job,
        attempt,
        candidate,
        {
          kind: "unknown",
          judgeCallId: null,
          reason: "provider_error",
          message: describeError(error),
          advisoryWarnings: [],
        },
        structuralWarnings,
        allowAcceptance
      );
      return;
    }

    if (built.kind === "unencodable_contract") {
      await this.applyJudgeOutcome(
        job,
        attempt,
        candidate,
        judgeBuildFailureOutcome({ judgeCallId: null, outcome: built }),
        structuralWarnings,
        allowAcceptance
      );
      return;
    }

    const nowIso = toIso(now());
    this.storage.transactionSync(() => {
      insertJudgeCall(this.sql, {
        judgeCallId,
        turnIndex: turn.turn_index,
        candidateId: candidate.candidate_id,
        attemptId: attempt.attempt_id,
        transport: built.request.transport,
        historyMode: built.request.historyMode,
        fileDeliveryMode: built.request.fileDeliveryMode,
        model: config.model,
        previousJudgeResponseId:
          config.historyMode === "chained" ? job.last_judge_response_id : null,
        manifestJson: JSON.stringify(built.request.manifest),
        requestBody: built.request.requestBody,
        diagnosticsJson: JSON.stringify({
          ...emptyJudgeDiagnostics(config.provider),
          advisory_warnings: built.request.advisoryWarnings,
          started_at_ms: now(),
        }),
        nowIso,
      });
      upsertDurableWork(this.sql, {
        work_id: `${judgeCallId}${DISPATCH_WORK_SUFFIX}`,
        kind: "judge_dispatch",
        attempt_id: attempt.attempt_id,
        turn_index: turn.turn_index,
        due_at_ms: now() + DISPATCH_WORK_DELAY_MS,
        payload_json: JSON.stringify({
          kind: "judge_dispatch",
          judgeCallId,
          attemptId: attempt.attempt_id,
        }),
        created_at: nowIso,
      });
      updateTurnStatus(this.sql, turn.turn_index, "awaiting_judge", nowIso);
    });

    let apiKey: string;
    try {
      apiKey = resolveEnvSecret(this.env, config.secretName);
    } catch (error) {
      const outcome = judgeMissingSecretOutcome({
        judgeCallId,
        secretName: config.secretName,
      });
      this.persistJudgeOutcome(judgeCallId, config, outcome);
      deleteDurableWork(this.sql, `${judgeCallId}${DISPATCH_WORK_SUFFIX}`);
      await this.applyJudgeOutcome(
        job,
        attempt,
        candidate,
        outcome,
        structuralWarnings,
        allowAcceptance
      );
      return;
    }

    let outcome: JudgeEvaluationOutcome;
    let observedJudgeResponseId: string | null = null;
    if (config.transport === "chat_completions") {
      outcome = {
        kind: "unknown",
        judgeCallId,
        reason: "provider_error",
        message: "Chat Completions judge transport has no ProviderIO executor",
        advisoryWarnings: built.request.advisoryWarnings,
      };
    } else {
      try {
        const dispatched = await dispatchResponsesCreate({
          apiKey,
          apiRoot: config.apiRoot,
          requestBytes: built.request.requestBytes,
          idempotencyKey: built.request.idempotencyKey,
        });
        if (dispatched.kind !== "dispatched") {
          outcome = {
            kind: "unknown",
            judgeCallId,
            reason: "provider_error",
            message:
              dispatched.kind === "terminal_error"
                ? dispatched.message
                : "Judge dispatch failed",
            advisoryWarnings: built.request.advisoryWarnings,
          };
        } else {
          observedJudgeResponseId = dispatched.responseId;
          this.storage.transactionSync(() => {
            updateJobStatusAndRevision(this.sql, {
              jobId: job.job_id,
              status: requireJob(this.sql, job.job_id).status,
              lastJudgeResponseId: dispatched.responseId,
              updatedAt: toIso(now()),
            });
            if (config.historyMode === "chained") {
              for (const entry of built.request.manifest) {
                if (entry.status !== "delivered_now") {
                  continue;
                }
                const selection = judgeFiles.files.find(
                  (candidateFile) => candidateFile.file.fileId === entry.fileId
                );
                if (selection !== undefined) {
                  markFileIntroducedInJudgeCall(
                    this.sql,
                    selection.turnIndex,
                    entry.fileId,
                    judgeCallId
                  );
                }
              }
            }
          });
          await this.publishJobIndex(requireJob(this.sql, job.job_id));
          const retrieval = await retrieveProviderResponse({
            apiKey,
            apiRoot: config.apiRoot,
            responseId: dispatched.responseId,
          });
          if (retrieval.kind === "still_running") {
            outcome = {
              kind: "unknown",
              judgeCallId,
              reason: "provider_error",
              message: "Judge response had not settled when retrieved",
              advisoryWarnings: built.request.advisoryWarnings,
            };
          } else {
            const parse = parseJudgeOutput(retrieval.outputText ?? "");
            outcome = classifyJudgeEvaluation({
              judgeCallId,
              parse,
              manifest: built.request.manifest,
              responseId: dispatched.responseId,
              usage: retrieval.usage,
              providerErrorMessage:
                retrieval.status === "failed"
                  ? (retrieval.errorMessage ?? "Judge provider response failed")
                  : null,
            });
          }
        }
      } catch (error) {
        outcome = {
          kind: "unknown",
          judgeCallId,
          reason: "provider_error",
          message: describeError(error),
          advisoryWarnings: built.request.advisoryWarnings,
        };
      }
    }

    const pendingCall = getJudgeCallSummary(this.sql, judgeCallId);
    if (pendingCall === null || pendingCall.status !== "pending") {
      deleteDurableWork(this.sql, `${judgeCallId}${DISPATCH_WORK_SUFFIX}`);
      return;
    }
    this.persistJudgeOutcome(judgeCallId, config, outcome, observedJudgeResponseId);
    deleteDurableWork(this.sql, `${judgeCallId}${DISPATCH_WORK_SUFFIX}`);
    await this.applyJudgeOutcome(
      job,
      attempt,
      candidate,
      outcome,
      structuralWarnings,
      allowAcceptance
    );
  }

  private persistJudgeOutcome(
    judgeCallId: string,
    config: JudgeConfig,
    outcome: JudgeEvaluationOutcome,
    observedResponseId: string | null = null
  ): void {
    const nowIso = toIso(now());
    const existing = getJudgeCallSummary(this.sql, judgeCallId);
    if (existing === null) {
      return;
    }
    const provider = config.enabled ? config.provider : "";
    const previousDiagnostics = parseJudgeDiagnostics(existing.diagnostics_json, provider);
    const baseDiagnostics: JudgeDiagnostics = {
      ...previousDiagnostics,
      provider,
      started_at_ms: null,
    };

    if (outcome.kind === "evaluated") {
      const diagnostics: JudgeDiagnostics = {
        ...baseDiagnostics,
        response_bytes: null,
        unknown_reason: null,
        unknown_message: null,
        advisory_warnings: outcome.advisoryWarnings,
      };
      completeJudgeCall(this.sql, {
        judgeCallId,
        status: "completed",
        providerResponseId: outcome.responseId,
        verdict: outcome.output.verdict,
        grade: outcome.output.grade,
        comment: outcome.output.comment,
        tagAgreement: outcome.output.tag_agreement,
        fileVisibility: outcome.output.file_visibility,
        usageJson: outcome.usage === null ? null : JSON.stringify(outcome.usage),
        diagnosticsJson: JSON.stringify(diagnostics),
        nowIso,
      });
      return;
    }

    if (outcome.kind === "unknown") {
      const diagnostics: JudgeDiagnostics = {
        ...baseDiagnostics,
        unknown_reason: outcome.reason,
        unknown_message: outcome.message,
        advisory_warnings: outcome.advisoryWarnings,
      };
      completeJudgeCall(this.sql, {
        judgeCallId,
        status: "unknown",
        providerResponseId: observedResponseId,
        verdict: "UNKNOWN",
        grade: null,
        comment: null,
        tagAgreement: null,
        fileVisibility: null,
        usageJson: null,
        diagnosticsJson: JSON.stringify(diagnostics),
        nowIso,
      });
    }
  }

  private async applyJudgeOutcome(
    job: JobRow,
    attempt: GenerationAttemptSummaryRow,
    candidate: TurnCandidateSummaryRow,
    outcome: JudgeEvaluationOutcome,
    structuralWarnings: readonly string[],
    allowAcceptance: boolean
  ): Promise<void> {
    if (outcome.kind === "skipped") {
      if (allowAcceptance) {
        await this.acceptCandidate(
          job,
          requireTurn(this.sql, attempt.turn_index),
          attempt,
          candidate,
          false,
          structuralWarnings,
          null
        );
      } else {
        await this.pauseForReview(
          job,
          attempt,
          "structural_review_required",
          "Structural classification requires operator review",
          null
        );
      }
      return;
    }

    if (outcome.kind === "unknown") {
      const warnings = [...structuralWarnings, `judge_unknown: ${outcome.message}`];
      if (allowAcceptance) {
        await this.acceptCandidate(
          job,
          requireTurn(this.sql, attempt.turn_index),
          attempt,
          candidate,
          true,
          warnings,
          null
        );
      } else {
        await this.pauseForReview(
          job,
          attempt,
          "structural_review_required",
          "Structurally non-acceptable candidate was evaluated by the judge",
          outcome.judgeCallId
        );
      }
      return;
    }

    const config = parseJudgeConfig(job.judge_config_json);
    const output = outcome.output;
    const coverageWarning =
      outcome.advisoryWarnings.length > 0 || output.file_visibility === false;
    const pausesForReview =
      output.verdict === "FAIL" ||
      (config.enabled && output.grade > config.maxGradeThreshold) ||
      output.tag_agreement === false ||
      !allowAcceptance;

    if (pausesForReview) {
      const reasons: string[] = [];
      if (output.verdict === "FAIL") {
        reasons.push("judge_rejected");
      }
      if (config.enabled && output.grade > config.maxGradeThreshold) {
        reasons.push("excessive_grade");
      }
      if (output.tag_agreement === false) {
        reasons.push("judge_tag_disagreement");
      }
      if (!allowAcceptance) {
        reasons.push("structural_review_required");
      }
      await this.pauseForReview(
        job,
        attempt,
        reasons.join("+"),
        output.comment,
        outcome.responseId
      );
      return;
    }

    const warnings = [
      ...structuralWarnings,
      ...outcome.advisoryWarnings,
      ...(output.file_visibility === false
        ? ["judge_file_visibility_incomplete"]
        : []),
    ];
    await this.acceptCandidate(
      job,
      requireTurn(this.sql, attempt.turn_index),
      attempt,
      candidate,
      coverageWarning,
      warnings,
      outcome.responseId
    );
  }

  private async acceptCandidate(
    job: JobRow,
    turn: TurnSummaryRow,
    attempt: GenerationAttemptSummaryRow,
    candidate: TurnCandidateSummaryRow,
    acceptedWithWarning: boolean,
    warnings: readonly string[],
    judgeResponseId: string | null
  ): Promise<void> {
    if (attempt.provider_response_id === null) {
      await this.pauseStorage(
        job.job_id,
        turn.turn_index,
        attempt.attempt_id,
        "Accepted candidate is missing its provider response id"
      );
      return;
    }
    if (
      candidate.structural_status !== "valid" ||
      candidate.deliverable_bytes <= 0
    ) {
      await this.pauseForReview(
        job,
        attempt,
        "structural_review_required",
        "Candidate is not structurally acceptable",
        judgeResponseId
      );
      return;
    }

    const nowIso = toIso(now());
    const warningJson = JSON.stringify([...warnings]);
    try {
      acceptTurnCandidate(this.storage, {
        jobId: job.job_id,
        turnIndex: turn.turn_index,
        candidateId: candidate.candidate_id,
        attemptId: attempt.attempt_id,
        responseId: attempt.provider_response_id,
        acceptedWithWarning,
        warningJson,
        nowIso,
      });
    } catch (error) {
      if (error instanceof ArtifactGuardError || error instanceof StorageFullError) {
        await this.pauseStorage(
          job.job_id,
          turn.turn_index,
          attempt.attempt_id,
          describeError(error)
        );
        return;
      }
      throw error;
    }

    const fresh = requireJob(this.sql, job.job_id);
    const lastIndex = this.getLastTurnIndex();
    const nextStatus = fresh.accepted_turn_index >= lastIndex ? "completed" : "running";
    const updated = updateJobStatusAndRevision(this.sql, {
      jobId: job.job_id,
      status: nextStatus,
      activeAttemptId: null,
      currentTurnIndex: turn.turn_index,
      ...(judgeResponseId === null ? {} : { lastJudgeResponseId: judgeResponseId }),
      lastErrorCode: null,
      lastErrorDetail: null,
      usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
      updatedAt: nowIso,
    });

    if (nextStatus === "completed") {
      await this.publishAndSchedule(updated);
      await this.registryStub().releaseJobFileRefs(job.job_id);
      return;
    }

    await this.publishAndSchedule(updated);
    await this.startNextTurnIfEligible();
  }

  // --------------------------------------------------------------------------
  // Turn advancement
  // --------------------------------------------------------------------------

  private async startNextTurnIfEligible(): Promise<void> {
    const job = getJob(this.sql);
    if (job === null) {
      return;
    }
    if (
      job.status === "paused_review" ||
      job.status === "paused_dispatch" ||
      job.status === "paused_storage" ||
      TERMINAL_JOB_STATUSES.has(job.status)
    ) {
      return;
    }
    if (job.active_attempt_id !== null) {
      const active = getGenerationAttemptSummary(this.sql, job.active_attempt_id);
      if (active !== null && IN_FLIGHT_ATTEMPT_STATUSES.has(active.status)) {
        return;
      }
    }
    const nextIndex = job.accepted_turn_index + 1;
    const turn = getTurnSummary(this.sql, nextIndex);
    if (turn === null || turn.status !== "pending") {
      return;
    }
    await this.startGenerationAttempt(job.job_id, nextIndex, "initial", 0, null);
  }

  // --------------------------------------------------------------------------
  // Operator decisions
  // --------------------------------------------------------------------------

  private async acceptPausedCandidateWithWarning(
    job: JobRow,
    note: string | undefined
  ): Promise<void> {
    if (job.status !== "paused_review") {
      throw new Error("accept_with_warning requires a job paused for review");
    }
    const turn = getTurnSummary(this.sql, job.current_turn_index);
    if (turn === null) {
      throw new Error(`Turn not found: ${job.current_turn_index}`);
    }
    const candidates = this.listAllCandidateSummaries(turn.turn_index);
    let selected: TurnCandidateSummaryRow | null = null;
    let selectedAttemptNumber = -1;
    for (const candidate of candidates) {
      if (candidate.structural_status !== "valid" || candidate.deliverable_bytes <= 0) {
        continue;
      }
      const attempt = getGenerationAttemptSummary(this.sql, candidate.attempt_id);
      const attemptNumber = attempt === null ? 0 : attempt.attempt_number;
      if (attemptNumber >= selectedAttemptNumber) {
        selected = candidate;
        selectedAttemptNumber = attemptNumber;
      }
    }
    if (selected === null) {
      throw new Error("No structurally valid candidate is available for operator acceptance");
    }
    const attempt = getGenerationAttemptSummary(this.sql, selected.attempt_id);
    if (attempt === null || attempt.provider_response_id === null) {
      throw new Error("Selected candidate has no recorded provider response id");
    }

    const warnings = readStringArray(selected.warning_json);
    warnings.push("operator_accept_with_warning");
    if (note !== undefined && note.trim().length > 0) {
      warnings.push(note);
    }

    const nowIso = toIso(now());
    acceptTurnCandidate(this.storage, {
      jobId: job.job_id,
      turnIndex: turn.turn_index,
      candidateId: selected.candidate_id,
      attemptId: attempt.attempt_id,
      responseId: attempt.provider_response_id,
      acceptedWithWarning: true,
      warningJson: JSON.stringify(warnings),
      nowIso,
    });

    const fresh = requireJob(this.sql, job.job_id);
    const lastIndex = this.getLastTurnIndex();
    const nextStatus = fresh.accepted_turn_index >= lastIndex ? "completed" : "running";
    const updated = updateJobStatusAndRevision(this.sql, {
      jobId: job.job_id,
      status: nextStatus,
      activeAttemptId: null,
      currentTurnIndex: turn.turn_index,
      lastErrorCode: null,
      lastErrorDetail: null,
      usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
      updatedAt: nowIso,
    });
    await this.publishAndSchedule(updated);
    if (nextStatus === "completed") {
      await this.registryStub().releaseJobFileRefs(job.job_id);
    } else {
      await this.startNextTurnIfEligible();
    }
  }

  private async performManualRetry(job: JobRow): Promise<void> {
    if (
      job.status !== "paused_review" &&
      job.status !== "paused_dispatch" &&
      job.status !== "paused_storage"
    ) {
      throw new Error("manual_retry requires a paused job");
    }
    const turnIndex = job.current_turn_index;
    const turn = getTurnSummary(this.sql, turnIndex);
    if (turn === null || turn.status === "accepted") {
      throw new Error("manual_retry has no unaccepted turn to retry");
    }

    const activeAttempt =
      job.active_attempt_id === null
        ? null
        : getGenerationAttemptSummary(this.sql, job.active_attempt_id);
    const providerResponseId =
      activeAttempt !== null && activeAttempt.provider_response_id !== null
        ? activeAttempt.provider_response_id
        : null;

    const nowIso = toIso(now());
    this.storage.transactionSync(() => {
      if (activeAttempt !== null) {
        updateGenerationAttemptState(this.sql, {
          attemptId: activeAttempt.attempt_id,
          status: "cancelled",
          nextBackoffAtMs: null,
          nextPollAtMs: null,
          diagnosticsJson: mergeAttemptDiagnostics(activeAttempt.diagnostics_json, {
            provider_error_message: "Superseded by a manual retry",
            settle_claimed_at_ms: null,
          }),
          nowIso,
        });
        deleteDurableWork(this.sql, `${activeAttempt.attempt_id}${DISPATCH_WORK_SUFFIX}`);
        deleteDurableWork(this.sql, `${activeAttempt.attempt_id}${POLL_WORK_SUFFIX}`);
      }
      updateJobStatusAndRevision(this.sql, {
        jobId: job.job_id,
        status: "running",
        activeAttemptId: null,
        currentTurnIndex: turnIndex,
        manualRetriesUsed: job.manual_retries_used + 1,
        lastErrorCode: null,
        lastErrorDetail: null,
        updatedAt: nowIso,
      });
    });

    if (providerResponseId !== null) {
      try {
        const apiKey = resolveEnvSecret(this.env, "OPENAI_API_KEY");
        await cancelProviderResponse({ apiKey, responseId: providerResponseId });
      } catch {
        // Cancellation is best-effort; the fresh attempt/key is authoritative.
      }
    }

    const fresh = requireJob(this.sql, job.job_id);
    await this.publishAndSchedule(fresh);
    await this.startGenerationAttempt(job.job_id, turnIndex, "manual_retry", 0, null);
  }

  private async cancelJob(job: JobRow, reason: string | undefined): Promise<void> {
    const activeAttempt =
      job.active_attempt_id === null
        ? null
        : getGenerationAttemptSummary(this.sql, job.active_attempt_id);
    const providerResponseId =
      activeAttempt !== null && activeAttempt.provider_response_id !== null
        ? activeAttempt.provider_response_id
        : null;

    this.storage.transactionSync(() => {
      const nowIso = toIso(now());
      for (const attempt of this.listAllAttemptSummaries()) {
        if (IN_FLIGHT_ATTEMPT_STATUSES.has(attempt.status)) {
          updateGenerationAttemptState(this.sql, {
            attemptId: attempt.attempt_id,
            status: "cancelled",
            nextBackoffAtMs: null,
            nextPollAtMs: null,
            diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
              provider_error_message: "Job cancelled by operator",
              settle_claimed_at_ms: null,
            }),
            nowIso,
          });
        }
      }
      for (const turn of this.listAllTurnSummaries(null)) {
        if (
          turn.status === "pending" ||
          turn.status === "running" ||
          turn.status === "awaiting_judge" ||
          turn.status === "paused_review"
        ) {
          updateTurnStatus(this.sql, turn.turn_index, "cancelled", nowIso);
        }
      }
      for (;;) {
        const works = this.listAllDurableWork();
        if (works.length === 0) {
          break;
        }
        for (const work of works) {
          deleteDurableWork(this.sql, work.work_id);
        }
      }
      updateJobStatusAndRevision(this.sql, {
        jobId: job.job_id,
        status: "cancelled",
        activeAttemptId: null,
        currentTurnIndex: job.current_turn_index,
        lastErrorCode: "operator_cancelled",
        lastErrorDetail: reason ?? "Job cancelled by operator",
        usageSummaryJson: JSON.stringify(this.computeUsageAggregate()),
        updatedAt: nowIso,
      });
    });

    if (providerResponseId !== null) {
      try {
        const apiKey = resolveEnvSecret(this.env, "OPENAI_API_KEY");
        await cancelProviderResponse({ apiKey, responseId: providerResponseId });
      } catch {
        // Cancellation is best-effort.
      }
    }

    const row = requireJob(this.sql, job.job_id);
    await this.publishAndSchedule(row);
    await this.registryStub().releaseJobFileRefs(job.job_id);
  }

  // --------------------------------------------------------------------------
  // Alarm work processing
  // --------------------------------------------------------------------------

  private async processDurableWork(work: DurableWorkRow): Promise<void> {
    const payload = parseDurableWorkPayload(work.payload_json);
    if (payload === null) {
      this.storage.transactionSync(() => {
        deleteDurableWork(this.sql, work.work_id);
      });
      return;
    }

    switch (work.kind) {
      case "capacity_backoff":
        if (payload.kind === "generation_dispatch") {
          await this.processDispatchWork(work, payload.attemptId);
        } else {
          this.deleteWork(work.work_id);
        }
        return;

      case "fallback_poll":
        if (payload.kind === "generation_poll") {
          await this.processPollWork(work, payload.attemptId);
        } else {
          this.deleteWork(work.work_id);
        }
        return;

      case "judge_dispatch":
        if (payload.kind === "judge_dispatch") {
          await this.processJudgeWork(work, payload.judgeCallId);
        } else {
          this.deleteWork(work.work_id);
        }
        return;

      case "webhook_process":
      case "cleanup":
        this.deleteWork(work.work_id);
        return;
    }
  }

  private deleteWork(workId: string): void {
    this.storage.transactionSync(() => {
      deleteDurableWork(this.sql, workId);
    });
  }

  private async processDispatchWork(work: DurableWorkRow, attemptId: string): Promise<void> {
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null) {
      this.deleteWork(work.work_id);
      return;
    }
    const job = getJob(this.sql);
    if (job === null) {
      this.deleteWork(work.work_id);
      return;
    }
    const nowMs = now();
    const diagnostics = parseAttemptDiagnostics(attempt.diagnostics_json);

    if (attempt.status === "dispatching") {
      if (
        diagnostics.dispatch_started_at_ms !== null &&
        nowMs - diagnostics.dispatch_started_at_ms >= WORK_CLAIM_STALE_MS
      ) {
        await this.pauseForManualRecovery(
          job.job_id,
          attempt.turn_index,
          attemptId,
          "ambiguous_dispatch",
          "Dispatch outcome was not recorded before recovery",
          "ambiguous_dispatch"
        );
        return;
      }
      this.storage.transactionSync(() => {
        upsertDurableWork(this.sql, {
          ...this.workRowCopy(work),
          due_at_ms: nowMs + WORK_CLAIM_STALE_MS,
        });
      });
      return;
    }

    if (attempt.status === "dispatched") {
      this.storage.transactionSync(() => {
        deleteDurableWork(this.sql, work.work_id);
        const nextPollAtMs = attempt.next_poll_at_ms ?? getNextFallbackPollAt(attempt.poll_probes, nowMs);
        if (nextPollAtMs !== null) {
          upsertDurableWork(this.sql, {
            work_id: `${attemptId}${POLL_WORK_SUFFIX}`,
            kind: "fallback_poll",
            attempt_id: attemptId,
            turn_index: attempt.turn_index,
            due_at_ms: nextPollAtMs,
            payload_json: JSON.stringify({
              kind: "generation_poll",
              attemptId,
            }),
            created_at: toIso(nowMs),
          });
        }
      });
      return;
    }

    if (attempt.status !== "prepared" && attempt.status !== "capacity_backoff") {
      this.deleteWork(work.work_id);
      return;
    }
    if (
      TERMINAL_JOB_STATUSES.has(job.status) ||
      job.status === "paused_review" ||
      job.status === "paused_dispatch" ||
      job.status === "paused_storage"
    ) {
      this.deleteWork(work.work_id);
      return;
    }
    await this.performGenerationDispatch(attemptId);
  }

  private workRowCopy(work: DurableWorkRow): DurableWorkRow {
    return {
      work_id: work.work_id,
      kind: work.kind,
      attempt_id: work.attempt_id,
      turn_index: work.turn_index,
      due_at_ms: work.due_at_ms,
      payload_json: work.payload_json,
      created_at: work.created_at,
    };
  }

  private async processPollWork(work: DurableWorkRow, attemptId: string): Promise<void> {
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null) {
      this.deleteWork(work.work_id);
      return;
    }
    const diagnostics = parseAttemptDiagnostics(attempt.diagnostics_json);
    const nowMs = now();

    if (attempt.status === "dispatching") {
      if (
        diagnostics.settle_claimed_at_ms !== null &&
        nowMs - diagnostics.settle_claimed_at_ms < WORK_CLAIM_STALE_MS
      ) {
        this.storage.transactionSync(() => {
          upsertDurableWork(this.sql, {
            ...this.workRowCopy(work),
            due_at_ms: diagnostics.settle_claimed_at_ms! + WORK_CLAIM_STALE_MS,
          });
        });
        return;
      }
      if (
        diagnostics.settle_claimed_at_ms !== null &&
        nowMs - diagnostics.settle_claimed_at_ms >= WORK_CLAIM_STALE_MS
      ) {
        const stuckJob = getJob(this.sql);
        if (stuckJob === null) {
          this.deleteWork(work.work_id);
          return;
        }
        await this.pauseForManualRecovery(
          stuckJob.job_id,
          attempt.turn_index,
          attemptId,
          "ambiguous_dispatch",
          "Settlement retrieval did not complete before recovery",
          "ambiguous_dispatch"
        );
        return;
      }
    }

    if (attempt.status !== "dispatched" && attempt.status !== "dispatching") {
      this.deleteWork(work.work_id);
      return;
    }

    try {
      const job = getJob(this.sql);
      if (job !== null && attempt.provider_response_id !== null) {
        await this.routerStub().registerResponseRoute({
          responseId: attempt.provider_response_id,
          jobId: job.job_id,
          attemptId,
          turnIndex: attempt.turn_index,
          registeredAtMs: now(),
          settledAtMs: null,
        });
      }
      const result = await this.settleDispatchedAttempt(attemptId);
      if (result === "still_running") {
        await this.advanceFallbackProbe(attemptId, null);
        return;
      }
    } catch (error) {
      await this.advanceFallbackProbe(attemptId, describeError(error));
      return;
    }

    this.deleteWork(work.work_id);
  }

  private async advanceFallbackProbe(
    attemptId: string,
    providerError: string | null
  ): Promise<void> {
    const attempt = getGenerationAttemptSummary(this.sql, attemptId);
    if (attempt === null) {
      return;
    }
    const nowMs = now();
    const probes = attempt.poll_probes + 1;
    const nextPollAtMs = hasRemainingFallbackProbes(probes)
      ? getNextFallbackPollAt(probes, nowMs)
      : null;
    const nowIso = toIso(nowMs);
    if (nextPollAtMs === null) {
      const job = getJob(this.sql);
      this.storage.transactionSync(() => {
        updateGenerationAttemptState(this.sql, {
          attemptId,
          status: "dispatched",
          pollProbes: probes,
          nextPollAtMs: null,
          diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
            settle_claimed_at_ms: null,
            provider_error_message:
              providerError ?? "Fallback polling reached its 24-probe bound",
          }),
          nowIso,
        });
        deleteDurableWork(this.sql, `${attemptId}${POLL_WORK_SUFFIX}`);
      });
      if (job !== null) {
        await this.pauseForManualRecovery(
          job.job_id,
          attempt.turn_index,
          attemptId,
          "fallback_poll_exhausted",
          "Fallback polling reached its 24-probe bound",
          "ambiguous_dispatch"
        );
      }
      return;
    }
    this.storage.transactionSync(() => {
      updateGenerationAttemptState(this.sql, {
        attemptId,
        status: "dispatched",
        pollProbes: probes,
        nextPollAtMs,
        diagnosticsJson: mergeAttemptDiagnostics(attempt.diagnostics_json, {
          settle_claimed_at_ms: null,
          provider_error_message: providerError,
        }),
        nowIso,
      });
      upsertDurableWork(this.sql, {
        work_id: `${attemptId}${POLL_WORK_SUFFIX}`,
        kind: "fallback_poll",
        attempt_id: attemptId,
        turn_index: attempt.turn_index,
        due_at_ms: nextPollAtMs,
        payload_json: JSON.stringify({
          kind: "generation_poll",
          attemptId,
        }),
        created_at: nowIso,
      });
    });
  }

  private async processJudgeWork(work: DurableWorkRow, judgeCallId: string): Promise<void> {
    const call = getJudgeCallSummary(this.sql, judgeCallId);
    if (call === null) {
      this.deleteWork(work.work_id);
      return;
    }
    if (call.status !== "pending") {
      this.deleteWork(work.work_id);
      return;
    }
    const job = getJob(this.sql);
    if (job === null) {
      this.deleteWork(work.work_id);
      return;
    }
    const attempt = getGenerationAttemptSummary(this.sql, call.attempt_id);
    const candidate = getTurnCandidateSummary(this.sql, call.candidate_id);
    if (attempt === null || candidate === null) {
      completeJudgeCall(this.sql, {
        judgeCallId,
        status: "unknown",
        verdict: "UNKNOWN",
        grade: null,
        comment: null,
        tagAgreement: null,
        fileVisibility: null,
        usageJson: null,
        diagnosticsJson: JSON.stringify({
          ...parseJudgeDiagnostics(call.diagnostics_json, ""),
          unknown_reason: "provider_error",
          unknown_message: "Judge recovery could not resolve its candidate or attempt",
          started_at_ms: null,
        }),
        nowIso: toIso(now()),
      });
      this.deleteWork(work.work_id);
      return;
    }

    const config = parseJudgeConfig(job.judge_config_json);
    const diagnostics = parseJudgeDiagnostics(call.diagnostics_json, config.enabled ? config.provider : "");
    const nowMs = now();
    if (
      diagnostics.started_at_ms !== null &&
      nowMs - diagnostics.started_at_ms < WORK_CLAIM_STALE_MS
    ) {
      this.storage.transactionSync(() => {
        upsertDurableWork(this.sql, {
          ...this.workRowCopy(work),
          due_at_ms: diagnostics.started_at_ms! + WORK_CLAIM_STALE_MS,
        });
      });
      return;
    }

    let outcome: JudgeEvaluationOutcome;
    if (call.provider_response_id === null) {
      outcome = {
        kind: "unknown",
        judgeCallId,
        reason: "provider_error",
        message: "Judge dispatch outcome was not recorded before recovery",
        advisoryWarnings: diagnostics.advisory_warnings,
      };
    } else {
      try {
        const apiKey = resolveEnvSecret(this.env, config.enabled ? config.secretName : "");
        const retrieval = await retrieveProviderResponse({
          apiKey,
          apiRoot: config.enabled ? config.apiRoot : undefined,
          responseId: call.provider_response_id,
        });
        if (retrieval.kind === "still_running") {
          outcome = {
            kind: "unknown",
            judgeCallId,
            reason: "provider_error",
            message: "Judge response had not settled during recovery",
            advisoryWarnings: diagnostics.advisory_warnings,
          };
        } else {
          const parse = parseJudgeOutput(retrieval.outputText ?? "");
          outcome = classifyJudgeEvaluation({
            judgeCallId,
            parse,
            manifest: parseManifest(call.manifest_json),
            responseId: call.provider_response_id,
            usage: retrieval.usage,
            providerErrorMessage:
              retrieval.status === "failed"
                ? (retrieval.errorMessage ?? "Judge provider response failed")
                : null,
          });
        }
      } catch (error) {
        outcome = {
          kind: "unknown",
          judgeCallId,
          reason: "provider_error",
          message: describeError(error),
          advisoryWarnings: diagnostics.advisory_warnings,
        };
      }
    }

    this.persistJudgeOutcome(judgeCallId, config, outcome, call.provider_response_id);
    this.deleteWork(work.work_id);
    await this.applyJudgeOutcome(
      job,
      attempt,
      candidate,
      outcome,
      [],
      candidate.structural_status === "valid" && candidate.deliverable_bytes > 0
    );
  }
}

// ============================================================================
// Cursor / artifact helpers
// ============================================================================

function parseNumberCursor(cursor: string | null | undefined, label: string): number | null {
  if (cursor === null || cursor === undefined || cursor === "") {
    return null;
  }
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RangeError(`${label} must be a positive integer cursor`);
  }
  return parsed;
}

function parseStringCursor(cursor: string | null | undefined): string | null {
  if (cursor === null || cursor === undefined || cursor === "") {
    return null;
  }
  return cursor;
}

function parseArtifactStringId(id: string | number): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Artifact id must be a non-empty string");
  }
  return id;
}

function parseArtifactTurnIndex(id: string | number): TurnIndex {
  const value = typeof id === "number" ? id : Number(id);
  assertTurnIndex(value, "readArtifact.turnIndex");
  return value;
}

function requireTurn(sql: SchemaSqlStorage, turnIndex: TurnIndex): TurnSummaryRow {
  const turn = getTurnSummary(sql, turnIndex);
  if (turn === null) {
    throw new Error(`Turn not found: ${turnIndex}`);
  }
  return turn;
}

