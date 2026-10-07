import { describe, expect, it } from 'vitest';
import type { ImageFetchResult } from '../../src/image/fetch-image';
import type { ListSubmissionInput } from '../../src/shopping-list/handle-list-submission';
import {
  createListSubmissionHandler,
  SUBMISSION_BUDGET_MS,
} from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { makeCapturingLogger } from '../helpers/logger';
import {
  createStubOcrProvider,
  okResult,
  type StubScriptEntry,
} from '../helpers/stub-ocr-provider';

// Zero network, zero vendor SDKs: the orchestrator runs against the stub
// provider and a scripted fetchImage seam.

const PAGE_TEXT = 'RECOGNIZED-PAGE-TEXT-Milk\nEggs\nBread';

function submission(
  overrides: Partial<ListSubmissionInput> = {},
  attachments: ListSubmissionInput['attachments'] = [
    { url: 'https://cdn.test/1.png', reportedSize: 3, reportedContentType: 'image/png' },
  ],
): ListSubmissionInput {
  return {
    correlationId: 'corr-1',
    userId: 'user-1',
    channelId: 'chan-1',
    attachments,
    ...overrides,
  };
}

function okFetch(data: number[], format: 'jpeg' | 'png' | 'webp' = 'png'): ImageFetchResult {
  const imageBytes = new Uint8Array(data);
  return { status: 'ok', bytes: imageBytes, format, sizeBytes: imageBytes.length };
}

function scriptedFetchImage(results: ImageFetchResult[], opts: { throws?: boolean } = {}) {
  const inputs: Array<{
    url: string;
    reportedSize: number | null;
    reportedContentType: string | null;
  }> = [];
  let next = 0;
  const fn = async (fetchInput: {
    url: string;
    reportedSize: number | null;
    reportedContentType: string | null;
  }): Promise<ImageFetchResult> => {
    inputs.push(fetchInput);
    if (opts.throws) {
      throw new Error('download exploded');
    }
    const result = results[next];
    next += 1;
    if (result === undefined) {
      throw new Error('scripted fetchImage: script exhausted');
    }
    return result;
  };
  return { fn, inputs };
}

function build(
  script: StubScriptEntry[],
  fetchResults: ImageFetchResult[],
  opts: { languageHints?: readonly string[]; fetchThrows?: boolean; now?: () => number } = {},
) {
  const cap = makeCapturingLogger();
  const provider = createStubOcrProvider(script);
  const fetchSeam = scriptedFetchImage(fetchResults, { throws: opts.fetchThrows });
  const handler = createListSubmissionHandler({
    provider,
    fetchImage: fetchSeam.fn,
    languageHints: opts.languageHints ?? ['en', 'de'],
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    now: opts.now ?? (() => 1_000),
  });
  return { handler, provider, fetchSeam, cap };
}

describe('orchestrator happy path', () => {
  it('single image: recognize is called once with the fetched bytes/format, configured hints, and a positive budget timeout; reply equals the page text byte-for-byte', async () => {
    const env = build([okResult(PAGE_TEXT)], [okFetch([1, 2, 3])]);
    const reply = await env.handler(submission());
    expect(reply.text).toBe(PAGE_TEXT);
    expect(env.provider.calls).toHaveLength(1);
    expect(env.provider.calls[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(env.provider.calls[0].format).toBe('png');
    expect(env.provider.calls[0].languageHints).toEqual(['en', 'de']);
    expect(env.provider.calls[0].timeoutMs).toBeGreaterThan(0);
    expect(env.provider.calls[0].timeoutMs).toBeLessThanOrEqual(SUBMISSION_BUDGET_MS);
  });

  it('three images: provider called sequentially in attachment order, reply is the page texts joined by a single newline', async () => {
    const env = build(
      [okResult('A'), okResult('B'), okResult('C')],
      [okFetch([1], 'jpeg'), okFetch([2], 'png'), okFetch([3], 'webp')],
    );
    const reply = await env.handler(
      submission({}, [
        { url: 'https://cdn.test/1.jpg', reportedSize: 1, reportedContentType: 'image/jpeg' },
        { url: 'https://cdn.test/2.png', reportedSize: 1, reportedContentType: 'image/png' },
        { url: 'https://cdn.test/3.webp', reportedSize: 1, reportedContentType: 'image/webp' },
      ]),
    );
    expect(reply.text).toBe('A\nB\nC');
    expect(env.fetchSeam.inputs.map((i) => i.url)).toEqual([
      'https://cdn.test/1.jpg',
      'https://cdn.test/2.png',
      'https://cdn.test/3.webp',
    ]);
    // Distinct formats per call prove the processing followed attachment order.
    expect(env.provider.calls.map((c) => c.format)).toEqual(['jpeg', 'png', 'webp']);
    expect(env.provider.calls.map((c) => c.bytes)).toEqual([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
  });
});

describe('orchestrator containment of unstructured outcomes', () => {
  it('fetchImage throwing is caught and answered with the generic message', async () => {
    const env = build([okResult('A')], [], { fetchThrows: true });
    const reply = await env.handler(submission());
    expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect(env.provider.calls).toHaveLength(0);
  });
});
