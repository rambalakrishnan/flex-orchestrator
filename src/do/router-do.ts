/**
 * RouterDO (`src/do/router-do.ts`) — global response routing and webhook inbox.
 *
 * Owns exactly two SQLite tables (both accessed through `src/db/router.ts`):
 * `response_routes` (immutable `response_id` → job/attempt/turn mapping) and
 * `webhook_inbox` (durable, signature-verified deliveries with their exact raw
 * payload bytes). RouterDO never writes job execution state: verified events are
 * handed to `JobDO.receiveWebhookDelivery`, and only inbox/route bookkeeping stays
 * here.
 *
 * Invariants (docs/ROUTERDO.md):
 * 1. A `webhook_inbox` row commits before `enqueueWebhook` resolves.
 * 2. Routes are immutable; a conflicting rebind is an error.
 * 3. Unmatched events are retained and reconciled by `response_id` when a route
 *    registers.
 * 4. `webhook_id` is the only dedupe key; settled rows are never reopened.
 * 5. Delivery retries are persisted (`next_attempt_at_ms`, `delivery_attempts`)
 *    and driven by one alarm at the earliest pending retry.
 */

import { DurableObject } from "cloudflare:workers";
import { LIST_PAGE_LIMIT_MAX } from "../constants.ts";
import {
  enqueueVerifiedWebhook,
  getEarliestWebhookRetryAtMs,
  getResponseRoute,
  getWebhookInboxRawBodyBlob,
  listDueWebhookDeliveries,
  markResponseRouteStatus,
  recordWebhookDeliveryResult,
  registerResponseRoute as registerRouteMapping,
} from "../db/router.ts";
import {
  migrateRouterDoSchema,
  type SchemaTransactionalStorage,
  type WebhookInboxSummaryRow,
} from "../db/schema.ts";
import {
  ensureAlarmNotLaterThan,
  isAlarmWallTimeBudgetExceeded,
  runWithAlarmSafety,
} from "../lib/alarm.ts";
import { now } from "../lib/clock.ts";
import { ArtifactGuardError } from "../lib/guards.ts";
import type {
  ResponseRouteMapping,
  VerifiedWebhookEvent,
  WebhookIngressReceipt,
} from "../types.ts";

/**
 * Maximum delivery attempts recorded on one inbox row before the row is failed
 * permanently. The row itself is always retained; only its status settles.
 */
const WEBHOOK_DELIVERY_MAX_ATTEMPTS = 8 as const;

/** Base delay for a delivery retry after a rejected `JobDO` hand-off. */
const WEBHOOK_DELIVERY_RETRY_BASE_MS = 2_000 as const;

/** Ceiling for the exponential delivery retry delay. */
const WEBHOOK_DELIVERY_RETRY_MAX_MS = 300_000 as const;

/** Maximum length of a persisted, sanitized delivery error message. */
const WEBHOOK_DELIVERY_ERROR_MAX_CHARS = 500 as const;

/**
 * Binding-RPC contract used for the verified webhook hand-off. `JobDO` documents
 * `receiveWebhookDelivery(event): Promise<void>`; a resolution is an accepted
 * delivery, and an explicit duplicate acknowledgement is honored when present.
 */
interface JobWebhookDeliveryRpc {
  receiveWebhookDelivery(event: VerifiedWebhookEvent): Promise<unknown>;
}

/** Per-row delivery outcome used to accumulate `deliverPending` counts. */
type InboxDeliveryResult = "delivered" | "retried" | "failed";

/** Result of the synchronous `enqueueVerifiedWebhook` inbox transaction. */
interface EnqueuedWebhook {
  readonly summary: WebhookInboxSummaryRow;
  readonly duplicate: boolean;
}

/**
 * Converts any thrown value into a single-line, length-bounded message that is
 * safe to persist in `webhook_inbox.last_error` (no raw payloads, no headers).
 */
function sanitizeDeliveryError(error: unknown): string {
  const raw =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) {
    return "delivery_failed";
  }
  return singleLine.length > WEBHOOK_DELIVERY_ERROR_MAX_CHARS
    ? singleLine.slice(0, WEBHOOK_DELIVERY_ERROR_MAX_CHARS)
    : singleLine;
}

/**
 * Exponential retry delay for attempt number `attempts` (1-based), capped at
 * `WEBHOOK_DELIVERY_RETRY_MAX_MS`.
 */
function computeDeliveryRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = WEBHOOK_DELIVERY_RETRY_BASE_MS * 2 ** exponent;
  return delay > WEBHOOK_DELIVERY_RETRY_MAX_MS
    ? WEBHOOK_DELIVERY_RETRY_MAX_MS
    : delay;
}

