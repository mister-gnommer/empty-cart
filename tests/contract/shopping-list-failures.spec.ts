import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ImageFetchResult, MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import type { OcrProviderResult, UnavailableCause } from '../../src/ocr/types';
import { SUBMISSION_BUDGET_MS } from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { att, buildHandler, okFetch, submission } from '../helpers/list-submission-env';
import { okResult, unavailableResult, undecodableResult } from '../helpers/stub-ocr-provider';

const OVERSIZE_ATTACHMENT = att({ reportedSize: MAX_IMAGE_BYTES + 1 });

describe('local metadata checks run before any download or provider call', () => {
  it('oversize reported size on attachment 2 of 2 → too-large message, nothing downloaded or recognized', async () => {
    const env = buildHandler({ script: [okResult('A')], fetch: [okFetch()] });
    const reply = await env.handler(submission({}, [att(), OVERSIZE_ATTACHMENT]));
    expect(reply.text).toBe(LIST_MESSAGES.imageTooLarge);
    expect(env.fetchInputs).toEqual([]);
    expect(env.provider.calls).toEqual([]);
  });

  it('unsupported reported content type → unsupported-format message, nothing downloaded', async () => {
    const env = buildHandler({ script: [okResult('A')], fetch: [okFetch()] });
    const reply = await env.handler(submission({}, [att({ reportedContentType: 'image/gif' })]));
    expect(reply.text).toBe(LIST_MESSAGES.unsupportedFormat);
    expect(env.fetchInputs).toEqual([]);
  });

  it('a MISSING content type is not a local rejection — the image proceeds to download', async () => {
    const env = buildHandler({ script: [okResult('A')], fetch: [okFetch()] });
    const reply = await env.handler(submission({}, [att({ reportedContentType: null })]));
    expect(reply.text).toBe('A');
    expect(env.fetchInputs).toHaveLength(1);
  });
});

describe('per-user busy guard', () => {
  it('an overlapping second submission from the same user gets the busy message without download or provider; the first completes uninterrupted', async () => {
    const gate = Promise.withResolvers<OcrProviderResult>();
    const env = buildHandler({
      script: [() => gate.promise, okResult('never')],
      fetch: [okFetch(), okFetch()],
    });
    const first = env.handler(submission());
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    const second = await env.handler(submission());
    expect(second.text).toBe(LIST_MESSAGES.busy);
    expect(env.fetchInputs).toHaveLength(1);
    expect(env.provider.calls).toHaveLength(1);

    gate.resolve(okResult('first-text'));
    expect((await first).text).toBe('first-text');
  });

  it('a different user is served while the first user is still in flight', async () => {
    const gate = Promise.withResolvers<OcrProviderResult>();
    const env = buildHandler({
      script: [() => gate.promise, okResult('text-of-user-2')],
      fetch: [okFetch(), okFetch()],
    });
    const first = env.handler(submission({ userId: 'user-1' }));
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    expect((await env.handler(submission({ userId: 'user-2' }))).text).toBe('text-of-user-2');

    gate.resolve(okResult('text-of-user-1'));
    expect((await first).text).toBe('text-of-user-1');
  });

  it('a busy user sending an oversized or wrongly typed attachment gets that specific message, not busy', async () => {
    const gate = Promise.withResolvers<OcrProviderResult>();
    const env = buildHandler({ script: [() => gate.promise], fetch: [okFetch()] });
    const first = env.handler(submission());
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    const oversize = await env.handler(submission({}, [OVERSIZE_ATTACHMENT]));
    expect(oversize.text).toBe(LIST_MESSAGES.imageTooLarge);
    const badType = await env.handler(submission({}, [att({ reportedContentType: 'video/mp4' })]));
    expect(badType.text).toBe(LIST_MESSAGES.unsupportedFormat);

    gate.resolve(okResult('done'));
    await first;
  });

  it('the guard is released after a successful submission', async () => {
    const env = buildHandler({
      script: [okResult('one'), okResult('two')],
      fetch: [okFetch(), okFetch()],
    });
    expect((await env.handler(submission())).text).toBe('one');
    expect((await env.handler(submission())).text).toBe('two');
  });

  it('the guard is released after a failed outcome', async () => {
    const env = buildHandler({
      script: [unavailableResult('unreachable'), okResult('after-failure')],
      fetch: [okFetch(), okFetch()],
    });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect((await env.handler(submission())).text).toBe('after-failure');
  });

  it('the guard is released even when the provider throws', async () => {
    const env = buildHandler({
      script: [
        () => {
          throw new Error('vendor exploded');
        },
        okResult('after-throw'),
      ],
      fetch: [okFetch(), okFetch()],
    });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect((await env.handler(submission())).text).toBe('after-throw');
  });
});

