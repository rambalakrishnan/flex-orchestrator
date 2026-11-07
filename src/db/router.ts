/**
 * RouterStorage (`src/db/router.ts`) — Response routing and durable webhook inbox persistence.
 *
 * Implements synchronous SQLite operations over `response_routes` and `webhook_inbox`
 * for `RouterDO`, including out-of-order webhook-before-registration race reconciliation,
 * 1,500,000-byte artifact and resulting-row guards, primary-key cursor pagination
 * without BLOBs, and `SQLITE_FULL` error mapping.
 */

import {
  ArtifactGuardError,
  assertArtifactAndRowSize,
  clampPageLimit,
  measureByteLength,
  toGuardedBlob,
} from "../lib/guards.ts";
import {
  WEBHOOK_INBOX_SUMMARY_COLUMNS,
  withSqlErrorMapping,
  type ResponseRouteRow,
  type SchemaSqlStorage,
  type SchemaTransactionalStorage,
  type SqlPrimitiveValue,
  type WebhookInboxRow,
  type WebhookInboxSummaryRow,
} from "./schema";

const RESPONSE_ROUTES_COLUMNS =
  "response_id, job_id, attempt_id, turn_index, status, registered_at_ms, delivered_at_ms, created_at, updated_at";

/**
 * Registers or updates a response route mapping in `response_routes` and reconciles
 * any existing `unmatched` webhook inbox records for that `response_id` inside
 * a single synchronous transaction.
 */
export function registerResponseRoute(
  storage: SchemaTransactionalStorage,
  input: {
    responseId: string;
    jobId: string;
    attemptId: string;
    turnIndex: number;
    nowMs: number;
    nowIso: string;
  }
): { route: ResponseRouteRow; matchedPendingWebhooks: WebhookInboxSummaryRow[] } {
  return withSqlErrorMapping(() => {
    const metadataBytes =
      measureByteLength(input.responseId) +
      measureByteLength(input.jobId) +
      measureByteLength(input.attemptId);
    assertArtifactAndRowSize(0, metadataBytes, "response_routes.row_bytes");

    return storage.transactionSync(() => {
      const sql = storage.sql;

      const existingRoutes = sql
        .exec<ResponseRouteRow>(
          `SELECT ${RESPONSE_ROUTES_COLUMNS} FROM response_routes WHERE response_id = ?`,
          input.responseId
        )
        .toArray();
      const existingRoute = existingRoutes[0] ?? null;

      if (existingRoute === null) {
        sql.exec(
          `INSERT INTO response_routes (
            response_id,
            job_id,
            attempt_id,
            turn_index,
            status,
            registered_at_ms,
            delivered_at_ms,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, 'registered', ?, NULL, ?, ?)`,
          input.responseId,
          input.jobId,
          input.attemptId,
          input.turnIndex,
          input.nowMs,
          input.nowIso,
          input.nowIso
        );
      } else {
        const preservedStatus =
          existingRoute.status === "delivered" || existingRoute.status === "settled"
            ? existingRoute.status
            : "registered";
        sql.exec(
          `UPDATE response_routes
           SET job_id = ?,
               attempt_id = ?,
               turn_index = ?,
               status = ?,
               updated_at = ?
           WHERE response_id = ?`,
          input.jobId,
          input.attemptId,
          input.turnIndex,
          preservedStatus,
          input.nowIso,
          input.responseId
        );
      }

      const unmatchedWebhooks = sql
        .exec<WebhookInboxSummaryRow>(
          `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS}
           FROM webhook_inbox
           WHERE response_id = ? AND status = 'unmatched'
           ORDER BY webhook_id ASC`,
          input.responseId
        )
        .toArray();

      const jobIdBytes = measureByteLength(input.jobId);
      for (const item of unmatchedWebhooks) {
        const currentMetadataBytes =
          measureByteLength(item.webhook_id) +
          measureByteLength(item.event_type) +
          measureByteLength(item.response_id) +
          jobIdBytes +
          measureByteLength(item.last_error);
        const { rowBytes } = assertArtifactAndRowSize(
          item.raw_body_bytes,
          currentMetadataBytes,
          "webhook_inbox.row_bytes"
        );

        sql.exec(
          `UPDATE webhook_inbox
           SET job_id = ?,
               status = 'pending',
               next_attempt_at_ms = ?,
               row_bytes = ?,
               updated_at = ?
           WHERE webhook_id = ? AND status = 'unmatched'`,
          input.jobId,
          input.nowMs,
          rowBytes,
          input.nowIso,
          item.webhook_id
        );
      }

      const route = sql
        .exec<ResponseRouteRow>(
          `SELECT ${RESPONSE_ROUTES_COLUMNS} FROM response_routes WHERE response_id = ?`,
          input.responseId
        )
        .one();

      const matchedPendingWebhooks =
        unmatchedWebhooks.length > 0
          ? sql
              .exec<WebhookInboxSummaryRow>(
                `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS}
                 FROM webhook_inbox
                 WHERE response_id = ? AND status = 'pending' AND job_id = ?
                 ORDER BY webhook_id ASC`,
                input.responseId,
                input.jobId
              )
              .toArray()
          : [];

      return { route, matchedPendingWebhooks };
    });
  });
}

