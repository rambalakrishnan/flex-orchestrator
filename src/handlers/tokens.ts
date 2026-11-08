/**
 * Tokens handler — `src/handlers/tokens.ts`
 *
 * Pending marginal-token preview (`POST /api/tokens/preview`).
 *
 * Invariants (docs/TOKENSHANDLER.md):
 * - The counted payload is the exact ARCHITECTURE §6 canonical request built by
 *   `buildCanonicalGenerationRequest`; never a reduced ad-hoc payload.
 * - Job context (cache TTL, continuity anchor, current turn index) comes only from
 *   persisted `JobDO.getState()`. Without a job, no anchor and `"nocache"` are claimed.
 * - The provider count is the marginal count; no prior usage total is added on top.
 * - The route is read-only: no storage writes, turn/attempt creation, or revision bump.
 * - Unknown models are rejected through `admission` (never a guessed limit or profile),
 *   while a provider count failure is a sanitized 5xx with no projected count.
 */

import {
  COMPATIBILITY,
  DEFAULT_MAX_JSON_BODY_BYTES,
  REASONING_EFFORT_LEVELS,
  isVerifiedGenerationModel,
} from "../constants.ts";
import {
  HttpError,
  badRequest,
  jsonResponse,
  methodNotAllowed,
  notFound,
  payloadTooLarge,
  readJson,
  toErrorResponse,
  unsupportedMediaType,
  withScopedAbort,
} from "../http.ts";
import { buildCanonicalGenerationRequest } from "../lib/dispatch.ts";
import { DEFAULT_OPENAI_TIMEOUT_MS, countResponsesInputTokens, resolveEnvSecret } from "../lib/openai.ts";
import { buildMarginalTokenPreview } from "../lib/tokens.ts";
import type {
  CacheTtl,
  FileId,
  JobStateResponse,
  MarginalTokenPreviewRequest,
  ReasoningEffort,
  ResponseId,
  TurnIndex,
} from "../types.ts";

/** The only route this handler serves. */
const TOKENS_PREVIEW_PATH = "/api/tokens/preview";

/**
 * Preview-only identity used when the request supplies no `jobId`.
 * `attemptNumber: 0` / `continuationIndex: 0` can never collide with a real
 * attempt (attempt numbering starts at 1), and the idempotency key produced by
 * the canonical builder is never sent by the count endpoint or recorded.
 */
const PREVIEW_JOB_ID = "preview";
const PREVIEW_TURN_INDEX: TurnIndex = 1;
const PREVIEW_ATTEMPT_NUMBER = 0;
const PREVIEW_CONTINUATION_INDEX = 0;

/** Resolved execution context used to build the pending canonical request. */
interface PreviewContext {
  readonly jobId: string;
  readonly cacheTtl: CacheTtl;
  readonly previousResponseId: ResponseId | null;
  readonly turnIndex: TurnIndex;
  readonly developerPrompt: string;
  readonly developerFileIds: readonly FileId[];
}

/** Structural view of the `JobDO` binding RPC used by the preview. */
interface JobDoRpcStub {
  getState(): Promise<JobStateResponse | null>;
}

/**
 * Handles the tokens handler surface. Any path other than `POST /api/tokens/preview`
 * is outside this handler's contract.
 */
export function handleTokensRequest(request: Request, env: Env): Promise<Response> {
  return routeTokensRequest(request, env).catch((err: unknown) => toErrorResponse(err));
}

async function routeTokensRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== TOKENS_PREVIEW_PATH) {
    return notFound();
  }
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  return createMarginalPreview(request, env);
}

