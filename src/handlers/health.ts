/**
 * Health handler (`src/handlers/health.ts`) — operator diagnostics for
 * `GET /api/health` and `GET /api/health?jobId=`.
 *
 * Invariants:
 * - No job-state writes, turn/attempt creation, or revision bumps. A job-scoped
 *   probe wakes the JobDO only to read its state.
 * - Responses contain only derived probe facts. Provider secrets and raw
 *   response bodies are never echoed; error strings are sanitized and bounded.
 * - The main probe always targets the canonical OpenAI API root; a job-scoped
 *   judge probe targets the job-declared judge root and model.
 */

import { DEFAULT_MAX_JSON_BODY_BYTES, HEALTH_PATH } from "../constants.ts";
import {
  HttpError,
  errorResponse,
  fetchWithAbort,
  forbidden,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readBoundedBytes,
  toErrorResponse,
} from "../http.ts";
import { now } from "../lib/clock.ts";
import {
  OPENAI_DEFAULT_API_ROOT,
  listProviderModels,
  normalizeApiRoot,
  resolveEnvSecret,
} from "../lib/openai.ts";
import { redactSensitiveText } from "../lib/redaction.ts";
import type { JobConfig, JobStateResponse, JudgeConfig } from "../types.ts";

/** Public OpenAI status-page summary endpoint (no credential required). */
export const OPENAI_STATUS_SUMMARY_URL = "https://status.openai.com/api/v2/summary.json" as const;

/** Timeout applied to each health probe request. */
export const HEALTH_PROBE_TIMEOUT_MS = 10_000 as const;

const utf8Decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
const MAX_ERROR_TEXT_LENGTH = 240;
const MAX_STATUS_DESCRIPTION_LENGTH = 300;
const MAX_STATUS_INDICATOR_LENGTH = 40;

/** Indicator/description pair extracted from the public OpenAI status summary. */
export interface HealthStatusSummary {
  readonly indicator: string;
  readonly description: string;
}

/** Model-list probe outcome for one provider root. */
export interface HealthModelsProbe {
  readonly ok: boolean;
  readonly count: number;
  readonly modelPresent: boolean | null;
  readonly error: string | null;
}

/** Result of one provider probe (main OpenAI or the job-declared judge). */
export interface HealthProbe {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly status: HealthStatusSummary | null;
  readonly models: HealthModelsProbe;
  readonly error: string | null;
}

/** Judge probe shape when the job has no enabled judge. */
export interface SkippedHealthProbe extends HealthProbe {
  readonly skipped: true;
}

export type JudgeHealthProbe = HealthProbe | SkippedHealthProbe;

/** Response body served by `GET /api/health`. */
export interface HealthResponse {
  readonly checkedAtMs: number;
  readonly main: HealthProbe;
  readonly judge: JudgeHealthProbe | null;
}

