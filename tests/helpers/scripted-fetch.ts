// Scripted fetch seam for image-download tests: canned responses, recorded
// request urls, and per-call body-cancellation tracking. No network access.
// Responses are real `Response` objects built over `ReadableStream`s whose
// `cancel()` hook records cancellation — chunked bodies are pulled on demand,
// so a consumer that cancels mid-body never buffers the remainder.

export type ScriptedResponseBody =
  | { chunks: readonly Uint8Array[] }
  | { bytes: Uint8Array }
  | { text: string }
  | null;

export type ScriptedFetchEntry =
  | { reject: Error | string }
  | { status?: number; headers?: Record<string, string>; body?: ScriptedResponseBody };

export type ScriptedFetch = {
  fetchImpl: typeof fetch;
  /** Requested urls, in call order. */
  readonly requestedUrls: string[];
  /** Per fetch call (same index as requestedUrls): was the body reader cancelled? */
  readonly cancelled: boolean[];
  /** Per fetch call: how many body chunks the consumer actually pulled (proves bounded accumulation). */
  readonly pulled: number[];
  /** Per fetch call: the abort signal passed in the request init, if any. */
  readonly signals: Array<AbortSignal | undefined>;
};

/** Normalizes every scripted body shape to the chunk list the stream serves, one pull per chunk. */
function toChunks(body: ScriptedResponseBody): Uint8Array[] {
  if (body === null || body === undefined) {
    return [];
  }
  if ('chunks' in body) {
    return [...body.chunks];
  }
  if ('bytes' in body) {
    return [body.bytes];
  }
  return [new TextEncoder().encode(body.text)];
}

/**
 * Creates a fetch stand-in that answers call N with entry N and records each
 * call's url, signal, pulled chunk count and body cancellation. Running past
 * the script rejects, so an unexpected download fails the test.
 * @param entries the canned responses or rejections, in call order
 */
export function createScriptedFetch(entries: readonly ScriptedFetchEntry[]): ScriptedFetch {
  const requestedUrls: string[] = [];
  const cancelled: boolean[] = [];
  const pulled: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];

  const fetchImpl: typeof fetch = (input, init) => {
    const index = requestedUrls.length;
    requestedUrls.push(String(input));
    signals[index] = init?.signal ?? undefined;
    cancelled[index] = false;
    pulled[index] = 0;

    const entry = entries[index];
    if (entry === undefined) {
      return Promise.reject(
        new Error(`scripted fetch: no entry for call ${index + 1} (${String(input)})`),
      );
    }
    if ('reject' in entry) {
      const err = typeof entry.reject === 'string' ? new Error(entry.reject) : entry.reject;
      return Promise.reject(err);
    }

    const hasBody = entry.body !== null && entry.body !== undefined;
    const chunks = toChunks(entry.body ?? null);
    let nextChunk = 0;
    const stream = hasBody
      ? new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks[nextChunk];
            nextChunk += 1;
            if (chunk !== undefined) {
              pulled[index] += 1;
              controller.enqueue(chunk);
            }
            if (nextChunk >= chunks.length) {
              controller.close();
            }
          },
          cancel() {
            cancelled[index] = true;
          },
        })
      : null;

    const response = new Response(stream, {
      status: entry.status ?? 200,
      headers: entry.headers ?? {},
    });
    return Promise.resolve(response);
  };

  return { fetchImpl, requestedUrls, cancelled, pulled, signals };
}
