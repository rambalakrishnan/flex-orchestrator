/**
 * Signature — Standard Webhooks authentication (`src/lib/signature.ts`).
 *
 * Implements Standard Webhooks (HMAC-SHA256) authentication over exact raw
 * payload bytes with a strict 300-second delivery-timestamp tolerance.
 *
 * Cross-cutting invariants enforced here:
 * - No module-level `CryptoKey` or `Promise<CryptoKey>` caching (DO eviction
 *   and request-context isolation safe; keys are imported per operation).
 * - Raw bytes are authenticated without JSON re-serialization (`TextEncoder` /
 *   `Uint8Array` only; no `Buffer` / `nodejs_compat` requirement).
 * - Bounded raw-body reading prevents unbounded isolate memory consumption.
 * - Constant-time verification via portable `crypto.subtle.verify('HMAC', ...)`
 *   plus a `crypto.subtle.timingSafeEqual` helper with portable constant-time
 *   fallback for non-Workers test runtimes (never `===`).
 */

import { now } from "./clock.ts";

/** Standard Webhooks delivery-timestamp tolerance in seconds (5 minutes). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Secret prefix specified by the Standard Webhooks specification. */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/** Signature version prefix specified by the Standard Webhooks specification. */
export const WEBHOOK_SIGNATURE_VERSION = "v1";

/** Default maximum raw webhook payload size (1,500,000-byte artifact guard). */
export const DEFAULT_MAX_WEBHOOK_BYTES = 1_500_000;

/** Canonical Standard Webhooks HTTP header names. */
export const WEBHOOK_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

/** Structured failure codes for Standard Webhooks verification. */
export type WebhookSignatureErrorCode =
  | "missing_headers"
  | "invalid_id"
  | "invalid_timestamp"
  | "timestamp_out_of_range"
  | "invalid_secret"
  | "invalid_signature_format"
  | "signature_mismatch"
  | "payload_too_large"
  | "body_read_error";

/** Extracted Standard Webhooks headers. */
export interface WebhookHeaders {
  readonly id: string;
  readonly timestamp: string;
  readonly signature: string;
}

/** Options for Standard Webhooks verification. */
export interface VerifyWebhookOptions {
  /**
   * Current Unix timestamp in milliseconds used to validate the delivery window.
   * Defaults to the injectable clock's `now()`.
   */
  readonly nowMs?: number;
  /**
   * Allowed timestamp skew in seconds (both past and future).
   * Defaults to `WEBHOOK_TOLERANCE_SECONDS` (300 seconds).
   */
  readonly toleranceSeconds?: number;
  /**
   * Maximum allowed raw payload size in bytes when reading from a `Request`.
   * Defaults to `DEFAULT_MAX_WEBHOOK_BYTES` (1,500,000 bytes).
   */
  readonly maxBodyBytes?: number;
}

/** Discriminated result of verifying a raw payload against pre-extracted headers. */
export type WebhookVerificationResult =
  | {
      readonly ok: true;
      readonly webhookId: string;
      readonly timestampSeconds: number;
    }
  | {
      readonly ok: false;
      readonly code: WebhookSignatureErrorCode;
      readonly message: string;
      readonly status: 400 | 401 | 413;
    };

/** Discriminated result of reading and verifying a webhook `Request` end-to-end. */
export type WebhookRequestVerificationResult =
  | {
      readonly ok: true;
      readonly webhookId: string;
      readonly timestampSeconds: number;
      readonly rawBody: Uint8Array;
      readonly rawText: string;
    }
  | {
      readonly ok: false;
      readonly code: WebhookSignatureErrorCode;
      readonly message: string;
      readonly status: 400 | 401 | 413;
    };

const sharedTextEncoder = new TextEncoder();
const sharedTextDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

/**
 * Constant-time byte comparison.
 *
 * Uses Cloudflare Workers' synchronous `crypto.subtle.timingSafeEqual` extension
 * when present on the runtime, falling back to a constant-time XOR accumulation
 * on portable Web Crypto runtimes (such as Bun / Node / Deno test runners).
 * Never uses `===` on secret or signature material.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Constant-time UTF-8 string comparison using `TextEncoder` and `timingSafeEqualBytes`.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bytesA = sharedTextEncoder.encode(a);
  const bytesB = sharedTextEncoder.encode(b);
  return timingSafeEqualBytes(bytesA, bytesB);
}

/**
 * Decodes a base64 or base64url string into raw bytes without relying on Node `Buffer`.
 * Returns `null` if the input is empty or not valid base64.
 */
