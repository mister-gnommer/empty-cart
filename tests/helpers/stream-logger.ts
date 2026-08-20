import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_PATHS } from '../../src/logger/create-logger';
import type { Config } from '../../src/shared/types';

// In-memory pino logger factory for wire-format assertions: same redact
// config as the production logger, but writing to a captured stream instead
// of stdout. The production logger uses pino's default (SonicBoom) stdout
// destination, which cannot be captured in-process.
export function makeStreamLogger(level: Config['logLevel'] = 'info') {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ level, redact: { paths: REDACT_PATHS, censor: '[Redacted]' } }, stream);
  return {
    logger,
    chunks: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}