/**
 * Fetches a response route mapping by `response_id`, or returns `null` if not registered.
 */
export function getResponseRoute(
  sql: SchemaSqlStorage,
  responseId: string
): ResponseRouteRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<ResponseRouteRow>(
        `SELECT ${RESPONSE_ROUTES_COLUMNS} FROM response_routes WHERE response_id = ?`,
        responseId
      )
      .toArray();
    return rows[0] ?? null;
  });
}

/**
 * Updates `status`, `delivered_at_ms` (when transitioning to `delivered` or `settled`),
 * and `updated_at` on `response_routes`.
 */
export function markResponseRouteStatus(
  sql: SchemaSqlStorage,
  responseId: string,
  status: ResponseRouteRow["status"],
  nowMs: number,
  nowIso: string
): void {
  withSqlErrorMapping(() => {
    if (status === "delivered" || status === "settled") {
      sql.exec(
        `UPDATE response_routes
         SET status = ?,
             delivered_at_ms = COALESCE(delivered_at_ms, ?),
             updated_at = ?
         WHERE response_id = ?`,
        status,
        nowMs,
        nowIso,
        responseId
      );
    } else {
      sql.exec(
        `UPDATE response_routes
         SET status = ?,
             updated_at = ?
         WHERE response_id = ?`,
        status,
        nowIso,
        responseId
      );
    }
  });
}

/**
 * Enqueues a signature-verified OpenAI webhook delivery into `webhook_inbox`
 * inside `storage.transactionSync`.
 *
 * - Deduplicates by `webhook_id` without overwriting existing state.
 * - Enforces the 1,500,000-byte artifact and resulting-row guards on `rawBody` (which must be non-empty).
 * - Resolves `job_id` from `response_routes` if already registered (`status = 'pending'`),
 *   or records `status = 'unmatched'` so a subsequent `registerResponseRoute` can reconcile it.
 */
