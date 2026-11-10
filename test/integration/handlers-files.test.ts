// Covers: 3, 4
import { env, exports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REGISTRY_DO_NAME } from "../../src/constants.ts";
import type {
  FileCatalogueRecord,
  FileUploadIntentRecord,
} from "../../src/types.ts";

// cloudflare:workers does not model the test worker's default export in this typing context.
const workerExports = exports as unknown as { readonly default: Fetcher };
const mainWorker = workerExports.default;

const APP_ORIGIN = "https://app.test";
const APP_HOST = "app.test";
const FILES_PATH = `https://${APP_HOST}/api/files`;
const PROVIDER_FILES_PATH = "/v1/files";

// ---------------------------------------------------------------------------
// Buffers. Allocated once per file, never string-built. Small payloads pin
// exact byte content (including non-UTF8 bytes, so a string re-encoding would
// change the hash); the two boundary buffers exist only for the single
// 16,000,000 / 16,000,001 test below.
// ---------------------------------------------------------------------------
const SMALL_BYTES = new Uint8Array([
  104, 101, 108, 108, 111, 44, 32, 102, 108, 101, 120, 33, 0, 255, 254, 13, 10,
]);
const DEDUPE_BYTES = new Uint8Array([
  222, 173, 190, 239, 0, 1, 2, 3, 240, 241, 242, 128, 129, 130, 10, 13,
]);
const RETRY_BYTES = new Uint8Array([7, 7, 7, 9, 0, 200, 201, 202, 10]);
const BOUNDARY_ACCEPT_BYTES = new Uint8Array(16_000_000);
BOUNDARY_ACCEPT_BYTES.fill(0x41);
const BOUNDARY_REJECT_BYTES = new Uint8Array(16_000_001);
BOUNDARY_REJECT_BYTES.fill(0x42);

const utf8 = new TextEncoder();

interface CatalogueWire {
  readonly fileId: string;
  readonly sha256Hex: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly activeJobRefCount: number;
  readonly uploadedAtMs: number;
  readonly lastReferencedAtMs: number;
  readonly deletedFromProviderAtMs: number | null;
}

interface UploadedWire {
  readonly kind: "uploaded";
  readonly file: CatalogueWire;
  readonly deduplicated: boolean;
}

interface CapturedUpload {
  readonly url: string;
  readonly method: string;
  readonly bodyBytes: Uint8Array;
}

type RegistryUploadRpc = {
  beginUploadIntent(input: {
    readonly intentId: string;
    readonly sha256: string;
    readonly filename: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly expiresAtMs: number;
  }): Promise<FileUploadIntentRecord>;
  completeUploadIntent(intentId: string, fileId: string): Promise<void>;
  findFileByHash(sha256: string): Promise<FileCatalogueRecord | null>;
};

function registryStub(): DurableObjectStub {
  // Single lockstep seam: the singleton registry name is pinned in one place
  // for afterEach teardown, the RPC view, and alarm driving alike.
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName(REGISTRY_DO_NAME));
}

function registryRpc(): RegistryUploadRpc {
  const stub: unknown = registryStub();
  if (stub === null || typeof stub !== "object") {
    throw new Error("Registry stub is not an object");
  }
  if (
    !("beginUploadIntent" in stub) ||
    !("completeUploadIntent" in stub) ||
    !("findFileByHash" in stub)
  ) {
    throw new Error("Registry stub lacks the upload RPC surface");
  }
  return stub as RegistryUploadRpc;
}

/** Lowercase SHA-256 hex over the exact bytes, mirroring the handler. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

function providerJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stubs global fetch for the OpenAI Files API only. Every other hostname fails
 * loudly, so no test can pass while touching the real network.
 */
function installFilesMock(
  resolveId: (callIndex: number) => string,
  responder?: (callIndex: number) => Response,
): CapturedUpload[] {
  const captured: CapturedUpload[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const parsed = new URL(url);
      if (parsed.hostname !== "api.openai.com") {
        throw new Error(`Unexpected network call: ${method} ${url}`);
      }
      if (parsed.pathname !== PROVIDER_FILES_PATH || method !== "POST") {
        throw new Error(`Unexpected Files API call: ${method} ${url}`);
      }
      const probe = new Request(url, {
        method,
        headers: init?.headers,
        body: init?.body,
      });
      const bodyBytes = new Uint8Array(await probe.arrayBuffer());
      const callIndex = captured.length;
      captured.push({ url, method, bodyBytes });
      if (responder !== undefined) {
        return responder(callIndex);
      }
      const fileId = resolveId(callIndex);
      return providerJson({ id: fileId, bytes: bodyBytes.byteLength, filename: "echo" });
    }),
  );
  return captured;
}

