import { describe, expect, it } from 'vitest';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import { childFor } from '../../src/logger/create-logger';
import type { Config } from '../../src/shared/types';
import { makeStreamLogger } from '../helpers/stream-logger';

// End-to-end secret-redaction path: a representative startup → echo-handle →
// shutdown event sequence through the real logger (with its production
// redact config) must never leak the Discord token value into any emitted
// log line.

describe('redaction end-to-end', () => {
  it('startup → echo-handle → shutdown sequence emits zero log lines containing the literal DISCORD_TOKEN value', () => {
    const SECRET_TOKEN = 'SUPERSECRET-token-value-DO-NOT-LEAK-0xDEADBEEF';
    const config: Config = {
      discordToken: SECRET_TOKEN,
      logLevel: 'debug',
      commandPrefix: '!',
      echoCommandName: 'echo',
      echoMaxLength: 1900,
      shutdownTimeoutMs: 5000,
      healthHost: '127.0.0.1',
      healthPort: 8081,
    };
    const { logger, chunks } = makeStreamLogger('debug');

    // --- startup events ---
    logger.info({
      msg: 'bot started',
      healthAddress: '127.0.0.1:8081',
      prefix: '!',
      echoCommandName: 'echo',
      config,
    });

    // --- echo-handle: log command-received / command-handled (lengths only,
    //     config never logged at value level by the contract) ---
    const cmd = { args: 'hello <@123> @everyone chosen-data' };
    const result = handleEchoCommand(cmd, config);
    const corrId = 'corr-redaction-001';
    // Safe: `logger` is a real pino Logger built by the helper; `as never`
    // only bridges the nominal pino import expected by childFor's signature.
    const log = childFor(logger as never, corrId);
    log.info({
      msg: 'command received',
      userId: 'u-1',
      channelId: 'c-1',
      argsLength: cmd.args.length,
    });
    log.info({
      msg: 'command handled',
      status: result.status,
      replyLength: result.reply.length,
    });

    // --- shutdown events (correlation-id-bearing) ---
    log.info({ msg: 'shutdown requested', reason: 'SIGTERM' });
    log.info({ msg: 'shutdown complete', phase: 'shutting-down' });

    const lines = chunks();
    expect(lines.length).toBeGreaterThan(0);
    // Zero secrets in any log line.
    for (const line of lines) {
      const json = JSON.stringify(line);
      expect(json, `redaction leak:\n${json}`).not.toContain(SECRET_TOKEN);
    }
    // Sanity: the token value WAS passed in some fields — confirm redaction
    // fired (the wire output contains "[Redacted]" rather than the value).
    const any = lines.map((l) => JSON.stringify(l)).join('\n');
    expect(any).toContain('[Redacted]');
  });
});
