// Handler-level harness for the list-submission orchestrator: the REAL handler
// over the stub OCR provider and a scripted fetchImage seam — zero network.
import type { ImageFetchInput, ImageFetchResult } from '../../src/image/fetch-image';
import type { OcrImageFormat } from '../../src/ocr/types';
import {
  createListSubmissionHandler,
  type ListSubmissionInput,
  type SubmissionAttachment,
} from '../../src/shopping-list/handle-list-submission';
import { makeCapturingLogger } from './logger';
import { createStubOcrProvider, type StubScriptEntry } from './stub-ocr-provider';

/** A scripted download: a fixed result, or a thunk that sees the request (to hold it open, throw, or capture its signal). */
export type FetchScriptEntry =
  | ImageFetchResult
  | ((input: ImageFetchInput) => Promise<ImageFetchResult>);

/** A successful download of these bytes, already sniffed as `format`. */
export function okFetch(
  format: OcrImageFormat = 'png',
  data: number[] = [1, 2, 3],
): ImageFetchResult {
  const bytes = new Uint8Array(data);
  return { status: 'ok', bytes, format, sizeBytes: bytes.length };
}

/** An attachment descriptor that passes the local metadata checks unless overridden. */
export function att(overrides: Partial<SubmissionAttachment> = {}): SubmissionAttachment {
  return {
    url: 'https://cdn.test/a.png',
    reportedSize: 3,
    reportedContentType: 'image/png',
    ...overrides,
  };
}

/** A submission from user-1 in chan-1, with one valid attachment by default. */
export function submission(
  overrides: Partial<ListSubmissionInput> = {},
  attachments: SubmissionAttachment[] = [att()],
): ListSubmissionInput {
  return {
    correlationId: 'corr-1',
    userId: 'user-1',
    channelId: 'chan-1',
    attachments,
    ...overrides,
  };
}

/**
 * Builds the handler over a stub provider answering `script` and a fetchImage
 * seam answering `fetch`, both in call order; running past either script rejects.
 * @param opts now defaults to a frozen clock, so every budget is exactly SUBMISSION_BUDGET_MS
 */
export function buildHandler(
  opts: {
    script?: StubScriptEntry[];
    fetch?: FetchScriptEntry[];
    languageHints?: readonly string[];
    now?: () => number;
  } = {},
) {
  const cap = makeCapturingLogger();
  const provider = createStubOcrProvider(opts.script ?? []);
  const fetchScript = opts.fetch ?? [];
  const fetchInputs: ImageFetchInput[] = [];
  const handler = createListSubmissionHandler({
    provider,
    fetchImage: async (input) => {
      const entry = fetchScript[fetchInputs.length];
      fetchInputs.push(input);
      if (entry === undefined) {
        throw new Error('scripted fetchImage: script exhausted');
      }
      return typeof entry === 'function' ? entry(input) : entry;
    },
    languageHints: opts.languageHints ?? ['en'],
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    now: opts.now ?? (() => 1_000),
  });
  return { handler, provider, fetchInputs, cap };
}