export function decodeBase64(input: string): Uint8Array | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Normalize URL-safe alphabet and restore canonical padding if omitted.
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const mod = normalized.length % 4;
  if (mod === 1) {
    return null;
  }
  const padded =
    mod === 0 ? normalized : normalized + "=".repeat((4 - mod) % 4);

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
    return null;
  }

  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Encodes raw bytes as standard padded base64 without relying on Node `Buffer`.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Decodes a Standard Webhooks signing secret.
 *
 * Strips the standard `whsec_` prefix when present and base64-decodes the secret
 * key material. Returns `null` if the secret is empty or malformed.
 */
export function decodeWebhookSecret(secret: string): Uint8Array | null {
  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const rawBase64 = trimmed.startsWith(WEBHOOK_SECRET_PREFIX)
    ? trimmed.slice(WEBHOOK_SECRET_PREFIX.length)
    : trimmed;
  if (rawBase64.length === 0) {
    return null;
  }
  const decoded = decodeBase64(rawBase64);
  if (decoded === null || decoded.byteLength === 0) {
    return null;
  }
  return decoded;
}

/**
 * Imports a Standard Webhooks secret as a non-extractable HMAC-SHA256 `CryptoKey`.
 *
 * Callers must import per request / verification rather than storing the key
 * at module scope across requests or Durable Object evictions.
 */
export async function importWebhookKey(
  secret: string | Uint8Array,
  usages: readonly ("sign" | "verify")[] = ["verify"],
): Promise<CryptoKey | null> {
  const keyBytes =
    typeof secret === "string" ? decodeWebhookSecret(secret) : secret;
  if (keyBytes === null || keyBytes.byteLength === 0) {
    return null;
  }
  const rawKeyBuffer = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(rawKeyBuffer).set(keyBytes);
  return crypto.subtle.importKey(
    "raw",
    rawKeyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [...usages],
  );
}

/**
 * Extracts `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers
 * from a `Headers` instance or header record.
 */
export function extractWebhookHeaders(
  headers: Headers | Record<string, string | undefined>,
): WebhookHeaders | null {
  const getHeader = (name: string): string | null => {
    if (headers instanceof Headers) {
      return headers.get(name);
    }
    const direct = headers[name] ?? headers[name.toLowerCase()];
    if (typeof direct === "string") {
      return direct;
    }
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name && typeof value === "string") {
        return value;
      }
    }
    return null;
  };

  const id = getHeader(WEBHOOK_HEADERS.id)?.trim() ?? "";
  const timestamp = getHeader(WEBHOOK_HEADERS.timestamp)?.trim() ?? "";
  const signature = getHeader(WEBHOOK_HEADERS.signature)?.trim() ?? "";

  if (id.length === 0 || timestamp.length === 0 || signature.length === 0) {
    return null;
  }

  return { id, timestamp, signature };
}

/**
 * Validates and parses the `webhook-timestamp` header (strict integer Unix seconds)
 * and enforces the allowed delivery tolerance window (default 300 seconds).
 */
export function verifyWebhookTimestamp(
  timestampHeader: string,
  options?: VerifyWebhookOptions,
):
  | { readonly ok: true; readonly timestampSeconds: number }
  | {
      readonly ok: false;
      readonly code: "invalid_timestamp" | "timestamp_out_of_range";
      readonly message: string;
    } {
  const trimmed = timestampHeader.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      code: "invalid_timestamp",
      message: "webhook-timestamp must be an integer Unix epoch in seconds.",
    };
  }

  const timestampSeconds = Number(trimmed);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds <= 0) {
    return {
      ok: false,
      code: "invalid_timestamp",
      message: "webhook-timestamp is not a valid positive safe integer.",
    };
  }

  const nowMs = options?.nowMs ?? now();
  const toleranceSeconds =
    options?.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor(nowMs / 1000);
  const deltaSeconds = Math.abs(nowSeconds - timestampSeconds);

  if (deltaSeconds > toleranceSeconds) {
    return {
      ok: false,
      code: "timestamp_out_of_range",
      message: `webhook-timestamp (${timestampSeconds}) is outside the ${toleranceSeconds}-second tolerance window.`,
    };
  }

  return { ok: true, timestampSeconds };
}

/**
 * Parses a Standard Webhooks `webhook-signature` header value (space-delimited
 * `<version>,<base64>` tokens, e.g. `"v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE="`)
 * and returns all valid decoded `v1` signature byte arrays.
 */
export function parseWebhookSignatures(signatureHeader: string): Uint8Array[] {
  const trimmed = signatureHeader.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const candidates: Uint8Array[] = [];
  const tokens = trimmed.split(/\s+/);
  for (const token of tokens) {
    const commaIndex = token.indexOf(",");
    if (commaIndex <= 0 || commaIndex === token.length - 1) {
      continue;
    }
    const version = token.slice(0, commaIndex);
    const encodedSig = token.slice(commaIndex + 1);
    if (version !== WEBHOOK_SIGNATURE_VERSION) {
      continue;
    }
    const decoded = decodeBase64(encodedSig);
    if (decoded !== null && decoded.byteLength > 0) {
      candidates.push(decoded);
    }
  }

  return candidates;
}

