import type { Client } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import type { BotState, Config } from '../../src/shared/types';
import type { ListSubmissionHandler } from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { makeCapturingLogger } from '../helpers/logger';
import { emitMessage, makeStubbedClient } from '../helpers/stubbed-client';

const USAGE_HINT = 'usage-hint-fixture-text';
const INTERNAL_ERROR_REPLY = 'An internal error occurred while processing your command.';
const EMPTY_MENTIONS = { parse: [], users: [], roles: [] };

const baseConfig: Config = {
  discordToken: 'SECRET-TOKEN-VALUE',
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

function makeBotState(): BotState {
  return {
    phase: 'running',
    discord: 'connected',
    startedAt: Date.now(),
    lastStateChangeAt: Date.now(),
  };
}

type FakeAttachment = {
  url: string;
  proxyURL: string;
  size: number;
  contentType: string | null;
};

function attachment(url: string, size: number, contentType: string | null): FakeAttachment {
  return { url, proxyURL: `https://media.proxy.test/proxy-of/${url}`, size, contentType };
}

function buildMessage(opts: {
  content?: string;
  authorBot?: boolean;
  authorId?: string;
  channelId?: string;
  attachments?: FakeAttachment[];
  system?: boolean;
  threadParentId?: string;
}) {
  const channelId = opts.channelId ?? 'chan-1';
  const send = vi.fn(async (..._args: unknown[]) => undefined);
  const threadParentId = opts.threadParentId;
  const channel =
    threadParentId === undefined
      ? { id: channelId, send, isThread: () => false, parentId: 'category-1' }
      : { id: channelId, send, isThread: () => true, parentId: threadParentId };
  const attachmentMap = new Map((opts.attachments ?? []).map((a, i) => [String(i), a]));
  const raw = {
    author: { bot: opts.authorBot ?? false, id: opts.authorId ?? 'user-1' },
    content: opts.content ?? '',
    system: opts.system ?? false,
    guild: { id: 'guild-1' },
    channelId,
    channel,
    attachments: attachmentMap,
  };
  return { raw, send };
}

function makeEnv(opts: { config?: Config; listSubmission?: ListSubmissionHandler } = {}) {
  const cap = makeCapturingLogger();
  const client = makeStubbedClient();
  const botState = makeBotState();
  const listSpy = vi.fn(opts.listSubmission ?? (async () => ({ text: 'handler reply' })));
  const adapter = createDiscordAdapter({
    config: opts.config ?? baseConfig,
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    botState,
    echo: handleEchoCommand,
    clientFactory: () => client,
    listSubmission: listSpy,
    usageHint: USAGE_HINT,
  });
  return { adapter, client, cap, listSpy };
}

async function dispatch(client: Client<true>, message: unknown): Promise<void> {
  emitMessage(client, message);
  // Flush the async handler chain (list handler + sends) before asserting.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

function sentPayloads(
  send: ReturnType<typeof vi.fn>,
): Array<{ content: string; allowedMentions: unknown }> {
  return send.mock.calls.map((call) => {
    // Safe: send is the adapter's own channel.send seam; the payload shape is
    // the documented { content, allowedMentions } contract asserted below.
    return call[0] as { content: string; allowedMentions: unknown };
  });
}

describe('adapter routing: commands are not subject to the allowlist', () => {
  it('echo command in a non-allowlisted channel → echo reply, listSubmission never called, no usage hint', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({ content: '!echo hi', channelId: 'chan-1' });
    await dispatch(env.client, msg.raw);
    expect(msg.send).toHaveBeenCalledTimes(1);
    expect(sentPayloads(msg.send)[0]).toEqual({ content: 'hi', allowedMentions: EMPTY_MENTIONS });
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });

  it('echo command WITH an attachment is still just an echo (commands never trigger the hint or the list path)', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({
      content: '!echo hi',
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(sentPayloads(msg.send)[0].content).toBe('hi');
    expect(msg.send).toHaveBeenCalledTimes(1);
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });
});

describe('adapter routing: channel allowlist', () => {
  it('image message in a non-allowlisted channel → nothing sent, listSubmission never called', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });

  it('text-only message in a non-allowlisted channel → ignored entirely (no hint)', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({ content: 'hello there' });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });

  it('allowlist null → every channel is processed', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      channelId: 'any-channel',
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    await env.adapter.stop();
  });

  it('allowlist containing the channel → processed', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['chan-1', '999888777666555444'] },
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    await env.adapter.stop();
  });
});

