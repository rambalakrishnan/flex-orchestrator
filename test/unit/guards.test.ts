// Covers: 6, 21

import { describe, expect, it } from "vitest";
import {
  ARTIFACT_BYTE_LIMIT,
  BRANCH_SNAPSHOT_BYTE_LIMIT,
  FILE_UPLOAD_BYTE_LIMIT,
  LIST_PAGE_LIMIT_DEFAULT,
  LIST_PAGE_LIMIT_MAX,
  LIST_PAGE_LIMIT_MIN,
  ROW_BYTE_LIMIT,
  SQL_MAX_BOUND_PARAMS,
  ArtifactGuardError,
  StorageFullError,
  assertArtifactAndRowSize,
  assertArtifactSize,
  assertBranchSnapshotSize,
  assertFileUploadSize,
  chunkRowsForBindLimit,
  clampPageLimit,
  guardBytes,
  isSqliteFullError,
  measureByteLength,
  toGuardedBlob,
  withSqlErrorMapping,
} from "../../src/db/schema.ts";

/** Captures the thrown `ArtifactGuardError` so its fields can be asserted. */
function captureArtifactGuardError(fn: () => unknown): ArtifactGuardError {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ArtifactGuardError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected ArtifactGuardError to be thrown");
}

describe("limit constants", () => {
  it("matches the architecture guard constants", () => {
    expect(ARTIFACT_BYTE_LIMIT).toBe(1_500_000);
    expect(ROW_BYTE_LIMIT).toBe(1_500_000);
    expect(BRANCH_SNAPSHOT_BYTE_LIMIT).toBe(8_000_000);
    expect(FILE_UPLOAD_BYTE_LIMIT).toBe(16_000_000);
    expect(LIST_PAGE_LIMIT_MIN).toBe(1);
    expect(LIST_PAGE_LIMIT_MAX).toBe(100);
    expect(LIST_PAGE_LIMIT_DEFAULT).toBe(50);
    expect(SQL_MAX_BOUND_PARAMS).toBe(100);
  });
});

describe("measureByteLength", () => {
  it("returns 0 for null and undefined", () => {
    expect(measureByteLength(null)).toBe(0);
    expect(measureByteLength(undefined)).toBe(0);
  });

  it("returns exact UTF-8 byte length for strings", () => {
    expect(measureByteLength("")).toBe(0);
    expect(measureByteLength("abc")).toBe(3);
    expect(measureByteLength("héllo")).toBe(6);
    expect(measureByteLength("日本語")).toBe(9);
    expect(measureByteLength("😀")).toBe(4);
    expect(measureByteLength("a\r\nb")).toBe(4);
  });

  it("returns exact byteLength for ArrayBuffers", () => {
    expect(measureByteLength(new ArrayBuffer(0))).toBe(0);
    expect(measureByteLength(new ArrayBuffer(16))).toBe(16);
    expect(measureByteLength(new Uint8Array(7).buffer)).toBe(7);
  });

  it("returns exact byteLength for views including byteOffset/byteLength slices", () => {
    const backing = new ArrayBuffer(16);
    expect(measureByteLength(new Uint8Array(backing))).toBe(16);
    expect(measureByteLength(new Uint8Array(backing, 4, 6))).toBe(6);
    expect(measureByteLength(new DataView(backing, 8, 4))).toBe(4);
    expect(measureByteLength(new Uint16Array(backing, 2, 3))).toBe(6);
    expect(measureByteLength(new Uint8Array([1, 2, 3]))).toBe(3);
  });

  it("throws ArtifactGuardError for a non-byte payload type", () => {
    const error = captureArtifactGuardError(() => measureByteLength(42 as unknown as string));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.context).toBe("invalid_payload_type");
    expect(Number.isNaN(error.actualBytes)).toBe(true);
    expect(error.limitBytes).toBe(ARTIFACT_BYTE_LIMIT);
  });
});