async function postFile(
  bytes: Uint8Array,
  filename: string,
  fields: ReadonlyArray<readonly [string, string]> = [],
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: "application/octet-stream" }));
  for (const [name, value] of fields) {
    form.append(name, value);
  }
  return mainWorker.fetch(FILES_PATH, {
    method: "POST",
    headers: { origin: APP_ORIGIN },
    body: form,
  });
}

async function expectErrorCode(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly error: { readonly code: string; readonly message: string };
  };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.message.length).toBeGreaterThan(0);
}

async function expectUploadRejection(
  response: Response,
  status: number,
  code: "file_too_large" | "invalid_multipart" | "unsupported_input" | "provider_error",
): Promise<void> {
  // Upload rejections render as the `rejected` FileUploadResult variant
  // (`{kind, code, message}`), not the generic `{error:{code}}` envelope.
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    readonly kind: string;
    readonly code: string;
    readonly message: string;
  };
  expect(body.kind).toBe("rejected");
  expect(body.code).toBe(code);
  expect(typeof body.message).toBe("string");
  expect(body.message.length).toBeGreaterThan(0);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  // Settle the singleton registry alarm before reset: alarms ignore isolated
  // storage and would otherwise bleed into the next test.
  await runInDurableObject(registryStub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
  await reset();
  await abortAllDurableObjects();
});