describe('post-download failures map to their reply class', () => {
  it.each([
    ['too-large', LIST_MESSAGES.imageTooLarge],
    ['unsupported-format', LIST_MESSAGES.unsupportedFormat],
    ['unretrievable', LIST_MESSAGES.serviceUnavailable],
  ] as const)(
    'fetch result %s → matching reply, provider never called',
    async (status, expected) => {
      const env = buildHandler({ script: [okResult('A')], fetch: [{ status }] });
      const reply = await env.handler(submission());
      expect(reply.text).toBe(expected);
      expect(env.provider.calls).toEqual([]);
    },
  );

  it('a throwing download is contained and answered with the generic message', async () => {
    const env = buildHandler({
      script: [okResult('A')],
      fetch: [
        async () => {
          throw new Error('download exploded');
        },
      ],
    });
    const reply = await env.handler(submission());
    expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect(env.provider.calls).toEqual([]);
  });
});

describe('provider outcomes map to their reply class', () => {
  it('undecodable image → unsupported-format message', async () => {
    const env = buildHandler({ script: [undecodableResult()], fetch: [okFetch()] });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.unsupportedFormat);
  });

  // deadline-exceeded takes its own (cancelled) logging branch; the reply must not differ.
  it.each(['unreachable', 'deadline-exceeded'] satisfies UnavailableCause[])(
    'unavailable (%s) → the generic message',
    async (cause) => {
      const env = buildHandler({ script: [unavailableResult(cause)], fetch: [okFetch()] });
      expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.serviceUnavailable);
    },
  );
});

describe('all-or-nothing multi-image submissions', () => {
  const THREE_IMAGES = [
    att({ url: 'https://cdn.test/1.png' }),
    att({ url: 'https://cdn.test/2.png' }),
    att({ url: 'https://cdn.test/3.png' }),
  ];

  it('a provider failure on image 2 → only its failure message, no partial text, image 3 never downloaded', async () => {
    const env = buildHandler({
      script: [okResult('PARTIAL-1'), undecodableResult(), okResult('3')],
      fetch: [okFetch(), okFetch(), okFetch()],
    });
    const reply = await env.handler(submission({}, THREE_IMAGES));
    expect(reply.text).toBe(LIST_MESSAGES.unsupportedFormat);
    expect(env.fetchInputs).toHaveLength(2);
  });

  it('a download failure on image 2 → only its failure message, no partial text, image 3 never downloaded', async () => {
    const env = buildHandler({
      script: [okResult('PARTIAL-1'), okResult('2'), okResult('3')],
      fetch: [okFetch(), { status: 'too-large' }, okFetch()],
    });
    const reply = await env.handler(submission({}, THREE_IMAGES));
    expect(reply.text).toBe(LIST_MESSAGES.imageTooLarge);
    expect(env.fetchInputs).toHaveLength(2);
    expect(env.provider.calls).toHaveLength(1);
  });
});

