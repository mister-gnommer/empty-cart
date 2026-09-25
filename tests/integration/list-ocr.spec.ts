import { describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import { fetchAndValidateImage } from '../../src/image/fetch-image';
import type { OcrProviderResult } from '../../src/ocr/types';
import type { BotState, Config } from '../../src/shared/types';
import { createListSubmissionHandler } from '../../src/shopping-list/handle-list-submission';
import { usageHintMessage } from '../../src/shopping-list/messages';
import { makeCapturingLogger } from '../helpers/logger';
import { createScriptedFetch, type ScriptedFetchEntry } from '../helpers/scripted-fetch';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
} from '../helpers/stub-ocr-provider';
import { emitMessage, makeStubbedClient } from '../helpers/stubbed-client';

// End-to-end message-in → reply-out through the REAL adapter and REAL
// submission handler, against the stubbed Discord client, a scripted fetch
// seam, and the stub OCR provider — zero external calls.

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
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

const EMPTY_MENTIONS = { parse: [], users: [], roles: [] };
const MARKER = '…';

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
  content?: string;
  authorId?: string;
  channelId?: string;
  attachments?: FakeAttachment[];
}) {
  const channelId = opts.channelId ?? 'chan-1';
  const send = vi.fn(async (..._args: unknown[]) => undefined);
  const channel = { id: channelId, send, isThread: () => false };
  const raw = {
    author: { bot: false, id: opts.authorId ?? 'user-1' },
    content: opts.content ?? '',
    guild: { id: 'guild-1' },
    channelId,
    channel,
    attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
  };
  return { raw, send };
}

function buildEnv(opts: {
  fetchEntries: ScriptedFetchEntry[];
  script: StubScriptEntry[];
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
  const provider = createStubOcrProvider(opts.script);
  const listSubmission = createListSubmissionHandler({
    provider,
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
  return { adapter, client, cap, provider, scriptedFetch };
}

function payloads(
  send: ReturnType<typeof vi.fn>,
): Array<{ content: string; allowedMentions: unknown }> {
  return send.mock.calls.map((call) => {
    // Safe: send is the stubbed channel.send; the payload shape is the
    // documented { content, allowedMentions } contract asserted below.
    return call[0] as { content: string; allowedMentions: unknown };
  });
}

describe('integration: list OCR round trip', () => {
  it('one image attachment → reply posted to the originating channel, byte-identical to the recognized text', async () => {
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult('Milk\nEggs\nBread')],
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/list.png', 'image/png')],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    expect(payloads(msg.send)[0]).toEqual({
      content: 'Milk\nEggs\nBread',
      allowedMentions: EMPTY_MENTIONS,
    });
    // The original CDN url was fetched — never the media proxy.
    expect(env.scriptedFetch.requestedUrls).toEqual(['https://cdn.test/list.png']);
    // Lifecycle logs carry the correlation id...
    const received = env.cap.lines.find((l) => l.msg === 'list submission received');
    expect(received).toBeDefined();
    expect(String(received?.correlationId)).toMatch(/.+/);
    // ...and NEVER the recognized text.
    const serialized = JSON.stringify(env.cap.lines);
    expect(serialized).not.toContain('Milk');
    expect(serialized).not.toContain('Bread');
    await env.adapter.stop();
  });

  it('recognized text containing mention tokens is posted byte-for-byte with mentions neutralized at the transport', async () => {
    const mentionText = '@everyone <@123456789012345678> <@&987654321098765432> Milk';
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult(mentionText)],
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/list.png', 'image/png')],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    expect(payloads(msg.send)[0]).toEqual({
      content: mentionText,
      allowedMentions: EMPTY_MENTIONS,
    });
    await env.adapter.stop();
  });

  it('a two-image message → combined text in attachment order', async () => {
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: JPEG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      script: [okResult('First page'), okResult('Second page')],
    });
    const msg = buildMessage({
      attachments: [
        attachment('https://cdn.test/one.jpg', 'image/jpeg'),
        attachment('https://cdn.test/two.png', 'image/png'),
      ],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    expect(payloads(msg.send)[0].content).toBe('First page\nSecond page');
    expect(env.scriptedFetch.requestedUrls).toEqual([
      'https://cdn.test/one.jpg',
      'https://cdn.test/two.png',
    ]);
    expect(env.provider.calls.map((c) => c.format)).toEqual(['jpeg', 'png']);
    await env.adapter.stop();
  });

  it('a text-only message in a processed channel → the usage hint naming !help', async () => {
    const env = buildEnv({ fetchEntries: [], script: [] });
    const msg = buildMessage({ content: 'what should I cook?' });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(1));
    const reply = payloads(msg.send)[0];
    expect(reply.content).toBe(usageHintMessage('!'));
    expect(reply.content).toContain('!help');
    expect(reply.allowedMentions).toEqual(EMPTY_MENTIONS);
    expect(env.provider.calls).toHaveLength(0);
    await env.adapter.stop();
  });

  it('a >2000-char recognition is delivered as ordered chunks, each ≤ 2000, with continuation markers at mid-line cuts', async () => {
    const longText = 'x'.repeat(5000);
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }],
      script: [okResult(longText)],
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/big.png', 'image/png')],
    });
    emitMessage(env.client, msg.raw);

    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(3));
    const sent = payloads(msg.send);
    for (const payload of sent) {
      expect(payload.content.length).toBeLessThanOrEqual(2000);
      expect(payload.allowedMentions).toEqual(EMPTY_MENTIONS);
    }
    expect(sent[0].content.endsWith(MARKER)).toBe(true);
    expect(sent[2].content.startsWith(MARKER)).toBe(true);
    const rebuilt = sent
      .map((payload, i) => {
        let s = payload.content;
        if (i > 0) {
          s = s.slice(1);
        }
        if (i < sent.length - 1) {
          s = s.slice(0, -1);
        }
        return s;
      })
      .join('');
    expect(rebuilt).toBe(longText);
    await env.adapter.stop();
  });

  it('two concurrent submissions from different users in different channels each receive their own text in their own channel', async () => {
    const gate = deferred<OcrProviderResult>();
    const env = buildEnv({
      fetchEntries: [{ body: { bytes: PNG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      script: [() => gate.promise, okResult('B-page-text')],
    });
    const msg1 = buildMessage({
      authorId: 'user-1',
      channelId: 'chan-1',
      attachments: [attachment('https://cdn.test/u1.png', 'image/png')],
    });
    const msg2 = buildMessage({
      authorId: 'user-2',
      channelId: 'chan-2',
      attachments: [attachment('https://cdn.test/u2.png', 'image/png')],
    });

    emitMessage(env.client, msg1.raw);
    await vi.waitFor(() => expect(env.provider.calls).toHaveLength(1));

    emitMessage(env.client, msg2.raw);
    await vi.waitFor(() => expect(msg2.send).toHaveBeenCalledTimes(1));
    // The second user is served while the first submission is still in flight.
    expect(payloads(msg2.send)[0].content).toBe('B-page-text');
    expect(msg1.send).not.toHaveBeenCalled();

    gate.resolve(okResult('A-page-text'));
    await vi.waitFor(() => expect(msg1.send).toHaveBeenCalledTimes(1));
    expect(payloads(msg1.send)[0].content).toBe('A-page-text');
    // No cross-talk: each channel received exactly its own text.
    expect(payloads(msg2.send)[0].content).not.toContain('A-page-text');
    await env.adapter.stop();
  });
});
