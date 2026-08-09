import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import { childFor, REDACT_PATHS } from '../../src/logger/create-logger';
import type { Config } from '../../src/shared/types';

// End-to-end redaction path: representative startup → echo-handle → shutdown
// event sequence through the REAL logger (pino to a captured stdout sink),
// asserting no log line contains the literal DISCORD_TOKEN env value
// anywhere in the output (wire-format JSON, redaction backstop + the
// "logs never contain content" rule).

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        // Safe: pino writes NDJSON objects, so JSON.parse yields a record.
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

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

describe('redaction end-to-end', () => {
  it('startup → echo-handle → shutdown sequence emits zero log lines containing the literal DISCORD_TOKEN value', () => {
    const sink = capture();
    // Bind a pino logger to the captured sink using the production REDACT_PATHS
    // constant, so the wire-format redaction under test is identical to what
    // createLogger configures — drift between the two is impossible.
    const logger = pino(
      {
        level: 'debug',
        redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      },
      sink.stream,
    );

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
    // Safe: `logger` is a real pino Logger built above; `as never` only
    // bridges the nominal import expected by childFor's signature.
    const log = childFor(logger as never, corrId) as typeof logger;
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

    const lines = sink.lines();
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
