// Covers: 3, 4, 5, 24

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ArtifactGuardError } from "../../src/lib/guards.ts";
import { RegistryDO } from "../../src/do/registry-do.ts";
import type { JobStatus, JobSummaryItem } from "../../src/types.ts";

/** Distinct object name per test; each test owns its own global registry. */
let registrySequence = 0;

function nextRegistryStub(): DurableObjectStub {
  registrySequence += 1;
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(`registry-do-test-${registrySequence}`));
}

async function withRegistry<T>(
  callback: (registry: RegistryDO, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return await runInDurableObject(nextRegistryStub(), async (instance, state) => {
    return await callback(instance as RegistryDO, state);
  });
}

function jobSummary(jobId: string, status: JobStatus = "ready"): JobSummaryItem {
  const createdAt = Date.UTC(2026, 0, 1);
  return {
    jobId,
    title: `title-${jobId}`,
    status,
    model: "model-test",
    currentTurnIndex: 1,
    acceptedTurnCount: 0,
    totalEstimatedCostUsd: null,
    createdAtMs: createdAt,
    updatedAtMs: createdAt,
  };
}

interface IndexRow extends Record<string, SqlStorageValue> {
  status: string;
  is_terminal: number;
  revision: number;
  current_turn_index: number;
  accepted_turn_count: number;
}

interface CatalogueRow extends Record<string, SqlStorageValue> {
  status: string;
  active_job_refs: number;
  deleted_at_ms: number | null;
}

interface IntentRow extends Record<string, SqlStorageValue> {
  status: string;
  file_id: string | null;
}

function indexRow(state: DurableObjectState, jobId: string): IndexRow {
  return state.storage.sql
    .exec<IndexRow>(
      "SELECT status, is_terminal, revision, current_turn_index, accepted_turn_count FROM job_index WHERE job_id = ?",
      jobId,
    )
    .one();
}

function catalogueRow(state: DurableObjectState, fileId: string): CatalogueRow {
  return state.storage.sql
    .exec<CatalogueRow>(
      "SELECT status, active_job_refs, deleted_at_ms FROM file_catalogue WHERE file_id = ?",
      fileId,
    )
    .one();
}

function intentRow(state: DurableObjectState, intentId: string): IntentRow {
  return state.storage.sql
    .exec<IntentRow>("SELECT status, file_id FROM upload_intents WHERE intent_id = ?", intentId)
    .one();
}

describe("RegistryDO job index", () => {
  it("registers idempotently, pages by job id, and ignores stale revisions", async () => {
    await withRegistry(async (registry, state) => {
      await registry.registerJob(jobSummary("job-b"));
      await registry.registerJob(jobSummary("job-a"));

      const first = await registry.listJobs({ limit: 1 });
      expect(first.items.map((item) => item.jobId)).toEqual(["job-a"]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe("job-a");

      const second = await registry.listJobs({ cursor: first.nextCursor, limit: 1 });
      expect(second.items.map((item) => item.jobId)).toEqual(["job-b"]);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();

      await registry.updateJobIndexStatus("job-a", "completed", 3, 4, 2);
      expect(indexRow(state, "job-a")).toMatchObject({
        status: "completed",
        is_terminal: 1,
        revision: 3,
        current_turn_index: 4,
        accepted_turn_count: 2,
      });

      await registry.updateJobIndexStatus("job-a", "running", 2, 9, 9);
      expect(indexRow(state, "job-a")).toMatchObject({
        status: "completed",
        is_terminal: 1,
        revision: 3,
      });

      const updatedPage = await registry.listJobs({ limit: 10 });
      const updated = updatedPage.items.find((item) => item.jobId === "job-a");
      expect(updated).toMatchObject({
        currentTurnIndex: 4,
        acceptedTurnCount: 2,
      });

      // Repeated registration never resets an advanced revision or status.
      await registry.registerJob(jobSummary("job-a", "ready"));
      expect(indexRow(state, "job-a")).toMatchObject({
        status: "completed",
        is_terminal: 1,
        revision: 3,
      });
      expect(
        state.storage.sql.exec("SELECT COUNT(*) AS total FROM job_index").one().total,
      ).toBe(2);
    });
  });
});

describe("RegistryDO file catalogue and uploads", () => {
  it("dedupes live content hashes and enforces the upload byte bound", async () => {
    await withRegistry(async (registry) => {
      const first = await registry.recordFileUpload({
        fileId: "file-1",
        sha256: "hash-1",
        filename: "context.txt",
        mimeType: "text/plain",
        byteSize: 1024,
      });
      expect(first).toMatchObject({
        fileId: "file-1",
        sha256Hex: "hash-1",
        activeJobRefCount: 0,
        deletedFromProviderAtMs: null,
      });

      const duplicate = await registry.recordFileUpload({
        fileId: "file-2",
        sha256: "hash-1",
        filename: "context.txt",
        mimeType: "text/plain",
        byteSize: 1024,
      });
      expect(duplicate.fileId).toBe("file-1");

      expect((await registry.findFileByHash("hash-1"))?.fileId).toBe("file-1");
      expect(await registry.findFileByHash("hash-missing")).toBeNull();
      expect(await registry.getFile("file-2")).toBeNull();

      await expect(
        registry.recordFileUpload({
          fileId: "file-too-large",
          sha256: "hash-large",
          filename: "large.bin",
          mimeType: "application/octet-stream",
          byteSize: 16_000_001,
        }),
      ).rejects.toBeInstanceOf(ArtifactGuardError);

      await expect(
        registry.beginUploadIntent({
          intentId: "intent-too-large",
          sha256: "hash-large",
          filename: "large.bin",
          mimeType: "application/octet-stream",
          byteSize: 16_000_001,
          expiresAtMs: Date.now() + 60_000,
        }),
      ).rejects.toBeInstanceOf(ArtifactGuardError);
    });
  });

  it("lists catalogue metadata with primary-key cursors and no file bytes", async () => {
    await withRegistry(async (registry) => {
      for (const suffix of ["c", "a", "b"]) {
        await registry.recordFileUpload({
          fileId: `file-${suffix}`,
          sha256: `hash-${suffix}`,
          filename: `${suffix}.txt`,
          mimeType: "text/plain",
          byteSize: 3,
        });
      }

      const first = await registry.listFiles({ limit: 2 });
      expect(first.items.map((file) => file.fileId)).toEqual(["file-a", "file-b"]);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBe("file-b");

      const second = await registry.listFiles({ cursor: first.nextCursor, limit: 2 });
      expect(second.items.map((file) => file.fileId)).toEqual(["file-c"]);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
    });
  });

  it("drives upload intents through completion and rejects late completion", async () => {
    await withRegistry(async (registry, state) => {
      const file = await registry.recordFileUpload({
        fileId: "file-intent",
        sha256: "hash-intent",
        filename: "intent.txt",
        mimeType: "text/plain",
        byteSize: 4,
      });

      const expiresAtMs = Date.now() + 60_000;
      const pending = await registry.beginUploadIntent({
        intentId: "intent-1",
        sha256: "hash-intent",
        filename: "intent.txt",
        mimeType: "text/plain",
        byteSize: 4,
        expiresAtMs,
      });
      expect(pending.status).toBe("pending");
      // One alarm, scheduled against the earliest obligation (the intent expiry).
      expect(await state.storage.getAlarm()).toBe(expiresAtMs);

      await registry.completeUploadIntent("intent-1", file.fileId);
      const completed = await registry.beginUploadIntent({
        intentId: "intent-1",
        sha256: "hash-intent",
        filename: "intent.txt",
        mimeType: "text/plain",
        byteSize: 4,
        expiresAtMs: Date.now() + 60_000,
      });
      expect(completed.status).toBe("completed");
      expect(completed.fileId).toBe("file-intent");

      // Reusing an intent id for different content is a conflict, not a silent overwrite.
      await expect(
        registry.beginUploadIntent({
          intentId: "intent-1",
          sha256: "hash-other",
          filename: "other.txt",
          mimeType: "text/plain",
          byteSize: 4,
          expiresAtMs: Date.now() + 60_000,
        }),
      ).rejects.toThrow(/different content/);

      const expiredAtMs = Date.now() - 1;
      await registry.beginUploadIntent({
        intentId: "intent-expired",
        sha256: "hash-expired",
        filename: "expired.txt",
        mimeType: "text/plain",
        byteSize: 4,
        expiresAtMs: expiredAtMs,
      });
      await expect(
        registry.completeUploadIntent("intent-expired", "file-late"),
      ).rejects.toThrow(/expired/);
    });
  });
});

describe("RegistryDO reference protection", () => {
  it("protects and releases each (job, file) pair exactly once", async () => {
    await withRegistry(async (registry, state) => {
      await registry.recordFileUpload({
        fileId: "file-protected",
        sha256: "hash-protected",
        filename: "protected.txt",
        mimeType: "text/plain",
        byteSize: 8,
      });

      await registry.protectJobFileRefs("job-protect", [
        "file-protected",
        "file-protected",
      ]);
      await registry.protectJobFileRefs("job-protect", ["file-protected"]);
      expect(catalogueRow(state, "file-protected").active_job_refs).toBe(1);

      await registry.releaseJobFileRefs("job-protect");
      await registry.releaseJobFileRefs("job-protect");
      expect(catalogueRow(state, "file-protected").active_job_refs).toBe(0);

      // Reactivation after release increments once again.
      await registry.protectJobFileRefs("job-protect", ["file-protected"]);
      expect(catalogueRow(state, "file-protected").active_job_refs).toBe(1);
    });
  });
});

describe("RegistryDO retention", () => {
  it("deletes only eligible unreferenced files, treating provider 404 as deleted", async () => {
    await withRegistry(async (registry, state) => {
      await registry.recordFileUpload({
        fileId: "file-sweep",
        sha256: "hash-sweep",
        filename: "sweep.txt",
        mimeType: "text/plain",
        byteSize: 5,
      });
      await registry.recordFileUpload({
        fileId: "file-fresh",
        sha256: "hash-fresh",
        filename: "fresh.txt",
        mimeType: "text/plain",
        byteSize: 5,
      });
      await registry.protectJobFileRefs("job-retained", ["file-fresh"]);

      // Make only the unreferenced file due now without moving the future alarm.
      state.storage.sql.exec(
        "UPDATE file_catalogue SET retention_eligible_at_ms = 1 WHERE file_id = ?",
        "file-sweep",
      );

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(null, { status: 404 });
      try {
        const counts = await registry.runRetentionSweep();
        expect(counts).toEqual({ deleted: 1, retained: 1, failed: 0 });
      } finally {
        globalThis.fetch = originalFetch;
      }

      const swept = catalogueRow(state, "file-sweep");
      expect(swept.status).toBe("deleted");
      expect(swept.deleted_at_ms).not.toBeNull();
      expect(catalogueRow(state, "file-fresh")).toMatchObject({
        status: "live",
        active_job_refs: 1,
      });
    });
  });

  it("expires pending upload intents through the single alarm", async () => {
    const stub = nextRegistryStub();
    await runInDurableObject(stub, async (instance, state) => {
      const registry = instance as RegistryDO;
      await registry.beginUploadIntent({
        intentId: "intent-alarm",
        sha256: "hash-alarm",
        filename: "alarm.txt",
        mimeType: "text/plain",
        byteSize: 4,
        expiresAtMs: Date.now() + 60_000,
      });
      // Make the intent just-expired without moving the already-scheduled alarm.
      state.storage.sql.exec(
        "UPDATE upload_intents SET expires_at_ms = ? WHERE intent_id = ?",
        Date.now() - 1_000,
        "intent-alarm",
      );
      expect(intentRow(state, "intent-alarm").status).toBe("pending");
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(intentRow(state, "intent-alarm").status).toBe("ambiguous");
      // An ambiguity record older than a full retention window is cleaned up.
      state.storage.sql.exec(
        "UPDATE upload_intents SET expires_at_ms = 1 WHERE intent_id = ?",
        "intent-alarm",
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(intentRow(state, "intent-alarm").status).toBe("cleaned");
    });
  });
});