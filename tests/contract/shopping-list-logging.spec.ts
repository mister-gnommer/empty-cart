import { describe, expect, it, vi } from 'vitest';
import type { ImageFetchResult } from '../../src/image/fetch-image';
import { MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import type { OcrProviderResult } from '../../src/ocr/types';
import {
  createListSubmissionHandler,
  type ListSubmissionInput,
  SUBMISSION_BUDGET_MS,
  type SubmissionAttachment,
} from '../../src/shopping-list/handle-list-submission';
import { type LoggedLine, makeCapturingLogger } from '../helpers/logger';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
  unavailableResult,
  undecodableResult,
} from '../helpers/stub-ocr-provider';

// Transition logging of the list-submission orchestrator: one structured,
// correlation-bound line per transition, and never any content — no image
// bytes, no recognized text, no full attachment urls, no credentials.

const FIXTURE_TEXT = 'FIXTURE-SECRET-LIST Milk\nEggs';
const FIXTURE_BYTES = [0xde, 0xad, 0xbe, 0xef, 0x42, 0x17];
const URL_PATH = '/attachments/123/456/private-list.png';
const URL = `https://cdn.discordapp.test${URL_PATH}?ex=abc&hm=signature`;

type FetchScriptEntry = ImageFetchResult | (() => Promise<ImageFetchResult>);

function okFetch(): ImageFetchResult {
  const bytes = new Uint8Array(FIXTURE_BYTES);
  return { status: 'ok', bytes, format: 'jpeg', sizeBytes: bytes.length };
}

function att(overrides: Partial<SubmissionAttachment> = {}): SubmissionAttachment {
  return { url: URL, reportedSize: 6, reportedContentType: 'image/jpeg', ...overrides };
}

function submission(
  overrides: Partial<ListSubmissionInput> = {},
  attachments: SubmissionAttachment[] = [att()],
): ListSubmissionInput {
  return {
    correlationId: 'corr-log',
    userId: 'user-1',
    channelId: 'chan-1',
    attachments,
    ...overrides,
  };
}

function build(script: StubScriptEntry[], fetch: FetchScriptEntry[], now?: () => number) {
  const cap = makeCapturingLogger();
  const provider = createStubOcrProvider(script, 'stub-provider');
  let next = 0;
  const handler = createListSubmissionHandler({
    provider,
    fetchImage: async () => {
      const entry = fetch[next];
      next += 1;
      if (entry === undefined) {
        throw new Error('scripted fetchImage: script exhausted');
      }
      return typeof entry === 'function' ? entry() : entry;
    },
    languageHints: ['en'],
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    now: now ?? (() => 1_000),
  });
  return { handler, cap, provider };
}

function only(lines: LoggedLine[], msg: string): LoggedLine {
  const matching = lines.filter((l) => l.msg === msg);
  expect(matching).toHaveLength(1);
  return matching[0];
}

/** Every logged string value, recursively — the content-free scan target. */
function loggedStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(loggedStrings);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(loggedStrings);
  }
  return [];
}

function expectContentFree(lines: LoggedLine[]): void {
  const strings = loggedStrings(lines);
  for (const s of strings) {
    expect(s).not.toContain('FIXTURE-SECRET-LIST');
    expect(s).not.toContain('Eggs');
    expect(s).not.toContain(URL_PATH);
    expect(s).not.toContain('hm=signature');
    expect(s).not.toMatch(/PRIVATE KEY|private_key|client_email/u);
  }
  // No byte-shaped values anywhere: no typed arrays, no raw byte sequences.
  const serialized = JSON.stringify(lines, (_k, v) => {
    expect(v).not.toBeInstanceOf(Uint8Array);
    return v;
  });
  expect(serialized).not.toContain(FIXTURE_BYTES.join(','));
}

