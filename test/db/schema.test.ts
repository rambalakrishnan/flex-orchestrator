// Covers: 6
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALL_SCHEMA_TABLE_DDL,
  type SchemaTransactionalStorage,
  type SqlPrimitiveValue,
} from "../../src/db/schema.ts";
import { toGuardedBlob } from "../../src/lib/guards.ts";

const NOW_ISO = "2026-11-07T00:00:00.000Z";

/** Every table created by `ALL_SCHEMA_TABLE_DDL`, sorted lexicographically. */
const EXPECTED_TABLES = [
  "_sql_schema_migrations",
  "attempt_response_artifacts",
  "branch_lineage",
  "durable_work",
  "file_catalogue",
  "generation_attempts",
  "job_file_refs",
  "job_files",
  "job_index",
  "jobs",
  "judge_calls",
  "response_routes",
  "turn_candidates",
  "turns",
  "upload_intents",
  "webhook_inbox",
] as const;

/** Unique Durable Object name per `runInDurableObject` call (per-file isolation). */
let objectSequence = 0;

/**
 * Runs `callback` inside a `JobDO` instance whose SQLite schema was dropped
 * first, so the callback observes an empty database that it can build itself.
 */
function withEmptyStorage<T>(
  callback: (storage: SchemaTransactionalStorage) => T | Promise<T>
): Promise<T> {
  objectSequence += 1;
  const stub = env.JOB_DO.get(env.JOB_DO.idFromName(`schema-ddl-${objectSequence}`));
  return runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    return callback(state.storage as unknown as SchemaTransactionalStorage);
  });
}

/** Executes the real `ALL_SCHEMA_TABLE_DDL` statements against an empty DO database. */
function withSchema<T>(
  callback: (storage: SchemaTransactionalStorage) => T | Promise<T>
): Promise<T> {
  return withEmptyStorage((storage) => {
    for (const ddl of ALL_SCHEMA_TABLE_DDL) {
      storage.sql.exec(ddl);
    }
    return callback(storage);
  });
}

/** Lists user tables visible in the `main` schema (excluding SQLite internals). */
function tableNames(storage: SchemaTransactionalStorage): string[] {
  return storage.sql
    .exec<{ schema: string; name: string; type: string }>("PRAGMA table_list")
    .toArray()
    .filter(
      (table) => table.schema === "main" && table.type === "table" && !table.name.startsWith("sqlite_")
    )
    .map((table) => table.name)
    .sort();
}

