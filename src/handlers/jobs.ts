/**
 * Jobs handler (`src/handlers/jobs.ts`) — application job commands, reads,
 * branching, and exports.
 *
 * This module owns no durable state: it validates HTTP input, calls the
 * `JobDO` / `RegistryDO` binding RPCs, and serializes responses. It never
 * writes job execution state, never dispatches provider calls, and never
 * reads a storage row directly.
 */

import {
  DEFAULT_MAX_JSON_BODY_BYTES,
  LIST_PAGE_LIMIT_MAX,
  MAX_BRANCH_SNAPSHOT_BYTES,
  REGISTRY_DO_NAME,
} from "../constants.ts";
import {
  HttpError,
  clampPageLimit,
  conflict,
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJson,
  streamResponse,
  toErrorResponse,
  unprocessableEntity,
} from "../http.ts";
import { now } from "../lib/clock.ts";
import { assertTurnIndex } from "../lib/guards.ts";
import type {
  GenerationAttemptSummaryRow,
  JudgeCallSummaryRow,
  TurnSummaryRow,
} from "../db/schema.ts";
import type {
  AppendTurnCommand,
  AttemptId,
  BranchCreationOutcome,
  BranchSnapshot,
  CreateJobCommand,
  CursorPage,
  CursorPageRequest,
  ExportHighWaterMarks,
  FileId,
  JobConfig,
  JobId,
  JobStateResponse,
  JobSummaryItem,
  JudgeCallId,
  MissingArtifactMarker,
  OperatorReviewDecision,
  TurnIndex,
  TurnPromptSpec,
} from "../types.ts";

const JOBS_PATH = "/api/jobs";
const JOBS_PATH_PREFIX = `${JOBS_PATH}/`;

const EXPORT_PAGE_LIMIT = LIST_PAGE_LIMIT_MAX;

/** Artifact kinds readable through `JobDO.readArtifact`. */
type ReadArtifactKind =
  | "turn_prompt"
  | "candidate_deliverable"
  | "attempt_request"
  | "attempt_response"
  | "judge_request";

interface ReadArtifactRequest {
  readonly kind: ReadArtifactKind;
  readonly id: string | number;
}

interface ArtifactPayload {
  readonly bytes: ArrayBuffer | Uint8Array;
}

/** Branch capture response that refuses to produce a snapshot. */
interface BranchSnapshotCaptureRejection {
  readonly kind: "rejected";
  readonly reason: "parent_not_quiescent" | "snapshot_too_large" | "invalid_fork_turn";
  readonly message: string;
}

type BranchSnapshotCapture = BranchSnapshot | BranchSnapshotCaptureRejection;

type BranchRejectionReason =
  | BranchSnapshotCaptureRejection["reason"]
  | Extract<BranchCreationOutcome, { readonly kind: "rejected" }>["reason"];

/** Structural view of the `JobDO` binding RPC used by this handler. */
interface JobDoRpcStub {
  createJob(command: CreateJobCommand): Promise<JobStateResponse>;
  getState(): Promise<JobStateResponse | null>;
  appendTurn(command: AppendTurnCommand): Promise<JobStateResponse>;
  applyOperatorDecision(decision: OperatorReviewDecision): Promise<JobStateResponse>;
  captureBranchSnapshot(forkTurnIndex: TurnIndex): Promise<BranchSnapshotCapture>;
  initializeBranch(snapshot: BranchSnapshot): Promise<BranchCreationOutcome>;
  listTurns(
    request: CursorPageRequest & { readonly maxTurnIndex?: TurnIndex },
  ): Promise<CursorPage<TurnSummaryRow>>;
  listAttempts(
    request: CursorPageRequest & { readonly turnIndex?: TurnIndex },
  ): Promise<CursorPage<GenerationAttemptSummaryRow>>;
  listJudgeCalls(
    request: CursorPageRequest & { readonly turnIndex?: TurnIndex },
  ): Promise<CursorPage<JudgeCallSummaryRow>>;
  captureExportHighWaterMarks(): Promise<ExportHighWaterMarks>;
  readArtifact(request: ReadArtifactRequest): Promise<ArtifactPayload | null>;
}

/** Structural view of the `RegistryDO` binding RPC used by this handler. */
interface RegistryDoRpcStub {
  registerJob(summary: JobSummaryItem): Promise<void>;
  listJobs(request: CursorPageRequest): Promise<CursorPage<JobSummaryItem>>;
  protectJobFileRefs(jobId: JobId, fileIds: readonly FileId[]): Promise<void>;
}

type ExportFormat = "markdown" | "json";

/**
 * Handles `/api/jobs` and `/api/jobs/:jobId/...`. Any other path is outside
 * this handler's contract and returns `404 not_found`.
 */
export function handleJobsRequest(request: Request, env: Env): Promise<Response> {
  return routeJobsRequest(request, env).catch((err: unknown) => toErrorResponse(err));
}

