// Covers: 18

import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { ROUTER_DO_NAME } from "../../src/constants.ts";
import { buildWebhookHeaders } from "../fixtures/webhooks.ts";

// cloudflare:workers does not model the test worker's default export in this typing context.
const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;

const HOOKS_URL = "https://hooks.test/openai";

interface AcceptedReceipt {
  readonly kind: "accepted";
  readonly webhookId: string;
  readonly duplicate: boolean;
  readonly matchedJobId: string | null;
}

interface RejectedReceipt {
  readonly kind: "rejected";
  readonly statusCode: number;
  readonly message: string;
}

let sequence = 0;

function nextIds(prefix: string): {
  readonly webhookId: string;
  readonly responseId: string;
  readonly eventId: string;
} {
  sequence += 1;
  return {
    webhookId: `wh-${prefix}-${sequence}`,
    responseId: `resp-${prefix}-${sequence}`,
    eventId: `evt-${prefix}-${sequence}`,
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function eventBytes(eventId: string, responseId: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      id: eventId,
      type: "response.completed",
      data: { id: responseId },
    }),
  );
}

async function signedHeaders(
  webhookId: string,
  timestampSeconds: number,
  rawBody: Uint8Array,
): Promise<Headers> {
  return buildWebhookHeaders({
    webhookId,
    timestampSeconds,
    rawBody,
    secret: env.OPENAI_WEBHOOK_SECRET,
  });
}

async function postRaw(
  rawBody: Uint8Array,
  headers: Headers,
): Promise<{ readonly response: Response; readonly receipt: AcceptedReceipt | RejectedReceipt }> {
  const response = await mainWorker.fetch(HOOKS_URL, {
    method: "POST",
    headers,
    body: rawBody,
  });
  const receipt = (await response.json()) as AcceptedReceipt | RejectedReceipt;
  return { response, receipt };
}

async function postSigned(
  webhookId: string,
  timestampSeconds: number,
  rawBody: Uint8Array,
): Promise<{ readonly response: Response; readonly receipt: AcceptedReceipt | RejectedReceipt }> {
  return postRaw(rawBody, await signedHeaders(webhookId, timestampSeconds, rawBody));
}

async function readInbox(webhookId: string): Promise<{
  readonly summary: { readonly status: string; readonly job_id: string | null } | null;
  readonly stored: number[] | null;
}> {
  const stub = env.ROUTER_DO.get(env.ROUTER_DO.idFromName(ROUTER_DO_NAME));
  return runInDurableObject(stub, async (_instance, state) => {
    const summaryRows = state.storage.sql
      .exec<{ status: string; job_id: string | null }>(
        "SELECT status, job_id FROM webhook_inbox WHERE webhook_id = ?",
        webhookId,
      )
      .toArray();
    const summary = summaryRows[0] ?? null;
    const blobRows = state.storage.sql
      .exec<{ raw_body_blob: ArrayBuffer | Uint8Array }>(
        "SELECT raw_body_blob FROM webhook_inbox WHERE webhook_id = ?",
        webhookId,
      )
      .toArray();
    const raw = blobRows[0]?.raw_body_blob ?? null;
    return {
      summary,
      stored:
        raw === null
          ? null
          : Array.from(raw instanceof Uint8Array ? raw : new Uint8Array(raw)),
    };
  });
}

function expectRejected(response: Response, receipt: AcceptedReceipt | RejectedReceipt): void {
  expect([401, 403]).toContain(response.status);
  expect(receipt.kind).toBe("rejected");
}

afterEach(async () => {
  // Unmatched deliveries schedule no alarm, but clear any pending RouterDO
  // alarm before wiping storage so nothing bleeds into the next test.
  const stub = env.ROUTER_DO.get(env.ROUTER_DO.idFromName(ROUTER_DO_NAME));
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  await reset();
  await abortAllDurableObjects();
});

