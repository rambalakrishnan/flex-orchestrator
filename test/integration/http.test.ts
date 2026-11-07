// Covers: 2, 4
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_JSON_BYTES,
  HttpError,
  clampPageLimit,
  errorResponse,
  fetchWithAbort,
  getRequestHostname,
  getSafeCfMetadata,
  isJsonContentType,
  jsonResponse,
  payloadTooLarge,
  readBoundedBytes,
  readBoundedText,
  readJson,
  toErrorResponse,
  withScopedAbort,
} from "../../src/http.ts";

/**
 * Item 2 (secret hygiene / no unbounded body buffering) and item 4 (bounded, recoverable
 * upload/body handling) are exercised through the shared HTTP primitives. All requests and
 * responses are Web-standard objects; no network calls are made.
 */

function expectHttpError(err: unknown, status: number, code: string): HttpError {
  expect(err).toBeInstanceOf(HttpError);
  const httpErr = err as HttpError;
  expect(httpErr.status).toBe(status);
  expect(httpErr.code).toBe(code);
  return httpErr;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("Expected promise to reject, but it resolved");
    },
    (err: unknown) => err,
  );
}

function captureSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("Expected function to throw, but it returned");
}

function jsonRequest(body: string, contentType = "application/json"): Request {
  return new Request("https://worker.test/inbox", {
    method: "POST",
    body,
    headers: { "content-type": contentType },
  });
}

function jsonResponseOf(body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    headers: { "content-type": "application/json", ...headers },
  });
}

function streamOfBytes(chunks: readonly Uint8Array[]): {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let pulls = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        const chunk = chunks[index];
        index += 1;
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isJsonContentType", () => {
  it("accepts JSON media types with optional parameters and casing", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("APPLICATION/JSON; CHARSET=UTF-8")).toBe(true);
    expect(isJsonContentType("application/ld+json")).toBe(true);
    expect(isJsonContentType("  application/json  ")).toBe(true);
  });

  it("rejects non-JSON, lookalike, and empty content types", () => {
    expect(isJsonContentType("text/json")).toBe(false);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("application/jsonx")).toBe(false);
    expect(isJsonContentType("")).toBe(false);
    expect(isJsonContentType(null)).toBe(false);
  });
});