/** Counts the rows currently stored in `table`. */
function countRows(storage: SchemaTransactionalStorage, table: string): number {
  return storage.sql.exec<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`).one().total;
}

/**
 * Asserts an insert is rejected by a CHECK constraint and that it left no row
 * behind (nothing was written silently).
 */
function expectRejectedInsert(
  storage: SchemaTransactionalStorage,
  table: string,
  query: string,
  ...bindings: SqlPrimitiveValue[]
): void {
  const before = countRows(storage, table);
  expect(() => storage.sql.exec(query, ...bindings), `insert into ${table} must be rejected`).toThrow(
    /CHECK constraint failed/i
  );
  expect(countRows(storage, table), `${table} must not gain a row`).toBe(before);
}

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("schema DDL validation", () => {
  it("executes every real CREATE TABLE statement and creates 16 STRICT tables", async () => {
    await withEmptyStorage((storage) => {
      for (const ddl of ALL_SCHEMA_TABLE_DDL) {
        expect(() => storage.sql.exec(ddl), ddl.slice(0, 80)).not.toThrow();
      }

      expect(ALL_SCHEMA_TABLE_DDL).toHaveLength(16);
      expect(tableNames(storage)).toEqual([...EXPECTED_TABLES]);

      const tableList = storage.sql
        .exec<{ schema: string; name: string; type: string; strict: number }>("PRAGMA table_list")
        .toArray();
      const userTables = tableList.filter(
        (table) => table.schema === "main" && table.type === "table" && !table.name.startsWith("sqlite_")
      );

      expect(userTables.map((table) => table.name).sort()).toEqual([...EXPECTED_TABLES]);
      for (const table of userTables) {
        expect(table.strict, `${table.name} must be a STRICT table`).toBe(1);
      }
    });
  });

  it("accepts one valid mock row in every table with guarded byte counts equal to blob lengths", async () => {
    await withSchema((storage) => {
      const prompt = toGuardedBlob("Write section 1 of the specification.", "turns.prompt_blob");
      const deliverable = toGuardedBlob("Section 1 content deliverable.", "deliverable_blob");
      const generationRequest = toGuardedBlob(
        '{"model":"gpt-5","background":true,"service_tier":"flex"}',
        "request_blob"
      );
      const generationResponse = toGuardedBlob(
        '{"id":"resp_001","status":"completed"}',
        "response_blob"
      );
      const judgeRequest = toGuardedBlob('{"model":"judge-1","input":"evaluate"}', "judge_request_blob");
      const webhookBody = toGuardedBlob('{"id":"evt_001","type":"response.completed"}', "raw_body_blob");

      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (?)", 1);

        storage.sql.exec(
          `INSERT INTO jobs (
            job_id, title, status, model, reasoning_effort, max_output_tokens,
            cache_ttl, web_search, judge_config_json, continuation_budget, continuations_used,
            auto_retry_budget, auto_retries_used, manual_retries_used, current_turn_index,
            total_turns, accepted_turn_index, active_attempt_id, last_accepted_response_id,
            last_judge_response_id, parent_job_id, fork_turn_index, revision,
            last_error_code, last_error_detail, warnings_json, usage_summary_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "job_001",
          "Spec Generation Job",
          "running",
          "gpt-5",
          "high",
          16384,
          "30m",
          1,
          '{"enabled":true,"transport":"responses","history_mode":"stateless","file_delivery_mode":"passthrough","model":"judge-1"}',
          3,
          0,
          1,
          0,
          0,
          1,
          3,
          0,
          "att_001",
          null,
          null,
          null,
          null,
          1,
          null,
          null,
          "[]",
          '{"input_tokens":120,"output_tokens":450}',
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO branch_lineage (
            job_id, parent_job_id, parent_revision, fork_turn_index,
            snapshot_bytes, snapshot_sha256, files_protected, parent_superseded, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "job_002",
          "job_001",
          1,
          1,
          4096,
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          1,
          1,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO job_files (
            file_id, turn_index, filename, mime_type, byte_size, sha256,
            introduced_in_judge_call_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          "file_abc123",
          1,
          "context.pdf",
          "application/pdf",
          102400,
          "a1b2c3d4",
          null,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO turns (
            turn_index, status, prompt_blob, prompt_bytes, row_bytes,
            attachment_file_ids_json, accepted_candidate_id, accepted_attempt_id,
            accepted_response_id, accepted_with_warning, marginal_input_tokens,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          1,
          "accepted",
          prompt.blob,
          prompt.byteLength,
          prompt.byteLength + 64,
          '["file_abc123"]',
          "cand_001",
          "att_001",
          "resp_001",
          0,
          512,
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO turn_candidates (
            candidate_id, turn_index, attempt_id, structural_status, parsed_tag_index,
            deliverable_blob, deliverable_bytes, row_bytes, accepted, warning_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "cand_001",
          1,
          "att_001",
          "valid",
          1,
          deliverable.blob,
          deliverable.byteLength,
          deliverable.byteLength + 48,
          1,
          "[]",
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO generation_attempts (
            attempt_id, turn_index, attempt_number, continuation_index, kind, status,
            idempotency_key, provider_response_id, parent_response_id, capacity_sends,
            next_backoff_at_ms, poll_probes, next_poll_at_ms, request_blob, request_bytes,
            row_bytes, usage_json, diagnostics_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "att_001",
          1,
          1,
          0,
          "initial",
          "completed",
          "idem_job_001_t1_a1",
          "resp_001",
          null,
          1,
          null,
          0,
          null,
          generationRequest.blob,
          generationRequest.byteLength,
          generationRequest.byteLength + 128,
          '{"input_tokens":120,"output_tokens":450}',
          "{}",
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO attempt_response_artifacts (
            attempt_id, turn_index, provider_response_id, response_blob, response_bytes,
            row_bytes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "att_001",
          1,
          "resp_001",
          generationResponse.blob,
          generationResponse.byteLength,
          generationResponse.byteLength + 32,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO judge_calls (
            judge_call_id, turn_index, candidate_id, attempt_id, transport,
            history_mode, file_delivery_mode, model, provider_response_id,
            previous_judge_response_id, status, verdict, grade, comment,
            tag_agreement, file_visibility, manifest_json, request_blob,
            request_bytes, row_bytes, usage_json, diagnostics_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "jcall_001",
          1,
          "cand_001",
          "att_001",
          "responses",
          "stateless",
          "passthrough",
          "judge-1",
          "jresp_001",
          null,
          "completed",
          "PASS",
          95,
          "Thorough and accurate.",
          1,
          1,
          '{"delivered_now":["file_abc123"],"inherited":[],"withheld":[]}',
          judgeRequest.blob,
          judgeRequest.byteLength,
          judgeRequest.byteLength + 128,
          '{"input_tokens":300,"output_tokens":60}',
          "{}",
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO durable_work (
            work_id, kind, attempt_id, turn_index, due_at_ms, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "work_001",
          "fallback_poll",
          "att_001",
          1,
          1762473600000,
          '{"probe":1}',
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO response_routes (
            response_id, job_id, attempt_id, turn_index, status, registered_at_ms,
            delivered_at_ms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "resp_001",
          "job_001",
          "att_001",
          1,
          "delivered",
          1762473500000,
          1762473510000,
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO webhook_inbox (
            webhook_id, event_type, response_id, job_id, delivery_timestamp_sec,
            received_at_ms, status, delivery_attempts, next_attempt_at_ms,
            raw_body_blob, raw_body_bytes, row_bytes, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "wh_001",
          "response.completed",
          "resp_001",
          "job_001",
          1762473505,
          1762473505123,
          "delivered",
          1,
          null,
          webhookBody.blob,
          webhookBody.byteLength,
          webhookBody.byteLength + 64,
          null,
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO job_index (
            job_id, title, status, model, parent_job_id, is_terminal, revision,
            current_turn_index, accepted_turn_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "job_001",
          "Spec Generation Job",
          "running",
          "gpt-5",
          null,
          0,
          1,
          2,
          1,
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO file_catalogue (
            file_id, sha256, filename, mime_type, byte_size, purpose, status,
            active_job_refs, retention_eligible_at_ms, created_at_ms, deleted_at_ms,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "file_abc123",
          "a1b2c3d4",
          "context.pdf",
          "application/pdf",
          102400,
          "user_data",
          "live",
          1,
          null,
          1762473000000,
          null,
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO upload_intents (
            intent_id, sha256, filename, mime_type, byte_size, status, file_id,
            expires_at_ms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "intent_001",
          "a1b2c3d4",
          "context.pdf",
          "application/pdf",
          102400,
          "uploaded",
          "file_abc123",
          1762477200000,
          NOW_ISO,
          NOW_ISO
        );

        storage.sql.exec(
          `INSERT INTO job_file_refs (job_id, file_id, is_non_terminal, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          "job_001",
          "file_abc123",
          1,
          NOW_ISO,
          NOW_ISO
        );
      });

      for (const table of EXPECTED_TABLES) {
        expect(countRows(storage, table), `${table} must hold exactly one mock row`).toBe(1);
      }

      const blobPairs = [
        { table: "turns", blob: "prompt_blob", bytes: "prompt_bytes", condition: "turn_index = 1" },
        {
          table: "turn_candidates",
          blob: "deliverable_blob",
          bytes: "deliverable_bytes",
          condition: "candidate_id = 'cand_001'",
        },
        {
          table: "generation_attempts",
          blob: "request_blob",
          bytes: "request_bytes",
          condition: "attempt_id = 'att_001'",
        },
        {
          table: "attempt_response_artifacts",
          blob: "response_blob",
          bytes: "response_bytes",
          condition: "attempt_id = 'att_001'",
        },
        {
          table: "judge_calls",
          blob: "request_blob",
          bytes: "request_bytes",
          condition: "judge_call_id = 'jcall_001'",
        },
        {
          table: "webhook_inbox",
          blob: "raw_body_blob",
          bytes: "raw_body_bytes",
          condition: "webhook_id = 'wh_001'",
        },
      ] as const;

      for (const pair of blobPairs) {
        const stored = storage.sql
          .exec<{ blob_length: number; byte_count: number }>(
            `SELECT length(${pair.blob}) AS blob_length, ${pair.bytes} AS byte_count
             FROM ${pair.table} WHERE ${pair.condition}`
          )
          .one();
        expect(stored.blob_length, `${pair.table}.${pair.bytes}`).toBe(stored.byte_count);
      }

      const turn = storage.sql
        .exec<{ prompt_blob: ArrayBuffer | Uint8Array; prompt_bytes: number; row_bytes: number }>(
          `SELECT prompt_blob, prompt_bytes, row_bytes FROM turns WHERE turn_index = 1`
        )
        .one();
      expect(turn.row_bytes).toBeGreaterThanOrEqual(turn.prompt_bytes);
      const promptBytes =
        turn.prompt_blob instanceof ArrayBuffer ? new Uint8Array(turn.prompt_blob) : turn.prompt_blob;
      expect(new TextDecoder().decode(promptBytes)).toBe("Write section 1 of the specification.");
    });
  });

  it("STRICT tables reject wrong column types and NOT NULL columns reject nulls", async () => {
    await withSchema((storage) => {
      expect(() =>
        storage.sql.exec(
          `INSERT INTO job_index (job_id, status, model, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          "job_text_in_integer",
          "running",
          "gpt-5",
          "not-an-integer",
          NOW_ISO,
          NOW_ISO
        )
      ).toThrow(/cannot store TEXT value in INTEGER column/i);
      expect(countRows(storage, "job_index")).toBe(0);

      expect(() =>
        storage.sql.exec(
          `INSERT INTO job_index (job_id, status, model, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          "job_blob_in_text",
          "running",
          new Uint8Array([1, 2, 3]),
          1,
          NOW_ISO,
          NOW_ISO
        )
      ).toThrow(/cannot store BLOB value in TEXT column/i);
      expect(countRows(storage, "job_index")).toBe(0);

      expect(() =>
        storage.sql.exec(
          `INSERT INTO job_index (job_id, status, model, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          "job_real_in_integer",
          "running",
          "gpt-5",
          1.5,
          NOW_ISO,
          NOW_ISO
        )
      ).toThrow(/cannot store REAL value in INTEGER column/i);
      expect(countRows(storage, "job_index")).toBe(0);

      expect(() =>
        storage.sql.exec(
          `INSERT INTO job_index (job_id, status, model, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          "job_null_model",
          "running",
          null,
          NOW_ISO,
          NOW_ISO
        )
      ).toThrow(/NOT NULL constraint failed: job_index\.model/i);
      expect(countRows(storage, "job_index")).toBe(0);

      expect(() =>
        storage.sql.exec(
          `INSERT INTO branch_lineage (
             job_id, parent_job_id, parent_revision, fork_turn_index,
             snapshot_bytes, snapshot_sha256, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          "job_null_sha",
          "job_parent",
          1,
          1,
          0,
          null,
          NOW_ISO
        )
      ).toThrow(/NOT NULL constraint failed: branch_lineage\.snapshot_sha256/i);
      expect(countRows(storage, "branch_lineage")).toBe(0);
    });
  });

  it("CHECK constraints reject artifact byte counts above 1,500,000 without writing", async () => {
    await withSchema((storage) => {
      const prompt = toGuardedBlob("prompt body", "turns.prompt_blob");
      const deliverable = toGuardedBlob("deliverable body", "deliverable_blob");
      const request = toGuardedBlob('{"model":"gpt-5"}', "request_blob");

      expectRejectedInsert(
        storage,
        "turns",
        `INSERT INTO turns (
           turn_index, status, prompt_blob, prompt_bytes, row_bytes,
           attachment_file_ids_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        1,
        "pending",
        prompt.blob,
        prompt.byteLength,
        1_500_001,
        "[]",
        NOW_ISO,
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "turns",
        `INSERT INTO turns (
           turn_index, status, prompt_blob, prompt_bytes, row_bytes,
           attachment_file_ids_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        2,
        "pending",
        prompt.blob,
        1_500_001,
        1_500_001,
        "[]",
        NOW_ISO,
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "turn_candidates",
        `INSERT INTO turn_candidates (
           candidate_id, turn_index, attempt_id, structural_status, parsed_tag_index,
           deliverable_blob, deliverable_bytes, row_bytes, accepted, warning_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "cand_oversized_bytes",
        1,
        "att_001",
        "valid",
        1,
        deliverable.blob,
        1_500_001,
        1_500_001,
        0,
        "[]",
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "turn_candidates",
        `INSERT INTO turn_candidates (
           candidate_id, turn_index, attempt_id, structural_status, parsed_tag_index,
           deliverable_blob, deliverable_bytes, row_bytes, accepted, warning_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "cand_oversized_row",
        1,
        "att_001",
        "valid",
        1,
        deliverable.blob,
        deliverable.byteLength,
        1_500_001,
        0,
        "[]",
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "generation_attempts",
        `INSERT INTO generation_attempts (
           attempt_id, turn_index, attempt_number, continuation_index, kind, status,
           idempotency_key, request_blob, request_bytes, row_bytes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "att_oversized",
        1,
        1,
        0,
        "initial",
        "prepared",
        "idem_oversized",
        request.blob,
        1_500_001,
        1_500_001,
        NOW_ISO,
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "attempt_response_artifacts",
        `INSERT INTO attempt_response_artifacts (
           attempt_id, turn_index, provider_response_id, response_blob, response_bytes,
           row_bytes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "att_oversized",
        1,
        "resp_oversized",
        request.blob,
        1_500_001,
        1_500_001,
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "judge_calls",
        `INSERT INTO judge_calls (
           judge_call_id, turn_index, candidate_id, attempt_id, transport, history_mode,
           file_delivery_mode, model, status, request_blob, request_bytes, row_bytes,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "jcall_oversized",
        1,
        "cand_001",
        "att_001",
        "responses",
        "stateless",
        "passthrough",
        "judge-1",
        "pending",
        request.blob,
        1_500_001,
        1_500_001,
        NOW_ISO,
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "webhook_inbox",
        `INSERT INTO webhook_inbox (
           webhook_id, event_type, response_id, delivery_timestamp_sec, received_at_ms,
           status, raw_body_blob, raw_body_bytes, row_bytes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "wh_oversized",
        "response.completed",
        "resp_oversized",
        1762473505,
        1762473505123,
        "unmatched",
        request.blob,
        1_500_001,
        1_500_001,
        NOW_ISO,
        NOW_ISO
      );
    });
  });

  it("enforces the 8,000,000-byte snapshot and 16,000,000-byte upload CHECK constraints", async () => {
    await withSchema((storage) => {
      storage.sql.exec(
        `INSERT INTO branch_lineage (
           job_id, parent_job_id, parent_revision, fork_turn_index,
           snapshot_bytes, snapshot_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "job_branch_exact",
        "job_parent",
        1,
        1,
        8_000_000,
        "sha_exact",
        NOW_ISO
      );
      expect(countRows(storage, "branch_lineage")).toBe(1);

      expectRejectedInsert(
        storage,
        "branch_lineage",
        `INSERT INTO branch_lineage (
           job_id, parent_job_id, parent_revision, fork_turn_index,
           snapshot_bytes, snapshot_sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "job_branch_over",
        "job_parent",
        1,
        1,
        8_000_001,
        "sha_over",
        NOW_ISO
      );

      storage.sql.exec(
        `INSERT INTO file_catalogue (
           file_id, sha256, filename, mime_type, byte_size, purpose, status,
           active_job_refs, created_at_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "file_exact",
        "sha_file_exact",
        "exact.bin",
        "application/octet-stream",
        16_000_000,
        "user_data",
        "live",
        0,
        1762473000000,
        NOW_ISO,
        NOW_ISO
      );
      expect(countRows(storage, "file_catalogue")).toBe(1);

      expectRejectedInsert(
        storage,
        "file_catalogue",
        `INSERT INTO file_catalogue (
           file_id, sha256, filename, mime_type, byte_size, purpose, status,
           active_job_refs, created_at_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "file_over",
        "sha_file_over",
        "over.bin",
        "application/octet-stream",
        16_000_001,
        "user_data",
        "live",
        0,
        1762473000000,
        NOW_ISO,
        NOW_ISO
      );

      expectRejectedInsert(
        storage,
        "file_catalogue",
        `INSERT INTO file_catalogue (
           file_id, sha256, filename, mime_type, byte_size, purpose, status,
           active_job_refs, created_at_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "file_negative",
        "sha_file_negative",
        "negative.bin",
        "application/octet-stream",
        -1,
        "user_data",
        "live",
        0,
        1762473000000,
        NOW_ISO,
        NOW_ISO
      );

      storage.sql.exec(
        `INSERT INTO job_files (file_id, turn_index, filename, mime_type, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "file_job_exact",
        1,
        "exact.bin",
        "application/octet-stream",
        16_000_000,
        "sha_job_exact",
        NOW_ISO
      );
      expect(countRows(storage, "job_files")).toBe(1);

      expectRejectedInsert(
        storage,
        "job_files",
        `INSERT INTO job_files (file_id, turn_index, filename, mime_type, byte_size, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        "file_job_over",
        1,
        "over.bin",
        "application/octet-stream",
        16_000_001,
        "sha_job_over",
        NOW_ISO
      );

      storage.sql.exec(
        `INSERT INTO upload_intents (
           intent_id, sha256, filename, mime_type, byte_size, status, expires_at_ms,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "intent_exact",
        "sha_intent_exact",
        "exact.bin",
        "application/octet-stream",
        16_000_000,
        "pending",
        1762477200000,
        NOW_ISO,
        NOW_ISO
      );
      expect(countRows(storage, "upload_intents")).toBe(1);

      expectRejectedInsert(
        storage,
        "upload_intents",
        `INSERT INTO upload_intents (
           intent_id, sha256, filename, mime_type, byte_size, status, expires_at_ms,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "intent_over",
        "sha_intent_over",
        "over.bin",
        "application/octet-stream",
        16_000_001,
        "pending",
        1762477200000,
        NOW_ISO,
        NOW_ISO
      );
    });
  });

  it("matches the frozen status vocabularies and rejects legacy status values", async () => {
    await withSchema((storage) => {
      const prompt = toGuardedBlob("turn prompt", "turns.prompt_blob");
      const deliverable = toGuardedBlob("deliverable body", "deliverable_blob");
      const request = toGuardedBlob('{"model":"gpt-5"}', "request_blob");
      const judgeRequest = toGuardedBlob('{"model":"judge-1"}', "judge_request_blob");

      const insertJob = (jobId: string, status: string): void => {
        storage.sql.exec(
          `INSERT INTO jobs (
             job_id, status, model, reasoning_effort, max_output_tokens, cache_ttl,
             judge_config_json, total_turns, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          jobId,
          status,
          "gpt-5",
          "high",
          1024,
          "nocache",
          "{}",
          1,
          NOW_ISO,
          NOW_ISO
        );
      };

      insertJob("job_ready", "ready");
      insertJob("job_operator_pause", "paused_operator");
      expect(countRows(storage, "jobs")).toBe(2);

      for (const legacyStatus of ["paused_ambiguous_dispatch", "paused_storage_error"]) {
        expectRejectedInsert(
          storage,
          "jobs",
          `INSERT INTO jobs (
             job_id, status, model, reasoning_effort, max_output_tokens, cache_ttl,
             judge_config_json, total_turns, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          `job_${legacyStatus}`,
          legacyStatus,
          "gpt-5",
          "high",
          1024,
          "nocache",
          "{}",
          1,
          NOW_ISO,
          NOW_ISO
        );
      }

      expectRejectedInsert(
        storage,
        "jobs",
        `INSERT INTO jobs (
           job_id, status, model, reasoning_effort, max_output_tokens, cache_ttl,
           judge_config_json, total_turns, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        "job_cache_24h",
        "ready",
        "gpt-5",
        "high",
        1024,
        "24h",
        "{}",
        1,
        NOW_ISO,
        NOW_ISO
      );

      const insertTurn = (turnIndex: number, status: string): void => {
        storage.sql.exec(
          `INSERT INTO turns (
             turn_index, status, prompt_blob, prompt_bytes, row_bytes,
             attachment_file_ids_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          turnIndex,
          status,
          prompt.blob,
          prompt.byteLength,
          prompt.byteLength,
          "[]",
          NOW_ISO,
          NOW_ISO
        );
      };

      insertTurn(1, "awaiting_judge");
      insertTurn(2, "accepted_with_warning");
      expect(countRows(storage, "turns")).toBe(2);

      expectRejectedInsert(
        storage,
        "turns",
        `INSERT INTO turns (
           turn_index, status, prompt_blob, prompt_bytes, row_bytes,
           attachment_file_ids_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        3,
        "judging",
        prompt.blob,
        prompt.byteLength,
        prompt.byteLength,
        "[]",
        NOW_ISO,
        NOW_ISO
      );

      const insertCandidate = (candidateId: string, structuralStatus: string): void => {
        storage.sql.exec(
          `INSERT INTO turn_candidates (
             candidate_id, turn_index, attempt_id, structural_status, parsed_tag_index,
             deliverable_blob, deliverable_bytes, row_bytes, accepted, warning_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          candidateId,
          1,
          "att_001",
          structuralStatus,
          null,
          deliverable.blob,
          deliverable.byteLength,
          deliverable.byteLength,
          0,
          "[]",
          NOW_ISO
        );
      };

      insertCandidate("cand_valid", "valid");
      insertCandidate("cand_trailing_content", "trailing_content");
      insertCandidate("cand_malformed_tag", "malformed_tag");
      expect(countRows(storage, "turn_candidates")).toBe(3);

      const insertAttempt = (attemptId: string, status: string): void => {
        storage.sql.exec(
          `INSERT INTO generation_attempts (
             attempt_id, turn_index, attempt_number, continuation_index, kind, status,
             idempotency_key, request_blob, request_bytes, row_bytes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          attemptId,
          1,
          1,
          0,
          "initial",
          status,
          `idem_${attemptId}`,
          request.blob,
          request.byteLength,
          request.byteLength,
          NOW_ISO,
          NOW_ISO
        );
      };

      insertAttempt("att_capacity_exhausted", "capacity_exhausted");
      insertAttempt("att_refused", "refused");
      insertAttempt("att_capacity_backoff", "capacity_backoff");
      expect(countRows(storage, "generation_attempts")).toBe(3);

      const JUDGE_CALL_INSERT_SQL = `INSERT INTO judge_calls (
         judge_call_id, turn_index, candidate_id, attempt_id, transport, history_mode,
         file_delivery_mode, model, status, verdict, grade, comment, tag_agreement,
         file_visibility, request_blob, request_bytes, row_bytes, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      const insertJudgeCall = (
        judgeCallId: string,
        status: string,
        verdict: string | null,
        grade: number | null,
        comment: string | null,
        tagAgreement: number | null,
        fileVisibility: number | null
      ): void => {
        storage.sql.exec(
          JUDGE_CALL_INSERT_SQL,
          judgeCallId,
          1,
          "cand_valid",
          "att_refused",
          "responses",
          "stateless",
          "passthrough",
          "judge-1",
          status,
          verdict,
          grade,
          comment,
          tagAgreement,
          fileVisibility,
          judgeRequest.blob,
          judgeRequest.byteLength,
          judgeRequest.byteLength,
          NOW_ISO,
          NOW_ISO
        );
      };

      insertJudgeCall("jcall_pending", "pending", null, null, null, null, null);
      insertJudgeCall("jcall_unknown", "unknown", "UNKNOWN", null, null, null, null);
      insertJudgeCall("jcall_complete", "completed", "PASS", 95, "Accurate.", 1, 1);
      expect(countRows(storage, "judge_calls")).toBe(3);

      const incompleteJudgeRows = [
        ["jcall_completed_no_verdict", null, 95, "Accurate.", 1, 1],
        ["jcall_completed_no_grade", "PASS", null, "Accurate.", 1, 1],
        ["jcall_completed_no_comment", "PASS", 95, null, 1, 1],
        ["jcall_completed_no_tag_agreement", "PASS", 95, "Accurate.", null, 1],
        ["jcall_completed_no_file_visibility", "PASS", 95, "Accurate.", 1, null],
      ] as const;

      for (const [judgeCallId, verdict, grade, comment, tagAgreement, fileVisibility] of incompleteJudgeRows) {
        expectRejectedInsert(
          storage,
          "judge_calls",
          JUDGE_CALL_INSERT_SQL,
          judgeCallId,
          1,
          "cand_valid",
          "att_refused",
          "responses",
          "stateless",
          "passthrough",
          "judge-1",
          "completed",
          verdict,
          grade,
          comment,
          tagAgreement,
          fileVisibility,
          judgeRequest.blob,
          judgeRequest.byteLength,
          judgeRequest.byteLength,
          NOW_ISO,
          NOW_ISO
        );
      }
    });
  });
});

describe("durable object sqlite storage contract", () => {
  it("reports cursor row counts, enforces one(), and rolls back on synchronous throws", async () => {
    await withSchema((storage) => {
      const writeCursor = storage.sql.exec(
        `INSERT INTO durable_work (work_id, kind, due_at_ms, created_at) VALUES (?, ?, ?, ?)`,
        "work_fixture",
        "cleanup",
        1,
        NOW_ISO
      );
      expect(writeCursor.rowsWritten).toBeGreaterThanOrEqual(1);
      expect(writeCursor.toArray()).toEqual([]);

      const readCursor = storage.sql.exec("SELECT work_id FROM durable_work");
      expect(readCursor.rowsRead).toBe(1);
      expect(readCursor.rowsWritten).toBe(0);
      expect(readCursor.one().work_id).toBe("work_fixture");
      expect(() =>
        storage.sql.exec("SELECT work_id FROM durable_work WHERE work_id = ?", "missing").one()
      ).toThrow(/exactly one result/i);

      storage.sql.exec(
        `INSERT INTO durable_work (work_id, kind, due_at_ms, created_at) VALUES (?, ?, ?, ?)`,
        "work_second",
        "cleanup",
        2,
        NOW_ISO
      );
      expect(() => storage.sql.exec("SELECT work_id FROM durable_work").one()).toThrow(
        /exactly one result/i
      );

      expect(() =>
        storage.transactionSync(() => {
          storage.sql.exec(
            `INSERT INTO durable_work (work_id, kind, due_at_ms, created_at) VALUES (?, ?, ?, ?)`,
            "work_rolled_back",
            "cleanup",
            3,
            NOW_ISO
          );
          throw new Error("simulated synchronous failure");
        })
      ).toThrow(/simulated synchronous failure/i);

      expect(countRows(storage, "durable_work")).toBe(2);
      expect(
        storage.sql
          .exec<{ total: number }>("SELECT COUNT(*) AS total FROM durable_work WHERE work_id = ?", "work_rolled_back")
          .one().total
      ).toBe(0);
    });
  });
});