describe('adapter routing: attachment descriptors', () => {
  it('a PDF attachment IS forwarded (filtering is not the adapter’s job)', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/doc.pdf', 4242, 'application/pdf')],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    const sent = env.listSpy.mock.calls[0][0];
    expect(sent.attachments).toEqual([
      {
        url: 'https://cdn.test/doc.pdf',
        reportedSize: 4242,
        reportedContentType: 'application/pdf',
      },
    ]);
    await env.adapter.stop();
  });

  it('descriptors preserve message order and map url (never proxyURL) / size / contentType', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      attachments: [
        attachment('https://cdn.test/first.png', 11, 'image/png'),
        attachment('https://cdn.test/second.bin', 22, null),
      ],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    const sent = env.listSpy.mock.calls[0][0];
    expect(sent.attachments).toEqual([
      { url: 'https://cdn.test/first.png', reportedSize: 11, reportedContentType: 'image/png' },
      { url: 'https://cdn.test/second.bin', reportedSize: 22, reportedContentType: null },
    ]);
    for (const descriptor of sent.attachments) {
      expect(descriptor.url).not.toContain('media.proxy.test');
    }
    expect(sent.userId).toBe('user-1');
    expect(sent.channelId).toBe('chan-1');
    expect(String(sent.correlationId)).toMatch(/.+/);
    await env.adapter.stop();
  });
});

describe('adapter routing: usage hint', () => {
  it('text-only message in a processed channel → usage-hint reply, listSubmission never called', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: 'just talking here' });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
    expect(msg.send).toHaveBeenCalledTimes(1);
    expect(sentPayloads(msg.send)[0]).toEqual({
      content: USAGE_HINT,
      allowedMentions: EMPTY_MENTIONS,
    });
    await env.adapter.stop();
  });

  it('an unrecognized command-like message also earns the hint', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: '!bogus args' });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
    expect(sentPayloads(msg.send)[0].content).toBe(USAGE_HINT);
    await env.adapter.stop();
  });

  it('bot authors are ignored (no hint, no list path)', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      content: 'from a bot',
      authorBot: true,
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });
});

describe('adapter routing: reply delivery', () => {
  it('handler result > 2000 chars → multiple sends in order, each ≤ 2000, each with empty allowedMentions', async () => {
    const longText = 'x'.repeat(5000);
    const env = makeEnv({ listSubmission: async () => ({ text: longText }) });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    const payloads = sentPayloads(msg.send);
    expect(payloads.length).toBe(3);
    for (const payload of payloads) {
      expect(payload.content.length).toBeLessThanOrEqual(2000);
      expect(payload.allowedMentions).toEqual(EMPTY_MENTIONS);
    }
    // Order preserved: stripping the continuation markers reconstructs the text.
    const rebuilt = payloads
      .map((payload, i) => {
        let s = payload.content;
        if (i > 0) {
          s = s.slice(1);
        }
        if (i < payloads.length - 1) {
          s = s.slice(0, -1);
        }
        return s;
      })
      .join('');
    expect(rebuilt).toBe(longText);
    await env.adapter.stop();
  });

  it('a short handler result is sent as a single message with empty allowedMentions', async () => {
    const env = makeEnv({ listSubmission: async () => ({ text: 'Milk\nEggs' }) });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(sentPayloads(msg.send)).toEqual([
      { content: 'Milk\nEggs', allowedMentions: EMPTY_MENTIONS },
    ]);
    await env.adapter.stop();
  });

  // 🤖 AI-start
  it('handler throwing → the generic service-unavailable reply with empty allowedMentions', async () => {
    const env = makeEnv({
      listSubmission: async () => {
        throw new Error('handler boom');
      },
    });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).toHaveBeenCalledTimes(1);
    expect(sentPayloads(msg.send)[0]).toEqual({
      content: LIST_MESSAGES.serviceUnavailable,
      allowedMentions: EMPTY_MENTIONS,
    });
    expect(sentPayloads(msg.send)[0].content).not.toBe(INTERNAL_ERROR_REPLY);
    // The exception text never reaches the user.
    expect(sentPayloads(msg.send)[0].content).not.toContain('boom');
    await env.adapter.stop();
  });
  // 🤖 AI-end
});

// 🤖 AI-start
describe('adapter routing: list reply delivery is logged', () => {
  it('a delivered multi-chunk reply logs chunk count and length under the correlation id', async () => {
    const longText = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    const env = makeEnv({ listSubmission: async () => ({ text: longText }) });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    const sent = env.cap.lines.find((l) => l.msg === 'list reply sent');
    expect(sent).toMatchObject({
      level: 'info',
      chunkCount: 2,
      deliveredChunks: 2,
      replyLength: longText.length,
    });
    expect(typeof sent?.correlationId).toBe('string');
    expect(JSON.stringify(sent)).not.toContain('aaaa');
    await env.adapter.stop();
  });

  it('an undelivered chunk is logged as a warning with the delivered count', async () => {
    const env = makeEnv({ listSubmission: async () => ({ text: 'Milk' }) });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const sent = env.cap.lines.find((l) => l.msg === 'list reply sent');
    expect(sent).toMatchObject({ level: 'warn', chunkCount: 1, deliveredChunks: 0 });
    await env.adapter.stop();
  });
});
// 🤖 AI-end

