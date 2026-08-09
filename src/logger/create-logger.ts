// Logger — pino NDJSON to stdout, redact.paths covering discordToken and the
// documented token shapes. Default destination is
// SonicBoom (`sync: false`); SonicBoom registers a `process.on('exit')` handler
// that sync-flushes the buffer before the process terminates, and pino's
// `fatal` auto-sync-flushes — so callers MUST NOT await `flush()` (it returns
// undefined, not a Promise).
import pino, { type Logger } from 'pino';
import type { Config } from '../shared/types';

const REDACT_PATHS = ['discordToken', '*.discordToken', '*.token', 'token', '*.*.token'];
const REDACT_CENSOR = '[Redacted]';

export function createLogger(config: Pick<Config, 'logLevel'>): Logger {
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  });
}

export function createBootstrapLogger(env: NodeJS.ProcessEnv): Logger {
  // Pre-validation logger; performs NO env validation.
  // Reads env.LOG_LEVEL directly with fallback to 'info'.
  const level = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];
  // If LOG_LEVEL is set to something bogus, pino would ignore levels it does
  // not recognise; clamp to 'info' to keep the bootstrap logger usable for the
  // fatal startup line regardless of stray env input.
  const allowed = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const safeLevel = allowed.includes(level) ? level : 'info';
  return pino({
    level: safeLevel,
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  });
}

export function createEmergencyLogger(): Logger {
  // Writes NDJSON to process.stderr (no stdout dependency). If
  // process.stderr is also unavailable, this
  // constructor throws and the caller exits non-zero without logging as a
  // last resort. We bind directly to the `process.stderr` stream object
  // (rather than pino.destination({ dest: 2 }) — which writes via the FD
  // number and bypasses any test spy on `process.stderr.write`). The
  // contract requires synchronous stderr output; pino treats a passed
  // Writable stream synchronously when the underlying stream is in sync
  // mode (process.stderr is sync by default for tty outputs).
  if (!process.stderr || typeof process.stderr.write !== 'function') {
    throw new Error('stderr unavailable for emergency logger');
  }
  return pino(
    {
      level: 'fatal',
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    },
    process.stderr,
  );
}

export function childFor(
  logger: Logger,
  correlationId: string,
  extra?: Record<string, unknown>,
): Logger {
  return logger.child({ correlationId, ...(extra ?? {}) });
}