/**
 * Detects an explicit duplicate acknowledgement from the `JobDO` hand-off. A
 * `void` resolution ("handed over, execution state already advanced") is treated
 * as a delivered observation by the caller.
 */
function isDuplicateDeliveryAck(ack: unknown): boolean {
  if (typeof ack !== "object" || ack === null || !("duplicate" in ack)) {
    return false;
  }
  return ack.duplicate === true;
}

export class RouterDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Workers-types widens SqlStorage bindings; the schema adapter accepts the same values at runtime.
    const storage = ctx.storage as unknown as SchemaTransactionalStorage;
    migrateRouterDoSchema(storage);
  }

  /**
   * Durably accepts one signature-verified OpenAI webhook delivery.
   *
   * The inbox transaction (`enqueueVerifiedWebhook`) commits before this method
   * resolves, so the handler's 2xx acknowledgement always follows durable
   * acceptance. Duplicates are returned with their existing summary and are
   * never rewritten. An oversized payload is a `413` receipt, never a partial
   * write.
   */
  async enqueueWebhook(
    event: VerifiedWebhookEvent,
  ): Promise<{ receipt: WebhookIngressReceipt; duplicate: boolean }> {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    let enqueued: EnqueuedWebhook;
    try {
      enqueued = enqueueVerifiedWebhook(this.storage(), {
        webhookId: event.webhookId,
        eventType: event.eventType,
        responseId: event.responseId,
        deliveryTimestampSec: event.timestampSeconds,
        receivedAtMs: event.receivedAtMs,
        rawBody: event.rawPayload,
        nowIso,
      });
    } catch (error: unknown) {
      if (error instanceof ArtifactGuardError) {
        return {
          receipt: {
            kind: "rejected",
            statusCode: 413,
            message: "Verified webhook payload exceeds the stored artifact guard",
          },
          duplicate: false,
        };
      }
      throw error;
    }

    // The row is committed; now make sure a pending delivery is scheduled.
    await this.scheduleEarliestRetry();

    const receipt: WebhookIngressReceipt = {
      kind: "accepted",
      webhookId: enqueued.summary.webhook_id,
      duplicate: enqueued.duplicate,
      matchedJobId: enqueued.summary.job_id,
    };
    return { receipt, duplicate: enqueued.duplicate };
  }

  /**
   * Registers the immutable `response_id` → job/attempt/turn mapping and
   * reconciles any inbox rows that arrived before the route (`unmatched` →
   * `pending`), atomically, then schedules their first delivery.
   *
   * Re-registering the identical mapping is idempotent; a conflicting mapping is
   * rejected without rebinding the existing route.
   */
  async registerResponseRoute(mapping: ResponseRouteMapping): Promise<void> {
    const storage = this.storage();
    const existing = getResponseRoute(storage.sql, mapping.responseId);
    if (
      existing !== null &&
      (existing.job_id !== mapping.jobId ||
        existing.attempt_id !== mapping.attemptId ||
        existing.turn_index !== mapping.turnIndex)
    ) {
      throw new Error(
        `Response route ${mapping.responseId} is immutable and already bound to a different attempt`,
      );
    }

    // No `await` between the immutability check and the registration transaction:
    // this single-threaded object cannot interleave another registration here.
    registerRouteMapping(storage, {
      responseId: mapping.responseId,
      jobId: mapping.jobId,
      attemptId: mapping.attemptId,
      turnIndex: mapping.turnIndex,
      nowMs: mapping.registeredAtMs,
      nowIso: new Date(now()).toISOString(),
    });

    if (mapping.settledAtMs !== null) {
      const settledAtMs = mapping.settledAtMs;
      markResponseRouteStatus(
        storage.sql,
        mapping.responseId,
        "settled",
        settledAtMs,
        new Date(settledAtMs).toISOString(),
      );
    }

    await this.scheduleEarliestRetry();
  }

  /**
   * Delivers every due inbox row to `JobDO` in earliest-deadline order, persisting
   * each row's outcome before starting the next delivery. Stops starting new
   * deliveries once the alarm wall-time budget is exhausted and returns the counts
   * for this invocation.
   */
  async deliverPending(): Promise<{
    delivered: number;
    retried: number;
    failed: number;
  }> {
    const startedAtMs = now();
    const counts: { delivered: number; retried: number; failed: number } = {
      delivered: 0,
      retried: 0,
      failed: 0,
    };

    while (!isAlarmWallTimeBudgetExceeded(startedAtMs)) {
      const dueRows = listDueWebhookDeliveries(
        this.storage().sql,
        now(),
        LIST_PAGE_LIMIT_MAX,
      );
      if (dueRows.length === 0) {
        break;
      }

      for (const row of dueRows) {
        if (isAlarmWallTimeBudgetExceeded(startedAtMs)) {
          break;
        }
        const result = await this.deliverInboxRow(row);
        counts[result] += 1;
      }
    }

    return counts;
  }

  /**
   * Single alarm for the earliest persisted webhook retry. Completes deliveries,
   * then reschedules from persisted deadlines only (never from timers), using
   * `scheduleNextObligationFromAlarm` inside `runWithAlarmSafety` because
   * `getAlarm()` is `null` during an active invocation.
   */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await runWithAlarmSafety(this.ctx.storage, alarmInfo, async () => {
      await this.deliverPending();
      return getEarliestWebhookRetryAtMs(this.storage().sql);
    });
  }

  private storage(): SchemaTransactionalStorage {
    return this.ctx.storage as unknown as SchemaTransactionalStorage;
  }

  /**
   * Schedules one alarm at the earliest persisted `next_attempt_at_ms`, never
   * pushing an earlier pending alarm out.
   */
  private async scheduleEarliestRetry(): Promise<number | null> {
    const earliestMs = getEarliestWebhookRetryAtMs(this.storage().sql);
    if (earliestMs === null) {
      return null;
    }
    return ensureAlarmNotLaterThan(this.ctx.storage, earliestMs);
  }

  /**
   * Hands one due inbox row to its `JobDO` (exact route lookup, exact stored
   * bytes), then records `delivered` / `duplicate`, or a persisted `retry` with a
   * future deadline, or `failed` once the attempt budget is exhausted.
   */
  private async deliverInboxRow(
    row: WebhookInboxSummaryRow,
  ): Promise<InboxDeliveryResult> {
    const sql = this.storage().sql;
    const jobId = row.job_id;

    if (jobId === null) {
      const observedAtMs = now();
      recordWebhookDeliveryResult(sql, {
        webhookId: row.webhook_id,
        outcome: "failed",
        lastError: "missing_route_target",
        nowMs: observedAtMs,
        nowIso: new Date(observedAtMs).toISOString(),
      });
      return "failed";
    }

    const rawBody = getWebhookInboxRawBodyBlob(sql, row.webhook_id);
    if (rawBody === null) {
      const observedAtMs = now();
      recordWebhookDeliveryResult(sql, {
        webhookId: row.webhook_id,
        outcome: "failed",
        lastError: "missing_raw_body",
        nowMs: observedAtMs,
        nowIso: new Date(observedAtMs).toISOString(),
      });
      return "failed";
    }

    // Exact stored bytes as their own ArrayBuffer: no decode, no re-serialization.
    const rawPayloadBytes = new Uint8Array(rawBody.byteLength);
    rawPayloadBytes.set(rawBody);

    const event: VerifiedWebhookEvent = {
      webhookId: row.webhook_id,
      timestampSeconds: row.delivery_timestamp_sec,
      eventType: row.event_type,
      responseId: row.response_id,
      rawPayload: rawPayloadBytes.buffer,
      receivedAtMs: row.received_at_ms,
    };

    try {
      const stub = this.env.JOB_DO.getByName(
        jobId,
      ) as unknown as JobWebhookDeliveryRpc;
      const ack = await stub.receiveWebhookDelivery(event);
      const nowMs = now();
      recordWebhookDeliveryResult(sql, {
        webhookId: row.webhook_id,
        outcome: isDuplicateDeliveryAck(ack) ? "duplicate" : "delivered",
        nextAttemptAtMs: null,
        lastError: null,
        nowMs,
        nowIso: new Date(nowMs).toISOString(),
      });
      return "delivered";
    } catch (error: unknown) {
      const attempts = row.delivery_attempts + 1;
      const lastError = sanitizeDeliveryError(error);

      if (attempts >= WEBHOOK_DELIVERY_MAX_ATTEMPTS) {
        const failedAtMs = now();
        recordWebhookDeliveryResult(sql, {
          webhookId: row.webhook_id,
          outcome: "failed",
          nextAttemptAtMs: null,
          lastError,
          nowMs: failedAtMs,
          nowIso: new Date(failedAtMs).toISOString(),
        });
        return "failed";
      }

      const observedAtMs = now();
      const retryAtMs =
        observedAtMs + computeDeliveryRetryDelayMs(attempts);
      recordWebhookDeliveryResult(sql, {
        webhookId: row.webhook_id,
        outcome: "retry",
        nextAttemptAtMs: retryAtMs,
        lastError,
        nowMs: observedAtMs,
        nowIso: new Date(observedAtMs).toISOString(),
      });
      return "retried";
    }
  }
}