// 🤖 AI-start
describe('adapter routing: every reply is traceable by correlation id', () => {
  async function flushRetries(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('a usage-hint reply is logged under a correlation id without the message content', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      content: 'milk eggs bread',
      authorId: 'user-7',
      channelId: 'chan-7',
    });
    await dispatch(env.client, msg.raw);
    const hint = env.cap.lines.find((l) => l.msg === 'usage hint sent');
    expect(hint).toMatchObject({
      level: 'info',
      userId: 'user-7',
      channelId: 'chan-7',
      delivered: true,
    });
    expect(typeof hint?.correlationId).toBe('string');
    expect(JSON.stringify(hint)).not.toContain('milk');
    await env.adapter.stop();
  });

  it('an undelivered usage hint is logged as a warning, and the send failure carries the same correlation id', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: 'milk' });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await flushRetries();
    const hint = env.cap.lines.find((l) => l.msg === 'usage hint sent');
    const failure = env.cap.lines.find((l) => l.msg === 'reply failed after retries');
    expect(hint).toMatchObject({ level: 'warn', delivered: false });
    expect(failure?.correlationId).toBeDefined();
    expect(failure?.correlationId).toBe(hint?.correlationId);
    await env.adapter.stop();
  });

  it('a failed list-reply send carries the submission correlation id', async () => {
    const env = makeEnv({ listSubmission: async () => ({ text: 'Milk' }) });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await flushRetries();
    const sent = env.cap.lines.find((l) => l.msg === 'list reply sent');
    const failure = env.cap.lines.find((l) => l.msg === 'reply failed after retries');
    expect(failure?.correlationId).toBeDefined();
    expect(failure?.correlationId).toBe(sent?.correlationId);
    await env.adapter.stop();
  });

  it('a failed echo-reply send carries the command correlation id', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: '!echo hi' });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await flushRetries();
    const received = env.cap.lines.find((l) => l.msg === 'command received');
    const failure = env.cap.lines.find((l) => l.msg === 'reply failed after retries');
    expect(failure?.correlationId).toBeDefined();
    expect(failure?.correlationId).toBe(received?.correlationId);
    await env.adapter.stop();
  });
});
// 🤖 AI-end

// 🤖 AI-start
describe('adapter routing: review follow-ups', () => {
  it('a Discord system message (member join, pin, boost) is ignored entirely', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: '', system: true });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });

  it('a photo in a thread under an allowlisted channel is processed, reply in the thread', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['111111111111111111'] },
    });
    const msg = buildMessage({
      channelId: '222222222222222222',
      threadParentId: '111111111111111111',
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    expect(sentPayloads(msg.send)[0].content).toBe('handler reply');
    await env.adapter.stop();
  });

  it('a thread under a non-allowlisted channel stays ignored', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['111111111111111111'] },
    });
    const msg = buildMessage({
      channelId: '222222222222222222',
      threadParentId: '333333333333333333',
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
    expect(msg.send).not.toHaveBeenCalled();
    await env.adapter.stop();
  });

  it('a regular channel is not admitted through its category id', async () => {
    const env = makeEnv({ config: { ...baseConfig, ocrChannelAllowlist: ['444444444444444444'] } });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    // The stub's non-thread channel reports parentId 'category-1'; allowlist the category instead.
    msg.raw.channel.parentId = '444444444444444444';
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
    await env.adapter.stop();
  });

  it('whitespace-only chunks are never sent (Discord rejects empty messages)', async () => {
    const text = `${'a'.repeat(1999)}\n\n`;
    const env = makeEnv({ listSubmission: async () => ({ text }) });
    const msg = buildMessage({
      attachments: [attachment('https://cdn.test/1.png', 3, 'image/png')],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).toHaveBeenCalledTimes(1);
    for (const payload of sentPayloads(msg.send)) {
      expect(payload.content.trim()).not.toBe('');
    }
    expect(env.cap.lines.find((l) => l.msg === 'list reply sent')).toMatchObject({
      level: 'info',
      chunkCount: 1,
      deliveredChunks: 1,
    });
    await env.adapter.stop();
  });
});
// 🤖 AI-end
