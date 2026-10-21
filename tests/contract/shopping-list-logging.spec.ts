import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import type { OcrProviderResult } from '../../src/ocr/types';
import {
  SUBMISSION_BUDGET_MS,
  type SubmissionAttachment,
} from '../../src/shopping-list/handle-list-submission';
import {
  att as baseAtt,
  okFetch as baseOkFetch,
  buildHandler,
  type FetchScriptEntry,
  submission,
} from '../helpers/list-submission-env';
import type { LoggedLine } from '../helpers/logger';
import {
  okResult,
  type StubScriptEntry,
  unavailableResult,
  undecodableResult,
} from '../helpers/stub-ocr-provider';

// Transition logging of the list-submission orchestrator: one structured,
// correlation-bound line per transition, and never any content — no image
// bytes, no recognized text, no full attachment urls.

const FIXTURE_TEXT = 'FIXTURE-SECRET-LIST Milk\nEggs';
const FIXTURE_BYTES = [0xde, 0xad, 0xbe, 0xef, 0x42, 0x17];
const URL_PATH = '/attachments/123/456/private-list.png';
const URL = `https://cdn.discordapp.test${URL_PATH}?ex=abc&hm=signature`;

/** A successful JPEG download of the recognizable fixture bytes. */
function okFetch() {
  return baseOkFetch('jpeg', FIXTURE_BYTES);
}

/** An attachment at the private fixture url, so a logged url is detectable. */
function att(overrides: Partial<SubmissionAttachment> = {}): SubmissionAttachment {
  return baseAtt({ url: URL, reportedSize: 6, reportedContentType: 'image/jpeg', ...overrides });
}

/** The single line logged with this message; fails the test on zero or several. */
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

/** Fails the test if any line carries the fixture text, url path or signature, or image bytes. */
function expectContentFree(lines: LoggedLine[]): void {
  for (const s of loggedStrings(lines)) {
    expect(s).not.toContain('FIXTURE-SECRET-LIST');
    expect(s).not.toContain(URL_PATH);
    expect(s).not.toContain('hm=signature');
  }
  // No byte-shaped values anywhere: no typed arrays, no raw byte sequences.
  const serialized = JSON.stringify(lines, (_k, v) => {
    expect(v).not.toBeInstanceOf(Uint8Array);
    return v;
  });
  expect(serialized).not.toContain(FIXTURE_BYTES.join(','));
}

type FailureRow = {
  label: string;
  script?: StubScriptEntry[];
  fetch?: FetchScriptEntry[];
  attachments?: SubmissionAttachment[];
  reason: string;
};

