import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/load-config';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import { fetchAndValidateImage, MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import { createDisabledProvider } from '../../src/ocr/disabled-provider';
import type { OcrProvider, OcrProviderResult, UnavailableCause } from '../../src/ocr/types';
import type { BotState, Config } from '../../src/shared/types';
import { createListSubmissionHandler } from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES, usageHintMessage } from '../../src/shopping-list/messages';
import { makeCapturingLogger } from '../helpers/logger';
import { createScriptedFetch, type ScriptedFetchEntry } from '../helpers/scripted-fetch';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
  unavailableResult,
} from '../helpers/stub-ocr-provider';
import { emitMessage, makeStubbedClient } from '../helpers/stubbed-client';

// Message-in → reply-out for every non-happy outcome, through the REAL
// adapter, REAL handler, and REAL image validator over a scripted fetch
// seam, against the stub OCR provider — zero external calls.

const baseConfig: Config = {
  discordToken: 'tok',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
  ocrProvider: 'none',
  gcpSaKeyPath: null,
  ocrLanguageHints: [],
  ocrChannelAllowlist: null,
};

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const GIF_BYTES = new TextEncoder().encode('GIF89a-not-accepted');

type FakeAttachment = {
  url: string;
  proxyURL: string;
  size: number;
  contentType: string | null;
};

function attachment(url: string, contentType: string | null, size = 12): FakeAttachment {
  return { url, proxyURL: `https://media.proxy.test/proxy-of/${url}`, size, contentType };
}

function buildMessage(opts: {
  authorId?: string;
  channelId?: string;
  attachments: FakeAttachment[];
}) {
  const channelId = opts.channelId ?? 'chan-1';
  const send = vi.fn(async (..._args: unknown[]) => undefined);
  const raw = {
    author: { bot: false, id: opts.authorId ?? 'user-1' },
    content: '',
    guild: { id: 'guild-1' },
    channelId,
    channel: { id: channelId, send, isThread: () => false },
    attachments: new Map(opts.attachments.map((a, i) => [String(i), a])),
  };
  return { raw, send };
}

function buildEnv(opts: {
  fetchEntries: ScriptedFetchEntry[];
  script?: StubScriptEntry[];
  provider?: OcrProvider;
  config?: Config;
}) {
  const cap = makeCapturingLogger();
  const client = makeStubbedClient();
  const botState: BotState = {
    phase: 'running',
    discord: 'connected',
    startedAt: Date.now(),
    lastStateChangeAt: Date.now(),
  };
  const config = opts.config ?? baseConfig;
  const scriptedFetch = createScriptedFetch(opts.fetchEntries);
  const stub = createStubOcrProvider(opts.script ?? []);
  const listSubmission = createListSubmissionHandler({
    provider: opts.provider ?? stub,
    fetchImage: (fetchInput) => fetchAndValidateImage(fetchInput, scriptedFetch.fetchImpl),
    languageHints: config.ocrLanguageHints,
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    now: Date.now,
  });
  const adapter = createDiscordAdapter({
    config,
    // Safe: same structural bridge as above.
    logger: cap.logger as never,
    botState,
    echo: handleEchoCommand,
    clientFactory: () => client,
    listSubmission,
    usageHint: usageHintMessage(config.commandPrefix),
  });
  return { adapter, client, cap, stub, scriptedFetch };
}

function sentContents(send: ReturnType<typeof vi.fn>): string[] {
  return send.mock.calls.map((call) => {
    // Safe: send is the stubbed channel.send; its first argument is the
    // documented { content, allowedMentions } payload.
    return (call[0] as { content: string }).content;
  });
}

async function roundTrip(opts: {
  fetchEntries: ScriptedFetchEntry[];
  script?: StubScriptEntry[];
  provider?: OcrProvider;
  config?: Config;
  attachments: FakeAttachment[];
}) {
  const env = buildEnv(opts);
  const msg = buildMessage({ attachments: opts.attachments });
  emitMessage(env.client, msg.raw);
  await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
  await env.adapter.stop();
  return { env, replies: sentContents(msg.send) };
}

const PNG_ATTACHMENT = attachment('https://cdn.test/list.png', 'image/png');

