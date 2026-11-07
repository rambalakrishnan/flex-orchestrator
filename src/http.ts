/**
 * HTTP — bounded JSON handling and HTTP response helpers.
 *
 * Adheres to Worker isolate memory bounds (128 MiB shared across DOs on the isolate),
 * explicit AbortController lifecycle cleanup, and safe Cloudflare property access.
 */

import { DEFAULT_MAX_JSON_BODY_BYTES } from "./constants.ts";

/**
 * Default maximum JSON payload size in bytes (262,144 bytes, sufficient for control
 * payloads; the single source of truth is `DEFAULT_MAX_JSON_BODY_BYTES` in
 * `src/constants.ts`). Callers may pass an explicit larger cap (e.g., 8,000,000 bytes
 * for branch snapshot imports).
 */
export const DEFAULT_MAX_JSON_BYTES = DEFAULT_MAX_JSON_BODY_BYTES;

/**
 * Maximum post-response execution tail granted by `ctx.waitUntil()` in Workers (30 seconds).
 * Long-running continuations or exports MUST use Durable Object alarms or RPC rather than `waitUntil`.
 */
export const WAIT_UNTIL_MAX_TAIL_MS = 30_000;

/**
 * Structured HTTP error carrying an HTTP status code and machine-readable code.
 */
export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Standard JSON error payload structure.
 */
export interface ErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Default security and cache headers applied to JSON API responses.
 */
const JSON_BASE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/**
 * Builds `Headers` initialized with standard JSON headers and optional overrides.
 */
function buildJsonHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(JSON_BASE_HEADERS);
  if (extra) {
    const extraHeaders = new Headers(extra);
    extraHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
}

/**
 * Creates a JSON `Response` with `application/json; charset=utf-8` and `no-store` caching.
 */
export function jsonResponse<T>(data: T, init?: number | ResponseInit): Response {
  const responseInit: ResponseInit =
    typeof init === "number" ? { status: init } : { ...init };
  return new Response(JSON.stringify(data), {
    ...responseInit,
    headers: buildJsonHeaders(responseInit.headers),
  });
}

/**
 * Creates a structured JSON error `Response`.
 */
export function errorResponse(
  status: number,
  code: string,
  message?: string,
  details?: unknown,
  init?: ResponseInit,
): Response {
  const resolvedMessage = message ?? code;
  const payload: ErrorPayload = {
    error: {
      code,
      message: resolvedMessage,
      ...(details !== undefined ? { details } : {}),
    },
  };
  return jsonResponse(payload, {
    ...init,
    status,
  });
}

/**
 * Converts an unknown caught error into a standardized JSON `Response`.
 * Preserves status and code if the error is an `HttpError`. Every other throwable
 * becomes a 500 `internal_error` with a fixed literal message — never the raw
 * `err.message`, stack, or details, which could leak credentials or internals.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return errorResponse(err.status, err.code, err.message, err.details);
  }
  return errorResponse(500, "internal_error", "Internal Server Error");
}

export function badRequest(message: string, code = "bad_request", details?: unknown): Response {
  return errorResponse(400, code, message, details);
}

export function unauthorized(message = "Unauthorized", code = "unauthorized"): Response {
  return errorResponse(401, code, message);
}

export function forbidden(message = "Forbidden", code = "forbidden"): Response {
  return errorResponse(403, code, message);
}

export function notFound(message = "Not found", code = "not_found"): Response {
  return errorResponse(404, code, message);
}

export function methodNotAllowed(allowed: readonly string[], message = "Method not allowed"): Response {
  return errorResponse(405, "method_not_allowed", message, undefined, {
    headers: { allow: allowed.join(", ") },
  });
}

export function conflict(message: string, code = "conflict", details?: unknown): Response {
  return errorResponse(409, code, message, details);
}

export function payloadTooLarge(
  message = "Request body exceeds maximum allowed size",
  code = "payload_too_large",
  maxBytes?: number,
): Response {
  return errorResponse(
    413,
    code,
    message,
    maxBytes !== undefined ? { max_bytes: maxBytes } : undefined,
  );
}

export function unsupportedMediaType(
  message = "Expected application/json content-type",
  code = "unsupported_media_type",
): Response {
  return errorResponse(415, code, message);
}

export function unprocessableEntity(
  message: string,
  code = "unprocessable_entity",
  details?: unknown,
): Response {
  return errorResponse(422, code, message, details);
}

/**
 * Creates a streaming `Response` (e.g. for Markdown or JSON exports).
 * Response bodies have no platform size ceiling, so large exports stream pages
 * and one artifact at a time without buffering full jobs in memory.
 */