describe('transition logging', () => {
  it('success: received → submitted (per image) → succeeded, each bound to the correlation id', async () => {
    let clock = 1_000;
    const env = build(
      [
        () => {
          clock += 1_234;
          return okResult(FIXTURE_TEXT);
        },
        okResult(FIXTURE_TEXT),
      ],
      [okFetch(), okFetch()],
      () => clock,
    );
    await env.handler(submission({}, [att(), att({ reportedSize: 7 })]));

    const received = only(env.cap.lines, 'list submission received');
    expect(received).toMatchObject({
      correlationId: 'corr-log',
      userId: 'user-1',
      channelId: 'chan-1',
      attachmentCount: 2,
      reportedSizes: [6, 7],
    });

    const submitted = env.cap.lines.filter((l) => l.msg === 'image submitted');
    expect(submitted.map((l) => [l.correlationId, l.position, l.sizeBytes, l.format])).toEqual([
      ['corr-log', 0, 6, 'jpeg'],
      ['corr-log', 1, 6, 'jpeg'],
    ]);

    const succeeded = only(env.cap.lines, 'list submission succeeded');
    expect(succeeded).toMatchObject({ correlationId: 'corr-log', imageCount: 2, elapsedMs: 1_234 });
    expectContentFree(env.cap.lines);
  });

  it.each([
    ['local oversize', [], [], [att({ reportedSize: MAX_IMAGE_BYTES + 1 })], 'too-large'],
    ['local bad content type', [], [], [att({ reportedContentType: 'image/gif' })], 'unsupported'],
    ['downloaded oversize', [], [{ status: 'too-large' }], [att()], 'too-large'],
    ['downloaded bad format', [], [{ status: 'unsupported-format' }], [att()], 'unsupported'],
    ['download failure', [], [{ status: 'unretrievable' }], [att()], 'unretrievable'],
    ['undecodable image', [undecodableResult()], [okFetch()], [att()], 'unsupported'],
  ] as const)(
    '%s → one failed line with its reason class',
    async (_label, script, fetch, attachments, reason) => {
      const env = build([...script], [...fetch]);
      await env.handler(submission({}, [...attachments]));
      const failed = only(env.cap.lines, 'list submission failed');
      expect(failed.correlationId).toBe('corr-log');
      expect(failed.reason).toBe(reason);
      expect(env.cap.lines.some((l) => l.msg === 'list submission succeeded')).toBe(false);
      expectContentFree(env.cap.lines);
    },
  );

  it('provider unavailability → failed line carrying the specific cause and the provider id', async () => {
    const env = build([unavailableResult('quota-exhausted')], [okFetch()]);
    await env.handler(submission());
    const failed = only(env.cap.lines, 'list submission failed');
    expect(failed).toMatchObject({
      correlationId: 'corr-log',
      reason: 'provider-unavailable',
      cause: 'quota-exhausted',
      providerId: 'stub-provider',
    });
    expectContentFree(env.cap.lines);
  });

  it('a thrown exception → failed line with the exception reason, bound to the correlation id', async () => {
    const env = build(
      [
        () => {
          throw new Error('vendor exploded');
        },
      ],
      [okFetch()],
    );
    await env.handler(submission());
    const failed = only(env.cap.lines, 'list submission failed');
    expect(failed).toMatchObject({ correlationId: 'corr-log', reason: 'exception' });
  });

  it('shared budget spent → one cancelled line with elapsedMs, no failed line', async () => {
    let clock = 1_000;
    const env = build(
      [okResult('never')],
      [
        async () => {
          clock += SUBMISSION_BUDGET_MS + 500;
          return okFetch();
        },
      ],
      () => clock,
    );
    await env.handler(submission());
    const cancelled = only(env.cap.lines, 'list submission cancelled');
    expect(cancelled).toMatchObject({
      correlationId: 'corr-log',
      elapsedMs: SUBMISSION_BUDGET_MS + 500,
    });
    expect(env.cap.lines.some((l) => l.msg === 'list submission failed')).toBe(false);
    expectContentFree(env.cap.lines);
  });

  it('a busy rejection → one rejected-busy line bound to the rejected submission correlation id', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = build([() => gate.promise], [okFetch()]);
    const first = env.handler(submission({ correlationId: 'corr-first' }));
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    await env.handler(submission({ correlationId: 'corr-second' }));
    const busy = only(env.cap.lines, 'list submission rejected busy');
    expect(busy).toMatchObject({ correlationId: 'corr-second', userId: 'user-1' });

    gate.resolve(okResult(FIXTURE_TEXT));
    await first;
    expectContentFree(env.cap.lines);
  });
});