describe('shared submission budget', () => {
  it('deadline passing mid-submission → generic message without asking the provider on a spent budget, guard released', async () => {
    let clock = 1_000;
    const env = buildHandler({
      script: [okResult('page-1'), okResult('next')],
      fetch: [
        okFetch(),
        async () => {
          // The second download eats the rest of the shared budget.
          clock += SUBMISSION_BUDGET_MS;
          return okFetch();
        },
        okFetch(),
      ],
      now: () => clock,
    });
    const reply = await env.handler(submission({}, [att(), att()]));
    expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect(env.provider.calls).toHaveLength(1);

    expect((await env.handler(submission())).text).toBe('next');
  });

  it('every provider call receives the remaining shared budget, not a fresh one', async () => {
    let clock = 1_000;
    const env = buildHandler({
      script: [
        () => {
          clock += 10_000;
          return okResult('a');
        },
        okResult('b'),
      ],
      fetch: [okFetch(), okFetch()],
      now: () => clock,
    });
    const reply = await env.handler(submission({}, [att(), att()]));
    expect(reply.text).toBe('a\nb');
    expect(env.provider.calls.map((c) => c.timeoutMs)).toEqual([
      SUBMISSION_BUDGET_MS,
      SUBMISSION_BUDGET_MS - 10_000,
    ]);
  });
});

describe('the shared budget is enforced against callees that never settle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const neverSettles = () => new Promise<never>(() => undefined);

  it('a download that never settles → generic message once the budget elapses, cancelled logged, guard released', async () => {
    const env = buildHandler({
      script: [okResult('after-release')],
      fetch: [neverSettles, okFetch()],
    });
    const pending = env.handler(submission());
    await vi.advanceTimersByTimeAsync(SUBMISSION_BUDGET_MS);
    expect((await pending).text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect(env.provider.calls).toEqual([]);
    expect(env.cap.lines.some((l) => l.msg === 'list submission cancelled')).toBe(true);

    expect((await env.handler(submission())).text).toBe('after-release');
  });

  it('a provider call that never settles → generic message once the budget elapses, guard released', async () => {
    const env = buildHandler({
      script: [neverSettles, okResult('after-release')],
      fetch: [okFetch(), okFetch()],
    });
    const pending = env.handler(submission());
    await vi.advanceTimersByTimeAsync(SUBMISSION_BUDGET_MS);
    expect((await pending).text).toBe(LIST_MESSAGES.serviceUnavailable);
    const cancelled = env.cap.lines.find((l) => l.msg === 'list submission cancelled');
    expect(cancelled?.providerId).toBe(env.provider.id);

    expect((await env.handler(submission())).text).toBe('after-release');
  });

  it('the download receives an abort signal that fires when the budget elapses', async () => {
    let seen: AbortSignal | undefined;
    const env = buildHandler({
      fetch: [
        (input) => {
          seen = input.signal;
          return neverSettles();
        },
      ],
    });
    const pending = env.handler(submission());
    await vi.advanceTimersByTimeAsync(0);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(SUBMISSION_BUDGET_MS);
    await pending;
    expect(seen?.aborted).toBe(true);
  });

  it('a submission that finishes in time leaves no budget timer behind', async () => {
    const env = buildHandler({ script: [okResult('A')], fetch: [okFetch()] });
    await env.handler(submission());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late rejection from a callee abandoned before it started is handled (no unhandled rejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const env = buildHandler({
        fetch: [
          () => {
            // The budget timer fires before the download promise exists, so the
            // race sees an already-aborted signal on entry.
            vi.advanceTimersByTime(SUBMISSION_BUDGET_MS);
            return new Promise<ImageFetchResult>((_resolve, reject) => {
              setTimeout(() => reject(new Error('late failure')), 10);
            });
          },
        ],
      });
      const reply = await env.handler(submission());
      expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
      await vi.advanceTimersByTimeAsync(20);
      // Unhandled-rejection events are delivered on a real macrotask.
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('blank pages in a multi-image submission', () => {
  it('a blank page between recognized pages is skipped — no stray empty line in the reply', async () => {
    const env = buildHandler({
      script: [okResult('page-1'), okResult(''), okResult(' \n'), okResult('page-4')],
      fetch: [okFetch(), okFetch(), okFetch(), okFetch()],
    });
    const reply = await env.handler(submission({}, [att(), att(), att(), att()]));
    expect(reply.text).toBe('page-1\npage-4');
  });

  it('only blank pages → the no-readable-text message', async () => {
    const env = buildHandler({
      script: [okResult(''), okResult('\n')],
      fetch: [okFetch(), okFetch()],
    });
    const reply = await env.handler(submission({}, [att(), att()]));
    expect(reply.text).toBe(LIST_MESSAGES.noReadableText);
  });
});