describe("guardBytes", () => {
  it("accepts zero and exactly the limit", () => {
    expect(guardBytes(0)).toBe(0);
    expect(guardBytes(ARTIFACT_BYTE_LIMIT)).toBe(ARTIFACT_BYTE_LIMIT);
    expect(guardBytes(10, 10)).toBe(10);
    expect(guardBytes(1, 1, "row_bytes", "row")).toBe(1);
  });

  it("returns the validated byte count unchanged", () => {
    expect(guardBytes(1_234_567)).toBe(1_234_567);
  });

  it("rejects limit + 1 with default kind/limit/context", () => {
    const error = captureArtifactGuardError(() => guardBytes(ARTIFACT_BYTE_LIMIT + 1));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.actualBytes).toBe(ARTIFACT_BYTE_LIMIT + 1);
    expect(error.limitBytes).toBe(ARTIFACT_BYTE_LIMIT);
    expect(error.context).toBe("artifact");
    expect(error.code).toBe("ARTIFACT_GUARD_EXCEEDED");
    expect(error.name).toBe("ArtifactGuardError");
  });

  it("rejects values above a caller-supplied limit with caller-supplied kind/context", () => {
    const error = captureArtifactGuardError(() =>
      guardBytes(11, 10, "row_bytes", "attempts.row_bytes")
    );
    expect(error.kind).toBe("row_bytes");
    expect(error.context).toBe("attempts.row_bytes");
    expect(error.actualBytes).toBe(11);
    expect(error.limitBytes).toBe(10);
    expect(error.message).toContain("attempts.row_bytes");
  });

  it("rejects negative, NaN, Infinity, -Infinity, and non-integer values", () => {
    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5]) {
      const error = captureArtifactGuardError(() => guardBytes(invalid));
      expect(error).toBeInstanceOf(ArtifactGuardError);
      expect(error.kind).toBe("artifact_bytes");
      expect(Number.isFinite(error.actualBytes)).toBe(Number.isFinite(invalid));
    }
  });

  it("rejects non-numeric input at runtime", () => {
    const error = captureArtifactGuardError(() => guardBytes("12" as unknown as number));
    expect(error.kind).toBe("artifact_bytes");
  });
});

describe("guard-specific asserts", () => {
  const boundaries = [
    {
      label: "assertArtifactSize",
      assertSize: assertArtifactSize,
      limit: ARTIFACT_BYTE_LIMIT,
      kind: "artifact_bytes",
      context: "artifact",
    },
    {
      label: "assertBranchSnapshotSize",
      assertSize: assertBranchSnapshotSize,
      limit: BRANCH_SNAPSHOT_BYTE_LIMIT,
      kind: "branch_snapshot_bytes",
      context: "branch_snapshot",
    },
    {
      label: "assertFileUploadSize",
      assertSize: assertFileUploadSize,
      limit: FILE_UPLOAD_BYTE_LIMIT,
      kind: "file_upload_bytes",
      context: "file_upload",
    },
  ] as const;

  for (const { label, assertSize, limit, kind, context } of boundaries) {
    it(`${label} accepts 0 and exactly the limit, rejects limit + 1`, () => {
      expect(assertSize(0)).toBe(0);
      expect(assertSize(limit)).toBe(limit);

      const error = captureArtifactGuardError(() => assertSize(limit + 1));
      expect(error.kind).toBe(kind);
      expect(error.actualBytes).toBe(limit + 1);
      expect(error.limitBytes).toBe(limit);
      expect(error.context).toBe(context);
    });

    it(`${label} rejects negative, NaN, Infinity, and non-integer sizes`, () => {
      for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
        const error = captureArtifactGuardError(() => assertSize(invalid));
        expect(error.kind).toBe(kind);
        expect(error.limitBytes).toBe(limit);
      }
    });

    it(`${label} propagates a caller-supplied context label`, () => {
      const error = captureArtifactGuardError(() => assertSize(limit + 1, `${label}.ctx`));
      expect(error.context).toBe(`${label}.ctx`);
    });
  }

  it("pins the artifact boundary at 1_500_000 / 1_500_001", () => {
    expect(assertArtifactSize(1_500_000)).toBe(1_500_000);
    expect(captureArtifactGuardError(() => assertArtifactSize(1_500_001)).actualBytes).toBe(1_500_001);
  });

  it("pins the branch snapshot boundary at 8_000_000 / 8_000_001", () => {
    expect(assertBranchSnapshotSize(8_000_000)).toBe(8_000_000);
    expect(captureArtifactGuardError(() => assertBranchSnapshotSize(8_000_001)).actualBytes).toBe(8_000_001);
  });

  it("pins the file upload boundary at 16_000_000 / 16_000_001", () => {
    expect(assertFileUploadSize(16_000_000)).toBe(16_000_000);
    expect(captureArtifactGuardError(() => assertFileUploadSize(16_000_001)).actualBytes).toBe(16_000_001);
  });
});