async function routeJobsRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();

  if (url.pathname === JOBS_PATH) {
    if (method === "GET") {
      rejectUnknownQuery(url, ["limit", "cursor"]);
      return listJobs(env, url);
    }
    if (method === "POST") {
      assertApplicationOrigin(request, env);
      rejectUnknownQuery(url, []);
      return createJob(request, env);
    }
    return methodNotAllowed(["GET", "POST"]);
  }

  if (!url.pathname.startsWith(JOBS_PATH_PREFIX)) {
    return notFound();
  }

  const jobRoute = parseJobRoute(url.pathname);
  if (jobRoute === null) {
    return notFound();
  }
  const { jobId, subpath } = jobRoute;
  if (subpath.length === 0) {
    if (method !== "GET") {
      return methodNotAllowed(["GET"]);
    }
    rejectUnknownQuery(url, []);
    return getJobState(env, jobId);
  }
  if (subpath.length !== 1) {
    return notFound();
  }

  switch (subpath[0]) {
    case "turns":
      if (method === "GET") {
        rejectUnknownQuery(url, ["limit", "cursor"]);
        return listJobTurns(env, jobId, url);
      }
      if (method === "POST") {
        assertApplicationOrigin(request, env);
        rejectUnknownQuery(url, []);
        return appendTurn(request, env, jobId);
      }
      return methodNotAllowed(["GET", "POST"]);
    case "review":
      if (method !== "POST") {
        return methodNotAllowed(["POST"]);
      }
      assertApplicationOrigin(request, env);
      rejectUnknownQuery(url, []);
      return reviewJob(request, env, jobId);
    case "branch":
      if (method !== "POST") {
        return methodNotAllowed(["POST"]);
      }
      assertApplicationOrigin(request, env);
      rejectUnknownQuery(url, []);
      return branchJob(request, env, jobId);
    case "attempts":
      if (method !== "GET") {
        return methodNotAllowed(["GET"]);
      }
      rejectUnknownQuery(url, ["limit", "cursor", "turnIndex"]);
      return listJobAttempts(env, jobId, url);
    case "judge-calls":
      if (method !== "GET") {
        return methodNotAllowed(["GET"]);
      }
      rejectUnknownQuery(url, ["limit", "cursor", "turnIndex"]);
      return listJobJudgeCalls(env, jobId, url);
    case "export":
      if (method !== "GET") {
        return methodNotAllowed(["GET"]);
      }
      rejectUnknownQuery(url, ["format"]);
      return exportJob(env, jobId, url);
    default:
      return notFound();
  }
}

/**
 * Splits `/api/jobs/:jobId/...` exactly once. The job identifier is decoded
 * once and never interpreted as a filesystem path.
 */
function parseJobRoute(
  pathname: string,
): { readonly jobId: JobId; readonly subpath: readonly string[] } | null {
  const remainder = pathname.slice(JOBS_PATH_PREFIX.length);
  if (remainder.length === 0) {
    return null;
  }
  const segments = remainder.split("/");
  const rawJobId = segments[0];
  if (rawJobId === undefined || rawJobId.length === 0) {
    return null;
  }

  let jobId: string;
  try {
    jobId = decodeURIComponent(rawJobId);
  } catch {
    throw new HttpError(400, "invalid_job_id", "Invalid job identifier");
  }
  if (
    jobId.length === 0 ||
    jobId.includes("/") ||
    /[\u0000-\u001f\u007f]/.test(jobId)
  ) {
    throw new HttpError(400, "invalid_job_id", "Invalid job identifier");
  }

  return { jobId, subpath: segments.slice(1) };
}

function getJobStub(env: Env, jobId: JobId): JobDoRpcStub {
  return env.JOB_DO.get(env.JOB_DO.idFromName(jobId)) as unknown as JobDoRpcStub;
}

function getRegistryStub(env: Env): RegistryDoRpcStub {
  return env.REGISTRY_DO.get(
    env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME),
  ) as unknown as RegistryDoRpcStub;
}

// ============================================================================
// Commands
// ============================================================================

async function createJob(request: Request, env: Env): Promise<Response> {
  const parsedBody = await readControlJson(request);
  const command = parseCreateJobCommand(parsedBody);
  const stub = getJobStub(env, command.jobId);

  let state: JobStateResponse;
  try {
    state = await stub.createJob(command);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    if (message.includes("already exists") || message.includes("duplicate")) {
      return conflict("A job with this identifier already exists", "conflict");
    }
    return rpcErrorResponse(err);
  }

  const registry = getRegistryStub(env);
  try {
    await registry.registerJob(toJobSummaryItem(state));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }

  try {
    await registry.protectJobFileRefs(
      command.jobId,
      collectAttachmentFileIds(command.initialTurns),
    );
  } catch {
    return errorResponse(
      500,
      "file_protection_failed",
      "File references could not be protected",
    );
  }

  return jsonResponse(state, 201);
}

