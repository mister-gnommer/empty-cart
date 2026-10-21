import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { splitReply } from '../../src/discord/split-reply';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import type { BotState, Config } from '../../src/shared/types';
import type { ListSubmissionHandler } from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { makeConfig } from '../helpers/config-fixture';
import { attachment, buildMessage, EMPTY_MENTIONS, sentPayloads } from '../helpers/list-flow-env';
import { makeCapturingLogger } from '../helpers/logger';
import { emitMessage, makeStubbedClient } from '../helpers/stubbed-client';

const USAGE_HINT = 'usage-hint-fixture-text';
const PNG_ATTACHMENT = attachment('https://cdn.test/1.png', 'image/png', 3);

const baseConfig = makeConfig({ discordToken: 'SECRET-TOKEN-VALUE' });

function makeBotState(): BotState {
  return {
    phase: 'running',
    discord: 'connected',
    startedAt: Date.now(),
    lastStateChangeAt: Date.now(),
  };
}

/** Builds an adapter over a list-handler spy and stops it when the test ends. */
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
  onTestFinished(() => adapter.stop());
  return { adapter, client, cap, listSpy };
}

async function dispatch(
  client: ReturnType<typeof makeStubbedClient>,
  message: unknown,
): Promise<void> {
  emitMessage(client, message);
  // Flush the async handler chain (list handler + sends) before asserting.
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

/** Waits until the capturing logger has recorded a line with this message. */
async function waitForLine(
  cap: ReturnType<typeof makeCapturingLogger>,
  msg: string,
): Promise<void> {
  await vi.waitFor(() => expect(cap.lines.some((l) => l.msg === msg)).toBe(true));
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
  });

  it('echo command WITH an attachment is still just an echo (commands never trigger the hint or the list path)', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({
      content: '!echo hi',
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(sentPayloads(msg.send)[0].content).toBe('hi');
    expect(msg.send).toHaveBeenCalledTimes(1);
    expect(env.listSpy).not.toHaveBeenCalled();
  });
});

describe('adapter routing: channel allowlist', () => {
  it('image message in a non-allowlisted channel → nothing sent, listSubmission never called', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
  });

  it('text-only message in a non-allowlisted channel → ignored entirely (no hint)', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['999888777666555444'] },
    });
    const msg = buildMessage({ content: 'hello there' });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
  });

  it('allowlist null → every channel is processed', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      channelId: 'any-channel',
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
  });

  it('allowlist containing the channel → processed', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['chan-1', '999888777666555444'] },
    });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
  });
});

describe('adapter routing: attachment descriptors', () => {
  it('forwards every attachment unfiltered, in message order, mapping url (never proxyURL) / size / contentType', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      attachments: [
        attachment('https://cdn.test/doc.pdf', 'application/pdf', 11),
        attachment('https://cdn.test/second.bin', null, 22),
      ],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    const sent = env.listSpy.mock.calls[0][0];
    expect(sent.attachments).toEqual([
      { url: 'https://cdn.test/doc.pdf', reportedSize: 11, reportedContentType: 'application/pdf' },
      { url: 'https://cdn.test/second.bin', reportedSize: 22, reportedContentType: null },
    ]);
    expect(sent.userId).toBe('user-1');
    expect(sent.channelId).toBe('chan-1');
    expect(sent.correlationId).toEqual(expect.stringMatching(/.+/));
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
  });

  it('an unrecognized command-like message also earns the hint', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: '!bogus args' });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
    expect(sentPayloads(msg.send)[0].content).toBe(USAGE_HINT);
  });

  it('bot authors are ignored (no hint, no list path)', async () => {
    const env = makeEnv();
    const msg = buildMessage({
      content: 'from a bot',
      authorBot: true,
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
  });
});

describe('adapter routing: reply delivery', () => {
  it('handler result > 2000 chars → the split chunks sent in order, each with empty allowedMentions', async () => {
    const longText = 'x'.repeat(5000);
    const env = makeEnv({ listSubmission: async () => ({ text: longText }) });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(sentPayloads(msg.send)).toEqual(
      splitReply(longText).map((content) => ({ content, allowedMentions: EMPTY_MENTIONS })),
    );
  });

  it('handler throwing → the generic service-unavailable reply with empty allowedMentions', async () => {
    const env = makeEnv({
      listSubmission: async () => {
        throw new Error('handler boom');
      },
    });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(msg.send).toHaveBeenCalledTimes(1);
    expect(sentPayloads(msg.send)[0]).toEqual({
      content: LIST_MESSAGES.serviceUnavailable,
      allowedMentions: EMPTY_MENTIONS,
    });
  });
});