describe("assertArtifactAndRowSize", () => {
  it("returns the computed artifact/metadata/row triple", () => {
    expect(assertArtifactAndRowSize(0)).toEqual({ artifactBytes: 0, metadataBytes: 0, rowBytes: 0 });
    expect(assertArtifactAndRowSize(1_000_000, 500_000)).toEqual({
      artifactBytes: 1_000_000,
      metadataBytes: 500_000,
      rowBytes: 1_500_000,
    });
    expect(assertArtifactAndRowSize(1_499_999, 1)).toEqual({
      artifactBytes: 1_499_999,
      metadataBytes: 1,
      rowBytes: 1_500_000,
    });
  });

  it("accepts the exact 1_500_000 artifact/row boundary", () => {
    const result = assertArtifactAndRowSize(1_500_000, 0);
    expect(result.rowBytes).toBe(1_500_000);
  });

  it("rejects an artifact alone above 1_500_000 under the artifact guard", () => {
    const error = captureArtifactGuardError(() => assertArtifactAndRowSize(1_500_001, 0, "turns.row"));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.context).toBe("turns.row.artifact");
    expect(error.actualBytes).toBe(1_500_001);
    expect(error.limitBytes).toBe(ARTIFACT_BYTE_LIMIT);
  });

  it("rejects when artifact + metadata exceeds 1_500_000 under the row guard", () => {
    const error = captureArtifactGuardError(() =>
      assertArtifactAndRowSize(1_000_000, 500_001, "judge_calls.row")
    );
    expect(error.kind).toBe("row_bytes");
    expect(error.context).toBe("judge_calls.row");
    expect(error.actualBytes).toBe(1_500_001);
    expect(error.limitBytes).toBe(ROW_BYTE_LIMIT);

    const boundaryError = captureArtifactGuardError(() =>
      assertArtifactAndRowSize(1_500_000, 1, "judge_calls.row")
    );
    expect(boundaryError.kind).toBe("row_bytes");
    expect(boundaryError.actualBytes).toBe(1_500_001);
  });

  it("rejects metadata alone above the row limit under the metadata guard", () => {
    const error = captureArtifactGuardError(() => assertArtifactAndRowSize(0, 1_500_001, "turns.row"));
    expect(error.kind).toBe("row_bytes");
    expect(error.context).toBe("turns.row.metadata");
    expect(error.actualBytes).toBe(1_500_001);
  });

  it("rejects a negative artifact size", () => {
    const error = captureArtifactGuardError(() => assertArtifactAndRowSize(-1, 0));
    expect(error.kind).toBe("artifact_bytes");
    expect(error.actualBytes).toBe(-1);
  });

  it("rejects a negative or non-integer metadata size", () => {
    expect(captureArtifactGuardError(() => assertArtifactAndRowSize(1, -1)).kind).toBe("row_bytes");
    expect(captureArtifactGuardError(() => assertArtifactAndRowSize(1, 1.5)).kind).toBe("row_bytes");
  });
});

