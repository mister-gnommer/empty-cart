import { describe, expect, it, vi } from 'vitest';
import { type ImageFetchResult, MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import { createDisabledProvider } from '../../src/ocr/disabled-provider';
import type { OcrProvider, OcrProviderResult, UnavailableCause } from '../../src/ocr/types';
import {
  createListSubmissionHandler,
  type ListSubmissionInput,
  SUBMISSION_BUDGET_MS,
  type SubmissionAttachment,
} from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { makeCapturingLogger } from '../helpers/logger';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
  unavailableResult,
  undecodableResult,
} from '../helpers/stub-ocr-provider';

// Failure taxonomy, busy guard, and shared budget of the list-submission
// orchestrator — stub provider + scripted fetchImage, zero network.

type FetchInput = {
  url: string;
  reportedSize: number | null;
  reportedContentType: string | null;
  signal?: AbortSignal;
};

type FetchScriptEntry = ImageFetchResult | (() => Promise<ImageFetchResult>);

function okFetch(data: number[] = [1, 2, 3]): ImageFetchResult {
  const bytes = new Uint8Array(data);
  return { status: 'ok', bytes, format: 'png', sizeBytes: bytes.length };
}

function att(overrides: Partial<SubmissionAttachment> = {}): SubmissionAttachment {
  return {
    url: 'https://cdn.test/a.png',
    reportedSize: 3,
    reportedContentType: 'image/png',
    ...overrides,
  };
}