async function createMarginalPreview(request: Request, env: Env): Promise<Response> {
  let parsedBody: unknown;
  try {
    parsedBody = await readJson<unknown>(request, {
      maxBytes: DEFAULT_MAX_JSON_BODY_BYTES,
      requireJsonContentType: true,
    });
  } catch (err: unknown) {
    if (err instanceof HttpError) {
      if (err.status === 413) {
        return payloadTooLarge(undefined, undefined, DEFAULT_MAX_JSON_BODY_BYTES);
      }
      if (err.status === 415) {
        return unsupportedMediaType();
      }
      if (err.status === 400) {
        return badRequest(err.message);
      }
    }
    return toErrorResponse(err);
  }

  const previewRequest = validatePreviewRequest(parsedBody);
  const context = await resolvePreviewContext(env, previewRequest.jobId);

  // Unknown models are rejected without a provider call or a guessed profile.
  // No count exists in this branch, so the projection is explicitly empty and
  // `admission` carries `unknown_model` with `maxAllowedInputTokens: null`.
  if (!isVerifiedGenerationModel(previewRequest.model)) {
    return jsonResponse(
      buildMarginalTokenPreview({
        model: previewRequest.model,
        marginalInputTokens: 0,
        priorTotalInputTokens: 0,
        maxOutputTokens: previewRequest.maxOutputTokens,
      }),
    );
  }

  const canonical = buildCanonicalGenerationRequest({
    jobId: context.jobId,
    model: previewRequest.model,
    reasoningEffort: previewRequest.reasoningEffort,
    maxOutputTokens: previewRequest.maxOutputTokens,
    cacheTtl: context.cacheTtl,
    webSearch: previewRequest.webSearch,
    turnIndex: context.turnIndex,
    attemptNumber: PREVIEW_ATTEMPT_NUMBER,
    continuationIndex: PREVIEW_CONTINUATION_INDEX,
    attemptKind: "initial",
    promptText: previewRequest.promptText,
    attachmentFileIds: previewRequest.attachmentFileIds,
    developerPrompt: previewRequest.developerPrompt ?? context.developerPrompt,
    developerFileIds: previewRequest.developerFileIds ?? context.developerFileIds,
    previousResponseId: context.previousResponseId,
  });

  const payload = parseCanonicalPayload(canonical.requestBody);
  const apiKey = resolveEnvSecret(env, "OPENAI_API_KEY");

  let marginalInputTokens: number;
  try {
    const counted = await withScopedAbort(
      {
        request,
        forwardRequestSignal: COMPATIBILITY.ENABLE_REQUEST_SIGNAL,
        timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
      },
      (signal) =>
        countResponsesInputTokens({
          apiKey,
          payload,
          timeoutMs: DEFAULT_OPENAI_TIMEOUT_MS,
          signal,
        }),
    );
    marginalInputTokens = counted.inputTokens;
  } catch (err: unknown) {
    // A count failure never yields a projection, and the raw provider body,
    // headers, and credentials are never echoed. An `HttpError` from the
    // provider layer contributes only its status code and machine code.
    if (err instanceof HttpError) {
      const providerCode = err.code.trim();
      const safeProviderCode =
        providerCode.length > 0 &&
        providerCode.length <= 64 &&
        /^[A-Za-z0-9_.:-]+$/.test(providerCode)
          ? providerCode
          : null;
      const codeSuffix = safeProviderCode === null ? "" : ` ${safeProviderCode}`;
      return toErrorResponse(
        new HttpError(
          502,
          "token_count_failed",
          `Provider token count request failed (HTTP ${err.status}${codeSuffix})`,
          {
            provider_status: err.status,
            provider_code: safeProviderCode,
          },
        ),
      );
    }
    return toErrorResponse(
      new HttpError(502, "token_count_failed", "Provider token count request failed"),
    );
  }

  // The provider count covers the full pending payload, including cached input.
  // Do not add a second prior total on top of it.
  return jsonResponse(
    buildMarginalTokenPreview({
      model: previewRequest.model,
      marginalInputTokens,
      priorTotalInputTokens: 0,
      maxOutputTokens: previewRequest.maxOutputTokens,
    }),
  );
}

/**
 * Validates the preview body before the provider call.
 */
