/**
 * Bounded credential redaction for provider-controlled error text.
 *
 * Provider error bodies may echo the presented credential. Diagnostics are
 * persisted and exported, so every provider error path redacts exact known
 * secrets plus common bearer/API-key shapes before the text leaves the client
 * library. This is intentionally conservative and idempotent.
 */

const REDACTED = "[redacted]";

/** Replaces exact secret values and common credential shapes in free text. */
export function redactSensitiveText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let text = value;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    text = text.split(secret).join(REDACTED);
  }

  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED)
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      REDACTED,
    )
    .replace(
      /([?&](?:api_?key|access_token|token)=)[^&\s]+/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(["']?x-api-key["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
      `$1${REDACTED}`,
    );
}