describe("webhook ingress signature concatenation", () => {
  it("accepts a baseline valid delivery and durably stores its exact bytes", async () => {
    const ids = nextIds("baseline");
    const body = eventBytes(ids.eventId, ids.responseId);

    const { response, receipt } = await postSigned(ids.webhookId, nowSeconds(), body);

    expect(response.status).toBe(200);
    expect(receipt).toEqual({
      kind: "accepted",
      webhookId: ids.webhookId,
      duplicate: false,
      matchedJobId: null,
    });

    const inbox = await readInbox(ids.webhookId);
    expect(inbox.summary).toMatchObject({ status: "unmatched", job_id: null });
    expect(inbox.stored).toEqual(Array.from(body));
  });

  it("rejects a body-tampered delivery and stores nothing", async () => {
    const ids = nextIds("body-tamper");
    const body = eventBytes(ids.eventId, ids.responseId);
    const headers = await signedHeaders(ids.webhookId, nowSeconds(), body);

    const tampered = new Uint8Array(body);
    const firstByte = tampered[0];
    if (firstByte === undefined) {
      throw new Error("Test event body must be non-empty.");
    }
    tampered[0] = firstByte ^ 0x01;

    const tamperedResult = await postRaw(tampered, headers);
    expectRejected(tamperedResult.response, tamperedResult.receipt);

    // The tampered delivery stored nothing: retrying the same webhook-id with
    // the originally signed bytes is accepted as a first (non-duplicate) delivery.
    const retryResult = await postRaw(body, headers);
    expect(retryResult.response.status).toBe(200);
    expect(retryResult.receipt).toEqual({
      kind: "accepted",
      webhookId: ids.webhookId,
      duplicate: false,
      matchedJobId: null,
    });
  });

  it("rejects a timestamp-tampered delivery", async () => {
    const ids = nextIds("timestamp-tamper");
    const timestampSeconds = nowSeconds();
    const body = eventBytes(ids.eventId, ids.responseId);
    const headers = await signedHeaders(ids.webhookId, timestampSeconds, body);

    // Valid signature for a different timestamp: shift the header 60s forward
    // (still inside the tolerance window, so only the signature can fail).
    const shifted = new Headers(headers);
    shifted.set("webhook-timestamp", String(timestampSeconds + 60));

    const { response, receipt } = await postRaw(body, shifted);
    expectRejected(response, receipt);

    const inbox = await readInbox(ids.webhookId);
    expect(inbox.summary).toBeNull();
    expect(inbox.stored).toBeNull();
  });

  it("rejects a webhook-id-tampered delivery", async () => {
    const ids = nextIds("id-tamper");
    const body = eventBytes(ids.eventId, ids.responseId);
    const headers = await signedHeaders(ids.webhookId, nowSeconds(), body);

    // Body and timestamp unchanged, webhook-id changed: catches a verifier
    // that fails to concatenate the delivery id into the signed string.
    const renamed = new Headers(headers);
    renamed.set("webhook-id", `${ids.webhookId}-renamed`);

    const { response, receipt } = await postRaw(body, renamed);
    expectRejected(response, receipt);

    const inbox = await readInbox(ids.webhookId);
    expect(inbox.summary).toBeNull();
    const renamedInbox = await readInbox(`${ids.webhookId}-renamed`);
    expect(renamedInbox.summary).toBeNull();
  });

  it("rejects a stale delivery older than 300 seconds", async () => {
    const ids = nextIds("stale");
    const body = eventBytes(ids.eventId, ids.responseId);

    const { response, receipt } = await postSigned(ids.webhookId, nowSeconds() - 600, body);
    expectRejected(response, receipt);

    const inbox = await readInbox(ids.webhookId);
    expect(inbox.summary).toBeNull();
    expect(inbox.stored).toBeNull();
  });

  it("verifies byte-identical-but-reserialized bodies against their exact raw bytes", async () => {
    const ids = nextIds("reserialized");
    const payload = {
      id: ids.eventId,
      type: "response.completed",
      data: { id: ids.responseId },
    };
    const compact = new TextEncoder().encode(JSON.stringify(payload));
    const pretty = new TextEncoder().encode(JSON.stringify(payload, null, 2));

    // Same parsed JSON, different serializations: proves the hash covers raw bytes.
    expect(Array.from(pretty)).not.toEqual(Array.from(compact));
    expect(JSON.parse(new TextDecoder().decode(pretty))).toEqual(payload);

    const timestampSeconds = nowSeconds();
    const compactHeaders = await signedHeaders(ids.webhookId, timestampSeconds, compact);

    // Reserialized bytes under the compact signature fail: only exact raw bytes verify.
    const crossResult = await postRaw(pretty, compactHeaders);
    expectRejected(crossResult.response, crossResult.receipt);

    // The exact signed bytes still verify afterwards (nothing was stored by the reject).
    const compactResult = await postRaw(compact, compactHeaders);
    expect(compactResult.response.status).toBe(200);
    expect(compactResult.receipt.kind).toBe("accepted");

    // The reserialized form verifies when signed as its own exact bytes.
    const prettyIds = nextIds("reserialized-pretty");
    const prettyResult = await postSigned(prettyIds.webhookId, nowSeconds(), pretty);
    expect(prettyResult.response.status).toBe(200);
    expect(prettyResult.receipt.kind).toBe("accepted");

    const storedCompact = await readInbox(ids.webhookId);
    expect(storedCompact.stored).toEqual(Array.from(compact));
    const storedPretty = await readInbox(prettyIds.webhookId);
    expect(storedPretty.stored).toEqual(Array.from(pretty));
  });
});