describe("Files API upload contract", () => {
  it("uploads bytes with purpose user_data and returns a catalogue-readable file_id", async () => {
    const captured = installFilesMock(() => "file-small-1");
    const expectedSha = await sha256Hex(SMALL_BYTES);

    const response = await postFile(SMALL_BYTES, "small.txt");
    expect(response.status).toBe(200);
    const body = (await response.json()) as UploadedWire;
    expect(body.kind).toBe("uploaded");
    expect(body.deduplicated).toBe(false);
    expect(body.file.fileId).toBe("file-small-1");
    expect(body.file.sha256Hex).toBe(expectedSha);
    expect(body.file.byteSize).toBe(SMALL_BYTES.byteLength);

    // The purpose proof is the outbound provider request bytes: the Files API
    expect(captured).toHaveLength(1);
    const sent = captured[0];
    if (sent === undefined) {
      throw new Error("Expected one captured Files API upload");
    }
    expect(containsBytes(sent.bodyBytes, utf8.encode('name="purpose"'))).toBe(true);
    expect(containsBytes(sent.bodyBytes, utf8.encode("user_data"))).toBe(true);
    expect(containsBytes(sent.bodyBytes, SMALL_BYTES)).toBe(true);
    expect(containsBytes(sent.bodyBytes, utf8.encode("small.txt"))).toBe(true);

    const catalogue = await mainWorker.fetch(`${FILES_PATH}/file-small-1`);
    expect(catalogue.status).toBe(200);
    const record = (await catalogue.json()) as CatalogueWire;
    expect(record).toMatchObject({
      fileId: "file-small-1",
      sha256Hex: expectedSha,
      byteSize: SMALL_BYTES.byteLength,
    });

    await expectErrorCode(
      await mainWorker.fetch(`${FILES_PATH}/file-no-such-file`),
      404,
      "not_found",
    );
  });

  it("rejects inline text, base64, and file_url submission forms at the interface", async () => {
    const captured = installFilesMock(() => "file-never-1");

    const json = await mainWorker.fetch(FILES_PATH, {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    await expectUploadRejection(json, 415, "unsupported_input");

    const stringFile = new FormData();
    stringFile.append("file", "this is inline text, not an upload");
    const stringField = await mainWorker.fetch(FILES_PATH, {
      method: "POST",
      headers: { origin: APP_ORIGIN },
      body: stringFile,
    });
    await expectUploadRejection(stringField, 415, "unsupported_input");

    for (const field of [
      "text",
      "content",
      "base64",
      "Base64",
      "inline_text",
      "file_url",
      "FILE_URL",
      "data",
    ]) {
      const response = await postFile(SMALL_BYTES, "note.txt", [[field, "smuggled"]]);
      await expectUploadRejection(response, 415, "unsupported_input");
    }

    expect(captured).toHaveLength(0);
  });

  it("rejects malformed multipart envelopes without reaching the provider", async () => {
    const captured = installFilesMock(() => "file-never-2");

    const missing = new FormData();
    missing.append("turnIndex", "1");
    await expectUploadRejection(
      await mainWorker.fetch(FILES_PATH, {
        method: "POST",
        headers: { origin: APP_ORIGIN },
        body: missing,
      }),
      400,
      "invalid_multipart",
    );

    const unexpected = await postFile(SMALL_BYTES, "note.txt", [["mystery", "x"]]);
    await expectUploadRejection(unexpected, 400, "invalid_multipart");

    expect(captured).toHaveLength(0);
  });

  it("accepts exactly 16,000,000 bytes and explicitly rejects 16,000,001", async () => {
    const captured = installFilesMock((callIndex) => `file-boundary-${callIndex}`);
    const expectedSha = await sha256Hex(BOUNDARY_ACCEPT_BYTES);

    const accepted = await postFile(BOUNDARY_ACCEPT_BYTES, "boundary.bin");
    expect(accepted.status).toBe(200);
    const acceptedBody = (await accepted.json()) as UploadedWire;
    expect(acceptedBody.kind).toBe("uploaded");
    expect(acceptedBody.deduplicated).toBe(false);
    expect(acceptedBody.file.fileId).toBe("file-boundary-0");
    expect(acceptedBody.file.sha256Hex).toBe(expectedSha);
    expect(acceptedBody.file.byteSize).toBe(16_000_000);
    expect(captured).toHaveLength(1);

    const rejected = await postFile(BOUNDARY_REJECT_BYTES, "too-big.bin");
    await expectUploadRejection(rejected, 413, "file_too_large");
  });
});

describe("upload dedupe and intent recovery", () => {
  it("dedupes identical-bytes re-uploads to the same file_id", async () => {
    const captured = installFilesMock(() => "file-dedupe-1");
    const expectedSha = await sha256Hex(DEDUPE_BYTES);

    const first = await postFile(DEDUPE_BYTES, "dedupe.txt");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as UploadedWire;
    expect(firstBody.deduplicated).toBe(false);
    expect(firstBody.file.fileId).toBe("file-dedupe-1");

    // Same bytes under a different filename converge on the live catalogue row
    // without a second provider call.
    const second = await postFile(DEDUPE_BYTES, "renamed.txt");
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as UploadedWire;
    expect(secondBody.deduplicated).toBe(true);
    expect(secondBody.file.fileId).toBe("file-dedupe-1");
    expect(secondBody.file.sha256Hex).toBe(expectedSha);
    expect(captured).toHaveLength(1);

    const catalogue = await mainWorker.fetch(`${FILES_PATH}/file-dedupe-1`);
    expect(catalogue.status).toBe(200);
    const record = (await catalogue.json()) as CatalogueWire;
    expect(record).toMatchObject({
      fileId: "file-dedupe-1",
      sha256Hex: expectedSha,
      byteSize: DEDUPE_BYTES.byteLength,
    });
  });

  it("surfaces provider failures explicitly and recovers on retry", async () => {
    let providerDown = true;
    const captured = installFilesMock(
      () => "file-retry-1",
      () => {
        if (providerDown) {
          return providerJson(
            { error: { code: "server_error", message: "provider boom" } },
            500,
          );
        }
        return providerJson({ id: "file-retry-1", bytes: RETRY_BYTES.byteLength });
      },
    );
    const expectedSha = await sha256Hex(RETRY_BYTES);

    const failed = await postFile(RETRY_BYTES, "retry.txt");
    await expectUploadRejection(failed, 502, "provider_error");
    expect(captured).toHaveLength(1);

    // The failed attempt catalogued nothing: the retry runs the full upload
    // path again instead of deduping against a phantom row.
    providerDown = false;
    const recovered = await postFile(RETRY_BYTES, "retry.txt");
    expect(recovered.status).toBe(200);
    const recoveredBody = (await recovered.json()) as UploadedWire;
    expect(recoveredBody.kind).toBe("uploaded");
    expect(recoveredBody.deduplicated).toBe(false);
    expect(recoveredBody.file.fileId).toBe("file-retry-1");
    expect(recoveredBody.file.sha256Hex).toBe(expectedSha);
    expect(captured).toHaveLength(2);

    const catalogue = await mainWorker.fetch(`${FILES_PATH}/file-retry-1`);
    expect(catalogue.status).toBe(200);
    expect(((await catalogue.json()) as CatalogueWire).sha256Hex).toBe(expectedSha);
  });

  it("recovers ambiguous upload intents and cleans them through the registry alarm", async () => {
    // Pure RegistryDO RPC: no provider IO is reachable from these entrypoints,
    // so no fetch stub is needed — any network call would fail the run anyway.
    // Intent ids are unique per run: the singleton registry shares per-file
    // isolated storage, so a fixed id reused with different bytes is a
    // conflict that bleeds across tests. RPC-throwing paths (different-content
    // begin, late complete) are covered by unit tests — driving them over RPC
    // surfaces worker-side uncaught exceptions — so this test backdates via
    // SQL (mirroring test/do/registry-do.test.ts) and asserts via non-throwing
    // reads only.
    const rpc = registryRpc();
    const unique = crypto.randomUUID().replaceAll("-", "");
    const recoverId = `intent-files-recover-${unique}`;
    const expiredId = `intent-files-expired-${unique}`;
    const hashRecover = `hash-files-recover-${unique}`;
    const hashExpired = `hash-files-expired-${unique}`;
    const intent = {
      sha256: hashRecover,
      filename: "recover.txt",
      mimeType: "text/plain",
      byteSize: 7,
    };
    // A far-future persisted deadline: no wall-clock sleeps.
    const farFutureMs = 4102444800000;

    const first = await rpc.beginUploadIntent({
      intentId: recoverId,
      expiresAtMs: farFutureMs,
      ...intent,
    });
    expect(first.status).toBe("pending");

    const repeat = await rpc.beginUploadIntent({
      intentId: recoverId,
      expiresAtMs: farFutureMs,
      ...intent,
    });
    expect(repeat.intentId).toBe(recoverId);
    expect(repeat.status).toBe("pending");

    await rpc.beginUploadIntent({
      intentId: expiredId,
      sha256: hashExpired,
      filename: "expired.txt",
      mimeType: "text/plain",
      byteSize: 9,
      expiresAtMs: farFutureMs,
    });

    // Make the intent just-expired without moving the already-scheduled alarm.
    await runInDurableObject(registryStub(), async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE upload_intents SET expires_at_ms = ? WHERE intent_id = ?",
        Date.now() - 1_000,
        expiredId,
      );
    });

    // The alarm marks the just-expired pending intent ambiguous (RPC: failed)
    // and creates no catalogue row.
    expect(await runDurableObjectAlarm(registryStub())).toBe(true);
    const ambiguous = await rpc.beginUploadIntent({
      intentId: expiredId,
      sha256: hashExpired,
      filename: "expired.txt",
      mimeType: "text/plain",
      byteSize: 9,
      expiresAtMs: farFutureMs,
    });
    expect(ambiguous.status).toBe("failed");
    expect(ambiguous.fileId).toBeNull();
    expect(await rpc.findFileByHash(hashExpired)).toBeNull();

    // An ambiguity record older than a full retention window is cleaned up.
    await runInDurableObject(registryStub(), async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE upload_intents SET expires_at_ms = 1 WHERE intent_id = ?",
        expiredId,
      );
    });

    // The persisted-deadline alarm retires the aged ambiguous record.
    expect(await runDurableObjectAlarm(registryStub())).toBe(true);
    const cleaned = await rpc.beginUploadIntent({
      intentId: expiredId,
      sha256: hashExpired,
      filename: "expired.txt",
      mimeType: "text/plain",
      byteSize: 9,
      expiresAtMs: farFutureMs,
    });
    expect(cleaned.status).toBe("cleaned_up");
    expect(cleaned.fileId).toBeNull();
    expect(await rpc.findFileByHash(hashExpired)).toBeNull();
    expect(await rpc.findFileByHash(hashRecover)).toBeNull();
  });
});
