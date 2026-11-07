## Files handler — `src/handlers/files.ts`

### Purpose and owned state

Implement the attachment submission and catalogue-read surface. ARCHITECTURE §16 maps it as "multipart uploads and catalogue coordination". The handler owns no durable state: it buffers a bounded upload, hashes it, and coordinates `RegistryDO` (catalogue, intents, file protection) with `ProviderIO` (Files API). Source file bytes are never persisted in SQLite (ARCHITECTURE §11).

### Public surface

HTTP routes. Do not add any other HTTP route or public method; private helpers are allowed.

```ts
- POST /api/files multipart/form-data field `file` (+ optional `turnIndex`) -> FileUploadResult
- GET /api/files/:fileId -> FileCatalogueRecord
```

Implementations MUST NOT invent interfaces: return `FileUploadResult` and `FileCatalogueRecord` from `src/types.ts` / `src/db/schema.ts`, and call the exact functions `resolveEnvSecret`, `uploadUserDataFile` (`src/lib/openai.ts`), `assertFileUploadSize` / `assertTurnIndex` (`src/lib/guards.ts`), plus the exact `RegistryDO` RPC methods `findFileByHash`, `beginUploadIntent`, `recordFileUpload`, `completeUploadIntent`, `listFiles`, `getFile`, and `protectJobFileRefs`.

### Invariants

**Bound multipart parsing at 16,000,000 bytes.** ARCHITECTURE §11: "The upload limit is **16,000,000 file bytes**. Multipart parsing, buffering, and hashing remain bounded." Check `Content-Length` before calling `request.formData()`; reject a declared size above the bound with a sanitized `413`. After parsing, enforce `file.size <= MAX_FILE_UPLOAD_BYTES` with `assertFileUploadSize`; 16,000,000 is accepted and 16,000,001 is rejected (TESTING §3). Never call `formData()` on an unchecked body (docs/HTTPHELPERS.md trap 4.1).

**Accept only the exact multipart contract.** Require `multipart/form-data`; read exactly one `file` field and an optional `turnIndex` field. Reject missing/duplicate `file`, non-file parts, and a non-positive or non-integer `turnIndex` (`assertTurnIndex`, strictly 1-based). README §Files and Limits: "Inline file text, base64 attachments, and `file_url` are not accepted by that submission interface." Reject JSON bodies, base64 strings, inline text, and `file_url` with the `rejected` result code `unsupported_input` or `invalid_multipart`.

**Hash the exact buffered bytes.** Compute the SHA-256 digest over the bytes exactly as received while buffering them; store/compare lowercase hex. Never derive the hash from a re-encoded string, never trust a client-supplied hash, and never accept an `sha256` form field as authoritative.

**Dedupe by content hash before uploading.** Call `REGISTRY_DO.findFileByHash(sha256)`. README §Files and Limits: "Live content hashes deduplicate source uploads." When a live `FileCatalogueRecord` exists, return `{ kind: "uploaded", file, deduplicated: true }` without a provider call and without a new catalogue row. Only a null/miss result proceeds to upload.

**Record a durable intent before the external upload.** Call `REGISTRY_DO.beginUploadIntent` with a unique `intentId`, the computed `sha256`, filename, MIME type, `byteSize`, and an explicit `expiresAtMs`; then upload. README §Files and Limits: "Upload intents support recovery and cleanup of ambiguous or redundant uploads." If the provider call fails, return the `rejected` variant (`provider_error`) with a sanitized message and leave the `pending` intent for expiry cleanup; do not invent a failure RPC.

**Use the Files API contract.** Call `uploadUserDataFile({ apiKey: resolveEnvSecret(env, "OPENAI_API_KEY"), filename, mimeType, bytes })`. README §Files and Limits: "Client-submitted generation attachments use Files API uploads with `purpose: "user_data"` and returned `file_id` references." Resolve the secret at call time; never cache, log, or serialize it.

**Complete the catalogue and the intent.** After a successful upload, call `REGISTRY_DO.recordFileUpload` with the provider `fileId`, hash, filename, MIME type, and byte size, then `REGISTRY_DO.completeUploadIntent(intentId, fileId)`. Return `{ kind: "uploaded", file, deduplicated: false }`. Never return a `file_id` that is not in the catalogue.

**Preflight allows the multipart envelope, the file bound is exact.** `Content-Length` includes boundaries and part headers, so a preflight check must allow a small envelope overhead while still rejecting obviously oversized requests; the authoritative check is `file.size` against `MAX_FILE_UPLOAD_BYTES` after parsing. Never accept file bytes above 16,000,000 and never reject a valid 16,000,000-byte file because of boundary overhead.

**Buffer once and only within the bound.** Keep a single bounded copy of the file bytes for hashing and upload; do not accumulate base64 or string copies, and release the buffer after the provider call. Never write the bytes to Durable Object storage.

**Normalize metadata without inventing it.** Use the part's filename reduced to its basename (no path components, no control characters) and its declared MIME type, defaulting to `application/octet-stream` only when absent. Never derive the filename from the hash, discard the original name, or trust a filename as a storage key.

**Concurrent duplicates converge on one live row.** Two identical uploads may both miss `findFileByHash`; each must still complete its own intent, but the catalogue must never hold two live rows for one hash. If the hash is already live when the provider upload returns, return the existing record with `deduplicated: true` and complete this path's intent against the live `fileId` instead of inserting a second row.

