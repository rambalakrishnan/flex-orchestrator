// Covers: provider-text credential redaction (`src/lib/redaction.ts`).

import { describe, expect, it } from "vitest";

import { redactSensitiveText } from "../../src/lib/redaction.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

describe("redactSensitiveText", () => {
  it("replaces exact multi-character secrets everywhere they appear", () => {
    const first = "super-secret-value-123456";
    const second = "another-secret-value-987654";

    expect(
      redactSensitiveText(`first ${first} then ${first} and ${second}`, [first, second]),
    ).toBe("first [redacted] then [redacted] and [redacted]");
  });

  it("leaves secrets shorter than eight characters untouched", () => {
    const shortSecret = "abc123";

    expect(redactSensitiveText(`value ${shortSecret}`, [shortSecret])).toBe(
      `value ${shortSecret}`,
    );
  });

  it("redacts Bearer credentials", () => {
    expect(redactSensitiveText("Authorization: Bearer abcDEF123._~+/=")).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  it("redacts sk-shaped API keys", () => {
    expect(redactSensitiveText("Incorrect API key provided: sk-super-secret")).toBe(
      "Incorrect API key provided: [redacted]",
    );
  });

  it("redacts JWTs", () => {
    expect(redactSensitiveText(`token ${JWT}`)).toBe("token [redacted]");
  });

  it("redacts api_key and token query parameters without touching other parameters", () => {
    expect(redactSensitiveText("https://api.test/v1?api_key=abcdef123456&foo=bar")).toBe(
      "https://api.test/v1?api_key=[redacted]&foo=bar",
    );
    expect(redactSensitiveText("https://api.test/v1?access_token=abcdef123456")).toBe(
      "https://api.test/v1?access_token=[redacted]",
    );
    expect(redactSensitiveText("https://api.test/v1?token=abcdef123456&foo=bar")).toBe(
      "https://api.test/v1?token=[redacted]&foo=bar",
    );
  });

  it("redacts x-api-key header values", () => {
    expect(redactSensitiveText("x-api-key: abcdef123456")).toBe("x-api-key: [redacted]");
    expect(redactSensitiveText('{"x-api-key":"abcdef123456"}')).toBe(
      '{"x-api-key":"[redacted]"}',
    );
  });

  it("is idempotent", () => {
    const secret = "super-secret-value-123456";
    const input = [
      `secret=${secret}`,
      "Authorization: Bearer abcDEF123",
      "key sk-super-secret",
      JWT,
      "https://api.test/v1?api_key=abcdef123456",
      "x-api-key: abcdef123456",
    ].join(" | ");

    const once = redactSensitiveText(input, [secret]);
    expect(once).not.toContain(secret);
    expect(redactSensitiveText(once, [secret])).toBe(once);
  });
});