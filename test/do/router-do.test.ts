// Covers: 18, 24

import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { RouterDO } from "../../src/do/router-do.ts";
import type { ResponseRouteMapping, VerifiedWebhookEvent } from "../../src/types.ts";

const NOW_MS = 1_700_000_000_000;

/** Future deadlines keep the seeded alarm from firing mid-assertion. */
const FUTURE_MS = Date.now() + 3_600_000;

/** Distinct object name per test, since each test owns its own inbox. */
let routerSequence = 0;

function nextRouterStub(): DurableObjectStub {
  routerSequence += 1;
  return env.ROUTER_DO.get(env.ROUTER_DO.idFromName(`router-do-test-${routerSequence}`));
}

async function withRouter<T>(
  callback: (router: RouterDO, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return await runInDurableObject(nextRouterStub(), async (instance, state) => {
    return await callback(instance as RouterDO, state);
  });
}

function webhookEvent(
  webhookId: string,
  responseId: string,
  body: string,
  receivedAtMs = NOW_MS,
): VerifiedWebhookEvent {
  const encoded = new TextEncoder().encode(body);
  const payload = new Uint8Array(encoded.byteLength);
  payload.set(encoded);
  return {
    webhookId,
    timestampSeconds: 1_700_000_000,
    eventType: "response.completed",
    responseId,
    rawPayload: payload.buffer,
    receivedAtMs,
  };
}

function routeMapping(
  responseId: string,
  jobId: string,
  registeredAtMs: number,
): ResponseRouteMapping {
  return {
    responseId,
    jobId,
    attemptId: `attempt-${jobId}`,
    turnIndex: 1,
    registeredAtMs,
    settledAtMs: null,
  };
}

interface InboxRow extends Record<string, SqlStorageValue> {
  status: string;
  job_id: string | null;
  delivery_attempts: number;
  next_attempt_at_ms: number | null;
  raw_body_bytes: number;
}

function readInboxRow(state: DurableObjectState, webhookId: string): InboxRow {
  const rows = state.storage.sql
    .exec<InboxRow>(
      `SELECT status, job_id, delivery_attempts, next_attempt_at_ms, raw_body_bytes
       FROM webhook_inbox
       WHERE webhook_id = ?`,
      webhookId,
    )
    .toArray();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Missing webhook inbox row: ${webhookId}`);
  }
  return row;
}

function countRows(state: DurableObjectState, table: "webhook_inbox" | "response_routes"): number {
  const rows = state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).toArray();
  return rows[0]?.count ?? 0;
}

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("RouterDO webhook ingress", () => {
  it("durably accepts an unmatched event and deduplicates by webhook_id", async () => {
    await withRouter(async (router, state) => {
      const first = await router.enqueueWebhook(
        webhookEvent("wh-1", "resp-1", '{"type":"response.completed"}'),
      );
      expect(first.duplicate).toBe(false);
      expect(first.receipt).toEqual({
        kind: "accepted",
        webhookId: "wh-1",
        duplicate: false,
        matchedJobId: null,
      });

      const duplicate = await router.enqueueWebhook(
        webhookEvent("wh-1", "resp-1", '{"type":"response.completed","tampered":true}'),
      );
      expect(duplicate.duplicate).toBe(true);

      expect(countRows(state, "webhook_inbox")).toBe(1);
      const row = readInboxRow(state, "wh-1");
      expect(row.status).toBe("unmatched");
      expect(row.job_id).toBeNull();
      expect(row.delivery_attempts).toBe(0);
      expect(row.next_attempt_at_ms).toBe(NOW_MS);
      // The stored bytes are the first delivery's bytes, never the duplicate's.
      expect(row.raw_body_bytes).toBe('{"type":"response.completed"}'.length);

      // Unmatched events are not deliverable, so no alarm is owed for them.
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("rejects an oversized payload without writing an inbox row", async () => {
    await withRouter(async (router, state) => {
      const oversized = new Uint8Array(1_500_001);
      const result = await router.enqueueWebhook({
        ...webhookEvent("wh-big", "resp-big", ""),
        rawPayload: oversized.buffer,
      });

      expect(result.receipt.kind).toBe("rejected");
      if (result.receipt.kind === "rejected") {
        expect(result.receipt.statusCode).toBe(413);
      }
      expect(result.duplicate).toBe(false);
      expect(countRows(state, "webhook_inbox")).toBe(0);
    });
  });
});

describe("RouterDO response routes", () => {
  it("reconciles unmatched events on registration and schedules one alarm", async () => {
    await withRouter(async (router, state) => {
      await router.enqueueWebhook(webhookEvent("wh-2", "resp-2", "{}", FUTURE_MS - 1_000));

      await router.registerResponseRoute(
        routeMapping("resp-2", "job-2", FUTURE_MS),
      );

      const row = readInboxRow(state, "wh-2");
      expect(row.status).toBe("pending");
      expect(row.job_id).toBe("job-2");
      expect(row.next_attempt_at_ms).toBe(FUTURE_MS);

      expect(await state.storage.getAlarm()).toBe(FUTURE_MS);

      // Re-registering the identical immutable mapping is idempotent.
      await router.registerResponseRoute(routeMapping("resp-2", "job-2", FUTURE_MS));
      expect(countRows(state, "response_routes")).toBe(1);
      expect(readInboxRow(state, "wh-2").job_id).toBe("job-2");
    });
  });

  it("rejects a conflicting rebind and preserves an advanced route status", async () => {
    await withRouter(async (router, state) => {
      await router.registerResponseRoute(routeMapping("resp-3", "job-3", FUTURE_MS));

      state.storage.sql.exec(
        "UPDATE response_routes SET status = 'delivered', delivered_at_ms = ? WHERE response_id = ?",
        FUTURE_MS,
        "resp-3",
      );

      await router.registerResponseRoute(routeMapping("resp-3", "job-3", FUTURE_MS));
      const rows = state.storage.sql
        .exec<{ status: string; job_id: string }>(
          "SELECT status, job_id FROM response_routes WHERE response_id = ?",
          "resp-3",
        )
        .toArray();
      expect(rows[0]?.status).toBe("delivered");
      expect(rows[0]?.job_id).toBe("job-3");

      await expect(
        router.registerResponseRoute(routeMapping("resp-3", "job-other", FUTURE_MS)),
      ).rejects.toThrow(/immutable/);
      expect(countRows(state, "response_routes")).toBe(1);
    });
  });

  it("keeps events that arrive after registration pending with their route target", async () => {
    await withRouter(async (router, state) => {
      await router.registerResponseRoute(routeMapping("resp-4", "job-4", FUTURE_MS));
      const result = await router.enqueueWebhook(webhookEvent("wh-4", "resp-4", "{}", FUTURE_MS));

      expect(result.receipt).toEqual({
        kind: "accepted",
        webhookId: "wh-4",
        duplicate: false,
        matchedJobId: "job-4",
      });
      const row = readInboxRow(state, "wh-4");
      expect(row.status).toBe("pending");
      expect(row.job_id).toBe("job-4");
      expect(await state.storage.getAlarm()).toBe(FUTURE_MS);
    });
  });
});

describe("RouterDO delivery", () => {
  it("persists one delivery attempt for a due row and keeps it in the inbox", async () => {
    const stub = nextRouterStub();
    await runInDurableObject(stub, async (instance, state) => {
      const router = instance as RouterDO;
      await router.registerResponseRoute(routeMapping("resp-5", "job-missing", FUTURE_MS));
      await router.enqueueWebhook(webhookEvent("wh-5", "resp-5", "{}", FUTURE_MS));

      // Make the row due without moving the already-scheduled (future) alarm.
      state.storage.sql.exec(
        "UPDATE webhook_inbox SET next_attempt_at_ms = 1 WHERE webhook_id = ?",
        "wh-5",
      );

      const counts = await router.deliverPending();
      expect(counts.delivered + counts.retried + counts.failed).toBe(1);

      const row = readInboxRow(state, "wh-5");
      expect(row.delivery_attempts).toBe(1);
      expect(row.status).not.toBe("unmatched");
      if (row.status === "pending") {
        expect(row.next_attempt_at_ms).not.toBeNull();
        expect(row.next_attempt_at_ms!).toBeGreaterThan(Date.now());
      } else {
        expect(["delivered", "duplicate", "failed"]).toContain(row.status);
      }
      expect(countRows(state, "webhook_inbox")).toBe(1);
    });
  });

  it("runs the single alarm and reschedules from persisted deadlines", async () => {
    const stub = nextRouterStub();
    await runInDurableObject(stub, async (instance, state) => {
      const router = instance as RouterDO;
      await router.registerResponseRoute(routeMapping("resp-6", "job-missing", FUTURE_MS));
      await router.enqueueWebhook(webhookEvent("wh-6", "resp-6", "{}", FUTURE_MS));
      state.storage.sql.exec(
        "UPDATE webhook_inbox SET next_attempt_at_ms = 1 WHERE webhook_id = ?",
        "wh-6",
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      const row = readInboxRow(state, "wh-6");
      expect(row.delivery_attempts).toBe(1);
      expect(countRows(state, "webhook_inbox")).toBe(1);

      const alarm = await state.storage.getAlarm();
      if (row.status === "pending") {
        expect(alarm).toBe(row.next_attempt_at_ms);
      } else {
        expect(alarm).toBeNull();
      }
    });
  });
});