describe("toGuardedBlob", () => {
  it("round-trips a small string through exact UTF-8 bytes", () => {
    const result = toGuardedBlob("héllo");
    expect(result.blob).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBe(6);
    expect(Array.from(result.blob)).toEqual(Array.from(new TextEncoder().encode("héllo")));
    expect(new TextDecoder().decode(result.blob)).toBe("héllo");
  });

  it("round-trips the empty string", () => {
    const result = toGuardedBlob("");
    expect(result.byteLength).toBe(0);
    expect(result.blob.byteLength).toBe(0);
  });

  it("accepts an ArrayBuffer and copies its bytes", () => {
    const buffer = new Uint8Array([1, 2, 3, 255]).buffer;
    const result = toGuardedBlob(buffer);
    expect(result.byteLength).toBe(4);
    expect(Array.from(result.blob)).toEqual([1, 2, 3, 255]);
  });

  it("accepts a Uint8Array and a byteOffset view of it", () => {
    const bytes = new Uint8Array([0, 255, 7]);
    const direct = toGuardedBlob(bytes);
    expect(direct.byteLength).toBe(3);
    expect(Array.from(direct.blob)).toEqual([0, 255, 7]);

    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const sliced = toGuardedBlob(view);
    expect(sliced.byteLength).toBe(3);
    expect(Array.from(sliced.blob)).toEqual([1, 2, 3]);
  });

  it("accepts input whose length exactly equals the limit", () => {
    const result = toGuardedBlob("abcd", "judge.request_blob", 4);
    expect(result.byteLength).toBe(4);
  });

  it("rejects oversized input with the context label and never returns a partial value", () => {
    let returned: unknown = "not-returned";
    const error = captureArtifactGuardError(() => {
      returned = toGuardedBlob("0123456789", "judge.request_blob", 5);
    });
    expect(returned).toBe("not-returned");
    expect(error.kind).toBe("artifact_bytes");
    expect(error.context).toBe("judge.request_blob");
    expect(error.actualBytes).toBe(10);
    expect(error.limitBytes).toBe(5);
  });

  it("uses the default context and limit when omitted", () => {
    const error = captureArtifactGuardError(() => toGuardedBlob("abc", undefined, 2));
    expect(error.context).toBe("artifact");
    expect(error.limitBytes).toBe(2);
  });
});