describe('transition logging', () => {
  it('success: received → submitted (per image) → succeeded, each bound to the correlation id', async () => {
    let clock = 1_000;
    const env = buildHandler({
      script: [
        () => {
          clock += 1_234;
          return okResult(FIXTURE_TEXT);
        },
        okResult(FIXTURE_TEXT),
      ],
      fetch: [okFetch(), okFetch()],
      now: () => clock,
    });
    await env.handler(submission({}, [att(), att({ reportedSize: 7 })]));

    expect(only(env.cap.lines, 'list submission received')).toMatchObject({
      correlationId: 'corr-1',
      userId: 'user-1',
      channelId: 'chan-1',
      attachmentCount: 2,
      reportedSizes: [6, 7],
    });
    expect(env.cap.lines.filter((l) => l.msg === 'image submitted')).toMatchObject([
      { correlationId: 'corr-1', position: 0, sizeBytes: 6, format: 'jpeg' },
      { correlationId: 'corr-1', position: 1, sizeBytes: 6, format: 'jpeg' },
    ]);
    expect(only(env.cap.lines, 'list submission succeeded')).toMatchObject({
      correlationId: 'corr-1',
      imageCount: 2,
      elapsedMs: 1_234,
    });
    expectContentFree(env.cap.lines);
  });

  it('a recognized page logs its text length at info level, never the text', async () => {
    const env = buildHandler({ script: [okResult(FIXTURE_TEXT)], fetch: [okFetch()] });
    await env.handler(submission({}, [att()]));
    expect(only(env.cap.lines, 'image recognized')).toMatchObject({
      level: 'info',
      position: 0,
      textLength: FIXTURE_TEXT.length,
    });
    expectContentFree(env.cap.lines);
  });

  it.each([
    {
      label: 'local oversize',
      attachments: [att({ reportedSize: MAX_IMAGE_BYTES + 1 })],
      reason: 'too-large',
    },
    {
      label: 'local bad content type',
      attachments: [att({ reportedContentType: 'image/gif' })],
      reason: 'unsupported',
    },
    { label: 'downloaded oversize', fetch: [{ status: 'too-large' }], reason: 'too-large' },
    {
      label: 'downloaded bad format',
      fetch: [{ status: 'unsupported-format' }],
      reason: 'unsupported',
    },
    { label: 'download failure', fetch: [{ status: 'unretrievable' }], reason: 'unretrievable' },
    {
      label: 'undecodable image',
      script: [undecodableResult()],
      fetch: [okFetch()],
      reason: 'unsupported',
    },
  ] satisfies FailureRow[])(
    '$label → one failed line with its reason class',
    async (row: FailureRow) => {
      const env = buildHandler({ script: row.script, fetch: row.fetch });
      await env.handler(submission({}, row.attachments ?? [att()]));
      expect(only(env.cap.lines, 'list submission failed')).toMatchObject({
        correlationId: 'corr-1',
        reason: row.reason,
      });
      expect(env.cap.lines.some((l) => l.msg === 'list submission succeeded')).toBe(false);
      expectContentFree(env.cap.lines);
    },
  );

  it('provider unavailability → failed line carrying the specific cause and the provider id', async () => {
    const env = buildHandler({
      script: [unavailableResult('quota-exhausted')],
      fetch: [okFetch()],
    });
    await env.handler(submission({}, [att()]));
    expect(only(env.cap.lines, 'list submission failed')).toMatchObject({
      correlationId: 'corr-1',
      reason: 'provider-unavailable',
      cause: 'quota-exhausted',
      providerId: env.provider.id,
    });
    expectContentFree(env.cap.lines);
  });

  it('provider log context is carried nested on the failed line', async () => {
    const env = buildHandler({
      script: [
        {
          status: 'unavailable',
          cause: 'provider-error',
          logContext: { googleCode: 13, googleReason: null, msg: 'vendor-shadow' },
        },
      ],
      fetch: [okFetch()],
    });
    await env.handler(submission({}, [att()]));
    const failed = only(env.cap.lines, 'list submission failed');
    // A nested `msg` must not shadow the line's own message.
    expect(failed.providerLogContext).toEqual({
      googleCode: 13,
      googleReason: null,
      msg: 'vendor-shadow',
    });
  });

  it('provider log context is carried on the cancelled line for a provider-side deadline', async () => {
    const env = buildHandler({
      script: [
        {
          status: 'unavailable',
          cause: 'deadline-exceeded',
          logContext: { googleCode: 4, googleReason: null },
        },
      ],
      fetch: [okFetch()],
    });
    await env.handler(submission({}, [att()]));
    expect(only(env.cap.lines, 'list submission cancelled')).toMatchObject({
      providerId: env.provider.id,
      providerLogContext: { googleCode: 4, googleReason: null },
    });
  });

  it('a thrown exception → failed line with the exception reason, bound to the correlation id', async () => {
    const env = buildHandler({
      script: [
        () => {
          throw new Error('vendor exploded');
        },
      ],
      fetch: [okFetch()],
    });
    await env.handler(submission({}, [att()]));
    expect(only(env.cap.lines, 'list submission failed')).toMatchObject({
      correlationId: 'corr-1',
      reason: 'exception',
    });
  });

  it('shared budget spent → one cancelled line with elapsedMs, no failed line', async () => {
    let clock = 1_000;
    const env = buildHandler({
      script: [okResult('never')],
      fetch: [
        async () => {
          clock += SUBMISSION_BUDGET_MS + 500;
          return okFetch();
        },
      ],
      now: () => clock,
    });
    await env.handler(submission({}, [att()]));
    expect(only(env.cap.lines, 'list submission cancelled')).toMatchObject({
      correlationId: 'corr-1',
      elapsedMs: SUBMISSION_BUDGET_MS + 500,
    });
    expect(env.cap.lines.some((l) => l.msg === 'list submission failed')).toBe(false);
    expectContentFree(env.cap.lines);
  });

  it('a busy rejection → one rejected-busy line bound to the rejected submission correlation id', async () => {
    const gate = Promise.withResolvers<OcrProviderResult>();
    const env = buildHandler({ script: [() => gate.promise], fetch: [okFetch()] });
    const first = env.handler(submission({ correlationId: 'corr-first' }, [att()]));
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    await env.handler(submission({ correlationId: 'corr-second' }, [att()]));
    expect(only(env.cap.lines, 'list submission rejected busy')).toMatchObject({
      correlationId: 'corr-second',
      userId: 'user-1',
    });

    gate.resolve(okResult(FIXTURE_TEXT));
    await first;
    expectContentFree(env.cap.lines);
  });
});
