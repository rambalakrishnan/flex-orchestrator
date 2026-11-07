// Standard Webhooks signing fixtures for signature and webhook-ingress tests.
//
// This fixture independently re-implements the Standard Webhooks signing
// concatenation (`${webhookId}.${timestampSeconds}.` + raw body bytes) with
// WebCrypto, so `src/lib/signature.ts` is checked against real HMAC-SHA256
// signature math instead of against itself. Raw bodies are always converted to
// bytes once, signed as those bytes, and handed to `Request` as those same
// bytes — no JSON re-serialization happens anywhere in this fixture.

/** Deterministic Standard Webhooks secret (`whsec_` + base64 key material). */
export const TEST_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

/** Deterministic webhook delivery ID used by signature fixtures. */
export const TEST_WEBHOOK_ID = "msg_2b1f4f9a6c7d4e0f";

/** Deterministic delivery timestamp (Unix seconds) used by signature fixtures. */
export const TEST_TIMESTAMP_SECONDS = 1_800_000_000;

/** Deterministic origin for signed fixture requests. */
export const TEST_WEBHOOK_ORIGIN = "https://hooks.example.com";

/** Raw body input accepted by the signing helpers. */
export type RawBodyInput = string | Uint8Array | ArrayBuffer;

/** Inputs required to compute a Standard Webhooks `v1,<base64>` signature. */
export interface SignWebhookParams {
  readonly webhookId: string;
  readonly timestampSeconds: number;
  readonly rawBody: RawBodyInput;
  /** Defaults to {@link TEST_WEBHOOK_SECRET}. */
  readonly secret?: string | Uint8Array;
}

/** Inputs for {@link buildWebhookHeaders} / {@link buildSignedRequest}. */
export interface SignedWebhookInput extends SignWebhookParams {
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly method?: string;
}

/** Inputs for {@link buildSignedRequest}. */
export interface SignedWebhookRequestInput extends SignedWebhookInput {
  /** Absolute or origin-relative request path; defaults to `/openai`. */
  readonly path?: string;
}

const encoder = new TextEncoder();

/** Converts a raw body input to the exact bytes that must be signed. */
export function webhookBodyBytes(rawBody: RawBodyInput): Uint8Array {
  if (typeof rawBody === "string") {
    return encoder.encode(rawBody);
  }
  if (rawBody instanceof Uint8Array) {
    return rawBody;
  }
  return new Uint8Array(rawBody);
}

/** Strips the `whsec_` prefix and decodes the Standard Webhooks key material. */
export function webhookSecretBytes(
  secret: string | Uint8Array = TEST_WEBHOOK_SECRET,
): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.byteLength === 0) {
      throw new Error("Webhook secret must not be empty.");
    }
    return secret;
  }

  const trimmed = secret.trim();
  const encoded = trimmed.startsWith("whsec_")
    ? trimmed.slice("whsec_".length)
    : trimmed;
  if (encoded.length === 0) {
    throw new Error("Webhook secret must not be empty.");
  }

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Standard padded base64 encoding without Node `Buffer`. */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

/**
 * Computes the Standard Webhooks `v1,<base64(HMAC-SHA256)>` signature value over
 * the exact UTF-8 bytes of `${webhookId}.${timestampSeconds}.` + raw body bytes.
 */
export async function signWebhookV1(
  params: SignWebhookParams,
): Promise<string> {
  const keyBytes = webhookSecretBytes(params.secret);
  const keyData = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyData).set(keyBytes);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const prefixBytes = encoder.encode(
    `${params.webhookId}.${params.timestampSeconds}.`,
  );
  const bodyBytes = webhookBodyBytes(params.rawBody);
  const signedBytes = new Uint8Array(
    prefixBytes.byteLength + bodyBytes.byteLength,
  );
  signedBytes.set(prefixBytes, 0);
  signedBytes.set(bodyBytes, prefixBytes.byteLength);

  const signature = await crypto.subtle.sign("HMAC", key, signedBytes);
  return `v1,${base64Encode(new Uint8Array(signature))}`;
}

/**
 * Builds `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers for
 * the supplied raw body (the signature always covers the exact body bytes).
 */
export async function buildWebhookHeaders(
  params: SignedWebhookInput,
): Promise<Headers> {
  const headers = new Headers(params.extraHeaders ?? {});
  headers.set("webhook-id", params.webhookId);
  headers.set("webhook-timestamp", String(params.timestampSeconds));
  headers.set("webhook-signature", await signWebhookV1(params));
  return headers;
}

/**
 * Builds a signed webhook `Request` whose body is exactly the raw bytes that
 * were signed. `path` defaults to `/openai` on {@link TEST_WEBHOOK_ORIGIN}.
 */
export async function buildSignedRequest(
  path: string,
  payload: SignedWebhookRequestInput,
): Promise<Request> {
  const targetPath = path.length === 0 ? (payload.path ?? "/openai") : path;
  const url = new URL(targetPath, TEST_WEBHOOK_ORIGIN).toString();

  const bytes = webhookBodyBytes(payload.rawBody);
  const headers = await buildWebhookHeaders(payload);

  return new Request(url, {
    method: payload.method ?? "POST",
    headers,
    body: bytes,
  });
}