/**
 * Constructs the exact Standard Webhooks signed message buffer:
 * `${webhookId}.${webhookTimestamp}.` followed immediately by the unmodified
 * raw body bytes (without re-serializing JSON or re-encoding binary payloads).
 */
export function buildSignedPayloadBytes(
  webhookId: string,
  webhookTimestamp: string,
  rawBody: Uint8Array | ArrayBuffer | string,
): ArrayBuffer {
  const prefixBytes = sharedTextEncoder.encode(
    `${webhookId}.${webhookTimestamp}.`,
  );
  const bodyBytes =
    typeof rawBody === "string"
      ? sharedTextEncoder.encode(rawBody)
      : rawBody instanceof Uint8Array
        ? rawBody
        : new Uint8Array(rawBody);

  const combined = new ArrayBuffer(prefixBytes.byteLength + bodyBytes.byteLength);
  const view = new Uint8Array(combined);
  view.set(prefixBytes, 0);
  view.set(bodyBytes, prefixBytes.byteLength);
  return combined;
}

/**
 * Computes a Standard Webhooks `v1,<base64>` signature header value over exact
 * raw bytes. Useful for signing outbound payloads or constructing verified test
 * fixtures.
 */
export async function signWebhookPayload(
  secret: string | Uint8Array,
  webhookId: string,
  webhookTimestamp: string | number,
  rawBody: Uint8Array | ArrayBuffer | string,
): Promise<string> {
  const key = await importWebhookKey(secret, ["sign"]);
  if (key === null) {
    throw new Error("Invalid Standard Webhooks signing secret.");
  }
  const timestampStr = String(webhookTimestamp);
  const signedPayload = buildSignedPayloadBytes(
    webhookId,
    timestampStr,
    rawBody,
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, signedPayload);
  const signatureBase64 = encodeBase64(new Uint8Array(signatureBuffer));
  return `${WEBHOOK_SIGNATURE_VERSION},${signatureBase64}`;
}

/**
 * Verifies a Standard Webhooks delivery given the raw body bytes and headers.
 *
 * Authenticates exact raw bytes (`${id}.${timestamp}.` + rawBody), enforces the
 * 300-second delivery-timestamp tolerance, and verifies candidate `v1` signatures
 * using Web Crypto `crypto.subtle.verify('HMAC', ...)` (timing-safe by spec and
 * portable across Cloudflare Workers, Bun, Node, and Deno).
 */
export async function verifyWebhookSignature(
  secret: string | Uint8Array,
  headersInput: WebhookHeaders | Headers | Record<string, string | undefined>,
  rawBody: Uint8Array | ArrayBuffer | string,
  options?: VerifyWebhookOptions,
): Promise<WebhookVerificationResult> {
  const headers: WebhookHeaders | null =
    headersInput instanceof Headers ||
    !("id" in headersInput) ||
    typeof headersInput.id !== "string" ||
    typeof headersInput.timestamp !== "string" ||
    typeof headersInput.signature !== "string"
      ? extractWebhookHeaders(
          headersInput as Headers | Record<string, string | undefined>,
        )
      : {
          id: headersInput.id.trim(),
          timestamp: headersInput.timestamp.trim(),
          signature: headersInput.signature.trim(),
        };

  if (
    headers === null ||
    headers.id.length === 0 ||
    headers.timestamp.length === 0 ||
    headers.signature.length === 0
  ) {
    return {
      ok: false,
      code: "missing_headers",
      message:
        "Missing required Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature).",
      status: 401,
    };
  }

  if (/[\r\n.]/.test(headers.id)) {
    return {
      ok: false,
      code: "invalid_id",
      message: "webhook-id contains invalid characters.",
      status: 401,
    };
  }

  const timestampCheck = verifyWebhookTimestamp(headers.timestamp, options);
  if (!timestampCheck.ok) {
    return {
      ok: false,
      code: timestampCheck.code,
      message: timestampCheck.message,
      status: 401,
    };
  }

  const candidateSignatures = parseWebhookSignatures(headers.signature);
  if (candidateSignatures.length === 0) {
    return {
      ok: false,
      code: "invalid_signature_format",
      message: "No valid v1 signature found in webhook-signature header.",
      status: 401,
    };
  }

  const key = await importWebhookKey(secret, ["verify"]);
  if (key === null) {
    return {
      ok: false,
      code: "invalid_secret",
      message: "Webhook signing secret is missing or malformed.",
      status: 401,
    };
  }

  const signedPayload = buildSignedPayloadBytes(
    headers.id,
    headers.timestamp,
    rawBody,
  );

  // Evaluate every v1 candidate without short-circuiting early to avoid
  // leaking which signature slot matched in multi-key rotation scenarios.
  let matched = false;
  for (const sigBytes of candidateSignatures) {
    const sigBuffer = new ArrayBuffer(sigBytes.byteLength);
    new Uint8Array(sigBuffer).set(sigBytes);
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBuffer,
      signedPayload,
    );
    if (verified) {
      matched = true;
    }
  }

  if (!matched) {
    return {
      ok: false,
      code: "signature_mismatch",
      message: "Webhook signature verification failed.",
      status: 401,
    };
  }

  return {
    ok: true,
    webhookId: headers.id,
    timestampSeconds: timestampCheck.timestampSeconds,
  };
}

