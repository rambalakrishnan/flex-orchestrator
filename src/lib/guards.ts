/**
 * Guards (`src/lib/guards.ts`) — pure artifact byte guards, primary-key cursor
 * pagination clamping, and SQL bound-parameter chunking.
 *
 * Every limit comes from `src/constants.ts`; this module has no storage or
 * runtime dependencies. Oversized artifacts never fall back to truncation:
 * they raise `ArtifactGuardError`.
 */

import {
  ARTIFACT_ROW_GUARD_BYTES,
  LIST_PAGE_LIMIT_DEFAULT,
  LIST_PAGE_LIMIT_MAX,
  LIST_PAGE_LIMIT_MIN,
  MAX_BRANCH_SNAPSHOT_BYTES,
  MAX_FILE_UPLOAD_BYTES,
  ROW_GUARD_BYTES,
  SQL_MAX_BOUND_PARAMS,
} from "../constants.ts";

export type SchemaGuardKind =
  | "artifact_bytes"
  | "row_bytes"
  | "branch_snapshot_bytes"
  | "file_upload_bytes"
  | "sql_bound_params";

/**
 * Raised when an artifact, resulting row, branch snapshot, or file upload
 * violates its byte guard. Oversized artifacts never fall back to truncation.
 */
export class ArtifactGuardError extends Error {
  readonly code = "ARTIFACT_GUARD_EXCEEDED" as const;
  readonly kind: SchemaGuardKind;
  readonly actualBytes: number;
  readonly limitBytes: number;
  readonly context: string;

  constructor(
    kind: SchemaGuardKind,
    actualBytes: number,
    limitBytes: number,
    context = "artifact"
  ) {
    super(
      `Guard violation (${kind}) on ${context}: ${actualBytes} bytes exceeds limit of ${limitBytes} bytes`
    );
    this.name = "ArtifactGuardError";
    this.kind = kind;
    this.actualBytes = actualBytes;
    this.limitBytes = limitBytes;
    this.context = context;
  }
}

const utf8Encoder = new TextEncoder();

/**
 * Returns the exact UTF-8 or raw byte length of a string or binary buffer.
 */
export function measureByteLength(value: string | ArrayBuffer | ArrayBufferView | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "string") {
    return utf8Encoder.encode(value).byteLength;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  throw new ArtifactGuardError("artifact_bytes", Number.NaN, ARTIFACT_ROW_GUARD_BYTES, "invalid_payload_type");
}

/**
 * Converts a string, `ArrayBuffer`, or `ArrayBufferView` into a `Uint8Array` BLOB
 * and enforces the 1,500,000-byte artifact guard before returning.
 */
export function toGuardedBlob(
  value: string | ArrayBuffer | Uint8Array,
  context = "artifact",
  limit: number = ARTIFACT_ROW_GUARD_BYTES
): { readonly blob: Uint8Array; readonly byteLength: number } {
  const blob =
    typeof value === "string"
      ? utf8Encoder.encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  guardBytes(blob.byteLength, limit, "artifact_bytes", context);
  return { blob, byteLength: blob.byteLength };
}

/**
 * Pure numeric byte-limit validator. Rejects negative numbers, `NaN`, `Infinity`,
 * non-integers, and values above `limit`.
 *
 * Designed for direct unit testing with mocked numbers without allocating multi-megabyte buffers.
 */
export function guardBytes(
  bytes: number,
  limit: number = ARTIFACT_ROW_GUARD_BYTES,
  kind: SchemaGuardKind = "artifact_bytes",
  context = "artifact"
): number {
  if (
    typeof bytes !== "number" ||
    !Number.isFinite(bytes) ||
    !Number.isInteger(bytes) ||
    bytes < 0 ||
    bytes > limit
  ) {
    throw new ArtifactGuardError(kind, bytes, limit, context);
  }
  return bytes;
}

/**
 * Enforces the 1,500,000-byte guard on a single artifact's byte count.
 */
export function assertArtifactSize(bytes: number, context = "artifact"): number {
  return guardBytes(bytes, ARTIFACT_ROW_GUARD_BYTES, "artifact_bytes", context);
}

/**
 * Enforces both the per-artifact 1,500,000-byte guard and the resulting-row
 * 1,500,000-byte guard (artifact bytes + metadata bytes), plus reserved control headroom.
 */
export function assertArtifactAndRowSize(
  artifactBytes: number,
  metadataBytes = 0,
  context = "row"
): { readonly artifactBytes: number; readonly metadataBytes: number; readonly rowBytes: number } {
  assertArtifactSize(artifactBytes, `${context}.artifact`);
  guardBytes(metadataBytes, ROW_GUARD_BYTES, "row_bytes", `${context}.metadata`);
  const rowBytes = artifactBytes + metadataBytes;
  guardBytes(rowBytes, ROW_GUARD_BYTES, "row_bytes", context);
  return { artifactBytes, metadataBytes, rowBytes };
}

/**
 * Enforces the 8,000,000-byte guard on encoded branch snapshots.
 */
export function assertBranchSnapshotSize(bytes: number, context = "branch_snapshot"): number {
  return guardBytes(bytes, MAX_BRANCH_SNAPSHOT_BYTES, "branch_snapshot_bytes", context);
}

/**
 * Enforces the 16,000,000-byte limit on uploaded source files.
 */
export function assertFileUploadSize(bytes: number, context = "file_upload"): number {
  return guardBytes(bytes, MAX_FILE_UPLOAD_BYTES, "file_upload_bytes", context);
}

/**
 * Clamps a list query limit to the required `[1, 100]` range.
 * Defaults to `50` when `rawLimit` is `undefined` or `null`.
 */
export function clampPageLimit(rawLimit?: number | null): number {
  if (rawLimit === undefined || rawLimit === null || Number.isNaN(rawLimit)) {
    return LIST_PAGE_LIMIT_DEFAULT;
  }
  const truncated = Math.trunc(rawLimit);
  if (truncated < LIST_PAGE_LIMIT_MIN) {
    return LIST_PAGE_LIMIT_MIN;
  }
  if (truncated > LIST_PAGE_LIMIT_MAX) {
    return LIST_PAGE_LIMIT_MAX;
  }
  return truncated;
}

/**
 * Splits a batch of rows into chunks whose bound parameter count never exceeds
 * the Durable Object SQLite 100-parameter ceiling (`rowsPerChunk * paramsPerRow <= 100`).
 */
export function chunkRowsForBindLimit<T>(
  rows: readonly T[],
  paramsPerRow: number,
  maxBoundParams: number = SQL_MAX_BOUND_PARAMS
): T[][] {
  if (!Number.isInteger(paramsPerRow) || paramsPerRow <= 0 || paramsPerRow > maxBoundParams) {
    throw new ArtifactGuardError("sql_bound_params", paramsPerRow, maxBoundParams, "params_per_row");
  }
  const maxRowsPerChunk = Math.floor(maxBoundParams / paramsPerRow);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += maxRowsPerChunk) {
    chunks.push(rows.slice(i, i + maxRowsPerChunk));
  }
  return chunks;
}