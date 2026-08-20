import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import type { BotState, Config } from '../../src/shared/types';
import { makeCapturingLogger } from '../helpers/logger';
import { emitMessage, makeStubbedClient } from '../helpers/stubbed-client';

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

describe('integration: !echo round trip', () => {
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
      // Safe: the capturing logger satisfies pino's Logger call surface
      // structurally; `as never` only bridges the nominal pino import.
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

      // The stub message is a partial stand-in for the real Message object;
      // emitMessage bridges it to the discord.js Message tuple shape.
      emitMessage(client, message);
      // Wait for the async handler to send the reply and emit both log lines.
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledTimes(1);
        expect(cap.lines.find((l) => l.msg === 'command received')).toBeDefined();
        expect(cap.lines.find((l) => l.msg === 'command handled')).toBeDefined();
      });

      // The reply was echoed on the stubbed channel.send. Assert via
      // toHaveBeenCalledWith (deep-equal of the call arg) to avoid indexing
      // the mock's untyped calls array or casting the payload by hand.
      expect(send).toHaveBeenCalledWith({
        content: 'integration round trip',
        allowedMentions: { parse: [], users: [], roles: [] },
      });

      // correlationId on every log line of the handler call.
      const rcv = cap.lines.find((l) => l.msg === 'command received');
      const handled = cap.lines.find((l) => l.msg === 'command handled');
      expect(rcv).toBeDefined();
      assert.ok(handled);
      expect(handled.status).toBe('echoed');
      const corrId = rcv?.correlationId;
      expect(corrId).toBeTypeOf('string');
      for (const line of cap.lines) {
        expect(line.correlationId).toBe(corrId);
      }
      // BotState.discord was set to connected by ClientReady — but we did not
      // raise ClientReady here, so it stays `disconnected`. The echo round
      // trip correctness does not require a gateway connection.
      expect(botState.discord).toBe('disconnected');
    } finally {
      await adapter.stop();
    }
  });
});