function validatePreviewRequest(value: unknown): MarginalTokenPreviewRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPreviewRequest("Request body must be a JSON object");
  }
  const record = value as Record<string, unknown>;

  const rawJobId = record.jobId;
  if (rawJobId !== undefined && (typeof rawJobId !== "string" || rawJobId.length === 0)) {
    throw invalidPreviewRequest("jobId must be a non-empty string when provided");
  }

  const model = record.model;
  if (typeof model !== "string" || model.length === 0) {
    throw invalidPreviewRequest("model must be a non-empty string");
  }

  const promptText = record.promptText;
  if (typeof promptText !== "string") {
    throw invalidPreviewRequest("promptText must be a string");
  }

  const rawFileIds = record.attachmentFileIds;
  if (!Array.isArray(rawFileIds)) {
    throw invalidPreviewRequest("attachmentFileIds must be an array of strings");
  }
  const attachmentFileIds: string[] = [];
  for (const fileId of rawFileIds as readonly unknown[]) {
    if (typeof fileId !== "string") {
      throw invalidPreviewRequest("attachmentFileIds must be an array of strings");
    }
    attachmentFileIds.push(fileId);
  }

  const rawDeveloperPrompt = record.developerPrompt;
  if (rawDeveloperPrompt !== undefined && typeof rawDeveloperPrompt !== "string") {
    throw invalidPreviewRequest("developerPrompt must be a string when provided");
  }

  const rawDeveloperFileIds = record.developerFileIds;
  let developerFileIds: string[] | undefined;
  if (rawDeveloperFileIds !== undefined) {
    if (!Array.isArray(rawDeveloperFileIds)) {
      throw invalidPreviewRequest("developerFileIds must be an array of non-empty strings");
    }
    developerFileIds = [];
    for (const fileId of rawDeveloperFileIds as readonly unknown[]) {
      if (typeof fileId !== "string" || fileId.length === 0) {
        throw invalidPreviewRequest("developerFileIds must be an array of non-empty strings");
      }
      developerFileIds.push(fileId);
    }
  }

  const maxOutputTokens = record.maxOutputTokens;
  if (
    typeof maxOutputTokens !== "number" ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens <= 0
  ) {
    throw invalidPreviewRequest("maxOutputTokens must be a positive integer");
  }

  const rawReasoningEffort = record.reasoningEffort;
  if (!isReasoningEffortLevel(rawReasoningEffort)) {
    throw invalidPreviewRequest(
      `reasoningEffort must be one of: ${REASONING_EFFORT_LEVELS.join(", ")}`,
    );
  }
  const reasoningEffort: ReasoningEffort = rawReasoningEffort;

  const webSearch = record.webSearch;
  if (typeof webSearch !== "boolean") {
    throw invalidPreviewRequest("webSearch must be a boolean");
  }

  const request: MarginalTokenPreviewRequest = {
    model,
    promptText,
    attachmentFileIds,
    maxOutputTokens,
    reasoningEffort,
    webSearch,
    ...(typeof rawDeveloperPrompt === "string" ? { developerPrompt: rawDeveloperPrompt } : {}),
    ...(developerFileIds !== undefined ? { developerFileIds } : {}),
    ...(typeof rawJobId === "string" ? { jobId: rawJobId } : {}),
  };
  return request;
}

function invalidPreviewRequest(message: string): HttpError {
  return new HttpError(422, "unprocessable_entity", message);
}

/**
 * Narrows a raw request value against the authoritative
 * `REASONING_EFFORT_LEVELS` list, so newly added levels need no change here.
 */
function isReasoningEffortLevel(
  value: unknown,
): value is (typeof REASONING_EFFORT_LEVELS)[number] {
  return (
    typeof value === "string" && (REASONING_EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Reads persisted job context. Without a `jobId` the preview claims no cache
 * retention, no continuity anchor, and a preview-only turn identity.
 */
async function resolvePreviewContext(
  env: Env,
  jobId: string | undefined,
): Promise<PreviewContext> {
  if (jobId === undefined) {
    return {
      jobId: PREVIEW_JOB_ID,
      cacheTtl: "nocache",
      previousResponseId: null,
      turnIndex: PREVIEW_TURN_INDEX,
      developerPrompt: "",
      developerFileIds: [],
    };
  }

  const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId)) as unknown as JobDoRpcStub;
  const state = await stub.getState();
  if (state === null) {
    throw new HttpError(404, "not_found", "Job not found");
  }
  return {
    jobId,
    cacheTtl: state.job.config.cacheTtl,
    previousResponseId: state.job.lastAcceptedResponseId,
    turnIndex: state.job.currentTurnIndex,
    developerPrompt: state.job.config.developerPrompt,
    developerFileIds: state.job.config.developerFileIds,
  };
}

/**
 * Parses the canonical request body into the object sent to the token-count
 * endpoint. The canonical builder always emits a JSON object.
 */
function parseCanonicalPayload(requestBody: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(requestBody);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Canonical generation request was not a JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}