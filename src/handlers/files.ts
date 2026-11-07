/**
 * Files handler (`src/handlers/files.ts`) — attachment submission and catalogue reads.
 *
 * Owns no durable state. A upload is bounded, hashed over the exact received bytes,
 * deduplicated against the live catalogue, recorded as a durable upload intent, and
 * only then forwarded to the OpenAI Files API. Source bytes are never persisted and
 * this handler never writes job execution state.
 *
 * Routes (exactly):
 * - `POST /api/files` multipart/form-data field `file` (+ optional `turnIndex`)
 * - `GET /api/files/:fileId`
 */

import { MAX_FILE_UPLOAD_BYTES, REGISTRY_DO_NAME } from "../constants.ts";
import {
  HttpError,
  forbidden,
  getRequestHostname,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readBoundedBytes,
  toErrorResponse,
} from "../http.ts";
import { now } from "../lib/clock.ts";
import {
  ArtifactGuardError,
  assertFileUploadSize,
  assertTurnIndex,
} from "../lib/guards.ts";
import { resolveEnvSecret, uploadUserDataFile } from "../lib/openai.ts";
import type {
  FileCatalogueRecord,
  FileId,
  FileUploadIntentRecord,
  FileUploadResult,
} from "../types.ts";

/**
 * Multipart envelope allowance: boundaries, part headers, and small text fields.
 * File bytes stay exactly bounded by `MAX_FILE_UPLOAD_BYTES`; this allowance only
 * keeps a valid boundary-size file from failing the pre-parse `Content-Length` check.
 */
const MULTIPART_ENVELOPE_BYTES = 64 * 1024;

/**
 * Lifetime of a durable upload intent. Pending intents past this instant are eligible
 * for RegistryDO expiry cleanup when the provider upload never completed.
 */
const UPLOAD_INTENT_TTL_MS = 15 * 60 * 1000;

/** Form fields that would smuggle inline content instead of a Files API upload. */
const UNSUPPORTED_INLINE_FIELDS: Readonly<Record<string, true>> = {
  file_url: true,
  fileurl: true,
  base64: true,
  inline: true,
  inline_text: true,
  inlinetext: true,
  text: true,
  content: true,
  data: true,
};

type RejectedCode = Extract<FileUploadResult, { readonly kind: "rejected" }>["code"];

/** A contract-level upload rejection rendered as the `rejected` `FileUploadResult`. */
interface UploadRejection {
  readonly rejected: true;
  readonly code: RejectedCode;
  readonly message: string;
  readonly status: number;
}

/** Validated single-file multipart payload. */
interface ParsedUpload {
  readonly file: File;
}

/** The subset of the RegistryDO binding RPC this handler calls. */
interface RegistryStub {
  findFileByHash(sha256: string): Promise<FileCatalogueRecord | null>;
  beginUploadIntent(input: {
    readonly intentId: string;
    readonly sha256: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly expiresAtMs: number;
  }): Promise<FileUploadIntentRecord>;
  recordFileUpload(input: {
    readonly fileId: FileId;
    readonly sha256: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly byteSize: number;
  }): Promise<FileCatalogueRecord>;
  completeUploadIntent(intentId: string, fileId: FileId): Promise<void>;
  getFile(fileId: FileId): Promise<FileCatalogueRecord | null>;
}

function rejection(code: RejectedCode, message: string, status: number): UploadRejection {
  return { rejected: true, code, message, status };
}

function invalidMultipart(message = "Invalid multipart upload"): UploadRejection {
  return rejection("invalid_multipart", message, 400);
}

function unsupportedInput(): UploadRejection {
  return rejection(
    "unsupported_input",
    "Inline file text, base64 attachments, and file_url are not accepted; upload bytes with multipart/form-data",
    415,
  );
}

function fileTooLarge(): UploadRejection {
  return rejection(
    "file_too_large",
    `File exceeds the ${MAX_FILE_UPLOAD_BYTES}-byte upload limit`,
    413,
  );
}

function providerError(): UploadRejection {
  return rejection("provider_error", "File upload provider call failed", 502);
}

function rejectedResponse(value: UploadRejection): Response {
  const result: FileUploadResult = {
    kind: "rejected",
    code: value.code,
    message: value.message,
  };
  return jsonResponse(result, value.status);
}

function uploadedResponse(file: FileCatalogueRecord, deduplicated: boolean): Response {
  const result: FileUploadResult = { kind: "uploaded", file, deduplicated };
  return jsonResponse(result);
}

