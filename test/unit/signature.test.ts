// Covers: 18

import { describe, expect, it } from "vitest";

import {
  WEBHOOK_TOLERANCE_SECONDS,
  signWebhookPayload,
  verifyWebhookRequest,
  verifyWebhookSignature,
} from "../../src/lib/signature.ts";
import {
  TEST_TIMESTAMP_SECONDS,
  TEST_WEBHOOK_ID,
  TEST_WEBHOOK_SECRET,
  base64Encode,
  buildSignedRequest,
  signWebhookV1,
  webhookBodyBytes,
} from "../fixtures/webhooks.ts";

const NOW_SECONDS = TEST_TIMESTAMP_SECONDS;
const NOW_MS = NOW_SECONDS * 1000;

const DELIVERY_BODY =
  '{"type":"response.completed","data":{"response_id":"resp_abc123","object":"response"}}';
const DELIVERY_TIMESTAMP = String(NOW_SECONDS - 5);

function canonicalHeaders(values: {
  id?: string;
  timestamp?: string;
  signature?: string;
}): Headers {
  const headers = new Headers();
  if (values.id !== undefined) headers.set("webhook-id", values.id);
  if (values.timestamp !== undefined) {
    headers.set("webhook-timestamp", values.timestamp);
  }
  if (values.signature !== undefined) {
    headers.set("webhook-signature", values.signature);
  }
  return headers;
}

async function deliverySignature(
  overrides: {
    webhookId?: string;
    timestampSeconds?: number;
    rawBody?: string | Uint8Array;
  } = {},
): Promise<string> {
  return await signWebhookV1({
    webhookId: overrides.webhookId ?? TEST_WEBHOOK_ID,
    timestampSeconds: overrides.timestampSeconds ?? NOW_SECONDS - 5,
    rawBody: overrides.rawBody ?? DELIVERY_BODY,
    secret: TEST_WEBHOOK_SECRET,
  });
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("Standard Webhooks baseline", () => {
  it("verifies an intact delivery over the exact raw body bytes", async () => {
    const signature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toEqual({
      ok: true,
      webhookId: TEST_WEBHOOK_ID,
      timestampSeconds: NOW_SECONDS - 5,
    });
  });

  it("accepts raw body bytes that are byte-identical to the signed string", async () => {
    const signature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      bytesOf(DELIVERY_BODY),
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({ ok: true, webhookId: TEST_WEBHOOK_ID });
  });

  it("matches the production signer's signature for the same inputs", async () => {
    const fixtureSignature = await deliverySignature();
    const productionSignature = await signWebhookPayload(
      TEST_WEBHOOK_SECRET,
      TEST_WEBHOOK_ID,
      NOW_SECONDS - 5,
      DELIVERY_BODY,
    );

    expect(fixtureSignature).toBe(productionSignature);
    expect(fixtureSignature.startsWith("v1,")).toBe(true);
  });

  it("verifies header values supplied as a plain record", async () => {
    const signature = await deliverySignature();
    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      {
        "webhook-id": TEST_WEBHOOK_ID,
        "webhook-timestamp": DELIVERY_TIMESTAMP,
        "webhook-signature": signature,
      },
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({ ok: true, webhookId: TEST_WEBHOOK_ID });
  });
});

describe("tampering breaks the concatenated signature", () => {
  it("rejects a body changed by exactly one byte", async () => {
    const signature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature,
    });

    const tamperedBody = bytesOf(DELIVERY_BODY);
    const lastIndex = tamperedBody.byteLength - 1;
    tamperedBody[lastIndex] = (tamperedBody[lastIndex] ?? 0) ^ 0x01;

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      tamperedBody,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "signature_mismatch",
      status: 401,
    });
  });

  it("rejects a timestamp changed within the tolerance window", async () => {
    const signature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: String(NOW_SECONDS - 4),
      signature,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "signature_mismatch",
    });
  });

  it("rejects a timestamp tampered outside the tolerance window", async () => {
    const signature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: String(NOW_SECONDS - 400),
      signature,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "timestamp_out_of_range",
      status: 401,
    });
  });

  it("rejects a changed webhook-id while body and timestamp stay untouched", async () => {
    const timestampSeconds = NOW_SECONDS - 5;
    const signature = await deliverySignature({ timestampSeconds });
    const tamperedId = `${TEST_WEBHOOK_ID.slice(0, -1)}0`;
    expect(tamperedId).not.toBe(TEST_WEBHOOK_ID);

    const headers = canonicalHeaders({
      id: tamperedId,
      timestamp: String(timestampSeconds),
      signature,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "signature_mismatch",
      status: 401,
    });
  });

  it("rejects an unparseable timestamp header", async () => {
    const signature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: "not-a-unix-timestamp",
      signature,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_timestamp" });
  });
});

