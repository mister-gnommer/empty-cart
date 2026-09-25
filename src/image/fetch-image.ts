// Image download + validation. Plain global fetch (no vendor library), a
// hard 7 MB ceiling enforced in three layers, and magic-byte sniffing as the
// authoritative format gate. Bytes are returned to the caller and never
// copied, stored, or logged.

import { type ImageFormat, sniffFormat } from './sniff-format';

export type { ImageFormat } from './sniff-format';

/** Hardcoded ceiling — a module constant, deliberately NOT operator-configurable. */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;

// 🤖 AI-start
/** Reported content types that pass the pre-download filter; a missing type also proceeds. */
export const ACCEPTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);
// 🤖 AI-end

export type ImageFetchInput = {
  url: string;
  /** Discord-reported bytes; a free pre-download size gate. */
  reportedSize: number | null;
  /** Extension-derived hint, untrusted; missing proceeds to download. */
  reportedContentType: string | null;
  /** Aborts the download (the caller's submission budget); an abort yields `unretrievable`. */
  signal?: AbortSignal;
};

export type ImageFetchResult =
  | { status: 'ok'; bytes: Uint8Array; format: ImageFormat; sizeBytes: number }
  | { status: 'too-large' }
  | { status: 'unsupported-format' }
  | { status: 'unretrievable' };

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Downloads and validates one attachment. Evaluation order is fixed —
 * cheapest, most local checks first; every rejection happens before any
 * caller-side OCR work. `fetchImpl` is a test seam; production omits it.
 */
export async function fetchAndValidateImage(
  input: ImageFetchInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageFetchResult> {
  // 1. Reported-size gate — no download.
  if (input.reportedSize !== null && input.reportedSize > MAX_IMAGE_BYTES) {
    return { status: 'too-large' };
  }
  // 2. Content-type pre-filter — a MISSING hint proceeds to download.
  if (
    input.reportedContentType !== null &&
    !ACCEPTED_CONTENT_TYPES.has(input.reportedContentType)
  ) {
    return { status: 'unsupported-format' };
  }
  // 3. Download the original CDN url (never the media proxy, which may serve
  //    re-encoded variants).
  let response: Response;
  try {
    response = await fetchImpl(input.url, { signal: input.signal });
  } catch {
    return { status: 'unretrievable' };
  }
  if (!response.ok) {
    return { status: 'unretrievable' };
  }
  // 4. Declared-length gate — abort before reading the body.
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 'too-large' };
  }
  if (response.body === null) {
    // A 200 without a body is a server-side oddity, not a format problem.
    return { status: 'unretrievable' };
  }
  // 5. Stream with a running cap — cancel the moment the total exceeds the
  //    ceiling so oversize content is never fully buffered.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // 🤖 AI-start
    // Checked per chunk so a fetch implementation that ignores the signal
    // still stops accumulating once the budget is spent.
    if (input.signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      return { status: 'unretrievable' };
    }
    // 🤖 AI-end
    let done: boolean;
    let value: Uint8Array | undefined;
    try {
      const read = await reader.read();
      done = read.done;
      value = read.value;
    } catch {
      await reader.cancel().catch(() => undefined);
      return { status: 'unretrievable' };
    }
    if (done) {
      break;
    }
    if (value !== undefined) {
      chunks.push(value);
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: 'too-large' };
      }
    }
  }
  // 6. Magic bytes are authoritative — a passing content-type hint never
  //    overrides a failed sniff.
  const bytes = concatChunks(chunks, total);
  const format = sniffFormat(bytes);
  if (format === null) {
    return { status: 'unsupported-format' };
  }
  // 7. Authoritative size is the streamed byte count.
  return { status: 'ok', bytes, format, sizeBytes: total };
}