export function streamResponse(
  stream: ReadableStream<Uint8Array>,
  contentType: string,
  init?: ResponseInit & { filename?: string },
): Response {
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (init?.filename) {
    const safeFilename = init.filename.replace(/["\\\r\n]/g, "_");
    headers.set("content-disposition", `attachment; filename="${safeFilename}"`);
  }
  if (init?.headers) {
    const extra = new Headers(init.headers);
    extra.forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return new Response(stream, {
    status: init?.status ?? 200,
    ...(init?.statusText !== undefined ? { statusText: init.statusText } : {}),
    headers,
  });
}

/**
 * Options for bounded body / JSON reading.
 */
export interface ReadBodyOptions {
  /**
   * Maximum allowed byte length. Defaults to `DEFAULT_MAX_JSON_BYTES` (262,144).
   */
  maxBytes?: number;
  /**
   * Whether to require an `application/json` (or `+json`) `Content-Type` header.
   * Defaults to `false` so internal RPC requests without explicit headers still work unless enforced.
   */
  requireJsonContentType?: boolean;
  /**
   * Optional caller abort signal.
   */
  signal?: AbortSignal;
}

/**
 * Checks whether a `Content-Type` header value represents JSON.
 */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/**
 * Reads a `Request` or `Response` body into a `Uint8Array` with a strict byte bound.
 *
 * Trap 4.1 mitigation:
 * Never calls `request.json()` or `request.text()` directly on an unbounded stream,
 * which could exhaust the 128 MiB Worker isolate memory limit.
 *
 * 1. Inspects `Content-Length` upfront and rejects immediately with `HttpError(413)` if it exceeds `maxBytes`.
 * 2. Streams chunks from `body.getReader()` and aborts + throws `HttpError(413)` the moment total bytes exceed `maxBytes`.
 */
export async function readBoundedBytes(
  source: Request | Response,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new HttpError(500, "invalid_body_limit", "Invalid maxBytes configuration");
  }

  const contentLengthHeader = source.headers.get("content-length");
  let declaredLength: number | undefined;
  if (contentLengthHeader !== null && contentLengthHeader.trim() !== "") {
    const parsed = Number(contentLengthHeader);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new HttpError(400, "invalid_content_length", "Invalid Content-Length header");
    }
    if (parsed > maxBytes) {
      throw new HttpError(
        413,
        "payload_too_large",
        `Content-Length (${parsed} bytes) exceeds maximum allowed size (${maxBytes} bytes)`,
        { max_bytes: maxBytes, content_length: parsed },
      );
    }
    declaredLength = parsed;
  }

  if (source.body === null) {
    return new Uint8Array(0);
  }

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel(signal.reason).catch(() => undefined);
        throw new HttpError(499, "request_aborted", "Request aborted while reading body");
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Payload too large").catch(() => undefined);
        throw new HttpError(
          413,
          "payload_too_large",
          `Request body exceeds maximum allowed size of ${maxBytes} bytes`,
          { max_bytes: maxBytes },
        );
      }

      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore if lock was already released
    }
  }

  if (declaredLength !== undefined && totalBytes !== declaredLength) {
    throw new HttpError(
      400,
      "content_length_mismatch",
      `Actual body length (${totalBytes} bytes) did not match Content-Length (${declaredLength} bytes)`,
    );
  }

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0]!;
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Reads a `Request` or `Response` body as UTF-8 text with a strict byte bound.
 */
export async function readBoundedText(
  source: Request | Response,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  const bytes = await readBoundedBytes(source, maxBytes, signal);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  try {
    return decoder.decode(bytes);
  } catch {
    throw new HttpError(400, "invalid_utf8", "Request body is not valid UTF-8");
  }
}

/**
 * Reads and parses a JSON body from a `Request` or `Response` with strict byte-size bounding.
 *
 * Rejects:
 * - Bodies exceeding `maxBytes` with `HttpError(413, "payload_too_large")` before full buffering.
 * - Missing/non-JSON `Content-Type` when `requireJsonContentType` is true with `HttpError(415, "unsupported_media_type")`.
 * - Empty bodies or malformed JSON with `HttpError(400, "invalid_json")`.
 */
export async function readJson<T = unknown>(
  source: Request | Response,
  options?: number | ReadBodyOptions,
): Promise<T> {
  const opts: ReadBodyOptions =
    typeof options === "number" ? { maxBytes: options } : (options ?? {});
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;

  if (opts.requireJsonContentType && !isJsonContentType(source.headers.get("content-type"))) {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Expected Content-Type: application/json",
    );
  }

  const text = await readBoundedText(source, maxBytes, opts.signal);
  if (text.trim().length === 0) {
    throw new HttpError(400, "empty_json_body", "JSON request body must not be empty");
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Syntax error";
    throw new HttpError(400, "invalid_json", `Invalid JSON body: ${detail}`);
  }
}

/**
 * Options for `withScopedAbort` and `fetchWithAbort`.
 */
export interface ScopedAbortOptions {
  /**
   * Incoming request whose `.signal` (if enabled via `enable_request_signal`) should
   * cancel the operation on client disconnect.
   */
  request?: Request;
  /**
   * Whether `request.signal` forwarding is enabled (`enable_request_signal` compatibility flag).
   * Defaults to `true`. When `false`, `request.signal` is not attached.
   */
  forwardRequestSignal?: boolean;
  /**
   * Additional upstream `AbortSignal` to link.
   */
  signal?: AbortSignal;
  /**
   * Optional timeout in milliseconds. Scheduled inside the active request context via
   * `setTimeout` and cleared in `finally` so it never fires after completion.
   */
  timeoutMs?: number;
}