export function enqueueVerifiedWebhook(
  storage: SchemaTransactionalStorage,
  input: {
    webhookId: string;
    eventType: WebhookInboxRow["event_type"];
    responseId: string;
    deliveryTimestampSec: number;
    receivedAtMs: number;
    rawBody: Uint8Array | ArrayBuffer | string;
    nowIso: string;
  }
): { summary: WebhookInboxSummaryRow; duplicate: boolean } {
  return withSqlErrorMapping(() => {
    return storage.transactionSync(() => {
      const sql = storage.sql;

      const existingRows = sql
        .exec<WebhookInboxSummaryRow>(
          `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
          input.webhookId
        )
        .toArray();
      const existing = existingRows[0] ?? null;
      if (existing !== null) {
        return { summary: existing, duplicate: true };
      }

      const { blob, byteLength: rawBodyBytes } = toGuardedBlob(
        input.rawBody,
        "webhook_inbox.raw_body_blob"
      );
      if (rawBodyBytes <= 0) {
        throw new ArtifactGuardError(
          "artifact_bytes",
          rawBodyBytes,
          1_500_000,
          "webhook_inbox.raw_body_blob"
        );
      }

      const routeRows = sql
        .exec<ResponseRouteRow>(
          `SELECT ${RESPONSE_ROUTES_COLUMNS} FROM response_routes WHERE response_id = ?`,
          input.responseId
        )
        .toArray();
      const route = routeRows[0] ?? null;

      const jobId = route !== null ? route.job_id : null;
      const status: WebhookInboxRow["status"] = route !== null ? "pending" : "unmatched";
      const nextAttemptAtMs = input.receivedAtMs;

      const metadataBytes =
        measureByteLength(input.webhookId) +
        measureByteLength(input.eventType) +
        measureByteLength(input.responseId) +
        measureByteLength(jobId);

      const { rowBytes } = assertArtifactAndRowSize(
        rawBodyBytes,
        metadataBytes,
        "webhook_inbox.row_bytes"
      );

      sql.exec(
        `INSERT INTO webhook_inbox (
          webhook_id,
          event_type,
          response_id,
          job_id,
          delivery_timestamp_sec,
          received_at_ms,
          status,
          delivery_attempts,
          next_attempt_at_ms,
          raw_body_blob,
          raw_body_bytes,
          row_bytes,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?)`,
        input.webhookId,
        input.eventType,
        input.responseId,
        jobId,
        input.deliveryTimestampSec,
        input.receivedAtMs,
        status,
        nextAttemptAtMs,
        blob,
        rawBodyBytes,
        rowBytes,
        input.nowIso,
        input.nowIso
      );

      const summary = sql
        .exec<WebhookInboxSummaryRow>(
          `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
          input.webhookId
        )
        .one();

      return { summary, duplicate: false };
    });
  });
}

/**
 * Fetches BLOB-free summary metadata for a single webhook inbox record by `webhook_id`.
 */
