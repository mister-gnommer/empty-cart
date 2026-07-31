import { Client, Events, GatewayIntentBits } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import type { BotState, Config } from '../../src/shared/types';

// Capture all log lines emitted by the adapter into an array of objects
// (parsed NDJSON so assertions can scan field values directly).
type LoggedLine = {
  level: string;
  msg: string;
  [k: string]: unknown;
};

function makeCapturingLogger(): {
  logger: unknown;
  lines: LoggedLine[];
} {
  const lines: LoggedLine[] = [];
  function make(bindings: Record<string, unknown> = {}): unknown {
    function emit(severity: string, args: unknown[]): void {
      let merged: Record<string, unknown> = { ...bindings };
      for (const a of args) {
        if (a && typeof a === 'object') {
          merged = { ...merged, ...(a as Record<string, unknown>) };
        }
      }
      lines.push({
        ...merged,
        msg: String(merged.msg ?? ''),
        level: severity,
      });
    }
    return {
      info: (...a: unknown[]) => emit('info', a),
      warn: (...a: unknown[]) => emit('warn', a),
      error: (...a: unknown[]) => emit('error', a),
      fatal: (...a: unknown[]) => emit('fatal', a),
      debug: (...a: unknown[]) => emit('debug', a),
      trace: (...a: unknown[]) => emit('trace', a),
      child: (b: Record<string, unknown>) => make({ ...bindings, ...b }),
    };
  }
  return { logger: make(), lines };
}

const baseConfig: Config = {
  discordToken: 'SECRET-TOKEN-VALUE',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
};

function makeBotState(): BotState {
  return {
    phase: 'starting',
    discord: 'disconnected',
    startedAt: Date.now(),
    lastStateChangeAt: Date.now(),
  };
}

type FakeMessage = {
  author: { bot: boolean; id: string };
  content: string;
  guild: { id: string } | null;
  channelId: string;
  channel: { id: string; send: ReturnType<typeof vi.fn> };
};

function buildFakeMessage(opts: {
  content: string;
  authorBot?: boolean;
  authorId?: string;
  guildId?: string | null;
  channelId?: string;
  sendImpl?: (...args: unknown[]) => Promise<unknown>;
}) {
  const sendImpl =
    opts.sendImpl ??
    (async (..._args: unknown[]) => {
      /* noop */
    });
  const channel = {
    id: opts.channelId ?? 'chan-1',
    send: vi.fn(sendImpl) as unknown as ReturnType<typeof vi.fn>,
  };
  return {
    raw: {
      author: {
        bot: opts.authorBot ?? false,
        id: opts.authorId ?? 'user-1',
      },
      content: opts.content,
      guild: opts.guildId == null ? null : { id: opts.guildId },
      channelId: opts.channelId ?? 'chan-1',
      channel,
    } as FakeMessage,
    channelStub: channel,
  };
}

function makeStubbedClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  // Do not perform a real WebSocket login or destroy.
  client.login = vi.fn(async () => 'fake-token');
  client.destroy = vi.fn(async () => undefined);
  return client;
}

function makeAdapter(
  cap: ReturnType<typeof makeCapturingLogger>,
  botState: BotState,
  client: Client,
  opts: {
    echo?: typeof handleEchoCommand;
    config?: Config;
  } = {},
) {
  return createDiscordAdapter({
    config: opts.config ?? baseConfig,
    logger: cap.logger as never,
    botState,
    echo: opts.echo ?? handleEchoCommand,
    clientFactory: () => client,
  });
}

async function dispatchMessage(client: Client, message: FakeMessage): Promise<void> {
  client.emit(Events.MessageCreate, message);
  // Flush enough microtasks for the async handler body to settle. The retry
  // loop's backoff uses real setTimeout; allow up to 500ms of real time for
  // up to three retries (each backoff is 30*attempt ms, total ~90-180ms).
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 500));
}