async function appendTurn(
  request: Request,
  env: Env,
  jobId: JobId,
): Promise<Response> {
  const parsedBody = await readControlJson(request);
  const command = parseAppendTurnCommand(parsedBody);
  const stub = getJobStub(env, jobId);
  try {
    return jsonResponse(await stub.appendTurn(command));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

async function reviewJob(
  request: Request,
  env: Env,
  jobId: JobId,
): Promise<Response> {
  const parsedBody = await readControlJson(request);
  const decision = parseReviewDecision(parsedBody);
  const stub = getJobStub(env, jobId);
  try {
    return jsonResponse(await stub.applyOperatorDecision(decision));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

async function branchJob(
  request: Request,
  env: Env,
  jobId: JobId,
): Promise<Response> {
  const parsedBody = await readJson<unknown>(request, {
    maxBytes: MAX_BRANCH_SNAPSHOT_BYTES,
    requireJsonContentType: true,
  });
  const forkTurnIndex = parseForkTurnIndex(parsedBody);

  const parentStub = getJobStub(env, jobId);
  let captured: BranchSnapshotCapture;
  try {
    captured = await parentStub.captureBranchSnapshot(forkTurnIndex);
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }

  if (isBranchCaptureRejection(captured)) {
    return branchRefusalResponse(captured.reason);
  }

  const branchJobId = deriveBranchJobId(captured);
  const registry = getRegistryStub(env);
  try {
    await registry.protectJobFileRefs(branchJobId, captured.referencedFileIds);
  } catch {
    return errorResponse(
      409,
      "file_protection_failed",
      "File references could not be protected for the branch",
    );
  }

  const branchStub = getJobStub(env, branchJobId);
  let outcome: BranchCreationOutcome;
  try {
    outcome = await branchStub.initializeBranch(captured);
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }

  if (outcome.kind === "rejected") {
    return branchRefusalResponse(outcome.reason);
  }
  return jsonResponse(outcome);
}

function branchRefusalResponse(reason: BranchRejectionReason): Response {
  switch (reason) {
    case "parent_not_quiescent":
      return conflict("Parent job is not quiescent", reason);
    case "snapshot_too_large":
      return unprocessableEntity(
        "Branch snapshot exceeds the maximum encoded size",
        reason,
      );
    case "invalid_fork_turn":
      return unprocessableEntity("forkTurnIndex is invalid for this job", reason);
    case "file_protection_failed":
      return conflict("File references could not be protected", reason);
    default:
      return errorResponse(409, "branch_rejected", "Branch creation was rejected");
  }
}

// ============================================================================
// Reads
// ============================================================================

async function listJobs(env: Env, url: URL): Promise<Response> {
  const limit = readLimit(url);
  const cursor = readCursor(url);
  const request: CursorPageRequest =
    cursor === null ? { limit } : { limit, cursor };
  const registry = getRegistryStub(env);
  try {
    return jsonResponse(await registry.listJobs(request));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

async function getJobState(env: Env, jobId: JobId): Promise<Response> {
  const stub = getJobStub(env, jobId);
  try {
    const state = await stub.getState();
    if (state === null) {
      return notFound("Job not found");
    }
    return jsonResponse(state);
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

async function listJobTurns(
  env: Env,
  jobId: JobId,
  url: URL,
): Promise<Response> {
  const limit = readLimit(url);
  const cursor = readCursor(url);
  const request: CursorPageRequest =
    cursor === null ? { limit } : { limit, cursor };
  const stub = getJobStub(env, jobId);
  try {
    return jsonResponse(await stub.listTurns(request));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

async function listJobAttempts(
  env: Env,
  jobId: JobId,
  url: URL,
): Promise<Response> {
  const limit = readLimit(url);
  const cursor = readCursor(url);
  const turnIndex = readTurnIndexQuery(url);
  const request: CursorPageRequest & { readonly turnIndex?: TurnIndex } = {
    limit,
    ...(cursor === null ? {} : { cursor }),
    ...(turnIndex === null ? {} : { turnIndex }),
  };
  const stub = getJobStub(env, jobId);
  try {
    return jsonResponse(await stub.listAttempts(request));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

async function listJobJudgeCalls(
  env: Env,
  jobId: JobId,
  url: URL,
): Promise<Response> {
  const limit = readLimit(url);
  const cursor = readCursor(url);
  const turnIndex = readTurnIndexQuery(url);
  const request: CursorPageRequest & { readonly turnIndex?: TurnIndex } = {
    limit,
    ...(cursor === null ? {} : { cursor }),
    ...(turnIndex === null ? {} : { turnIndex }),
  };
  const stub = getJobStub(env, jobId);
  try {
    return jsonResponse(await stub.listJudgeCalls(request));
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }
}

// ============================================================================
// Exports
// ============================================================================

async function exportJob(
  env: Env,
  jobId: JobId,
  url: URL,
): Promise<Response> {
  const format = readExportFormat(url);
  return format === "markdown"
    ? exportMarkdown(env, jobId)
    : exportJson(env, jobId);
}

async function exportMarkdown(env: Env, jobId: JobId): Promise<Response> {
  const stub = getJobStub(env, jobId);
  let state: JobStateResponse;
  try {
    const loaded = await stub.getState();
    if (loaded === null) {
      return notFound("Job not found");
    }
    state = loaded;
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }

  // The accepted-prefix boundary is captured once, before the first page is
  // read. Later acceptances can never enter this export.
  const boundary = deriveAcceptedBoundary(state);
  return streamResponse(
    streamTextChunks(markdownExportChunks(stub, state, boundary)),
    "text/markdown; charset=utf-8",
    { filename: exportFilename(jobId, "md") },
  );
}

async function exportJson(env: Env, jobId: JobId): Promise<Response> {
  const stub = getJobStub(env, jobId);
  let marks: ExportHighWaterMarks;
  let state: JobStateResponse;
  try {
    marks = await stub.captureExportHighWaterMarks();
    const loaded = await stub.getState();
    if (loaded === null) {
      return notFound("Job not found");
    }
    state = loaded;
  } catch (err: unknown) {
    return rpcErrorResponse(err);
  }

  return streamResponse(
    streamTextChunks(jsonExportChunks(stub, state, marks)),
    "application/json; charset=utf-8",
    { filename: exportFilename(jobId, "json") },
  );
}

/**
 * Captures the accepted prefix from the state observed at export start.
 * Turn indices are strictly sequential, so the highest accepted turn observed
 * is the inclusive boundary.
 */
function deriveAcceptedBoundary(state: JobStateResponse): number {
  const count =
    Number.isSafeInteger(state.job.acceptedTurnCount) &&
    state.job.acceptedTurnCount >= 0
      ? state.job.acceptedTurnCount
      : 0;

  let boundary = count;
  for (const turn of state.turns) {
    if (
      (turn.status === "accepted" || turn.status === "accepted_with_warning") &&
      Number.isSafeInteger(turn.turnIndex) &&
      turn.turnIndex > boundary
    ) {
      boundary = turn.turnIndex;
    }
  }
  return boundary;
}

async function* markdownExportChunks(
  stub: JobDoRpcStub,
  state: JobStateResponse,
  boundary: number,
): AsyncGenerator<string, void, void> {
  yield `# ${escapeMarkdownInline(state.job.title)}\n\n`;
  yield `- Job ID: ${escapeMarkdownInline(state.job.jobId)}\n`;
  yield `- Status: ${state.job.status}\n`;
  yield `- Included turns: ${boundary > 0 ? `1-${boundary}` : "none"}\n`;
  yield `- Accepted turns: ${state.job.acceptedTurnCount}\n\n`;

  if (boundary <= 0) {
    yield "_No accepted turns._\n";
    return;
  }

  let cursor: string | null = null;
  let finished = false;
  try {
    while (!finished) {
      const page = await stub.listTurns({
        limit: EXPORT_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
        maxTurnIndex: boundary,
      });
      for (const turn of page.items) {
        if (
          !Number.isSafeInteger(turn.turn_index) ||
          turn.turn_index > boundary
        ) {
          finished = true;
          break;
        }
        if (
          turn.status !== "accepted" &&
          turn.status !== "accepted_with_warning"
        ) {
          continue;
        }

        yield `## Turn ${turn.turn_index} - ${turn.status}\n\n`;
        const candidateId = turn.accepted_candidate_id;
        let deliverable: string | null = null;
        if (typeof candidateId === "string" && candidateId.length > 0) {
          const artifact = await stub.readArtifact({
            kind: "candidate_deliverable",
            id: candidateId,
          });
          if (artifact !== null) {
            deliverable = decodeArtifactText(artifact.bytes);
          }
        }

        if (deliverable === null) {
          yield `_Missing artifact: deliverable ${escapeMarkdownInline(
            candidateId ?? "(not recorded)",
          )}_\n\n`;
          continue;
        }

        yield escapeMarkdownText(deliverable);
        if (!deliverable.endsWith("\n")) {
          yield "\n";
        }
        yield "\n";
      }

      if (finished) {
        break;
      }
      const nextCursor = page.nextCursor;
      if (!page.hasMore || nextCursor === null || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }
  } catch {
    yield "\n_Export incomplete: an internal error interrupted the stream._\n";
  }
}

async function* jsonExportChunks(
  stub: JobDoRpcStub,
  state: JobStateResponse,
  marks: ExportHighWaterMarks,
): AsyncGenerator<string, void, void> {
  const missingArtifacts: MissingArtifactMarker[] = [];
  const fileIds = new Set<string>();
  const maxTurnIndex =
    Number.isSafeInteger(marks.maxTurnIndex) && marks.maxTurnIndex >= 0
      ? marks.maxTurnIndex
      : 0;
  const maxAttemptId =
    typeof marks.maxAttemptId === "string" && marks.maxAttemptId.length > 0
      ? marks.maxAttemptId
      : null;
  const maxJudgeCallId =
    typeof marks.maxJudgeCallId === "string" &&
    marks.maxJudgeCallId.length > 0
      ? marks.maxJudgeCallId
      : null;

  yield `{"exportFormat":"json","exportVersion":1,"generatedAtMs":${now()},"startingRevision":${toJson(
    marks.startingRevision,
  )},"maxTurnIndex":${toJson(marks.maxTurnIndex)},"maxAttemptId":${toJson(
    marks.maxAttemptId,
  )},"maxJudgeCallId":${toJson(marks.maxJudgeCallId)},"highWaterMarks":${toJson(
    marks,
  )},"job":${toJson(state.job)},"usage":${toJson(state.usage)},"turns":[`;

  let complete = true;
  complete = yield* writeTurnItems(stub, maxTurnIndex, fileIds, missingArtifacts);

  yield '],"attempts":[';
  if (complete) {
    complete = yield* writeAttemptItems(stub, maxAttemptId, missingArtifacts);
  }
  yield '],"judgeCalls":[';
  if (complete) {
    complete = yield* writeJudgeCallItems(stub, maxJudgeCallId, fileIds, missingArtifacts);
  }
  yield `],"fileIds":${toJson(Array.from(fileIds).sort())},"missingArtifacts":${toJson(
    missingArtifacts,
  )}`;
  yield complete
    ? ',"exportComplete":true}'
    : ',"exportComplete":false,"exportError":"internal_error"}';
}

async function* writeTurnItems(
  stub: JobDoRpcStub,
  maxTurnIndex: number,
  fileIds: Set<string>,
  missingArtifacts: MissingArtifactMarker[],
): AsyncGenerator<string, boolean, void> {
  let first = true;
  let complete = true;
  if (maxTurnIndex <= 0) {
    return complete;
  }

  let cursor: string | null = null;
  let finished = false;
  try {
    while (!finished) {
      const page = await stub.listTurns({
        limit: EXPORT_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
        maxTurnIndex,
      });
      for (const turn of page.items) {
        if (
          !Number.isSafeInteger(turn.turn_index) ||
          turn.turn_index > maxTurnIndex
        ) {
          finished = true;
          break;
        }
        const record = await buildTurnExportRecord(
          stub,
          turn,
          fileIds,
          missingArtifacts,
        );
        yield first ? record : `,${record}`;
        first = false;
      }
      if (finished) {
        break;
      }
      const nextCursor = page.nextCursor;
      if (!page.hasMore || nextCursor === null || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }
  } catch {
    complete = false;
  }
  return complete;
}

async function buildTurnExportRecord(
  stub: JobDoRpcStub,
  turn: TurnSummaryRow,
  fileIds: Set<string>,
  missingArtifacts: MissingArtifactMarker[],
): Promise<string> {
  const attachmentFileIds = collectTurnFileIds(
    parseJsonField(turn.attachment_file_ids_json),
    fileIds,
  );

  const promptArtifact = await stub.readArtifact({
    kind: "turn_prompt",
    id: turn.turn_index,
  });
  const promptText =
    promptArtifact === null ? null : decodeArtifactText(promptArtifact.bytes);

  let deliverableText: string | null = null;
  const candidateId = turn.accepted_candidate_id;
  if (typeof candidateId === "string" && candidateId.length > 0) {
    const deliverableArtifact = await stub.readArtifact({
      kind: "candidate_deliverable",
      id: candidateId,
    });
    if (deliverableArtifact === null) {
      missingArtifacts.push({
        artifactKind: "deliverable",
        ownerId: candidateId,
        reason: "omitted_or_missing",
      });
    } else {
      deliverableText = decodeArtifactText(deliverableArtifact.bytes);
    }
  } else if (
    turn.status === "accepted" ||
    turn.status === "accepted_with_warning"
  ) {
    missingArtifacts.push({
      artifactKind: "deliverable",
      ownerId: `turn:${turn.turn_index}`,
      reason: "not_recorded",
    });
  }

  return toJson({
    ...turn,
    attachmentFileIds,
    promptText,
    promptArtifactAvailable: promptText !== null,
    deliverableText,
  });
}

async function* writeAttemptItems(
  stub: JobDoRpcStub,
  maxAttemptId: AttemptId | null,
  missingArtifacts: MissingArtifactMarker[],
): AsyncGenerator<string, boolean, void> {
  let first = true;
  let complete = true;
  if (maxAttemptId === null) {
    return complete;
  }

  let cursor: string | null = null;
  let finished = false;
  try {
    while (!finished) {
      const request: CursorPageRequest = {
        limit: EXPORT_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      };
      const page = await stub.listAttempts(request);
      for (const attempt of page.items) {
        if (attempt.attempt_id > maxAttemptId) {
          finished = true;
          break;
        }
        const record = await buildAttemptExportRecord(
          stub,
          attempt,
          missingArtifacts,
        );
        yield first ? record : `,${record}`;
        first = false;
      }
      if (finished) {
        break;
      }
      const nextCursor = page.nextCursor;
      if (!page.hasMore || nextCursor === null || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }
  } catch {
    complete = false;
  }
  return complete;
}

async function buildAttemptExportRecord(
  stub: JobDoRpcStub,
  attempt: GenerationAttemptSummaryRow,
  missingArtifacts: MissingArtifactMarker[],
): Promise<string> {
  const requestArtifact = await stub.readArtifact({
    kind: "attempt_request",
    id: attempt.attempt_id,
  });
  let requestText: string | null = null;
  if (requestArtifact === null) {
    missingArtifacts.push({
      artifactKind: "generation_request",
      ownerId: attempt.attempt_id,
      reason: "omitted_or_missing",
    });
  } else {
    requestText = decodeArtifactText(requestArtifact.bytes);
  }

  // Raw provider response envelopes are never serialized into an export. The
  // retained response artifact is observed for presence and size only.
  const responseArtifact = await stub.readArtifact({
    kind: "attempt_response",
    id: attempt.attempt_id,
  });
  const responseByteLength =
    responseArtifact === null ? null : responseArtifact.bytes.byteLength;
  if (responseByteLength === null) {
    missingArtifacts.push({
      artifactKind: "generation_response",
      ownerId: attempt.attempt_id,
      reason:
        attempt.provider_response_id === null
          ? "not_recorded"
          : "omitted_or_missing",
    });
  }

  return toJson({
    ...attempt,
    usage: parseJsonField(attempt.usage_json),
    diagnostics: parseJsonField(attempt.diagnostics_json),
    requestText,
    response: {
      recorded: responseByteLength !== null,
      byteLength: responseByteLength ?? 0,
    },
  });
}

async function* writeJudgeCallItems(
  stub: JobDoRpcStub,
  maxJudgeCallId: JudgeCallId | null,
  fileIds: Set<string>,
  missingArtifacts: MissingArtifactMarker[],
): AsyncGenerator<string, boolean, void> {
  let first = true;
  let complete = true;
  if (maxJudgeCallId === null) {
    return complete;
  }

  let cursor: string | null = null;
  let finished = false;
  try {
    while (!finished) {
      const request: CursorPageRequest = {
        limit: EXPORT_PAGE_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      };
      const page = await stub.listJudgeCalls(request);
      for (const judgeCall of page.items) {
        if (judgeCall.judge_call_id > maxJudgeCallId) {
          finished = true;
          break;
        }
        const record = await buildJudgeCallExportRecord(
          stub,
          judgeCall,
          fileIds,
          missingArtifacts,
        );
        yield first ? record : `,${record}`;
        first = false;
      }
      if (finished) {
        break;
      }
      const nextCursor = page.nextCursor;
      if (!page.hasMore || nextCursor === null || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }
  } catch {
    complete = false;
  }
  return complete;
}

async function buildJudgeCallExportRecord(
  stub: JobDoRpcStub,
  judgeCall: JudgeCallSummaryRow,
  fileIds: Set<string>,
  missingArtifacts: MissingArtifactMarker[],
): Promise<string> {
  const manifest = parseJsonField(judgeCall.manifest_json);
  collectManifestFileIds(manifest, fileIds);

  const requestArtifact = await stub.readArtifact({
    kind: "judge_request",
    id: judgeCall.judge_call_id,
  });
  let requestText: string | null = null;
  if (requestArtifact === null) {
    missingArtifacts.push({
      artifactKind: "judge_request",
      ownerId: judgeCall.judge_call_id,
      reason: "omitted_or_missing",
    });
  } else {
    // Retained inline judge requests carry their encoded file bytes; exporting
    // the stored request is the only way those bytes enter an export.
    requestText = decodeArtifactText(requestArtifact.bytes);
  }

  if (judgeCall.status !== "pending") {
    missingArtifacts.push({
      artifactKind: "judge_response",
      ownerId: judgeCall.judge_call_id,
      reason:
        judgeCall.provider_response_id === null
          ? "not_recorded"
          : "omitted_or_missing",
    });
  }

  return toJson({
    ...judgeCall,
    manifest,
    usage: parseJsonField(judgeCall.usage_json),
    diagnostics: parseJsonField(judgeCall.diagnostics_json),
    requestText,
  });
}

/** Streams generated text chunks with consumer-driven backpressure. */
function streamTextChunks(
  chunks: AsyncIterable<string>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      try {
        const result = await iterator.next();
        if (result.done === true) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(result.value));
      } catch {
        controller.error(new Error("Export stream failed"));
      }
    },
  });
}

// ============================================================================
// Body and query parsing
// ============================================================================

function readControlJson(request: Request): Promise<unknown> {
  return readJson<unknown>(request, {
    maxBytes: DEFAULT_MAX_JSON_BODY_BYTES,
    requireJsonContentType: true,
  });
}

function parseCreateJobCommand(value: unknown): CreateJobCommand {
  const body = requireRecord(
    value,
    400,
    "invalid_request_body",
    "Request body must be a JSON object",
  );

  const jobId = requireNonEmptyString(body.jobId, "jobId");
  if (
    jobId.includes("/") ||
    jobId === "." ||
    jobId === ".." ||
    /[\u0000-\u001f\u007f]/.test(jobId)
  ) {
    throw new HttpError(
      400,
      "invalid_request_body",
      "jobId must be a path-safe identifier",
    );
  }
  const title = requireString(body.title, "title");
  const config = requireRecord(
    body.config,
    400,
    "invalid_request_body",
    "config must be a JSON object",
  );
  if (!Array.isArray(body.initialTurns)) {
    throw new HttpError(
      400,
      "invalid_request_body",
      "initialTurns must be an array",
    );
  }

  const rawTurns = body.initialTurns as readonly unknown[];
  const initialTurns: TurnPromptSpec[] = [];
  for (let index = 0; index < rawTurns.length; index++) {
    const turn = requireRecord(
      rawTurns[index],
      400,
      "invalid_request_body",
      `initialTurns[${index}] must be a JSON object`,
    );
    const turnIndex = parseTurnIndexValue(
      turn.turnIndex,
      `initialTurns[${index}].turnIndex`,
      400,
      "invalid_request_body",
    );
    if (turnIndex !== index + 1) {
      throw new HttpError(
        400,
        "invalid_request_body",
        "initialTurns must be sequential 1-based",
      );
    }
    initialTurns.push({
      turnIndex,
      promptText: requireString(
        turn.promptText,
        `initialTurns[${index}].promptText`,
      ),
      attachmentFileIds: requireFileIdArray(
        turn.attachmentFileIds,
        `initialTurns[${index}].attachmentFileIds`,
      ),
    });
  }

  return {
    jobId,
    title,
    config: config as unknown as JobConfig,
    initialTurns,
  };
}

function parseAppendTurnCommand(value: unknown): AppendTurnCommand {
  const body = requireRecord(
    value,
    400,
    "invalid_request_body",
    "Request body must be a JSON object",
  );
  return {
    promptText: requireString(body.promptText, "promptText"),
    attachmentFileIds: requireFileIdArray(
      body.attachmentFileIds,
      "attachmentFileIds",
    ),
  };
}

function parseReviewDecision(value: unknown): OperatorReviewDecision {
  const body = requireRecord(
    value,
    400,
    "invalid_review_decision",
    "Request body must be a JSON object",
  );

  const kind = body.kind;
  if (kind === "accept_with_warning") {
    const note = body.note;
    if (note !== undefined && typeof note !== "string") {
      throw new HttpError(
        400,
        "invalid_review_decision",
        "note must be a string when provided",
      );
    }
    return note === undefined
      ? { kind: "accept_with_warning" }
      : { kind: "accept_with_warning", note };
  }
  if (kind === "manual_retry") {
    return { kind: "manual_retry" };
  }
  if (kind === "cancel_job") {
    const reason = body.reason;
    if (reason !== undefined && typeof reason !== "string") {
      throw new HttpError(
        400,
        "invalid_review_decision",
        "reason must be a string when provided",
      );
    }
    return reason === undefined
      ? { kind: "cancel_job" }
      : { kind: "cancel_job", reason };
  }

  throw new HttpError(
    400,
    "invalid_review_decision",
    "kind must be one of accept_with_warning, manual_retry, or cancel_job",
  );
}

function parseForkTurnIndex(value: unknown): TurnIndex {
  const body = requireRecord(
    value,
    422,
    "invalid_fork_turn_index",
    "Request body must be a JSON object with forkTurnIndex",
  );
  return parseTurnIndexValue(
    body.forkTurnIndex,
    "forkTurnIndex",
    422,
    "invalid_fork_turn_index",
  );
}

function parseTurnIndexValue(
  value: unknown,
  label: string,
  status: number,
  code: string,
): TurnIndex {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new HttpError(status, code, `${label} must be a positive integer`);
  }
  try {
    return assertTurnIndex(value, label);
  } catch {
    throw new HttpError(status, code, `${label} must be a positive integer`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new HttpError(
      400,
      "invalid_request_body",
      `${label} must be a string`,
    );
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(
      400,
      "invalid_request_body",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requireFileIdArray(value: unknown, label: string): readonly FileId[] {
  if (!Array.isArray(value)) {
    throw new HttpError(
      400,
      "invalid_request_body",
      `${label} must be an array of file identifiers`,
    );
  }
  const rawValues = value as readonly unknown[];
  const fileIds: FileId[] = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      throw new HttpError(
        400,
        "invalid_request_body",
        `${label} must be an array of non-empty strings`,
      );
    }
    fileIds.push(rawValue);
  }
  return fileIds;
}

function rejectUnknownQuery(url: URL, allowedKeys: readonly string[]): void {
  const allowed = new Set(allowedKeys);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new HttpError(400, "invalid_query", "Unsupported query parameter");
    }
  }
}

function readLimit(url: URL): number {
  const values = url.searchParams.getAll("limit");
  if (values.length > 1) {
    throw new HttpError(
      400,
      "invalid_limit",
      "Query parameter 'limit' must be provided once",
    );
  }
  return clampPageLimit(values[0] ?? null);
}

function readCursor(url: URL): string | null {
  const values = url.searchParams.getAll("cursor");
  if (values.length > 1) {
    throw new HttpError(
      400,
      "invalid_cursor",
      "Query parameter 'cursor' must be provided once",
    );
  }
  const value = values[0];
  return value === undefined || value.length === 0 ? null : value;
}

function readTurnIndexQuery(url: URL): TurnIndex | null {
  const values = url.searchParams.getAll("turnIndex");
  if (values.length === 0) {
    return null;
  }
  if (values.length > 1) {
    throw new HttpError(
      400,
      "invalid_turn_index",
      "Query parameter 'turnIndex' must be provided once",
    );
  }
  const rawValue = values[0];
  if (rawValue === undefined || !/^[0-9]+$/.test(rawValue)) {
    throw new HttpError(
      400,
      "invalid_turn_index",
      "turnIndex must be a positive integer",
    );
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(
      400,
      "invalid_turn_index",
      "turnIndex must be a positive integer",
    );
  }
  try {
    return assertTurnIndex(parsed, "turnIndex");
  } catch {
    throw new HttpError(
      400,
      "invalid_turn_index",
      "turnIndex must be a positive integer",
    );
  }
}

function readExportFormat(url: URL): ExportFormat {
  const values = url.searchParams.getAll("format");
  if (values.length !== 1) {
    throw new HttpError(
      400,
      "invalid_format",
      "Query parameter 'format' must be provided exactly once",
    );
  }
  const value = values[0];
  if (value !== "markdown" && value !== "json") {
    throw new HttpError(
      400,
      "invalid_format",
      "format must be 'markdown' or 'json'",
    );
  }
  return value;
}

// ============================================================================
// Request, RPC, and export helpers
// ============================================================================

/**
 * Validates that an untrusted JSON value is an object and returns it for
 * field-by-field parsing at the HTTP boundary.
 */
function requireRecord(
  value: unknown,
  status: number,
  code: string,
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(status, code, message);
  }
  return value as Record<string, unknown>;
}

/**
 * Rejects state-changing browser requests without the application's own
 * Origin. The webhook host is never an acceptable application Origin.
 */
function assertApplicationOrigin(request: Request, env: Env): void {
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null || rawOrigin.trim().length === 0) {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed",
    );
  }

  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed",
    );
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed",
    );
  }

  const originHostname = origin.hostname.toLowerCase();
  const requestUrl = new URL(request.url);
  if (origin.host.toLowerCase() !== requestUrl.host.toLowerCase()) {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed",
    );
  }

  const hooksHost = normalizeConfiguredHost(env.HOOKS_HOST);
  if (hooksHost.length > 0 && originHostname === hooksHost) {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "Request origin is not allowed",
    );
  }
}

function normalizeConfiguredHost(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function toJobSummaryItem(state: JobStateResponse): JobSummaryItem {
  return {
    jobId: state.job.jobId,
    title: state.job.title,
    status: state.job.status,
    model: state.job.config.model,
    currentTurnIndex: state.job.currentTurnIndex,
    acceptedTurnCount: state.job.acceptedTurnCount,
    totalEstimatedCostUsd: state.usage.totalEstimatedCostUsd,
    createdAtMs: state.job.createdAtMs,
    updatedAtMs: state.job.updatedAtMs,
  };
}

function collectAttachmentFileIds(turns: readonly TurnPromptSpec[]): readonly FileId[] {
  const fileIds = new Set<string>();
  for (const turn of turns) {
    for (const fileId of turn.attachmentFileIds) {
      fileIds.add(fileId);
    }
  }
  return Array.from(fileIds);
}

/**
 * The branch identity is derived from the snapshot so the handler can protect
 * the child's file references before activation. `JobDO.initializeBranch`
 * derives the same identity from the snapshot it consumes.
 */
function deriveBranchJobId(snapshot: BranchSnapshot): JobId {
  return `${snapshot.parentJob.jobId}:branch:${snapshot.forkTurnIndex}:${snapshot.capturedAtMs}`;
}

function isBranchCaptureRejection(
  value: BranchSnapshotCapture,
): value is BranchSnapshotCaptureRejection {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "rejected"
  );
}

/**
 * Converts a failed RPC into a stable, sanitized HTTP response. Durable Object
 * errors may cross the serialization boundary without preserving the
 * `HttpError` prototype, so structured `status` / `code` fields are honored.
 */
function rpcErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return toErrorResponse(err);
  }

  const statusValue =
    typeof err === "object" && err !== null && "status" in err
      ? err.status
      : undefined;
  const codeValue =
    typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;
  const status =
    typeof statusValue === "number" && Number.isSafeInteger(statusValue)
      ? statusValue
      : null;
  const code =
    typeof codeValue === "string" &&
    codeValue.length > 0 &&
    codeValue.length <= 64
      ? codeValue
      : null;

  if (status === 404 || code === "not_found") {
    return notFound("Job not found");
  }
  if (status !== null && status >= 400 && status <= 599 && code !== null) {
    if (status === 409) {
      return conflict("Request conflicts with current job state", code);
    }
    if (status === 422) {
      return unprocessableEntity("Request could not be processed", code);
    }
    if (status >= 500) {
      return errorResponse(status, code, "Internal Server Error");
    }
    return errorResponse(status, code, "Request failed");
  }

  const message = err instanceof Error ? err.message.toLowerCase() : "";
  if (message.includes("not found") || message.includes("no such job")) {
    return notFound("Job not found");
  }

  return toErrorResponse(err);
}

function parseJsonField(raw: string | null | undefined): unknown {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return raw;
  }
}

