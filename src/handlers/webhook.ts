/**
 * Webhook ingress (`src/handlers/webhook.ts`) — authenticated OpenAI webhook route.
 *
 * Owns no storage: it verifies the exact raw request bytes with the Standard
 * Webhooks implementation in `src/lib/signature.ts`, builds a
 * `VerifiedWebhookEvent`, and enqueues it into the global `RouterDO` before
 * acknowledging. It never calls `JobDO`, never mutates job state, and never
 * reads or rewrites the payload after verification.
 */

import { now } from "../lib/clock.ts";
import {
  DEFAULT_MAX_WEBHOOK_BYTES,
  WEBHOOK_TOLERANCE_SECONDS,
  verifyWebhookRequest,
} from "../lib/signature.ts";
import {
  OPENAI_WEBHOOK_EVENT_TYPES,
  ROUTER_DO_NAME,
  WEBHOOK_OPENAI_PATH,
} from "../constants.ts";
import {
  jsonResponse,
  methodNotAllowed,
  notFound,
  toErrorResponse,
} from "../http.ts";
import type { RouterDO } from "../do/router-do.ts";
import type { VerifiedWebhookEvent, WebhookIngressReceipt } from "../types.ts";

/** Subscribed OpenAI webhook event types as accepted by this ingress. */
type SubscribedWebhookEventType = (typeof OPENAI_WEBHOOK_EVENT_TYPES)[number];

/** Rejection receipt returned for signature, size, or payload-shape failures. */
type WebhookRejectionReceipt = Extract<WebhookIngressReceipt, { readonly kind: "rejected" }>;

const subscribedEventTypes: ReadonlySet<string> = new Set(OPENAI_WEBHOOK_EVENT_TYPES);

/**
 * Narrows an untrusted JSON value to one of the subscribed OpenAI event types.
 */
function isSubscribedWebhookEventType(
  value: unknown,
): value is SubscribedWebhookEventType {
  return typeof value === "string" && subscribedEventTypes.has(value);
}

/**
 * Extracts event metadata from an already-verified raw payload.
 *
 * Parsing happens exactly once, after signature verification, and only
 * `type` / `data.id` (plus the required event `id`) are read. The raw bytes
 * handed to the inbox are never rebuilt from this parsed object.
 */
function parseVerifiedPayload(
  rawText: string,
): { readonly eventType: SubscribedWebhookEventType; readonly responseId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  if (!("id" in parsed) || !("type" in parsed) || !("data" in parsed)) {
    return null;
  }

  const eventId = parsed.id;
  if (typeof eventId !== "string" || eventId.length === 0) {
    return null;
  }

  const eventType = parsed.type;
  if (!isSubscribedWebhookEventType(eventType)) {
    return null;
  }

  const data = parsed.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  if (!("id" in data)) {
    return null;
  }

  const responseId = data.id;
  if (typeof responseId !== "string" || responseId.length === 0) {
    return null;
  }

  return { eventType, responseId };
}

/**
 * Builds a rejection receipt response for the webhook route.
 */
function rejectWebhook(
  statusCode: WebhookRejectionReceipt["statusCode"],
  message: string,
): Response {
  const receipt: WebhookRejectionReceipt = {
    kind: "rejected",
    statusCode,
    message,
  };
  return jsonResponse(receipt, statusCode);
}

/**
 * Handles OpenAI webhook deliveries for `POST /openai`.
 *
 * The route accepts only POST on the configured webhook path; verification runs
 * on the exact bounded raw bytes with the 300-second delivery-timestamp
 * tolerance, and the verified event is awaited into `RouterDO` before a 2xx
 * acknowledgement. Duplicates and unmatched responses are accepted by the
 * inbox, which owns deduplication and registration reconciliation.
 */
export function handleWebhookRequest(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== WEBHOOK_OPENAI_PATH) {
    return Promise.resolve(notFound());
  }

  if (request.method !== "POST") {
    return Promise.resolve(methodNotAllowed(["POST"]));
  }

  return handleOpenAiWebhook(request, env);
}

/**
 * Verifies, validates, and durably enqueues one webhook delivery.
 */
async function handleOpenAiWebhook(request: Request, env: Env): Promise<Response> {
  // One injectable clock read drives both the tolerance window and the event's
  // received-at timestamp so tests and production agree exactly.
  const receivedAtMs = now();

  const verification = await verifyWebhookRequest(request, env.OPENAI_WEBHOOK_SECRET, {
    nowMs: receivedAtMs,
    toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
    maxBodyBytes: DEFAULT_MAX_WEBHOOK_BYTES,
  });

  if (!verification.ok) {
    return rejectWebhook(verification.status, verification.message);
  }

  const metadata = parseVerifiedPayload(verification.rawText);
  if (metadata === null) {
    return rejectWebhook(400, "Webhook payload is not a valid subscribed event.");
  }

  // Copy the verified bytes into an exact-length ArrayBuffer for the RPC so the
  // inbox stores precisely what was signed rather than a larger backing buffer.
  const rawPayload = verification.rawBody.slice().buffer;

  const event: VerifiedWebhookEvent = {
    webhookId: verification.webhookId,
    timestampSeconds: verification.timestampSeconds,
    eventType: metadata.eventType,
    responseId: metadata.responseId,
    rawPayload,
    receivedAtMs,
  };

  try {
    // `env.ROUTER_DO` is a bare `DurableObjectNamespace` (docs/ENVTYPES.md trap
    // 1.3); parameterize the singleton stub with the documented RouterDO RPC.
    const stub = env.ROUTER_DO.get(
      env.ROUTER_DO.idFromName(ROUTER_DO_NAME),
    ) as DurableObjectStub<RouterDO>;
    const result = await stub.enqueueWebhook(event);

    return jsonResponse(result.receipt, result.receipt.kind === "accepted"
      ? 200
      : result.receipt.statusCode);
  } catch (error) {
    // Sanitized failure: the sender retries with the same webhook-id, which the
    // inbox deduplicates. Never acknowledge before durable acceptance.
    return toErrorResponse(error);
  }
}