# Contract — `image`

**Module path**: `src/image/`
**Depends on**: `src/shared/types` only (global `fetch`; no vendor imports → no new
`biome.json` boundary entry)
**Depended on by**: `shopping-list` (orchestrator)
**Spec refs**: FR-015, FR-021, User Story 2 scenarios 3–4, Edge Cases (non-image,
unsupported/corrupt, oversize, permission-less download)

## Public surface

```typescript
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024; // hardcoded 7 MB (spec §Assumptions)

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export type ImageFetchInput = {
  url: string;
  reportedSize: number | null;          // Discord-reported bytes
  reportedContentType: string | null;   // extension-derived hint, untrusted
};

export type ImageFetchResult =
  | { status: 'ok'; bytes: Uint8Array; format: ImageFormat; sizeBytes: number }
  | { status: 'too-large' }
  | { status: 'unsupported-format' }
  | { status: 'unretrievable' };

export function fetchAndValidateImage(
  input: ImageFetchInput,
  fetchImpl?: typeof fetch, // test seam; production omits
): Promise<ImageFetchResult>;

export function sniffFormat(bytes: Uint8Array): ImageFormat | null; // pure
```

## Behavioral contract

1. **Evaluation order is fixed** (cheapest, most local first; every rejection happens
   before any OCR provider call, FR-015/FR-021):
   1. `reportedSize > MAX_IMAGE_BYTES` → `too-large` (no download).
   2. `reportedContentType` present and not in `image/jpeg | image/png | image/webp` →
      `unsupported-format` (no download). A *missing* content type proceeds to download.
   3. Download `url` with `fetchImpl`; network error or non-OK status → `unretrievable`.
   4. `Content-Length` header > cap → abort, `too-large`.
   5. Stream the body via reader, accumulating chunks; cancel the reader the moment the
      running total exceeds the cap → `too-large` (never buffer oversize content, R8).
   6. `sniffFormat` on the downloaded bytes: `null` → `unsupported-format`.
   7. Otherwise `ok` with bytes, sniffed format, and authoritative `sizeBytes`.
2. **Magic bytes (`sniffFormat`, pure; research R9):** JPEG `FF D8 FF`; PNG
   `89 50 4E 47 0D 0A 1A 0A`; WEBP `RIFF` at offset 0 AND `WEBP` at offset 8. Fewer than
   12 bytes → `null`. GIF/BMP/TIFF/HEIC (`ftyp` brands) and anything else → `null`.
   Corrupt-but-sniff-passing files are the provider's decode-failure backstop and land on
   the same user message via the `undecodable-image` arm (ocr contract).
3. **No retention, no content logging.** `bytes` are returned to the caller and never
   copied, stored, or logged; failures log url host + reported size only, never bytes
   (FR-017, SC-005).
4. **Timeouts.** The download runs under the caller's shared submission budget; this
   module exposes no independent timeout knob (the orchestrator aborts via the budget —
   an over-budget download manifests as the submission's `cancelled`/generic path).

## Test obligations (TDD — written first, red, then green)

- `sniffFormat` unit table: minimal valid JPEG/PNG/WEBP headers → correct format; GIF,
  BMP, TIFF (both endians), HEIC `ftyp` box, random bytes, < 12 bytes → `null`.
- `fetchAndValidateImage` with a scripted `fetchImpl` seam:
  - `reportedSize` over cap → `too-large`, and fetch is NEVER called;
  - contentType `image/gif`, `application/pdf`, `video/mp4` → `unsupported-format`, fetch
    never called; contentType `null` → proceeds to download;
  - fetch rejects / status 403/404/500 → `unretrievable`;
  - `Content-Length` over cap → `too-large`, body reader cancelled;
  - chunked stream (no Content-Length) exceeding the cap mid-body → `too-large`, and the
    accumulated buffer is bounded (assert the reader was cancelled, not the whole body
    buffered);
  - ok body with PNG magic but contentType claiming `image/webp` → `ok` with format
    `png` (bytes beat the hint);
  - ok body under cap with JPEG magic → `ok`, `sizeBytes` equals actual length.