export function getWebhookInboxSummary(
  sql: SchemaSqlStorage,
  webhookId: string
): WebhookInboxSummaryRow | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<WebhookInboxSummaryRow>(
        `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
        webhookId
      )
      .toArray();
    return rows[0] ?? null;
  });
}

/**
 * Fetches the raw verified payload bytes (`raw_body_blob`) for a single webhook inbox item.
 */
export function getWebhookInboxRawBodyBlob(
  sql: SchemaSqlStorage,
  webhookId: string
): Uint8Array | null {
  return withSqlErrorMapping(() => {
    const rows = sql
      .exec<{ raw_body_blob: ArrayBuffer | Uint8Array }>(
        "SELECT raw_body_blob FROM webhook_inbox WHERE webhook_id = ?",
        webhookId
      )
      .toArray();
    const row = rows[0] ?? null;
    if (row === null) {
      return null;
    }
    return row.raw_body_blob instanceof Uint8Array
      ? row.raw_body_blob
      : new Uint8Array(row.raw_body_blob);
  });
}

/**
 * Lists webhook inbox summaries using primary-key cursor pagination (`webhook_id > afterWebhookId`),
 * omitting `raw_body_blob`, and clamping the page limit to `1..100`.
 */
export function listWebhookInboxSummaries(
  sql: SchemaSqlStorage,
  options?: {
    status?: WebhookInboxRow["status"];
    jobId?: string;
    afterWebhookId?: string | null;
    limit?: number;
  }
): WebhookInboxSummaryRow[] {
  return withSqlErrorMapping(() => {
    const limit = clampPageLimit(options?.limit);
    const conditions: string[] = [];
    const bindings: SqlPrimitiveValue[] = [];

    if (options?.status !== undefined) {
      conditions.push("status = ?");
      bindings.push(options.status);
    }
    if (options?.jobId !== undefined) {
      conditions.push("job_id = ?");
      bindings.push(options.jobId);
    }
    if (options?.afterWebhookId !== undefined && options.afterWebhookId !== null) {
      conditions.push("webhook_id > ?");
      bindings.push(options.afterWebhookId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    bindings.push(limit);

    return sql
      .exec<WebhookInboxSummaryRow>(
        `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS}
         FROM webhook_inbox
         ${whereClause}
         ORDER BY webhook_id ASC
         LIMIT ?`,
        ...bindings
      )
      .toArray();
  });
}

/**
 * Lists due `pending` webhook deliveries (`next_attempt_at_ms <= nowMs`) ordered by
 * `next_attempt_at_ms ASC, webhook_id ASC`, omitting `raw_body_blob` and clamped to `1..100`.
 */
export function listDueWebhookDeliveries(
  sql: SchemaSqlStorage,
  nowMs: number,
  limit?: number
): WebhookInboxSummaryRow[] {
  return withSqlErrorMapping(() => {
    const clampedLimit = clampPageLimit(limit);
    return sql
      .exec<WebhookInboxSummaryRow>(
        `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS}
         FROM webhook_inbox
         WHERE status = 'pending'
           AND next_attempt_at_ms IS NOT NULL
           AND next_attempt_at_ms <= ?
         ORDER BY next_attempt_at_ms ASC, webhook_id ASC
         LIMIT ?`,
        nowMs,
        clampedLimit
      )
      .toArray();
  });
}

/**
 * Returns the earliest `next_attempt_at_ms` across `pending` webhook inbox entries,
 * or `null` when no pending retry is scheduled.
 */
export function getEarliestWebhookRetryAtMs(sql: SchemaSqlStorage): number | null {
  return withSqlErrorMapping(() => {
    const row = sql
      .exec<{ earliest_ms: number | null }>(
        `SELECT MIN(next_attempt_at_ms) AS earliest_ms
         FROM webhook_inbox
         WHERE status = 'pending' AND next_attempt_at_ms IS NOT NULL`
      )
      .one();
    return typeof row.earliest_ms === "number" ? row.earliest_ms : null;
  });
}

/**
 * Records the outcome of a webhook delivery attempt on `webhook_inbox` and,
 * when `outcome === "delivered"`, marks the corresponding `response_routes` record as `delivered`.
 */
export function recordWebhookDeliveryResult(
  sql: SchemaSqlStorage,
  params: {
    webhookId: string;
    outcome: "delivered" | "duplicate" | "retry" | "failed";
    nextAttemptAtMs?: number | null;
    lastError?: string | null;
    nowMs: number;
    nowIso: string;
  }
): void {
  withSqlErrorMapping(() => {
    const existingRows = sql
      .exec<WebhookInboxSummaryRow>(
        `SELECT ${WEBHOOK_INBOX_SUMMARY_COLUMNS} FROM webhook_inbox WHERE webhook_id = ?`,
        params.webhookId
      )
      .toArray();
    const existing = existingRows[0] ?? null;
    if (existing === null) {
      throw new Error(`Webhook inbox record not found: ${params.webhookId}`);
    }

    const nextStatus: WebhookInboxRow["status"] =
      params.outcome === "retry" ? "pending" : params.outcome;

    const nextAttemptAtMs =
      params.outcome === "retry" ? (params.nextAttemptAtMs ?? params.nowMs) : null;

    const lastError =
      params.outcome === "delivered" || params.outcome === "duplicate"
        ? (params.lastError ?? null)
        : (params.lastError ?? existing.last_error);

    const metadataBytes =
      measureByteLength(existing.webhook_id) +
      measureByteLength(existing.event_type) +
      measureByteLength(existing.response_id) +
      measureByteLength(existing.job_id) +
      measureByteLength(lastError);

    const { rowBytes } = assertArtifactAndRowSize(
      existing.raw_body_bytes,
      metadataBytes,
      "webhook_inbox.row_bytes"
    );

    sql.exec(
      `UPDATE webhook_inbox
       SET status = ?,
           delivery_attempts = delivery_attempts + 1,
           next_attempt_at_ms = ?,
           row_bytes = ?,
           last_error = ?,
           updated_at = ?
       WHERE webhook_id = ?`,
      nextStatus,
      nextAttemptAtMs,
      rowBytes,
      lastError,
      params.nowIso,
      params.webhookId
    );

    if (params.outcome === "delivered") {
      sql.exec(
        `UPDATE response_routes
         SET status = CASE WHEN status = 'settled' THEN 'settled' ELSE 'delivered' END,
             delivered_at_ms = COALESCE(delivered_at_ms, ?),
             updated_at = ?
         WHERE response_id = ?`,
        params.nowMs,
        params.nowIso,
        existing.response_id
      );
    }
  });
}