/** Resolves the singleton RegistryDO stub through binding RPC. */
function getRegistry(env: Env): RegistryStub {
  const stub = env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME));
  return stub as typeof stub & RegistryStub;
}

/**
 * Enforces a same-application `Origin` on state-changing requests.
 * A missing, unparseable, cross-origin, cross-scheme, or webhook-host origin is rejected.
 */
function hasAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin.length === 0) {
    return false;
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }

  const requestUrl = new URL(request.url);
  if (getRequestHostname(request) === env.HOOKS_HOST.trim().toLowerCase()) {
    return false;
  }
  if (originUrl.protocol !== requestUrl.protocol) {
    return false;
  }
  return originUrl.host.toLowerCase() === requestUrl.host.toLowerCase();
}

function isMultipartFormData(contentType: string | null): contentType is string {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "multipart/form-data";
}

/**
 * Bounds the multipart body before parsing.
 *
 * A declared `Content-Length` is checked against the file bound plus envelope overhead
 * before `formData()` runs. When no length is declared, the body is read with the shared
 * bounded reader and parsed from the buffered copy, so parsing is still bounded.
 */
async function readUploadForm(request: Request): Promise<FormData | UploadRejection> {
  const contentType = request.headers.get("content-type");
  if (!isMultipartFormData(contentType)) {
    return unsupportedInput();
  }

  const contentLength = request.headers.get("content-length");
  const maxEnvelopeBytes = MAX_FILE_UPLOAD_BYTES + MULTIPART_ENVELOPE_BYTES;

  try {
    if (contentLength === null) {
      const buffered = await readBoundedBytes(request, maxEnvelopeBytes);
      if (buffered.byteLength === 0) {
        return invalidMultipart("Multipart body is empty");
      }
      return await new Response(buffered, {
        headers: { "content-type": contentType },
      }).formData();
    }

    const trimmedLength = contentLength.trim();
    if (!/^\d+$/.test(trimmedLength)) {
      return invalidMultipart("Invalid Content-Length header");
    }
    const declaredBytes = Number(trimmedLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      return invalidMultipart("Invalid Content-Length header");
    }
    if (declaredBytes > maxEnvelopeBytes) {
      return fileTooLarge();
    }

    return await request.formData();
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) {
      return fileTooLarge();
    }
    return invalidMultipart("Multipart body could not be parsed");
  }
}

/** Validates the exact multipart contract: one `file` part and an optional `turnIndex`. */
function extractUpload(form: FormData): ParsedUpload | UploadRejection {
  let file: File | null = null;
  let fileParts = 0;
  let rawTurnIndex: string | null = null;
  let turnIndexSeen = false;

  for (const [name, value] of form.entries()) {
    if (name === "file") {
      fileParts += 1;
      if (typeof value === "string") {
        return unsupportedInput();
      }
      file = value;
      continue;
    }

    if (name === "turnIndex") {
      if (turnIndexSeen) {
        return invalidMultipart("Duplicate turnIndex field");
      }
      if (typeof value !== "string") {
        return invalidMultipart("turnIndex must be a single text field");
      }
      turnIndexSeen = true;
      rawTurnIndex = value;
      continue;
    }

    if (UNSUPPORTED_INLINE_FIELDS[name.toLowerCase()] === true) {
      return unsupportedInput();
    }
    return invalidMultipart("Unexpected multipart field");
  }

  if (fileParts === 0 || file === null) {
    return invalidMultipart("Missing file field");
  }
  if (fileParts > 1) {
    return invalidMultipart("Exactly one file field is required");
  }

  if (rawTurnIndex !== null) {
    if (!/^[1-9][0-9]*$/.test(rawTurnIndex)) {
      return invalidMultipart("turnIndex must be a positive integer");
    }
    const parsedTurnIndex = Number(rawTurnIndex);
    if (!Number.isSafeInteger(parsedTurnIndex)) {
      return invalidMultipart("turnIndex must be a positive integer");
    }
    try {
      assertTurnIndex(parsedTurnIndex);
    } catch {
      return invalidMultipart("turnIndex must be a positive integer");
    }
  }

  return { file };
}

/** Reduces a part filename to its basename and strips control characters. */
function sanitizeFilename(rawName: string): string | null {
  const segments = rawName.split(/[\\/]/);
  const basename = segments[segments.length - 1] ?? "";
  const cleaned = basename.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return null;
  }
  return cleaned;
}

/** Uses the declared MIME type, defaulting only when it is absent. */
function sanitizeMimeType(rawType: string): string {
  const cleaned = rawType.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "application/octet-stream";
}