function collectTurnFileIds(
  parsedAttachmentIds: unknown,
  fileIds: Set<string>,
): readonly string[] {
  if (!Array.isArray(parsedAttachmentIds)) {
    return [];
  }
  const rawValues = parsedAttachmentIds as readonly unknown[];
  const attachmentFileIds: string[] = [];
  for (const rawValue of rawValues) {
    if (typeof rawValue === "string" && rawValue.length > 0) {
      attachmentFileIds.push(rawValue);
      fileIds.add(rawValue);
    }
  }
  return attachmentFileIds;
}

function collectManifestFileIds(manifest: unknown, fileIds: Set<string>): void {
  let entries: readonly unknown[] | null = null;
  if (Array.isArray(manifest)) {
    entries = manifest as readonly unknown[];
  } else if (typeof manifest === "object" && manifest !== null) {
    if ("files" in manifest && Array.isArray(manifest.files)) {
      entries = manifest.files as readonly unknown[];
    }
  }
  if (entries === null) {
    return;
  }

  for (const entry of entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("fileId" in entry)
    ) {
      continue;
    }
    const fileId = entry.fileId;
    if (typeof fileId === "string" && fileId.length > 0) {
      fileIds.add(fileId);
    }
  }
}

function decodeArtifactText(bytes: ArrayBuffer | Uint8Array): string {
  const decoder = new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: false,
  });
  return decoder.decode(bytes);
}

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

function exportFilename(jobId: string, extension: string): string {
  const safe = jobId
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = safe.length > 0 ? safe.slice(0, 96) : "job";
  return `${base}.${extension}`;
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMarkdownInline(value: string): string {
  return escapeMarkdownText(value).replace(/\r\n?|\n/g, " ");
}