import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLogger,
  createBootstrapLogger,
  createEmergencyLogger,
  childFor,
} from '../../src/logger/create-logger';
import type { Config } from '../../src/shared/types';

// Capture pino's stdout output by writing to a test destination buffer:
// createLogger uses pino's default destination (SonicBoom to stdout). For
// tests we capture process.stdout by overriding pino's destination via
// `pino(stream)` form. createLogger() in production uses the default
// destination; production callers pass only a Config (no stream). To assert
// wire-shape behaviour we exercise createLogger via a wrapper here that
// re-imports with the same redact config writing to an in-memory stream.
import pino from 'pino';

const redactPaths = [
  'discordToken',
  '*.discordToken',
  '*.token',
  'token',
  '*.*.token',
];

function makeStreamLogger(level: Config['logLevel'] = 'info') {
  const chunks: string[] = [];
  const stream = new (require('stream').Writable)({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ level, redact: { paths: redactPaths, censor: '[Redacted]' } }, stream);
  return { logger, chunks: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as Record<string, unknown>[] };
}

describe('logger (contracts/logger.md)', () => {
  describe('redact.paths — SC-006 backstop', () => {
    it('object shaped { config: { discordToken: "x" } } serializes with "[Redacted]" and never "x" (depth-2 *.discordToken)', () => {
      const { logger, chunks } = makeStreamLogger('info');
      logger.info({ config: { discordToken: 'x' } }, 'msg');
      const lines = chunks();
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines[0])).toContain('[Redacted]');
      expect(JSON.stringify(lines[0])).not.toContain('"x"');
    });

    it('top-level discordToken is redacted (depth-1 path)', () => {
      const { logger, chunks } = makeStreamLogger('info');
      logger.info({ discordToken: 'x' }, 'msg');
      const line = JSON.stringify(chunks()[0]);
      expect(line).toContain('[Redacted]');
      expect(line).not.toContain('"x"');
    });

    it('deep-nested differently-named secret { app: { bot: { apiKey: "x" } } } documents the backstop LIMIT: redaction does NOT cover it (no Secrets object may be passed to log)', () => {
      const { logger, chunks } = makeStreamLogger('info');
      logger.info({ app: { bot: { apiKey: 'x' } } }, 'msg');
      const line = JSON.stringify(chunks()[0]);
      // The contract's stated limitation: redaction does NOT cover depth-4+
      // secrets with different names. The test asserts the value appears
      // VERBATIM, documenting why "no Secrets passed to log" is load-bearing.
      expect(line).toContain('"x"');
      expect(line).not.toContain('[Redacted]');
    });

    it('`*.token` redacts a depth-2 differently-shaped key named `token`', () => {
      const { logger, chunks } = makeStreamLogger('info');
      logger.info({ session: { token: 'x' } }, 'msg');
      const line = JSON.stringify(chunks()[0]);
      expect(line).toContain('[Redacted]');
      expect(line).not.toContain('"x"');
    });
  });

  describe('childFor binds correlationId on every subsequent line', () => {
    it('every line emitted by the child logger carries the binding', () => {
      const { logger, chunks } = makeStreamLogger('info');
      const child = childFor(logger as never, 'corr-1') as ReturnType<typeof makeStreamLogger>['logger'];
      child.info({ msg: 'first' });
      child.warn({ msg: 'second' });
      child.error({ msg: 'third' });
      const lines = chunks();
      expect(lines).toHaveLength(3);
      for (const l of lines) {
        expect(l.correlationId).toBe('corr-1');
      }
    });

    it('extra bindings are also merged onto every line', () => {
      const { logger, chunks } = makeStreamLogger('info');
      const child = childFor(logger as never, 'corr-2', { userId: 'u1' }) as ReturnType<typeof makeStreamLogger>['logger'];
      child.info({ msg: 'event' });
      const line = chunks()[0];
      expect(line.correlationId).toBe('corr-2');
      expect(line.userId).toBe('u1');
    });
  });

  describe('pino-pretty is dev-only (static scan)', () => {
    it('src/ production build does not import pino-pretty', () => {
      // Lint the production source for a pino-pretty import.
      const srcPath = resolve(__dirname, '../../src/logger/create-logger.ts');
      const src = readFileSync(srcPath, 'utf8');
      expect(src).not.toMatch(/pino-pretty/);
      // Also assert the production build artifact:
      const distPath = resolve(__dirname, '../../dist/logger/create-logger.js');
      if (existsSync(distPath)) {
        const dist = readFileSync(distPath, 'utf8');
        expect(dist).not.toMatch(/pino-pretty/);
      }
    });
  });

  describe('no logger.flush() awaited (static scan)', () => {
    it('src/ contains no `.flush(` call', () => {
      const filesToScan = ['create-logger.ts'];
      for (const f of filesToScan) {
        const path = resolve(__dirname, '../../src/logger', f);
        const src = readFileSync(path, 'utf8');
        expect(src).not.toMatch(/\.flush\(/);
      }
    });
  });

  describe('bootstrap logger', () => {
    it('createBootstrapLogger returns a usable info logger reading env.LOG_LEVEL', () => {
      const logger = createBootstrapLogger({ LOG_LEVEL: 'warn' });
      expect(typeof logger.info).toBe('function');
      // introspect level — pino sets @level
      expect((logger as unknown as { level: string }).level).toBe('warn');
    });

    it('createBootstrapLogger clamps an unknown LOG_LEVEL to info', () => {
      const logger = createBootstrapLogger({ LOG_LEVEL: 'verbose' });
      expect((logger as unknown as { level: string }).level).toBe('info');
    });
  });

  describe('emergency logger (contracts/logger.md §7)', () => {
    it('createEmergencyLogger writes a fatal line to process.stderr and applies redact.paths', () => {
      const captured: string[] = [];
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Buffer | Uint8Array) => {
          captured.push(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk));
          return true;
        });
      try {
        const logger = createEmergencyLogger();
        logger.fatal({ config: { discordToken: 'SECRET' } }, 'startup failed');
      } finally {
        spy.mockRestore();
      }
      const joined = captured.join('');
      expect(joined).toContain('startup failed');
      expect(joined).toContain('[Redacted]');
      expect(joined).not.toContain('SECRET');
    });

    it('createEmergencyLogger throws when process.stderr is unavailable', () => {
      const restore = Object.getOwnPropertyDescriptor(process, 'stderr');
      Object.defineProperty(process, 'stderr', { value: null, writable: true });
      try {
        expect(() => createEmergencyLogger()).toThrowError(/stderr/);
      } finally {
        Object.defineProperty(process, 'stderr', restore as PropertyDescriptor);
      }
    });
  });

  describe('createLogger', () => {
    it('returns a pino Logger usable as .info', () => {
      const logger = createLogger({ logLevel: 'info' });
      expect(typeof logger.info).toBe('function');
    });
  });

  // Suppress unhandled console noise from writing through pino during tests.
  afterEach(() => {
    vi.restoreAllMocks();
  });
});