/**
 * Runs an async operation with a local `AbortController` that links optional `request.signal`,
 * caller `signal`, and an optional timeout timer, removing all listeners and clearing timers
 * immediately upon completion.
 *
 * Traps 4.2, 4.3, and 4.4 mitigation:
 * - Never calls `AbortSignal.timeout()` at module top level.
 * - Uses a dedicated local `AbortController` rather than passing `request.signal` or
 *   `AbortSignal.timeout()` directly to long-running operations, preventing late aborts
 *   after completion from raising uncaught internal errors in a Durable Object.
 * - Removes abort event listeners and clears timeout timers in `finally`.
 */
export async function withScopedAbort<T>(
  options: ScopedAbortOptions,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let completed = false;
  let timerId: number | null = null;

  const cleanupCallbacks: Array<() => void> = [];

  const triggerAbort = (reason: unknown): void => {
    if (completed || controller.signal.aborted) {
      return;
    }
    controller.abort(reason);
  };

  const attachSignal = (upstream: AbortSignal | undefined): void => {
    if (!upstream) return;
    if (upstream.aborted) {
      triggerAbort(upstream.reason);
      return;
    }
    const onAbort = (): void => {
      triggerAbort(upstream.reason);
    };
    upstream.addEventListener("abort", onAbort, { once: true });
    cleanupCallbacks.push(() => {
      upstream.removeEventListener("abort", onAbort);
    });
  };

  if (options.forwardRequestSignal !== false && options.request) {
    // Access `request.signal` defensively in case compatibility flags vary across environments.
    const reqSignal: AbortSignal | undefined = options.request.signal;
    attachSignal(reqSignal);
  }

  attachSignal(options.signal);

  if (
    options.timeoutMs !== undefined &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0 &&
    !controller.signal.aborted
  ) {
    const ms = options.timeoutMs;
    timerId = setTimeout(() => {
      triggerAbort(new DOMException(`Operation timed out after ${ms}ms`, "TimeoutError"));
    }, ms);
  }

  try {
    return await fn(controller.signal);
  } finally {
    completed = true;
    clearTimeout(timerId);
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
  }
}

/**
 * Performs an outbound `fetch()` guarded by `withScopedAbort`.
 *
 * Requires the `enable_request_signal` compatibility flag for `request.signal` to fire
 * when the downstream client disconnects (Trap 4.2). Cleans up all listeners and timers
 * once the fetch settles (Trap 4.4).
 */
export async function fetchWithAbort(
  input: RequestInfo | URL,
  init?: RequestInit,
  abortOptions?: ScopedAbortOptions,
): Promise<Response> {
  const mergedOptions: ScopedAbortOptions = {
    ...abortOptions,
    ...(init?.signal ? { signal: init.signal } : {}),
  };

  return withScopedAbort(mergedOptions, (signal) =>
    fetch(input, {
      ...init,
      signal,
    }),
  );
}

/**
 * Safely reads Cloudflare request metadata (`request.cf`), which may be `undefined` or
 * partial in `wrangler dev`, Miniflare, or synthetic test requests (Trap 4.6).
 */
export interface SafeCfMetadata {
  colo: string | null;
  country: string | null;
  asn: number | null;
  httpProtocol: string | null;
  tlsVersion: string | null;
}

export function getSafeCfMetadata(request: Request): SafeCfMetadata {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf;
  if (!cf || typeof cf !== "object") {
    return {
      colo: null,
      country: null,
      asn: null,
      httpProtocol: null,
      tlsVersion: null,
    };
  }
  return {
    colo: typeof cf["colo"] === "string" ? cf["colo"] : null,
    country: typeof cf["country"] === "string" ? cf["country"] : null,
    asn: typeof cf["asn"] === "number" ? cf["asn"] : null,
    httpProtocol: typeof cf["httpProtocol"] === "string" ? cf["httpProtocol"] : null,
    tlsVersion: typeof cf["tlsVersion"] === "string" ? cf["tlsVersion"] : null,
  };
}

/**
 * Parses and clamps a cursor pagination `limit` query parameter to `[1, maxLimit]` (default 100).
 * Per README §Files and Limits: "Lists use primary-key cursors, omit BLOBs, and clamp page limits to 1–100."
 */
export function clampPageLimit(
  rawLimit: string | number | null | undefined,
  defaultLimit = 50,
  minLimit = 1,
  maxLimit = 100,
): number {
  if (rawLimit === null || rawLimit === undefined || rawLimit === "") {
    return Math.min(Math.max(defaultLimit, minLimit), maxLimit);
  }
  const parsed = typeof rawLimit === "number" ? rawLimit : Number(rawLimit);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, "invalid_limit", "Query parameter 'limit' must be a valid number");
  }
  const truncated = Math.trunc(parsed);
  return Math.min(Math.max(truncated, minLimit), maxLimit);
}

/**
 * Extracts the normalized hostname (lowercased, without port) from a `Request` URL.
 * Never compares against hardcoded domain names; callers compare against `env.HOOKS_HOST`.
 */
export function getRequestHostname(request: Request): string {
  const url = new URL(request.url);
  return url.hostname.toLowerCase();
}
