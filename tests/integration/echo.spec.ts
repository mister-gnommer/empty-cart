import { describe, it, expect, vi } from 'vitest';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import type { BotState, Config } from '../../src/shared/types';

type LoggedLine = { level: string; msg: string; [k: string]: unknown };

function makeCapturingLogger(): { logger: unknown; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  function make(bindings: Record<string, unknown> = {}): unknown {
    function emit(severity: string, args: unknown[]): void {
      let merged: Record<string, unknown> = { ...bindings, level: severity };
      for (const a of args) {
        if (a && typeof a === 'object') {
          merged = { ...merged, ...(a as Record<string, unknown>) };
        }
      }
      lines.push({ ...merged, msg: String(merged.msg ?? '') });
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

const config: Config = {
  discordToken: 'tok',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
};

function makeStubbedClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.login = (async () => 'stub-token') as typeof client.login;
  client.destroy = (async () => undefined) as typeof client.destroy;
  return client;
}

describe('integration: !echo round trip (contracts/discord.md §integration)', () => {
  it('hand-driven Events.MessageCreate produces the echoed reply on a stubbed channel.send with correlationId on every log line of the handler call', async () => {
    const cap = makeCapturingLogger();
    const botState: BotState = {
      phase: 'starting',
      discord: 'disconnected',
      startedAt: Date.now(),
      lastStateChangeAt: Date.now(),
    };
    const client = makeStubbedClient();
    const adapter = createDiscordAdapter({
      config,
      logger: cap.logger as never,
      botState,
      echo: handleEchoCommand,
      clientFactory: () => client,
    });
    try {
      const send = vi.fn(async () => undefined);
      const message = {
        author: { bot: false, id: 'user-42' },
        content: '!echo integration round trip',
        guild: { id: 'guild-7' },
        channelId: 'channel-9',
        channel: { id: 'channel-9', send },
      };

      client.emit(Events.MessageCreate, message);
      // Flush microtasks for the async handler.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }

      // The reply was echoed on the stubbed channel.send.
      expect(send.mock.calls.length).toBe(1);
      const payload = send.mock.calls[0]![0] as {
        content: string;
        allowedMentions: unknown;
      };
      expect(payload.content).toBe('integration round trip');
      expect(payload.allowedMentions).toEqual({
        parse: [],
        users: [],
        roles: [],
      });

      // correlationId on every log line of the handler call.
      const rcv = cap.lines.find((l) => l.msg === 'command received');
      const handled = cap.lines.find((l) => l.msg === 'command handled');
      expect(rcv).toBeDefined();
      expect(handled).toBeDefined();
      expect(handled!.status).toBe('echoed');
      const corrId = String(rcv!.correlationId);
      expect(corrId).toMatch(/.+/);
      for (const line of cap.lines) {
        expect(String(line.correlationId)).toBe(corrId);
      }
      // BotState discord was set to connected by ClientReady — but we did not
      // raise ClientReady here, so it stays `disconnected`. The echo round
      // trip correctness does NOT require a gateway-up line (US1 independent
      // test spec).
      expect(botState.discord).toBe('disconnected');
    } finally {
      await adapter.stop();
    }
  });
});