describe("300-second delivery-timestamp tolerance", () => {
  it("accepts a timestamp exactly 300 seconds old", async () => {
    expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    const timestampSeconds = NOW_SECONDS - 300;
    const signature = await deliverySignature({ timestampSeconds });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        id: TEST_WEBHOOK_ID,
        timestamp: String(timestampSeconds),
        signature,
      }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({ ok: true, timestampSeconds });
  });

  it("rejects a timestamp 301 seconds old", async () => {
    const timestampSeconds = NOW_SECONDS - 301;
    const signature = await deliverySignature({ timestampSeconds });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        id: TEST_WEBHOOK_ID,
        timestamp: String(timestampSeconds),
        signature,
      }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "timestamp_out_of_range",
    });
  });

  it("accepts a timestamp exactly 300 seconds in the future and rejects 301", async () => {
    const futureOkSeconds = NOW_SECONDS + 300;
    const futureOkSignature = await deliverySignature({
      timestampSeconds: futureOkSeconds,
    });
    const futureOk = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        id: TEST_WEBHOOK_ID,
        timestamp: String(futureOkSeconds),
        signature: futureOkSignature,
      }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );
    expect(futureOk).toMatchObject({ ok: true, timestampSeconds: futureOkSeconds });

    const futureTooFarSeconds = NOW_SECONDS + 301;
    const futureTooFarSignature = await deliverySignature({
      timestampSeconds: futureTooFarSeconds,
    });
    const futureTooFar = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        id: TEST_WEBHOOK_ID,
        timestamp: String(futureTooFarSeconds),
        signature: futureTooFarSignature,
      }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );
    expect(futureTooFar).toMatchObject({
      ok: false,
      code: "timestamp_out_of_range",
    });
  });
});

describe("raw-byte fidelity", () => {
  const canonicalBody =
    '{"object":"event","type":"response.completed","data":{"response_id":"resp_abc123"}}';
  const reorderedBody =
    '{\n  "data": {\n    "response_id": "resp_abc123"\n  },\n  "type": "response.completed",\n  "object": "event"\n}';

  it("uses identical JSON values but different serialized bytes", () => {
    expect(JSON.parse(canonicalBody)).toEqual(JSON.parse(reorderedBody));
    expect(canonicalBody).not.toBe(reorderedBody);
    expect(canonicalBody.length).not.toBe(reorderedBody.length);
  });

  it("verifies only the byte-identical serialization", async () => {
    const signature = await deliverySignature({ rawBody: canonicalBody });
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature,
    });

    const canonicalResult = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      canonicalBody,
      { nowMs: NOW_MS },
    );
    expect(canonicalResult).toMatchObject({ ok: true });

    const reorderedResult = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      reorderedBody,
      { nowMs: NOW_MS },
    );
    expect(reorderedResult).toMatchObject({
      ok: false,
      code: "signature_mismatch",
    });

    const reorderedSignature = await deliverySignature({
      rawBody: reorderedBody,
    });
    const reorderedOwnResult = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        id: TEST_WEBHOOK_ID,
        timestamp: DELIVERY_TIMESTAMP,
        signature: reorderedSignature,
      }),
      webhookBodyBytes(reorderedBody),
      { nowMs: NOW_MS },
    );
    expect(reorderedOwnResult).toMatchObject({ ok: true });
  });
});

describe("malformed signature headers", () => {
  it("rejects a signature value without the v1 version prefix", async () => {
    const signatureBase64 = (await deliverySignature()).slice("v1,".length);
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: signatureBase64,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_signature_format",
      status: 401,
    });
  });

  it("rejects a signature value with only a non-v1 scheme", async () => {
    const signatureBase64 = (await deliverySignature()).slice("v1,".length);
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: `v2,${signatureBase64}`,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_signature_format",
    });
  });

  it("rejects invalid base64 signature material", async () => {
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: "v1,@@@not-base64@@@",
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_signature_format",
    });
  });

  it("rejects an empty v1 signature value", async () => {
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: "v1,",
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "invalid_signature_format",
    });
  });

  it("treats a blank signature header as missing headers", async () => {
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: "",
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "missing_headers",
      status: 401,
    });
  });

  it("distinguishes a well-formed but wrong signature from a malformed one", async () => {
    const zeroSignature = base64Encode(new Uint8Array(32));
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: `v1,${zeroSignature}`,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "signature_mismatch",
    });
  });
});

describe("missing required headers", () => {
  it("rejects a request missing webhook-id", async () => {
    const signature = await deliverySignature();
    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        timestamp: DELIVERY_TIMESTAMP,
        signature,
      }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );
    expect(result).toMatchObject({ ok: false, code: "missing_headers" });
  });

  it("rejects a request missing webhook-timestamp", async () => {
    const signature = await deliverySignature();
    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({ id: TEST_WEBHOOK_ID, signature }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );
    expect(result).toMatchObject({ ok: false, code: "missing_headers" });
  });

  it("rejects a request missing webhook-signature", async () => {
    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      canonicalHeaders({
        id: TEST_WEBHOOK_ID,
        timestamp: DELIVERY_TIMESTAMP,
      }),
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );
    expect(result).toMatchObject({ ok: false, code: "missing_headers" });
  });

  it("rejects an empty header set", async () => {
    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      {},
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );
    expect(result).toMatchObject({
      ok: false,
      code: "missing_headers",
      status: 401,
    });
  });
});