/** Lowercase SHA-256 hex over the exact buffered bytes (never a re-encoded string). */
async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const digestBytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of digestBytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!hasAllowedOrigin(request, env)) {
    return forbidden("Request origin is not allowed", "forbidden_origin");
  }

  const form = await readUploadForm(request);
  if (!(form instanceof FormData)) {
    return rejectedResponse(form);
  }

  const parsed = extractUpload(form);
  if ("rejected" in parsed) {
    return rejectedResponse(parsed);
  }

  const filename = sanitizeFilename(parsed.file.name);
  if (filename === null) {
    return rejectedResponse(invalidMultipart("File part requires a usable filename"));
  }
  const mimeType = sanitizeMimeType(parsed.file.type);

  try {
    assertFileUploadSize(parsed.file.size);
  } catch (err) {
    if (err instanceof ArtifactGuardError) {
      return rejectedResponse(fileTooLarge());
    }
    throw err;
  }

  let fileBytes: Uint8Array | null;
  try {
    fileBytes = new Uint8Array(await parsed.file.arrayBuffer());
  } catch {
    return rejectedResponse(invalidMultipart("File part could not be read"));
  }

  let byteSize: number;
  try {
    byteSize = assertFileUploadSize(fileBytes.byteLength);
  } catch (err) {
    if (err instanceof ArtifactGuardError) {
      return rejectedResponse(fileTooLarge());
    }
    throw err;
  }

  const sha256Hex = await sha256HexOf(fileBytes);

  const registry = getRegistry(env);
  const liveBeforeUpload = await registry.findFileByHash(sha256Hex);
  if (liveBeforeUpload !== null) {
    return uploadedResponse(liveBeforeUpload, true);
  }

  const intentId = crypto.randomUUID();
  await registry.beginUploadIntent({
    intentId,
    sha256: sha256Hex,
    filename,
    mimeType,
    byteSize,
    expiresAtMs: now() + UPLOAD_INTENT_TTL_MS,
  });

  const apiKey = resolveEnvSecret(env, "OPENAI_API_KEY");
  let providerFileId: FileId;
  try {
    const uploaded = await uploadUserDataFile({ apiKey, filename, mimeType, bytes: fileBytes });
    providerFileId = uploaded.fileId;
  } catch (err) {
    if (err instanceof ArtifactGuardError) {
      throw err;
    }
    return rejectedResponse(providerError());
  } finally {
    // Drop the handler's reference to the source bytes once the provider call settles.
    fileBytes = null;
  }

  // Concurrent duplicate: the hash may have become live while the provider call ran.
  // Converge on the existing catalogue row and complete this path's intent against it.
  const liveAfterUpload = await registry.findFileByHash(sha256Hex);
  if (liveAfterUpload !== null) {
    await registry.completeUploadIntent(intentId, liveAfterUpload.fileId);
    return uploadedResponse(liveAfterUpload, true);
  }

  const record = await registry.recordFileUpload({
    fileId: providerFileId,
    sha256: sha256Hex,
    filename,
    mimeType,
    byteSize,
  });
  await registry.completeUploadIntent(intentId, record.fileId);
  return uploadedResponse(record, record.fileId !== providerFileId);
}

async function handleCatalogueRead(env: Env, rawFileId: string): Promise<Response> {
  let fileId: string;
  try {
    fileId = decodeURIComponent(rawFileId);
  } catch {
    return notFound("File not found");
  }
  if (fileId.length === 0 || fileId.includes("/")) {
    return notFound("File not found");
  }

  const file = await getRegistry(env).getFile(fileId);
  if (file === null) {
    return notFound("File not found");
  }
  return jsonResponse(file);
}

/**
 * Routes the Files surface. Only `POST /api/files` and `GET /api/files/:fileId` exist;
 * every other path is `404 not_found`.
 */
export async function handleFilesRequest(request: Request, env: Env): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/api/files") {
      if (request.method !== "POST") {
        return methodNotAllowed(["POST"]);
      }
      return await handleUpload(request, env);
    }

    const filesPrefix = "/api/files/";
    if (pathname.startsWith(filesPrefix)) {
      const rawFileId = pathname.slice(filesPrefix.length);
      if (rawFileId.length === 0 || rawFileId.includes("/")) {
        return notFound("File not found");
      }
      if (request.method !== "GET") {
        return methodNotAllowed(["GET"]);
      }
      return await handleCatalogueRead(env, rawFileId);
    }

    return notFound();
  } catch (err) {
    return toErrorResponse(err);
  }
}