**Protect references before a job becomes ready.** README §Files and Limits: "Non-terminal file references are protected before a job becomes ready." When an upload is associated with a pending `turnIndex`, it is the job-creation path's obligation to call `REGISTRY_DO.protectJobFileRefs(jobId, fileIds)` before the job is observable as ready; this handler never sets job status and never claims a job reference on its own.

**Catalogue reads are metadata only.** `GET /api/files/:fileId` calls `REGISTRY_DO.getFile(fileId)` and returns a `FileCatalogueRecord` (IDs, hash, filename, MIME type, size, reference counts, timestamps), never bytes. Unknown IDs are `404 not_found`. Lists (if exposed through `listFiles`) use primary-key cursors and clamp to 1–100 (README §Files and Limits).

**Rejections never mutate the catalogue.** A rejected upload writes no catalogue row, no file reference, and no job reference. If an intent was already begun, leave it `pending` for expiry cleanup; do not delete or repurpose another record to compensate.

**Reads are side-effect free.** `GET /api/files/:fileId` performs no revision bump, no reference change, and no provider call. Unknown IDs return `404`; deleted catalogue records return their recorded status rather than a fabricated live record.

**No direct provider fetch.** All Files API traffic goes through `src/lib/openai.ts` (`uploadUserDataFile`); do not call `https://api.openai.com` from the handler, build the authorization header by hand, or parse the raw provider envelope beyond what the function returns.

**Intent timestamps are durable observations.** Record `createdAtMs` / `updatedAtMs` and the intent expiry from the handler clock at the moment of the call; never derive them inside the DO from a different clock. An expired intent never authorizes a later upload.

**Sanitize errors and redact credentials.** Use `toErrorResponse` / `errorResponse` with stable codes; never return stack traces, provider bodies containing secrets, file bytes, or base64 echoes. Do not log the authorization header, the API key, or full file content.

### Platform traps

- Read an upload body once (`arrayBuffer()`/`formData()`) and forward cloneable bytes; a `ReadableStream` request body cannot be replayed by retries, and a second read after `bodyUsed` fails unless the request was cloned first.
- RPC arguments containing streams, stubs, functions, or `RpcTarget` are not retried; convert upload bytes to `Uint8Array`/`ArrayBuffer` (both structured-cloneable) before passing them to a Durable Object.
- Outbound Durable Object/Worker `fetch()` request bodies are capped at 100 MiB per request and can return `413 Payload Too Large`; streaming, HTTP chunked transfer, and `multipart/form-data` do not bypass the cap.
- A request can hold at most 6 simultaneous outgoing connections, the same limit as Workers.
- SQLite-backed storage rejects any string, `BLOB`, or row larger than 2 MB; `SQLITE_FULL` rejects writes while reads and deletes continue.
- CPU time defaults to 30 seconds per invocation; incoming HTTP wall time is unlimited while the client remains connected, and `waitUntil()` adds only a 30-second tail after the response or disconnect.
- Each isolate has a 128 MB memory limit, which bounds how much upload payload can be buffered in memory at once.
- Runtime retries can repeat a file-creation/upload call; an unmarked method rejects replay after an ambiguous connection drop, `retryable()` permits a second run, and `.overloaded` errors are never retried.
Source: https://developers.cloudflare.com/durable-objects/best-practices/automatic-retries/ ; https://developers.cloudflare.com/durable-objects/platform/limits/#outbound-http-request-body-size ; https://developers.cloudflare.com/durable-objects/platform/limits/#sqlite-backed-durable-objects-general-limits ; https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type

### Integration points

- `env.REGISTRY_DO`: `findFileByHash`, `beginUploadIntent`, `recordFileUpload`, `completeUploadIntent`, `listFiles`, `getFile`, `protectJobFileRefs`.
- `src/lib/openai.ts`: `resolveEnvSecret`, `uploadUserDataFile`; `src/lib/guards.ts`: `assertFileUploadSize`, `assertTurnIndex`, `clampPageLimit`.
- `src/http.ts`: `readBoundedBytes` where applicable, `errorResponse` / `payloadTooLarge` / `unsupportedMediaType` / `notFound`, `toErrorResponse`.
- `src/constants.ts`: `MAX_FILE_UPLOAD_BYTES`, `OPENAI_FILE_UPLOAD_PURPOSE`.
- `GET /api/files/:fileId` uses the amended `getFile(fileId)` catalogue lookup.

### Anti-patterns

- Do not call `request.formData()` before bounding `Content-Length`, and do not buffer an upload twice.
- Do not accept inline text, base64, or `file_url` content through the attachment surface.
- Do not hash a re-serialized string, a client hash, or a truncated prefix.
- Do not upload before the intent is durable, or complete an intent with a different `fileId`.
- Do not create a second catalogue row for a live hash match.
- Do not store bytes in SQLite, return them from the catalogue route, or log them.
- Do not mark a job ready or claim job references from this handler.
- Do not allow multipart envelope overhead to widen the file-byte bound, or reject a valid boundary-size file.
- Do not derive a filename from the content hash, use a filename as a storage path, or drop control-character checks.
- Do not keep a second copy of the upload for hashing, or leave the buffer alive past the provider call.
- Do not create a catalogue row, file reference, or job reference for a rejected upload.
- Do not call the Files API directly or hand-build its authorization header.
- Do not re-upload when a live hash row exists, or return a catalogue record whose intent never completed.
- Do not add read-by-other-key routes or extra RPC methods to work around a missing contract.
### Export

```ts
export function handleFilesRequest(request: Request, env: Env): Promise<Response>
```

Only `/api/files` and `/api/files/:fileId`; any other path returns `404 not_found`.