describe("readBoundedBytes", () => {
  it("accepts a body of exactly maxBytes", async () => {
    const payload = new TextEncoder().encode("abcd");
    const response = new Response(payload, {
      headers: { "content-length": String(payload.byteLength) },
    });

    const bytes = await readBoundedBytes(response, payload.byteLength);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(4);
    expect(bytes).toEqual(payload);
  });

  it("rejects a maxBytes + 1 streamed body with HttpError 413 payload_too_large", async () => {
    const response = new Response(new Uint8Array(5));
    response.headers.delete("content-length");

    const err = await rejectionOf(readBoundedBytes(response, 4));

    const httpErr = expectHttpError(err, 413, "payload_too_large");
    expect(httpErr.details).toEqual({ max_bytes: 4 });
    expect(httpErr.message).toContain("4");
  });

  it("rejects on a declared Content-Length above the cap before consuming the stream", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = new Response(stream, {
      headers: { "content-length": "5" },
    });

    const err = await rejectionOf(readBoundedBytes(response, 4));

    const httpErr = expectHttpError(err, 413, "payload_too_large");
    expect(httpErr.details).toEqual({ max_bytes: 4, content_length: 5 });
    expect(pulls).toBe(0);
  });

  it("honors an explicit non-default cap at the 8,000,000-byte branch-snapshot boundary", async () => {
    const snapshotBytes = new Uint8Array(DEFAULT_MAX_JSON_BYTES + 1);
    expect(snapshotBytes.byteLength).toBe(1_500_001);

    const defaultErr = await rejectionOf(
      readBoundedBytes(new Response(snapshotBytes), DEFAULT_MAX_JSON_BYTES),
    );
    expectHttpError(defaultErr, 413, "payload_too_large");

    const bytes = await readBoundedBytes(new Response(snapshotBytes), 8_000_000);
    expect(bytes.byteLength).toBe(1_500_001);
    expect(bytes.byteLength).toBeLessThanOrEqual(8_000_000);
  });

  it("aggregates multiple streamed chunks under the cap", async () => {
    const { stream, pulls } = streamOfBytes([
      new TextEncoder().encode("ab"),
      new TextEncoder().encode("cd"),
      new TextEncoder().encode("ef"),
    ]);
    const response = new Response(stream);

    const bytes = await readBoundedBytes(response, 6);

    expect(pulls()).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes)).toBe("abcdef");
  });

  it("aborts a streamed body the moment the running total exceeds the cap", async () => {
    const { stream, pulls } = streamOfBytes([new Uint8Array(3), new Uint8Array(3)]);
    const response = new Response(stream);

    const err = await rejectionOf(readBoundedBytes(response, 4));

    expectHttpError(err, 413, "payload_too_large");
    // The first chunk (3 bytes) is under the cap; the second one crosses it.
    expect(pulls()).toBe(2);
  });

  it("rejects an invalid maxBytes configuration", async () => {
    const response = new Response(new Uint8Array(1));

    const err = await rejectionOf(readBoundedBytes(response, -1));

    expectHttpError(err, 500, "invalid_body_limit");
  });

  it("rejects a non-numeric Content-Length header", async () => {
    const response = new Response(new Uint8Array(1), {
      headers: { "content-length": "abc" },
    });

    const err = await rejectionOf(readBoundedBytes(response, 10));

    expectHttpError(err, 400, "invalid_content_length");
  });

  it("rejects when the actual body length differs from the declared Content-Length", async () => {
    const response = new Response(new Uint8Array(3), {
      headers: { "content-length": "5" },
    });

    const err = await rejectionOf(readBoundedBytes(response, 10));

    const httpErr = expectHttpError(err, 400, "content_length_mismatch");
    expect(httpErr.message).toContain("3");
    expect(httpErr.message).toContain("5");
  });

  it("rejects an already-aborted read with HttpError 499", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = new Response(new Uint8Array(2));
    response.headers.delete("content-length");

    const err = await rejectionOf(readBoundedBytes(response, 10, controller.signal));

    expectHttpError(err, 499, "request_aborted");
  });
});

describe("readBoundedText", () => {
  it("decodes valid UTF-8 within the byte bound", async () => {
    const payload = new TextEncoder().encode("héllo → ✓");
    const response = new Response(payload, {
      headers: { "content-length": String(payload.byteLength) },
    });

    const text = await readBoundedText(response, payload.byteLength);

    expect(text).toBe("héllo → ✓");
  });

  it("rejects invalid UTF-8 bytes with HttpError 400 invalid_utf8", async () => {
    const response = new Response(new Uint8Array([0x66, 0xff, 0x66]));

    const err = await rejectionOf(readBoundedText(response, 16));

    expectHttpError(err, 400, "invalid_utf8");
  });

  it("lets the platform decoder handle a leading BOM (ignoreBOM: false strips it)", async () => {
    const payload = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const response = new Response(payload, {
      headers: { "content-length": "5" },
    });

    const text = await readBoundedText(response, 5);

    // TextDecoder({ ignoreBOM: false }) is the standard's "do handle the BOM" mode:
    // the BOM is consumed rather than emitted as U+FEFF, and it is never re-encoded.
    expect(text).toBe("hi");
    expect(text).not.toContain("\uFEFF");
    expect(text.length).toBe(2);
  });

  it("enforces the byte bound before decoding", async () => {
    const payload = new TextEncoder().encode("0123456789");
    const response = new Response(payload, {
      headers: { "content-length": "10" },
    });

    const err = await rejectionOf(readBoundedText(response, 9));

    expectHttpError(err, 413, "payload_too_large");
  });
});