describe('adapter routing: list reply delivery is logged', () => {
  it('a delivered multi-chunk reply logs chunk count and length under the correlation id', async () => {
    const longText = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    const env = makeEnv({ listSubmission: async () => ({ text: longText }) });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
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
  });

  it('an undelivered chunk is logged as a warning with the delivered count', async () => {
    const env = makeEnv({ listSubmission: async () => ({ text: 'Milk' }) });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await waitForLine(env.cap, 'list reply sent');
    const sent = env.cap.lines.find((l) => l.msg === 'list reply sent');
    expect(sent).toMatchObject({ level: 'warn', chunkCount: 1, deliveredChunks: 0 });
  });
});

describe('adapter routing: every reply is traceable by correlation id', () => {
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
  });

  it('an undelivered usage hint is logged as a warning, and the send failure carries the same correlation id', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: 'milk' });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await waitForLine(env.cap, 'reply failed after retries');
    const hint = env.cap.lines.find((l) => l.msg === 'usage hint sent');
    const failure = env.cap.lines.find((l) => l.msg === 'reply failed after retries');
    expect(hint).toMatchObject({ level: 'warn', delivered: false });
    expect(failure?.correlationId).toBeDefined();
    expect(failure?.correlationId).toBe(hint?.correlationId);
  });

  it('a failed list-reply send carries the submission correlation id', async () => {
    const env = makeEnv({ listSubmission: async () => ({ text: 'Milk' }) });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await waitForLine(env.cap, 'reply failed after retries');
    const sent = env.cap.lines.find((l) => l.msg === 'list reply sent');
    const failure = env.cap.lines.find((l) => l.msg === 'reply failed after retries');
    expect(failure?.correlationId).toBeDefined();
    expect(failure?.correlationId).toBe(sent?.correlationId);
  });

  it('a failed echo-reply send carries the command correlation id', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: '!echo hi' });
    msg.send.mockImplementation(async () => {
      throw new Error('discord down');
    });
    await dispatch(env.client, msg.raw);
    await waitForLine(env.cap, 'reply failed after retries');
    const received = env.cap.lines.find((l) => l.msg === 'command received');
    const failure = env.cap.lines.find((l) => l.msg === 'reply failed after retries');
    expect(failure?.correlationId).toBeDefined();
    expect(failure?.correlationId).toBe(received?.correlationId);
  });
});

describe('adapter routing: system messages, threads, and blank chunks', () => {
  it('a Discord system message (member join, pin, boost) is ignored entirely', async () => {
    const env = makeEnv();
    const msg = buildMessage({ content: '', system: true });
    await dispatch(env.client, msg.raw);
    expect(msg.send).not.toHaveBeenCalled();
    expect(env.listSpy).not.toHaveBeenCalled();
  });

  it('a photo in a thread under an allowlisted channel is processed, reply in the thread', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['111111111111111111'] },
    });
    const msg = buildMessage({
      channelId: '222222222222222222',
      threadParentId: '111111111111111111',
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).toHaveBeenCalledTimes(1);
    expect(sentPayloads(msg.send)[0].content).toBe('handler reply');
  });

  it('a thread under a non-allowlisted channel stays ignored', async () => {
    const env = makeEnv({
      config: { ...baseConfig, ocrChannelAllowlist: ['111111111111111111'] },
    });
    const msg = buildMessage({
      channelId: '222222222222222222',
      threadParentId: '333333333333333333',
      attachments: [PNG_ATTACHMENT],
    });
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
    expect(msg.send).not.toHaveBeenCalled();
  });

  it('a regular channel is not admitted through its category id', async () => {
    const env = makeEnv({ config: { ...baseConfig, ocrChannelAllowlist: ['444444444444444444'] } });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
    });
    // The stub's non-thread channel reports parentId 'category-1'; allowlist the category instead.
    msg.raw.channel.parentId = '444444444444444444';
    await dispatch(env.client, msg.raw);
    expect(env.listSpy).not.toHaveBeenCalled();
  });

  it('whitespace-only chunks are never sent (Discord rejects empty messages)', async () => {
    const text = `${'a'.repeat(1999)}\n\n`;
    const env = makeEnv({ listSubmission: async () => ({ text }) });
    const msg = buildMessage({
      attachments: [PNG_ATTACHMENT],
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
  });
});