describe('discord adapter contract (contracts/discord.md)', () => {
  let originalProcessExit: typeof process.exit;
  beforeEach(() => {
    originalProcessExit = process.exit;
    process.exit = vi.fn((() => {
      throw new Error('process.exit called');
    }) as never) as never;
  });
  afterEach(() => {
    process.exit = originalProcessExit;
  });

  describe('§2 event → state mapping (with reconnect correlationId)', () => {
    it('ClientReady sets botState.discord=connected and phase=running, logs discord connected', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      client.emit(Events.ClientReady, client);
      expect(botState.discord).toBe('connected');
      expect(cap.lines.some((l) => l.msg === 'discord connected')).toBe(true);
      await adapter.stop();
    });

    it('ShardDisconnect → reconnecting with fresh correlationId, then ShardResume → connected carrying the SAME correlationId (FR-012)', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      client.emit(Events.ShardDisconnect, { code: 1006 }, 0);
      const discLine = cap.lines.find((l) => l.msg === 'discord shard disconnected');
      expect(discLine, 'expected shard-disconnect warn line').toBeDefined();
      expect(String(discLine!.correlationId)).toMatch(/.+/);
      expect(botState.discord).toBe('reconnecting');

      client.emit(Events.ShardResume, undefined, 0);
      const resumeLine = cap.lines.find((l) => l.msg === 'discord reconnected');
      expect(resumeLine, 'expected reconnect info line').toBeDefined();
      expect(resumeLine!.correlationId).toBe(discLine!.correlationId);
      expect(botState.discord).toBe('connected');

      await adapter.stop();
    });

    it('ShardReady after a disconnect carries the same correlationId (FR-012)', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      client.emit(Events.ShardDisconnect, { code: 1011 }, 0);
      const discLine = cap.lines.find((l) => l.msg === 'discord shard disconnected');
      client.emit(Events.ShardReady, 0);
      const readyLine = cap.lines.find((l) => l.msg === 'discord reconnected');
      expect(readyLine).toBeDefined();
      expect(readyLine!.correlationId).toBe(discLine!.correlationId);

      await adapter.stop();
    });

    it('each NEW ShardDisconnect generates a fresh correlationId (per-attempt traceability)', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      client.emit(Events.ShardDisconnect, { code: 1006 }, 0);
      const first = cap.lines.findIndex((l) => l.msg === 'discord shard disconnected');
      client.emit(Events.ShardResume, undefined, 0);
      client.emit(Events.ShardDisconnect, { code: 1000 }, 0);
      const second = cap.lines.slice(first + 1).find((l) => l.msg === 'discord shard disconnected');
      expect(second).toBeDefined();
      expect(second!.correlationId).not.toBe(cap.lines[first]!.correlationId);

      await adapter.stop();
    });
  });

  describe('§4 no ghost-ping — allowedMentions on every send branch', () => {
    it('echoed reply is sent with allowedMentions {parse: [], users: [], roles: []}', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      const fake = buildFakeMessage({ content: '!echo hello world' });
      await dispatchMessage(client, fake.raw);

      expect(fake.channelStub.send).toHaveBeenCalledTimes(1);
      const payload = fake.channelStub.send.mock.calls[0]![0] as {
        content: string;
        allowedMentions: unknown;
      };
      expect(payload).toEqual({
        content: 'hello world',
        allowedMentions: { parse: [], users: [], roles: [] },
      });
      await adapter.stop();
    });

    it('usage-hint reply is sent with allowedMentions empty-parse', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      const fake = buildFakeMessage({ content: '!echo' });
      await dispatchMessage(client, fake.raw);

      expect(fake.channelStub.send).toHaveBeenCalledTimes(1);
      const payload = fake.channelStub.send.mock.calls[0]![0] as {
        content: unknown;
        allowedMentions: unknown;
      };
      expect(payload.allowedMentions).toEqual({
        parse: [],
        users: [],
        roles: [],
      });
      await adapter.stop();
    });

    it('too-long reply is sent with allowedMentions empty-parse', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      const fake = buildFakeMessage({ content: `!echo ${'a'.repeat(1901)}` });
      await dispatchMessage(client, fake.raw);

      const payload = fake.channelStub.send.mock.calls[0]![0] as {
        content: string;
        allowedMentions: unknown;
      };
      expect(payload.content).toBe('Input too long (max 1900 chars).');
      expect(payload.allowedMentions).toEqual({
        parse: [],
        users: [],
        roles: [],
      });
      await adapter.stop();
    });
  });

  describe('§5 handler-throw — canonical user-facing error reply (byte-equal, no exception leaked)', () => {
    it('on handler throw, sends the canonical string + logs msg="command handler threw"', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client, {
        echo: vi.fn(() => {
          throw new Error('boom from echo core');
        }),
      });

      const fake = buildFakeMessage({ content: '!echo payload' });
      await dispatchMessage(client, fake.raw);

      expect(fake.channelStub.send).toHaveBeenCalledTimes(1);
      const payload = fake.channelStub.send.mock.calls[0]![0] as {
        content: string;
      };
      expect(payload.content).toBe('An internal error occurred while processing your command.');
      const errLine = cap.lines.find((l) => l.msg === 'command handler threw');
      expect(errLine).toBeDefined();
      expect(String(errLine!.errorMessage)).toContain('boom from echo core');
      // Reply must NOT contain the exception text.
      expect(payload.content).not.toContain('boom');
      await adapter.stop();
    });
  });

  describe('§6 bounded transient-transport retry', () => {
    it('honors attempts ≤ 3 when channel.send always rejects (shutdownTimeoutMs=4000 → totalMs=2000)', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client, {
        config: { ...baseConfig, shutdownTimeoutMs: 4000 },
      });
      const send = vi.fn(async () => {
        throw new Error('send rejected');
      });
      const fake = buildFakeMessage({ content: '!echo x', sendImpl: send });
      await dispatchMessage(client, fake.raw);

      expect(send.mock.calls.length).toBeLessThanOrEqual(3);
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(1);
      const failLine = cap.lines.find((l) => l.msg === 'reply failed after retries');
      expect(failLine).toBeDefined();
      expect(Number(failLine!.attempts)).toBeLessThanOrEqual(3);
      expect(botState.discord).toBe('disconnected');
      await adapter.stop();
    });

    it('does not retry when shutdownTimeoutMs=2000 (totalMs=0)', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client, {
        config: { ...baseConfig, shutdownTimeoutMs: 2000 },
      });
      const send = vi.fn(async () => {
        throw new Error('no retry');
      });
      const fake = buildFakeMessage({ content: '!echo x', sendImpl: send });
      await dispatchMessage(client, fake.raw);
      expect(send.mock.calls.length).toBe(1);
      const failLine = cap.lines.find((l) => l.msg === 'reply failed after retries');
      expect(failLine).toBeDefined();
      expect(Number(failLine!.attempts)).toBe(1);
      await adapter.stop();
    });

    it('stop() cancels an in-flight retry loop without blocking — adapter.stop() resolves quickly', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client, {
        config: { ...baseConfig, shutdownTimeoutMs: 4000 },
      });
      const rejects: (() => void)[] = [];
      const send = vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejects.push(reject as () => void);
          }),
      );
      const fake = buildFakeMessage({ content: '!echo x', sendImpl: send });
      void dispatchMessage(client, fake.raw);
      // Let the first attempt register its pending send promise.
      await new Promise((r) => setImmediate(r));

      // stop() should resolve well under the 5s shutdown budget even though
      // the in-flight send is still pending — the abort fires and the retry
      // loop terminates without awaiting the backoff.
      const stopStart = Date.now();
      await adapter.stop();
      const stopMs = Date.now() - stopStart;
      expect(stopMs).toBeLessThan(1000);
      expect(botState.discord).toBe('destroyed');

      // Drain the pending dangling send so the unhandled rejection does not
      // bleed across subsequent tests.
      for (const r of rejects) r();
    });
  });

  describe('§7 clean shutdown', () => {
    it('stop() removes MessageCreate listener, calls client.destroy(), sets destroyed, logs discord disconnected', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      expect(client.listenerCount(Events.MessageCreate)).toBe(1);
      await adapter.stop();
      expect(client.listenerCount(Events.MessageCreate)).toBe(0);
      expect((client.destroy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect(botState.discord).toBe('destroyed');
      expect(cap.lines.some((l) => l.msg === 'discord disconnected')).toBe(true);
    });

    it('MessageCreate arriving after stop() is ignored (stopping gate / listener removed)', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      await adapter.stop();
      expect(client.listenerCount(Events.MessageCreate)).toBe(0);
      const fake = buildFakeMessage({ content: '!echo post-stop' });
      client.emit(Events.MessageCreate, fake.raw);
      await new Promise((r) => setImmediate(r));
      expect(fake.channelStub.send).not.toHaveBeenCalled();
    });
  });

  describe('§8 logs never contain raw args/reply text', () => {
    it('command-received and command-handled lines carry length fields only, not content', async () => {
      const cap = makeCapturingLogger();
      const botState = makeBotState();
      const client = makeStubbedClient();
      const adapter = makeAdapter(cap, botState, client);

      const secretText = 'SUPER-SECRET-PAYLOAD-MUST-NOT-LEAK-TO-LOGS';
      const fake = buildFakeMessage({ content: `!echo ${secretText}` });
      await dispatchMessage(client, fake.raw);

      for (const line of cap.lines) {
        const json = JSON.stringify(line);
        expect(json, `line leaked content: ${json}`).not.toContain(secretText);
      }
      const rcv = cap.lines.find((l) => l.msg === 'command received');
      expect(rcv).toBeDefined();
      expect(Number(rcv!.argsLength)).toBe(secretText.length);
      const handled = cap.lines.find((l) => l.msg === 'command handled');
      expect(handled).toBeDefined();
      expect(handled!.status).toBe('echoed');
      expect(Number(handled!.replyLength)).toBe(secretText.length);
      await adapter.stop();
    });
  });
});