describe("readJson", () => {
  it("parses a JSON object body", async () => {
    const request = jsonRequest(JSON.stringify({ jobId: "job_1", turn: 2 }));

    const parsed = await readJson<{ jobId: string; turn: number }>(request);

    expect(parsed).toEqual({ jobId: "job_1", turn: 2 });
  });

  it("parses a JSON response body", async () => {
    const response = jsonResponseOf(JSON.stringify({ ok: true }));

    const parsed = await readJson<{ ok: boolean }>(response);

    expect(parsed.ok).toBe(true);
  });

  it("rejects malformed JSON with HttpError 400 invalid_json", async () => {
    const request = jsonRequest('{"jobId":');

    const err = await rejectionOf(readJson(request));

    const httpErr = expectHttpError(err, 400, "invalid_json");
    expect(httpErr.message).toContain("Invalid JSON body");
  });

  it("rejects whitespace-only and empty bodies with HttpError 400 empty_json_body", async () => {
    const emptyErr = await rejectionOf(readJson(jsonRequest("")));
    expectHttpError(emptyErr, 400, "empty_json_body");

    const blankErr = await rejectionOf(readJson(jsonRequest("   \n\t ")));
    expectHttpError(blankErr, 400, "empty_json_body");
  });

  it("only enforces the content-type gate when requireJsonContentType is set", async () => {
    const parsed = await readJson<{ a: number }>(jsonRequest('{"a":1}', "text/plain"));
    expect(parsed).toEqual({ a: 1 });

    const gatedErr = await rejectionOf(
      readJson(jsonRequest('{"a":1}', "text/plain"), { requireJsonContentType: true }),
    );
    expectHttpError(gatedErr, 415, "unsupported_media_type");
  });

  it("accepts application/json with parameters when the gate is enabled", async () => {
    const parsed = await readJson<{ a: number }>(
      jsonRequest('{"a":1}', "application/json; charset=utf-8"),
      { requireJsonContentType: true },
    );

    expect(parsed).toEqual({ a: 1 });
  });

  it("applies a numeric maxBytes argument to the body bound", async () => {
    const request = jsonRequest('{"a":1}', "application/json");
    request.headers.set("content-length", "7");

    const err = await rejectionOf(readJson(request, 3));

    expectHttpError(err, 413, "payload_too_large");
  });
});

describe("jsonResponse / errorResponse / toErrorResponse", () => {
  it("builds a 200 JSON response with no-store caching by default", async () => {
    const response = jsonResponse({ jobId: "job_1" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ jobId: "job_1" });
  });

  it("accepts a numeric status override and keeps JSON headers", async () => {
    const response = jsonResponse({ created: true }, 201);

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("emits the structured error envelope with optional details", async () => {
    const response = errorResponse(422, "unprocessable_entity", "Bad turn", { turn: -1 });

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await response.json()).toEqual({
      error: {
        code: "unprocessable_entity",
        message: "Bad turn",
        details: { turn: -1 },
      },
    });
  });

  it("defaults the error message to the code", async () => {
    const response = errorResponse(404, "not_found");

    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "not_found" },
    });
  });

  it("builds a 413 payload_too_large error with the configured bound", async () => {
    const response = payloadTooLarge(undefined, "payload_too_large", 1_500_000);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "Request body exceeds maximum allowed size",
        details: { max_bytes: 1_500_000 },
      },
    });
  });

  it("preserves status and code from an HttpError", async () => {
    const response = toErrorResponse(new HttpError(409, "conflict", "Duplicate job"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { code: "conflict", message: "Duplicate job" },
    });
  });

  it("preserves the message of an unexpected Error under internal_error", async () => {
    const response = toErrorResponse(new Error("database exploded"));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "database exploded" },
    });
  });

  it("uses a generic message for non-Error throwables", async () => {
    const response = toErrorResponse("not an error object");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });
});