/**
 * Reads the request body into a single `Uint8Array` with a strict byte bound so
 * oversized payloads cannot exhaust the shared 128 MB isolate memory limit.
 */
export async function readBoundedRawBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_WEBHOOK_BYTES,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly code: "payload_too_large" | "body_read_error";
      readonly message: string;
      readonly status: 400 | 413;
    }
> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader.trim())) {
    const declaredBytes = Number(contentLengthHeader.trim());
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
      return {
        ok: false,
        code: "payload_too_large",
        message: `Webhook body exceeds maximum allowed size of ${maxBytes} bytes.`,
        status: 413,
      };
    }
  }

  if (request.body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined && value.byteLength > 0) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel("Webhook payload exceeded byte limit.").catch(
            () => undefined,
          );
          return {
            ok: false,
            code: "payload_too_large",
            message: `Webhook body exceeds maximum allowed size of ${maxBytes} bytes.`,
            status: 413,
          };
        }
        chunks.push(value);
      }
    }
  } catch {
    return {
      ok: false,
      code: "body_read_error",
      message: "Failed to read webhook request body.",
      status: 400,
    };
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) {
    return { ok: true, bytes: new Uint8Array(0) };
  }
  if (chunks.length === 1 && chunks[0] !== undefined) {
    return { ok: true, bytes: chunks[0] };
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: combined };
}

/**
 * Verifies an incoming webhook `Request` end-to-end:
 * 1. Validates headers and the 300-second delivery-timestamp window before
 *    buffering the body.
 * 2. Reads the exact raw request bytes with a strict byte bound (default 1.5 MB).
 * 3. Authenticates the raw bytes via HMAC-SHA256 (`crypto.subtle.verify`).
 * 4. Returns the verified webhook ID, timestamp, exact `rawBody` bytes, and
 *    UTF-8 decoded `rawText`.
 */
export async function verifyWebhookRequest(
  request: Request,
  secret: string | Uint8Array,
  options?: VerifyWebhookOptions,
): Promise<WebhookRequestVerificationResult> {
  const headers = extractWebhookHeaders(request.headers);
  if (headers === null) {
    return {
      ok: false,
      code: "missing_headers",
      message:
        "Missing required Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature).",
      status: 401,
    };
  }

  if (/[\r\n.]/.test(headers.id)) {
    return {
      ok: false,
      code: "invalid_id",
      message: "webhook-id contains invalid characters.",
      status: 401,
    };
  }

  // Reject stale/invalid timestamps and malformed signature headers before buffering body bytes.
  const timestampCheck = verifyWebhookTimestamp(headers.timestamp, options);
  if (!timestampCheck.ok) {
    return {
      ok: false,
      code: timestampCheck.code,
      message: timestampCheck.message,
      status: 401,
    };
  }

  if (parseWebhookSignatures(headers.signature).length === 0) {
    return {
      ok: false,
      code: "invalid_signature_format",
      message: "No valid v1 signature found in webhook-signature header.",
      status: 401,
    };
  }

  const maxBytes = options?.maxBodyBytes ?? DEFAULT_MAX_WEBHOOK_BYTES;
  const bodyResult = await readBoundedRawBody(request, maxBytes);
  if (!bodyResult.ok) {
    return bodyResult;
  }

  const verification = await verifyWebhookSignature(
    secret,
    headers,
    bodyResult.bytes,
    options,
  );
  if (!verification.ok) {
    return verification;
  }

  return {
    ok: true,
    webhookId: verification.webhookId,
    timestampSeconds: verification.timestampSeconds,
    rawBody: bodyResult.bytes,
    rawText: sharedTextDecoder.decode(bodyResult.bytes),
  };
}