function submission(
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

function scriptedFetchImage(script: FetchScriptEntry[]) {
  const inputs: FetchInput[] = [];
  let next = 0;
  const fn = async (input: FetchInput): Promise<ImageFetchResult> => {
    inputs.push(input);
    const entry = script[next];
    next += 1;
    if (entry === undefined) {
      throw new Error('scripted fetchImage: script exhausted');
    }
    return typeof entry === 'function' ? entry() : entry;
  };
  return { fn, inputs };
}

function build(opts: {
  script?: StubScriptEntry[];
  provider?: OcrProvider;
  fetch?: FetchScriptEntry[];
  fetchImpl?: (input: FetchInput) => Promise<ImageFetchResult>;
  now?: () => number;
}) {
  const cap = makeCapturingLogger();
  const stub = createStubOcrProvider(opts.script ?? []);
  const provider = opts.provider ?? stub;
  const fetchSeam = scriptedFetchImage(opts.fetch ?? []);
  const handler = createListSubmissionHandler({
    provider,
    fetchImage: opts.fetchImpl ?? fetchSeam.fn,
    languageHints: ['en'],
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    now: opts.now ?? (() => 1_000),
  });
  return { handler, stub, fetchSeam, cap };
}

describe('local metadata checks run before any download, provider call, or guard acquisition', () => {
  it('oversize reported size on attachment 2 of 2 → too-large message, nothing downloaded or recognized', async () => {
    const env = build({ script: [okResult('A')], fetch: [okFetch()] });
    const reply = await env.handler(
      submission({}, [att(), att({ reportedSize: MAX_IMAGE_BYTES + 1 })]),
    );
    expect(reply.text).toBe(LIST_MESSAGES.imageTooLarge);
    expect(env.fetchSeam.inputs).toHaveLength(0);
    expect(env.stub.calls).toHaveLength(0);
  });

  it('the local rejection leaves the busy guard untouched: an immediate follow-up is accepted', async () => {
    const env = build({ script: [okResult('A')], fetch: [okFetch()] });
    await env.handler(submission({}, [att({ reportedSize: MAX_IMAGE_BYTES + 1 })]));
    const reply = await env.handler(submission());
    expect(reply.text).toBe('A');
    expect(env.cap.lines.some((l) => l.msg === 'list submission rejected busy')).toBe(false);
  });

  it('unsupported reported content type → unsupported-format message, no download', async () => {
    const env = build({ script: [okResult('A')], fetch: [okFetch()] });
    const reply = await env.handler(submission({}, [att({ reportedContentType: 'image/gif' })]));
    expect(reply.text).toBe(LIST_MESSAGES.unsupportedFormat);
    expect(env.fetchSeam.inputs).toHaveLength(0);
    expect(env.stub.calls).toHaveLength(0);
  });

  it('a missing content type hint is not a local rejection — the image proceeds to download', async () => {
    const env = build({ script: [okResult('A')], fetch: [okFetch()] });
    const reply = await env.handler(submission({}, [att({ reportedContentType: null })]));
    expect(reply.text).toBe('A');
    expect(env.fetchSeam.inputs).toHaveLength(1);
  });
});

describe('per-user busy guard', () => {
  it('an overlapping second submission from the same user gets the busy message without fetch or provider; the first completes uninterrupted', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = build({
      script: [() => gate.promise, okResult('never')],
      fetch: [okFetch(), okFetch()],
    });
    const first = env.handler(submission({ correlationId: 'corr-first' }));
    await vi.waitFor(() => expect(env.stub.calls).toHaveLength(1));

    const second = await env.handler(submission({ correlationId: 'corr-second' }));
    expect(second.text).toBe(LIST_MESSAGES.busy);
    expect(env.fetchSeam.inputs).toHaveLength(1);
    expect(env.stub.calls).toHaveLength(1);

    gate.resolve(okResult('first-text'));
    expect((await first).text).toBe('first-text');
  });

  it('a submission after the first finished is accepted (guard released)', async () => {
    const env = build({
      script: [okResult('one'), okResult('two')],
      fetch: [okFetch(), okFetch()],
    });
    expect((await env.handler(submission())).text).toBe('one');
    expect((await env.handler(submission())).text).toBe('two');
  });

  it('the guard is released even when handling throws', async () => {
    const env = build({
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

  it('the guard is released after a failed outcome', async () => {
    const env = build({
      script: [unavailableResult('unreachable'), okResult('after-failure')],
      fetch: [okFetch(), okFetch()],
    });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect((await env.handler(submission())).text).toBe('after-failure');
  });

  it('a busy user sending an oversized attachment gets the too-large message, not busy', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = build({ script: [() => gate.promise], fetch: [okFetch()] });
    const first = env.handler(submission());
    await vi.waitFor(() => expect(env.stub.calls).toHaveLength(1));

    const oversize = await env.handler(
      submission({}, [att({ reportedSize: MAX_IMAGE_BYTES + 1 })]),
    );
    expect(oversize.text).toBe(LIST_MESSAGES.imageTooLarge);

    const badType = await env.handler(submission({}, [att({ reportedContentType: 'video/mp4' })]));
    expect(badType.text).toBe(LIST_MESSAGES.unsupportedFormat);

    gate.resolve(okResult('done'));
    expect((await first).text).toBe('done');
  });

  it('two users overlapping both complete with their own texts', async () => {
    const gate1 = deferred<ImageFetchResult>();
    const gate2 = deferred<ImageFetchResult>();
    const cap = makeCapturingLogger();
    const providerFor: Record<string, ReturnType<typeof createStubOcrProvider>> = {
      'user-1': createStubOcrProvider([okResult('text-of-user-1')]),
      'user-2': createStubOcrProvider([okResult('text-of-user-2')]),
    };
    // The url identifies the owner, so each user's image routes to that
    // user's scripted provider — any cross-talk would surface as the wrong text.
    const provider: OcrProvider = {
      id: 'per-user-stub',
      recognize: (req) => {
        const owner = String.fromCharCode(...req.image.bytes);
        return providerFor[owner].recognize(req);
      },
    };
    const handler = createListSubmissionHandler({
      provider,
      fetchImage: (input) => (input.url.endsWith('u1.png') ? gate1.promise : gate2.promise),
      languageHints: [],
      // Safe: structural bridge to pino's Logger, as above.
      logger: cap.logger as never,
      now: () => 1_000,
    });
    const encode = (s: string): ImageFetchResult => {
      const bytes = new TextEncoder().encode(s);
      return { status: 'ok', bytes, format: 'png', sizeBytes: bytes.length };
    };

    const p1 = handler(
      submission({ userId: 'user-1', correlationId: 'c1' }, [
        att({ url: 'https://cdn.test/u1.png' }),
      ]),
    );
    const p2 = handler(
      submission({ userId: 'user-2', correlationId: 'c2', channelId: 'chan-2' }, [
        att({ url: 'https://cdn.test/u2.png' }),
      ]),
    );
    gate2.resolve(encode('user-2'));
    gate1.resolve(encode('user-1'));

    expect((await p1).text).toBe('text-of-user-1');
    expect((await p2).text).toBe('text-of-user-2');
    expect(cap.lines.some((l) => l.msg === 'list submission rejected busy')).toBe(false);
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
      const env = build({ script: [okResult('A')], fetch: [{ status }] });
      const reply = await env.handler(submission());
      expect(reply.text).toBe(expected);
      expect(env.stub.calls).toHaveLength(0);
    },
  );
});

describe('provider outcomes map to their reply class', () => {
  it('undecodable image → unsupported-format message', async () => {
    const env = build({ script: [undecodableResult()], fetch: [okFetch()] });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.unsupportedFormat);
  });

  const causes: UnavailableCause[] = [
    'unreachable',
    'unauthorized',
    'quota-exhausted',
    'provider-error',
    'deadline-exceeded',
    'disabled',
  ];
  it.each(causes)('unavailable (%s) → the generic message', async (cause) => {
    const env = build({ script: [unavailableResult(cause)], fetch: [okFetch()] });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.serviceUnavailable);
  });

  it('disabled provider: every image submission is still answered with the generic message', async () => {
    const env = build({
      provider: createDisabledProvider(),
      fetch: [okFetch(), okFetch(), okFetch()],
    });
    for (let i = 0; i < 3; i += 1) {
      const reply = await env.handler(submission({ correlationId: `corr-${i}` }));
      expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
    }
  });
});

describe('all-or-nothing multi-image submissions', () => {
  it.each([
    [
      'provider failure',
      [okResult('PARTIAL-1'), undecodableResult(), okResult('3')],
      [okFetch(), okFetch(), okFetch()],
      LIST_MESSAGES.unsupportedFormat,
    ],
    [
      'download failure',
      [okResult('PARTIAL-1'), okResult('2'), okResult('3')],
      [okFetch(), { status: 'too-large' } as const, okFetch()],
      LIST_MESSAGES.imageTooLarge,
    ],
  ] as const)(
    'a %s on image 2 → exactly one failure message, no partial text, image 3 untouched',
    async (_label, script, fetch, expected) => {
      const env = build({ script: [...script], fetch: [...fetch] });
      const reply = await env.handler(
        submission({}, [
          att({ url: 'https://cdn.test/1.png' }),
          att({ url: 'https://cdn.test/2.png' }),
          att({ url: 'https://cdn.test/3.png' }),
        ]),
      );
      expect(reply.text).toBe(expected);
      expect(reply.text).not.toContain('PARTIAL-1');
      expect(env.fetchSeam.inputs.map((i) => i.url)).not.toContain('https://cdn.test/3.png');
      expect(env.stub.calls.length).toBeLessThanOrEqual(2);
    },
  );
});

describe('shared submission budget', () => {
  it('deadline passing mid-submission → generic message, provider not asked with a spent budget, guard released, handler resolves', async () => {
    let clock = 1_000;
    const env = build({
      script: [okResult('page-1'), okResult('never'), okResult('next')],
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
    const reply = await env.handler(
      submission({}, [
        att({ url: 'https://cdn.test/1.png' }),
        att({ url: 'https://cdn.test/2.png' }),
      ]),
    );
    expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
    expect(env.stub.calls).toHaveLength(1);
    expect(env.stub.calls[0].timeoutMs).toBe(SUBMISSION_BUDGET_MS);

    // Guard released: the same user is served again.
    expect((await env.handler(submission())).text).toBe('never');
  });

  it('every provider call receives the remaining shared budget, not a fresh one', async () => {
    let clock = 1_000;
    const env = build({
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
    expect(env.stub.calls.map((c) => c.timeoutMs)).toEqual([
      SUBMISSION_BUDGET_MS,
      SUBMISSION_BUDGET_MS - 10_000,
    ]);
  });
});

// 🤖 AI-start
describe('the shared budget is enforced against callees that never settle', () => {
  it('a download that never settles → generic message once the budget elapses, cancelled logged, guard released', async () => {
    vi.useFakeTimers();
    try {
      const env = build({
        script: [okResult('after-release')],
        fetch: [() => new Promise<ImageFetchResult>(() => undefined), okFetch()],
      });
      const pending = env.handler(submission());
      await vi.advanceTimersByTimeAsync(SUBMISSION_BUDGET_MS);
      expect((await pending).text).toBe(LIST_MESSAGES.serviceUnavailable);
      expect(env.stub.calls).toHaveLength(0);
      expect(env.cap.lines.some((l) => l.msg === 'list submission cancelled')).toBe(true);

      // Guard released: the same user is served again.
      expect((await env.handler(submission())).text).toBe('after-release');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a provider call that never settles → generic message once the budget elapses, guard released', async () => {
    vi.useFakeTimers();
    try {
      const env = build({
        script: [() => new Promise<OcrProviderResult>(() => undefined), okResult('after-release')],
        fetch: [okFetch(), okFetch()],
      });
      const pending = env.handler(submission());
      await vi.advanceTimersByTimeAsync(SUBMISSION_BUDGET_MS);
      expect((await pending).text).toBe(LIST_MESSAGES.serviceUnavailable);
      const cancelled = env.cap.lines.find((l) => l.msg === 'list submission cancelled');
      expect(cancelled?.providerId).toBe(env.stub.id);

      expect((await env.handler(submission())).text).toBe('after-release');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the download receives an abort signal that fires when the budget elapses', async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const env = build({
        fetchImpl: (input) => {
          seen = input.signal;
          return new Promise<ImageFetchResult>(() => undefined);
        },
      });
      const pending = env.handler(submission());
      await vi.advanceTimersByTimeAsync(0);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(SUBMISSION_BUDGET_MS);
      await pending;
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a submission that finishes in time leaves no budget timer behind', async () => {
    vi.useFakeTimers();
    try {
      const env = build({ script: [okResult('A')], fetch: [okFetch()] });
      await env.handler(submission());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('blank pages in a multi-image submission', () => {
  it('a blank page between recognized pages is skipped — no stray empty line in the reply', async () => {
    const env = build({
      script: [okResult('page-1'), okResult(''), okResult(' \n'), okResult('page-4')],
      fetch: [okFetch(), okFetch(), okFetch(), okFetch()],
    });
    const reply = await env.handler(submission({}, [att(), att(), att(), att()]));
    expect(reply.text).toBe('page-1\npage-4');
  });

  it('only blank pages → the no-readable-text message', async () => {
    const env = build({
      script: [okResult(''), okResult('\n')],
      fetch: [okFetch(), okFetch()],
    });
    const reply = await env.handler(submission({}, [att(), att()]));
    expect(reply.text).toBe(LIST_MESSAGES.noReadableText);
  });
});

describe('provider fidelity self-check is logged content-free', () => {
  it('a mismatch reported by the provider is logged as a warning without any text', async () => {
    const env = build({
      script: [okResult('Milk', 'mismatch')],
      fetch: [okFetch()],
    });
    await env.handler(submission());
    const recognized = env.cap.lines.find((l) => l.msg === 'image recognized');
    expect(recognized).toMatchObject({ position: 0, lineCount: 1, fidelityCheck: 'mismatch' });
    expect(recognized?.level).toBe('warn');
    expect(JSON.stringify(recognized)).not.toContain('Milk');
  });

  it('a matching or absent self-check is logged at info level', async () => {
    const env = build({
      script: [okResult('A', 'match'), okResult('B')],
      fetch: [okFetch(), okFetch()],
    });
    await env.handler(submission({}, [att(), att()]));
    const recognized = env.cap.lines.filter((l) => l.msg === 'image recognized');
    expect(recognized.map((l) => [l.level, l.fidelityCheck])).toEqual([
      ['info', 'match'],
      ['info', undefined],
    ]);
  });
});

describe('disabled provider still applies input checks first', () => {
  it('an oversized image gets the too-large message even when recognition is disabled', async () => {
    const env = build({ provider: createDisabledProvider() });
    const reply = await env.handler(submission({}, [att({ reportedSize: MAX_IMAGE_BYTES + 1 })]));
    expect(reply.text).toBe(LIST_MESSAGES.imageTooLarge);
  });

  it('an image that fails the downloaded-bytes format check gets the unsupported message even when disabled', async () => {
    const env = build({
      provider: createDisabledProvider(),
      fetch: [{ status: 'unsupported-format' }],
    });
    expect((await env.handler(submission())).text).toBe(LIST_MESSAGES.unsupportedFormat);
  });
});
// 🤖 AI-end

// 🤖 AI-start
describe('budget already spent when a callee starts', () => {
  it('a late rejection from an abandoned callee is handled (no unhandled rejection)', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const env = build({
        fetchImpl: () => {
          // The budget timer fires before the download promise exists, so the
          // race sees an already-aborted signal on entry.
          vi.advanceTimersByTime(SUBMISSION_BUDGET_MS);
          return new Promise<ImageFetchResult>((_resolve, reject) => {
            setTimeout(() => reject(new Error('late failure')), 10);
          });
        },
      });
      const reply = await env.handler(submission());
      expect(reply.text).toBe(LIST_MESSAGES.serviceUnavailable);
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
// 🤖 AI-end