describe("clampPageLimit", () => {
  it("defaults to 50 for undefined, null, and NaN", () => {
    expect(clampPageLimit(undefined)).toBe(50);
    expect(clampPageLimit(null)).toBe(50);
    expect(clampPageLimit(Number.NaN)).toBe(50);
    expect(clampPageLimit()).toBe(LIST_PAGE_LIMIT_DEFAULT);
  });

  it("clamps to the inclusive 1..100 range", () => {
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(1)).toBe(1);
    expect(clampPageLimit(50)).toBe(50);
    expect(clampPageLimit(100)).toBe(100);
    expect(clampPageLimit(101)).toBe(100);
    expect(clampPageLimit(1_000_000)).toBe(100);
    expect(clampPageLimit(-5)).toBe(1);
    expect(clampPageLimit(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampPageLimit(Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("truncates fractional limits before clamping", () => {
    expect(clampPageLimit(49.9)).toBe(49);
    expect(clampPageLimit(100.9)).toBe(100);
    expect(clampPageLimit(0.5)).toBe(1);
  });
});

describe("chunkRowsForBindLimit", () => {
  const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

  it("returns an empty array for empty input", () => {
    expect(chunkRowsForBindLimit([], 8)).toEqual([]);
    expect(chunkRowsForBindLimit([], 100)).toEqual([]);
  });

  it("keeps rows * paramsPerRow <= 100 and preserves order", () => {
    const rows = range(25);
    const chunks = chunkRowsForBindLimit(rows, 8);
    expect(chunks.map((chunk) => chunk.length)).toEqual([12, 12, 1]);
    for (const chunk of chunks) {
      expect(chunk.length * 8).toBeLessThanOrEqual(SQL_MAX_BOUND_PARAMS);
    }
    expect(chunks.flat()).toEqual(rows);
  });

  it("handles the exact 100-row boundary with one parameter per row", () => {
    const rows = range(100);
    const chunks = chunkRowsForBindLimit(rows, 1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(rows);

    const overflow = chunkRowsForBindLimit(range(101), 1);
    expect(overflow.map((chunk) => chunk.length)).toEqual([100, 1]);
  });

  it("permits exactly 100 parameters in a single chunk", () => {
    const chunks = chunkRowsForBindLimit(range(100), 100);
    expect(chunks).toHaveLength(100);
    for (const chunk of chunks) {
      expect(chunk).toHaveLength(1);
      expect(chunk.length * 100).toBe(SQL_MAX_BOUND_PARAMS);
    }
  });

  it("honors a caller-supplied maxBoundParams", () => {
    const chunks = chunkRowsForBindLimit(range(5), 2, 4);
    expect(chunks.map((chunk) => chunk.length)).toEqual([2, 2, 1]);
    expect(chunks.flat()).toEqual(range(5));
  });

  it("throws for paramsPerRow outside 1..maxBoundParams or non-integer", () => {
    for (const invalid of [0, -1, 101, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = captureArtifactGuardError(() => chunkRowsForBindLimit(range(3), invalid));
      expect(error.kind).toBe("sql_bound_params");
      expect(error.context).toBe("params_per_row");
      expect(error.limitBytes).toBe(SQL_MAX_BOUND_PARAMS);
    }

    expect(captureArtifactGuardError(() => chunkRowsForBindLimit(range(3), 5, 4)).limitBytes).toBe(4);
  });
});

describe("isSqliteFullError", () => {
  it("recognizes StorageFullError instances", () => {
    expect(isSqliteFullError(new StorageFullError())).toBe(true);
  });

  it("recognizes Error objects with SQLITE_FULL codes/messages", () => {
    const coded = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    expect(isSqliteFullError(coded)).toBe(true);
    expect(isSqliteFullError(new Error("SQLITE_FULL: database or disk is full"))).toBe(true);
    expect(isSqliteFullError(new Error("step failed: database or disk is full"))).toBe(true);
  });

  it("recognizes raw strings carrying SQLITE_FULL", () => {
    expect(isSqliteFullError("SQLITE_FULL")).toBe(true);
    expect(isSqliteFullError("database or disk is full")).toBe(true);
  });

  it("rejects unrelated errors, plain objects, and non-error values", () => {
    expect(isSqliteFullError(new Error("syntax error"))).toBe(false);
    expect(isSqliteFullError({ code: "SQLITE_FULL" })).toBe(false);
    expect(isSqliteFullError(null)).toBe(false);
    expect(isSqliteFullError(undefined)).toBe(false);
    expect(isSqliteFullError(42)).toBe(false);
    expect(isSqliteFullError("constraint failed")).toBe(false);
  });
});

describe("withSqlErrorMapping", () => {
  it("returns the operation result unchanged", () => {
    expect(withSqlErrorMapping(() => 42)).toBe(42);
    expect(withSqlErrorMapping(() => "value")).toBe("value");
  });

  it("maps a SQLITE_FULL error to StorageFullError with the original cause", () => {
    const original = Object.assign(new Error("database or disk is full (13)"), { code: "SQLITE_FULL" });
    let thrown: unknown;
    try {
      withSqlErrorMapping(() => {
        throw original;
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageFullError);
    const storageFull = thrown as StorageFullError;
    expect(storageFull.code).toBe("SQLITE_FULL");
    expect(storageFull.message).toBe("database or disk is full (13)");
    expect(storageFull.cause).toBe(original);
  });

  it("maps a raw SQLITE_FULL string to StorageFullError", () => {
    let thrown: unknown;
    try {
      withSqlErrorMapping(() => {
        throw "SQLITE_FULL";
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StorageFullError);
    expect((thrown as StorageFullError).cause).toBe("SQLITE_FULL");
  });

  it("passes ArtifactGuardError through unchanged", () => {
    const original = new ArtifactGuardError("artifact_bytes", 1_500_001, 1_500_000, "turn.prompt");
    let thrown: unknown;
    try {
      withSqlErrorMapping(() => {
        throw original;
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(original);
  });

  it("passes StorageFullError through unchanged", () => {
    const original = new StorageFullError("already full");
    let thrown: unknown;
    try {
      withSqlErrorMapping(() => {
        throw original;
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(original);
  });

  it("rethrows unrelated errors unchanged", () => {
    const original = new Error("syntax error near SELECT");
    let thrown: unknown;
    try {
      withSqlErrorMapping(() => {
        throw original;
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(original);
    expect(thrown).not.toBeInstanceOf(StorageFullError);
  });

  it("rethrows unclassified non-error values unchanged", () => {
    const original = { code: "SQLITE_FULL" };
    let thrown: unknown;
    try {
      withSqlErrorMapping(() => {
        throw original;
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBe(original);
    expect(thrown).not.toBeInstanceOf(StorageFullError);
  });
});