describe("multiple signature schemes in one header", () => {
  it("ignores a valid non-v1 scheme even when the v1 signature is bad", async () => {
    const validSignature = await deliverySignature();
    const validBase64 = validSignature.slice("v1,".length);
    const wrongV1 = `v1,${base64Encode(new Uint8Array(32))}`;
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: `${wrongV1} v2,${validBase64}`,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "signature_mismatch",
    });
  });

  it("passes when a valid v1 is accompanied by an unrelated scheme", async () => {
    const validSignature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: `${validSignature} v2,not-valid-base64!!!`,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({ ok: true, webhookId: TEST_WEBHOOK_ID });
  });

  it("passes when a bad v1 is followed by a good v1 (key rotation)", async () => {
    const validSignature = await deliverySignature();
    const headers = canonicalHeaders({
      id: TEST_WEBHOOK_ID,
      timestamp: DELIVERY_TIMESTAMP,
      signature: `v1,${base64Encode(new Uint8Array(32))} ${validSignature}`,
    });

    const result = await verifyWebhookSignature(
      TEST_WEBHOOK_SECRET,
      headers,
      DELIVERY_BODY,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({ ok: true });
  });
});

describe("request-level verification over exact bytes", () => {
  it("verifies a signed Request and returns the exact bytes that were sent", async () => {
    const timestampSeconds = NOW_SECONDS - 5;
    const signature = await deliverySignature({ timestampSeconds });
    const request = await buildSignedRequest("/openai", {
      webhookId: TEST_WEBHOOK_ID,
      timestampSeconds,
      rawBody: DELIVERY_BODY,
      secret: TEST_WEBHOOK_SECRET,
    });

    expect(request.headers.get("webhook-signature")).toBe(signature);
    expect(request.headers.get("webhook-timestamp")).toBe(
      String(timestampSeconds),
    );

    const probe = request.clone();
    const sentBytes = new Uint8Array(await probe.arrayBuffer());
    expect(sentBytes.byteLength).toBe(bytesOf(DELIVERY_BODY).byteLength);

    const result = await verifyWebhookRequest(request, TEST_WEBHOOK_SECRET, {
      nowMs: NOW_MS,
    });

    if (!result.ok) {
      throw new Error(`expected verification to succeed: ${result.code}`);
    }
    expect(result.webhookId).toBe(TEST_WEBHOOK_ID);
    expect(result.timestampSeconds).toBe(timestampSeconds);
    expect(Array.from(result.rawBody)).toEqual(Array.from(sentBytes));
    expect(result.rawText).toBe(DELIVERY_BODY);
  });

  it("does not mutate the body: verified bytes replay successfully", async () => {
    const timestampSeconds = NOW_SECONDS - 5;
    const rawBytes = bytesOf(DELIVERY_BODY);
    const request = await buildSignedRequest("/openai", {
      webhookId: TEST_WEBHOOK_ID,
      timestampSeconds,
      rawBody: rawBytes,
      secret: TEST_WEBHOOK_SECRET,
    });

    const before = request.clone();
    const sentBytes = new Uint8Array(await before.arrayBuffer());

    const result = await verifyWebhookRequest(request, TEST_WEBHOOK_SECRET, {
      nowMs: NOW_MS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected verification to succeed: ${result.code}`);
    }

    // Verification must hand back the sender's bytes byte-for-byte, not a
    // re-serialized or re-encoded copy.
    expect(Array.from(result.rawBody)).toEqual(Array.from(sentBytes));
    expect(result.rawBody.byteLength).toBe(rawBytes.byteLength);

    // Replaying exactly those bytes under the same headers must verify again.
    const replay = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: result.rawBody,
    });
    const replayResult = await verifyWebhookRequest(
      replay,
      TEST_WEBHOOK_SECRET,
      { nowMs: NOW_MS },
    );
    expect(replayResult).toMatchObject({ ok: true });

    // Header set is untouched by verification.
    expect(request.headers.get("webhook-id")).toBe(TEST_WEBHOOK_ID);
    expect(request.headers.get("webhook-timestamp")).toBe(
      String(timestampSeconds),
    );
  });

  it("rejects a Request whose body was tampered after signing", async () => {
    const timestampSeconds = NOW_SECONDS - 5;
    const signed = await buildSignedRequest("/openai", {
      webhookId: TEST_WEBHOOK_ID,
      timestampSeconds,
      rawBody: DELIVERY_BODY,
      secret: TEST_WEBHOOK_SECRET,
    });

    const tamperedBytes = bytesOf(DELIVERY_BODY);
    tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0x01;
    const tamperedRequest = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: tamperedBytes,
    });

    const result = await verifyWebhookRequest(
      tamperedRequest,
      TEST_WEBHOOK_SECRET,
      { nowMs: NOW_MS },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "signature_mismatch",
      status: 401,
    });
  });
});