describe('integration: every service-side cause yields the same single generic message', () => {
  const causes: UnavailableCause[] = [
    'unreachable',
    'unauthorized',
    'quota-exhausted',
    'provider-error',
    'deadline-exceeded',
    'disabled',
  ];

  it.each(causes)('provider unavailable (%s)', async (cause) => {
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [unavailableResult(cause)],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
  });

  it('attachment cannot be retrieved (HTTP 500)', async () => {
    const { replies, env } = await roundTrip({
      fetchEntries: [{ status: 500 }],
      script: [okResult('never')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
    expect(env.stub.calls).toHaveLength(0);
  });

  it('provider throws unexpectedly — no crash, no technical detail', async () => {
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [
        () => {
          throw new Error('grpc stack trace with internals');
        },
      ],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
  });

  it('recognition disabled via the wiring with OCR_PROVIDER unset', async () => {
    const config = loadConfig({ DISCORD_TOKEN: 'tok' });
    expect(config.ocrProvider).toBe('none');
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      provider: createDisabledProvider(),
      config,
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
  });
});

describe('integration: each input problem yields its own distinct actionable message', () => {
  it('no readable text', async () => {
    const { replies } = await roundTrip({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult('   ')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.noReadableText]);
  });

  it('locally unsupported format → rejected with zero downloads and zero provider calls', async () => {
    const { replies, env } = await roundTrip({
      fetchEntries: [],
      script: [okResult('never')],
      attachments: [attachment('https://cdn.test/anim.gif', 'image/gif')],
    });
    expect(replies).toEqual([LIST_MESSAGES.unsupportedFormat]);
    expect(env.scriptedFetch.requestedUrls).toHaveLength(0);
    expect(env.stub.calls).toHaveLength(0);
  });

  it('corrupt content behind an accepted content type → unsupported format, zero provider calls', async () => {
    const { replies, env } = await roundTrip({
      fetchEntries: [{ body: { bytes: GIF_BYTES } }],
      script: [okResult('never')],
      attachments: [PNG_ATTACHMENT],
    });
    expect(replies).toEqual([LIST_MESSAGES.unsupportedFormat]);
    expect(env.stub.calls).toHaveLength(0);
  });

  it('oversize image → too-large message with zero downloads and zero provider calls', async () => {
    const { replies, env } = await roundTrip({
      fetchEntries: [],
      script: [okResult('never')],
      attachments: [attachment('https://cdn.test/huge.png', 'image/png', MAX_IMAGE_BYTES + 1)],
    });
    expect(replies).toEqual([LIST_MESSAGES.imageTooLarge]);
    expect(env.scriptedFetch.requestedUrls).toHaveLength(0);
    expect(env.stub.calls).toHaveLength(0);
  });

  it('the three input messages, the generic message, and the busy message are pairwise distinct', () => {
    const all = [
      LIST_MESSAGES.noReadableText,
      LIST_MESSAGES.unsupportedFormat,
      LIST_MESSAGES.imageTooLarge,
      LIST_MESSAGES.serviceUnavailable,
      LIST_MESSAGES.busy,
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('integration: concurrency', () => {
  it('a second photo from the same user while the first is in flight → busy message; the first completes normally', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      script: [() => gate.promise, okResult('never')],
    });
    const msg1 = buildMessage({ attachments: [PNG_ATTACHMENT] });
    const msg2 = buildMessage({ attachments: [PNG_ATTACHMENT] });

    emitMessage(env.client, msg1.raw);
    await vi.waitFor(() => expect(env.stub.calls).toHaveLength(1));
    emitMessage(env.client, msg2.raw);
    await vi.waitFor(() => expect(msg2.send).toHaveBeenCalledTimes(1));

    expect(sentContents(msg2.send)).toEqual([LIST_MESSAGES.busy]);
    expect(env.stub.calls).toHaveLength(1);
    expect(env.scriptedFetch.requestedUrls).toHaveLength(1);
    expect(msg1.send).not.toHaveBeenCalled();

    gate.resolve(okResult('first list'));
    await vi.waitFor(() => expect(msg1.send).toHaveBeenCalledTimes(1));
    expect(sentContents(msg1.send)).toEqual(['first list']);
    await env.adapter.stop();
  });

  it('two users in different channels overlapping → each gets their own text in their own channel', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      script: [() => gate.promise, okResult('user-2 list')],
    });
    const msg1 = buildMessage({
      authorId: 'user-1',
      channelId: 'chan-1',
      attachments: [PNG_ATTACHMENT],
    });
    const msg2 = buildMessage({
      authorId: 'user-2',
      channelId: 'chan-2',
      attachments: [PNG_ATTACHMENT],
    });

    emitMessage(env.client, msg1.raw);
    await vi.waitFor(() => expect(env.stub.calls).toHaveLength(1));
    emitMessage(env.client, msg2.raw);
    await vi.waitFor(() => expect(msg2.send).toHaveBeenCalledTimes(1));
    gate.resolve(okResult('user-1 list'));
    await vi.waitFor(() => expect(msg1.send).toHaveBeenCalledTimes(1));

    expect(sentContents(msg1.send)).toEqual(['user-1 list']);
    expect(sentContents(msg2.send)).toEqual(['user-2 list']);
    await env.adapter.stop();
  });
});

describe('integration: all-or-nothing multi-image submissions', () => {
  it('page 2 of 3 fails → a single failure message, no partial text, page 3 never fetched', async () => {
    const { replies, env } = await roundTrip({
      fetchEntries: [
        { body: { bytes: PNG_BYTES } },
        { status: 404 },
        { body: { bytes: PNG_BYTES } },
      ],
      script: [okResult('PARTIAL page one'), okResult('never'), okResult('never')],
      attachments: [
        attachment('https://cdn.test/1.png', 'image/png'),
        attachment('https://cdn.test/2.png', 'image/png'),
        attachment('https://cdn.test/3.png', 'image/png'),
      ],
    });
    expect(replies).toEqual([LIST_MESSAGES.serviceUnavailable]);
    expect(env.scriptedFetch.requestedUrls).toEqual([
      'https://cdn.test/1.png',
      'https://cdn.test/2.png',
    ]);
  });
});