export interface FetchOpenAIStatusSummaryParams {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** Structural view of the `JobDO` binding RPC used by the job-scoped probe. */
interface JobDoRpcStub {
  getState(): Promise<JobStateResponse | null>;
}

interface ProbeStatusResult {
  readonly summary: HealthStatusSummary | null;
  readonly error: string | null;
}

/**
 * Fetches and parses the public OpenAI status summary.
 *
 * Only `status.indicator` and `status.description` are extracted; the rest of
 * the body is discarded. The read is bounded and the provider body is never
 * included in thrown errors.
 */
export async function fetchOpenAIStatusSummary(
  params: FetchOpenAIStatusSummaryParams = {},
): Promise<HealthStatusSummary> {
  const init: RequestInit = {
    method: "GET",
    headers: { Accept: "application/json" },
  };

  const response = params.fetchImpl
    ? await params.fetchImpl(OPENAI_STATUS_SUMMARY_URL, init)
    : await fetchWithAbort(OPENAI_STATUS_SUMMARY_URL, init, {
        timeoutMs: params.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS,
        ...(params.signal ? { signal: params.signal } : {}),
        forwardRequestSignal: false,
      });

  const rawBytes = await readBoundedBytes(
    response,
    DEFAULT_MAX_JSON_BODY_BYTES,
    params.signal,
  );

  if (!response.ok) {
    throw new HttpError(
      response.status,
      "status_summary_failed",
      `Status summary returned HTTP ${response.status}`,
    );
  }

  const rawText = utf8Decoder.decode(rawBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new HttpError(502, "invalid_status_summary", "Status summary was not valid JSON");
  }

  const statusObj =
    isPlainRecord(parsed) && isPlainRecord(parsed.status) ? parsed.status : null;
  if (
    statusObj === null ||
    typeof statusObj.indicator !== "string" ||
    statusObj.indicator.trim().length === 0
  ) {
    throw new HttpError(
      502,
      "invalid_status_summary",
      "Status summary lacked a valid status indicator",
    );
  }

  return {
    indicator: sanitizeHealthText(statusObj.indicator, MAX_STATUS_INDICATOR_LENGTH).toLowerCase(),
    description:
      typeof statusObj.description === "string"
        ? sanitizeHealthText(statusObj.description, MAX_STATUS_DESCRIPTION_LENGTH)
        : "",
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Flattens whitespace/control characters and caps the text length so probe
 * responses stay bounded and cannot carry multi-line provider payloads.
 */
function sanitizeHealthText(value: string, maxLength: number): string {
  const flattened = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength)}...` : flattened;
}

/**
 * Sanitizes an error for probe output: strips bearer tokens and OpenAI-style
 * key material, flattens control characters, and caps the length.
 */
function sanitizeHealthError(
  err: unknown,
  secrets: readonly string[] = [],
): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Unknown probe error";
  const redacted = redactSensitiveText(raw, secrets);
  const sanitized = sanitizeHealthText(redacted, MAX_ERROR_TEXT_LENGTH);
  return sanitized.length > 0 ? sanitized : "Unknown probe error";
}

function isOpenAIStatusApplicable(apiRoot: string): boolean {
  try {
    return new URL(normalizeApiRoot(apiRoot)).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

async function probeStatusSummary(signal?: AbortSignal): Promise<ProbeStatusResult> {
  try {
    const summary = await fetchOpenAIStatusSummary({ signal });
    return { summary, error: null };
  } catch (err: unknown) {
    return { summary: null, error: sanitizeHealthError(err) };
  }
}

async function probeModelAvailability(
  env: Env,
  secretName: string,
  apiRoot: string,
  targetModel: string | null,
  signal?: AbortSignal,
): Promise<HealthModelsProbe> {
  let apiKey: string | null = null;
  try {
    apiKey = resolveEnvSecret(env, secretName);
    const { modelIds } = await listProviderModels({
      apiKey,
      apiRoot,
      timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return {
      ok: true,
      count: modelIds.length,
      modelPresent: targetModel === null ? null : modelIds.includes(targetModel),
      error: null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      count: 0,
      modelPresent: null,
      error: sanitizeHealthError(err, apiKey === null ? [] : [apiKey]),
    };
  }
}

function assembleProbe(
  startedAt: number,
  statusResult: ProbeStatusResult,
  models: HealthModelsProbe,
): HealthProbe {
  const errors: string[] = [];

  if (statusResult.error !== null) {
    errors.push(`OpenAI status unavailable: ${statusResult.error}`);
  }
  if (statusResult.summary !== null && statusResult.summary.indicator !== "none") {
    errors.push(`OpenAI status indicator: ${statusResult.summary.indicator}`);
  }
  if (models.error !== null) {
    errors.push(`Models unavailable: ${models.error}`);
  }
  if (models.ok && models.modelPresent === false) {
    errors.push("Configured model is not present in the provider model list");
  }

  return {
    ok: errors.length === 0 && models.ok,
    latencyMs: Math.max(0, now() - startedAt),
    status: statusResult.summary,
    models,
    error: errors.length > 0 ? errors.join("; ") : null,
  };
}

async function buildMainProbe(
  env: Env,
  config: JobConfig | null,
  signal?: AbortSignal,
): Promise<HealthProbe> {
  const startedAt = now();
  const targetModel = config === null ? null : config.model;

  const [statusResult, models] = await Promise.all([
    probeStatusSummary(signal),
    probeModelAvailability(
      env,
      "OPENAI_API_KEY",
      OPENAI_DEFAULT_API_ROOT,
      targetModel,
      signal,
    ),
  ]);

  return assembleProbe(startedAt, statusResult, models);
}

async function buildJudgeProbe(
  env: Env,
  judge: JudgeConfig,
  signal?: AbortSignal,
): Promise<JudgeHealthProbe> {
  if (!judge.enabled) {
    return {
      ok: true,
      skipped: true,
      latencyMs: 0,
      status: null,
      models: { ok: true, count: 0, modelPresent: null, error: null },
      error: null,
    };
  }

  const startedAt = now();
  const statusResultPromise: Promise<ProbeStatusResult> = isOpenAIStatusApplicable(judge.apiRoot)
    ? probeStatusSummary(signal)
    : Promise.resolve({ summary: null, error: null });
  const [statusResult, models] = await Promise.all([
    statusResultPromise,
    probeModelAvailability(env, judge.secretName, judge.apiRoot, judge.model, signal),
  ]);

  return assembleProbe(startedAt, statusResult, models);
}

/**
 * Handles `GET /api/health` (application host only).
 *
 * Without `jobId`, only the main OpenAI probe is returned (`judge: null`).
 * With `jobId`, the job's configured model is checked on the main root and the
 * job-declared judge is probed separately (skipped when disabled).
 */
export function handleHealthRequest(request: Request, env: Env): Promise<Response> {
  return routeHealthRequest(request, env).catch((err: unknown) => toErrorResponse(err));
}

async function routeHealthRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== HEALTH_PATH) {
    return notFound();
  }
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return forbidden("Cross-site health probes are not allowed", "cross_site_forbidden");
  }

  for (const key of url.searchParams.keys()) {
    if (key !== "jobId") {
      return errorResponse(
        400,
        "unsupported_query_parameter",
        `Unsupported query parameter: ${sanitizeHealthText(key, MAX_STATUS_INDICATOR_LENGTH)}`,
      );
    }
  }

  const rawJobIds = url.searchParams.getAll("jobId");
  if (rawJobIds.length > 1) {
    return errorResponse(400, "invalid_job_id", "jobId must be provided at most once");
  }
  const rawJobId = rawJobIds[0];
  if (
    rawJobId !== undefined &&
    (rawJobId.length === 0 ||
      rawJobId.includes("/") ||
      rawJobId === "." ||
      rawJobId === ".." ||
      /[\u0000-\u001f\u007f]/.test(rawJobId))
  ) {
    return errorResponse(
      400,
      "invalid_job_id",
      "jobId must be a path-safe non-empty identifier without control characters",
    );
  }
  const jobId = rawJobId === undefined ? null : rawJobId;

  let state: JobStateResponse | null = null;
  if (jobId !== null) {
    const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId)) as unknown as JobDoRpcStub;
    try {
      state = await stub.getState();
    } catch {
      throw new HttpError(502, "job_state_unavailable", "Job state could not be loaded");
    }
    if (state === null) {
      return notFound("Job not found", "not_found");
    }
  }

  const config = state === null ? null : state.job.config;

  const [main, judge] = await Promise.all([
    buildMainProbe(env, config, request.signal),
    config === null
      ? Promise.resolve<JudgeHealthProbe | null>(null)
      : buildJudgeProbe(env, config.judge, request.signal),
  ]);

  const body: HealthResponse = {
    checkedAtMs: now(),
    main,
    judge,
  };
  return jsonResponse(body);
}