describe("clampPageLimit", () => {
  it("uses the default for empty, null, and undefined input", () => {
    expect(clampPageLimit("")).toBe(50);
    expect(clampPageLimit(null)).toBe(50);
    expect(clampPageLimit(undefined)).toBe(50);
  });

  it("clamps to the 1..100 window", () => {
    expect(clampPageLimit("0")).toBe(1);
    expect(clampPageLimit("-10")).toBe(1);
    expect(clampPageLimit("50")).toBe(50);
    expect(clampPageLimit("100")).toBe(100);
    expect(clampPageLimit("101")).toBe(100);
    expect(clampPageLimit("1e2")).toBe(100);
    expect(clampPageLimit(42.9)).toBe(42);
    expect(clampPageLimit(1_000)).toBe(100);
  });

  it("clamps a caller-supplied default into the window", () => {
    expect(clampPageLimit(null, 250)).toBe(100);
    expect(clampPageLimit(null, 0)).toBe(1);
    expect(clampPageLimit("25", 50, 1, 20)).toBe(20);
  });

  it("rejects non-numeric limits with HttpError 400 invalid_limit", () => {
    const err = captureSync(() => clampPageLimit("abc"));

    expectHttpError(err, 400, "invalid_limit");
  });
});

describe("getRequestHostname", () => {
  it("lowercases the host and strips the port", () => {
    const request = new Request("HTTP://APP.Example.COM:8080/jobs");

    expect(getRequestHostname(request)).toBe("app.example.com");
  });

  it("returns a bare hostname unchanged", () => {
    const request = new Request("https://hooks.example.com/openai");

    expect(getRequestHostname(request)).toBe("hooks.example.com");
  });

  it("preserves IPv6 literal brackets and strips the port", () => {
    const request = new Request("http://[::1]:8787/inbox");

    expect(getRequestHostname(request)).toBe("[::1]");
  });
});

describe("withScopedAbort", () => {
  it("rejects with a TimeoutError when the timeout elapses", async () => {
    vi.useFakeTimers();

    const pending = rejectionOf(
      withScopedAbort({ timeoutMs: 10 }, (signal) => {
        const { promise, reject } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        return promise;
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    const err = await pending;

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
    expect((err as DOMException).message).toContain("10ms");
  });

  it("removes upstream listeners and ignores late aborts after completion", async () => {
    const upstream = new AbortController();
    const addSpy = vi.spyOn(upstream.signal, "addEventListener");
    const removeSpy = vi.spyOn(upstream.signal, "removeEventListener");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let observedAborted: boolean | null = null;
    try {
      const result = await withScopedAbort(
        { signal: upstream.signal, timeoutMs: 1_000 },
        async (signal) => {
          observedAborted = signal.aborted;
          return "done";
        },
      );

      expect(result).toBe("done");
      expect(observedAborted).toBe(false);
      expect(addSpy).toHaveBeenCalled();
      const attachedListener = addSpy.mock.calls[0]?.[1];
      expect(attachedListener).toBeTypeOf("function");
      expect(removeSpy.mock.calls).toContainEqual(["abort", attachedListener]);

      // Aborting the upstream signal after completion must not reach the finished operation.
      upstream.abort(new Error("late abort"));
      // Flush two event-loop turns so a stray unhandled rejection would be observed.
      const firstTick = Promise.withResolvers<void>();
      setImmediate(firstTick.resolve);
      await firstTick.promise;
      const secondTick = Promise.withResolvers<void>();
      setImmediate(secondTick.resolve);
      await secondTick.promise;
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("ignores request.signal when forwardRequestSignal is false", async () => {
    const client = new AbortController();
    const request = new Request("https://worker.test/jobs", { signal: client.signal });
    client.abort(new Error("client disconnected"));

    let observedAborted: boolean | null = null;
    const result = await withScopedAbort(
      { request, forwardRequestSignal: false },
      async (signal) => {
        await Promise.resolve();
        observedAborted = signal.aborted;
        return "ok";
      },
    );

    expect(result).toBe("ok");
    expect(observedAborted).toBe(false);
  });

  it("forwards request.signal by default", async () => {
    const client = new AbortController();
    const request = new Request("https://worker.test/jobs", { signal: client.signal });
    client.abort(new Error("client disconnected"));

    let observedAborted: boolean | null = null;
    const result = await withScopedAbort({ request }, async (signal) => {
      observedAborted = signal.aborted;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(observedAborted).toBe(true);
  });

  it("links a caller signal that aborts during the operation", async () => {
    const controller = new AbortController();

    const err = await rejectionOf(
      withScopedAbort({ signal: controller.signal }, (signal) => {
        const { promise, reject } = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        controller.abort(new Error("upstream failure"));
        return promise;
      }),
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("upstream failure");
  });
});

describe("fetchWithAbort", () => {
  it("forwards method and headers to fetch and installs a scoped signal", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        capturedInput = input;
        capturedInit = init;
        return new Response(JSON.stringify({ id: "resp_1" }), {
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fakeFetch);

    const response = await fetchWithAbort(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: { authorization: "Bearer test-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt" }),
      },
      { timeoutMs: 1_000 },
    );

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(capturedInput).toBe("https://api.openai.com/v1/responses");
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer test-key");
    expect(capturedInit?.body).toBe(JSON.stringify({ model: "gpt" }));
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
    expect((capturedInit?.signal as AbortSignal).aborted).toBe(false);
    expect(await response.json()).toEqual({ id: "resp_1" });
  });

  it("aborts the outbound fetch with a TimeoutError when the timeout elapses", async () => {
    vi.useFakeTimers();

    const fakeFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("fetchWithAbort did not pass a signal"));
      } else if (signal.aborted) {
        reject(signal.reason);
      } else {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }
      return promise;
    });
    vi.stubGlobal("fetch", fakeFetch);

    const pending = rejectionOf(
      fetchWithAbort("https://api.openai.com/v1/responses", {}, { timeoutMs: 10 }),
    );
    await vi.advanceTimersByTimeAsync(10);
    const err = await pending;

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("TimeoutError");
  });
});

// Node's Request does not declare `cf`; tests inject Cloudflare metadata at runtime.
function setCfMetadata(request: Request, value: unknown): void {
  const target = request as unknown as { cf?: unknown };
  target.cf = value;
}

describe("getSafeCfMetadata", () => {
  it("returns defined null defaults for a plain Request without cf metadata", () => {
    const request = new Request("https://worker.test/jobs");

    const metadata = getSafeCfMetadata(request);

    expect(metadata).toEqual({
      colo: null,
      country: null,
      asn: null,
      httpProtocol: null,
      tlsVersion: null,
    });
  });

  it("reads well-typed cf fields", () => {
    const request = new Request("https://worker.test/jobs") as Request & {
      cf?: Record<string, unknown>;
    };
    request.cf = {
      colo: "SFO",
      country: "US",
      asn: 64500,
      httpProtocol: "HTTP/2",
      tlsVersion: "TLSv1.3",
    };

    expect(getSafeCfMetadata(request)).toEqual({
      colo: "SFO",
      country: "US",
      asn: 64500,
      httpProtocol: "HTTP/2",
      tlsVersion: "TLSv1.3",
    });
  });

  it("nulls out wrong-typed and missing cf properties", () => {
    const request = new Request("https://worker.test/jobs") as Request & {
      cf?: Record<string, unknown>;
    };
    request.cf = { colo: 42, country: "US", asn: "64500" };

    expect(getSafeCfMetadata(request)).toEqual({
      colo: null,
      country: "US",
      asn: null,
      httpProtocol: null,
      tlsVersion: null,
    });
  });

  it("tolerates a non-object cf value", () => {
    const request = new Request("https://worker.test/jobs");
    setCfMetadata(request, null);

    expect(getSafeCfMetadata(request)).toEqual({
      colo: null,
      country: null,
      asn: null,
      httpProtocol: null,
      tlsVersion: null,
    });

    setCfMetadata(request, "not-an-object");

    expect(getSafeCfMetadata(request).colo).toBeNull();
  });
});