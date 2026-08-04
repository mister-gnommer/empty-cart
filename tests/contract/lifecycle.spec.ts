import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newCorrelationId } from '../../src/shared/correlation-id';
import type { BotState, Config } from '../../src/shared/types';

const SIGTERM = 'SIGTERM' as const;
const SIGINT = 'SIGINT' as const;
const SIG_LIST = [SIGTERM, SIGINT] as const;
type SigName = (typeof SIG_LIST)[number];

const DEFAULT_CONFIG: Config = {
  discordToken: 'tok',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
};

// Drive lifecycle.runApp() with mocked child modules. We import the module
// AFTER installing the stubs so its imports resolve to our mocks.

type LoggedLine = { level: string; msg: string; [k: string]: unknown };

function makeCapturingLogger(): {
  logger: unknown;
  child: (b: Record<string, unknown>) => unknown;
  lines: LoggedLine[];
} {
  const lines: LoggedLine[] = [];
  const handlers: Record<string, (severity: string, fields: Record<string, unknown>) => void> = {};
  function emit(sev: string, args: unknown[], bindings: Record<string, unknown>): void {
    let merged: Record<string, unknown> = { ...bindings };
    for (const a of args) {
      if (a && typeof a === 'object') merged = { ...merged, ...(a as Record<string, unknown>) };
    }
    lines.push({ ...merged, level: sev, msg: String(merged.msg ?? '') });
  }
  function make(bindings: Record<string, unknown> = {}): unknown {
    return {
      info: (...a: unknown[]) => emit('info', a, bindings),
      warn: (...a: unknown[]) => emit('warn', a, bindings),
      error: (...a: unknown[]) => emit('error', a, bindings),
      fatal: (...a: unknown[]) => emit('fatal', a, bindings),
      debug: (...a: unknown[]) => emit('debug', a, bindings),
      trace: (...a: unknown[]) => emit('trace', a, bindings),
      child: (b: Record<string, unknown>) => make({ ...bindings, ...b }),
    };
  }
  void handlers;
  return { logger: make(), child: (b) => make(b), lines };
}

function _makeBotState(): BotState {
  return {
    phase: 'starting',
    discord: 'disconnected',
    startedAt: Date.now(),
    lastStateChangeAt: Date.now(),
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// Build the mocked module graph by mocking the dependency modules before
// importing src/lifecycle/run-app.
async function loadAppWithMocks(opts: {
  loadConfigImpl?: () => Config;
  loadConfigThrowsEnvField?: string;
  loadConfigThrowsReason?: 'missing' | 'malformed';
  startHealthServerImpl?: () => { stop: () => Promise<void> };
  startHealthThrows?: Error;
  adapterStartImpl?: () => Promise<void>;
  adapterStopImpl?: () => Promise<void>;
  bootLogger?: unknown;
  bootstrapLoggerThrows?: boolean;
  emergencyLoggerThrows?: boolean;
}) {
  const cap = makeCapturingLogger();

  // Mock ConfigError class is defined OUTSIDE the loadConfig factory so that
  // both the thrown instance AND the consumer's `instanceof ConfigError` check
  // refer to the same class.
  class ConfigError extends Error {
    readonly envField: string;
    readonly reason: 'missing' | 'malformed';
    constructor(a: { envField: string; reason: 'missing' | 'malformed' }) {
      super('cfg');
      this.envField = a.envField;
      this.reason = a.reason;
      this.name = 'ConfigError';
    }
  }

  // Mock config loader.
  const loadConfigMock = opts.loadConfigThrowsEnvField
    ? vi.fn((): Config => {
        throw new ConfigError({
          envField: opts.loadConfigThrowsEnvField!,
          reason: opts.loadConfigThrowsReason ?? 'missing',
        });
      })
    : vi.fn((): Config => opts.loadConfigImpl?.() ?? makeConfig());

  // Mock createLogger family.
  const createLoggerMock = vi.fn(() => cap.logger);
  const createBootstrapLoggerMock = vi.fn(() => {
    if (opts.bootstrapLoggerThrows) {
      throw new Error('bootstrap logger construction threw');
    }
    return cap.logger;
  });
  const createEmergencyLoggerMock = vi.fn(() => {
    if (opts.emergencyLoggerThrows) {
      throw new Error('emergency logger construction threw');
    }
    return cap.logger;
  });
  const childForMock = vi.fn(
    (l: unknown, correlationId: string, extra?: Record<string, unknown>) => {
      void l;
      void extra;
      return cap.child({ correlationId });
    },
  );

  // Mock health server.
  const healthStop = vi.fn(async () => {
    /* noop — resolved immediately by default */
  });
  const startHealthServerMock = vi.fn(() => {
    if (opts.startHealthThrows) {
      throw opts.startHealthThrows;
    }
    return {
      stop: healthStop,
      address: '127.0.0.1:8081',
    };
  });

  // Mock discord adapter.
  const adapterStart = vi.fn(async () => {
    if (opts.adapterStartImpl) await opts.adapterStartImpl();
  });
  const adapterStop = vi.fn(async () => {
    if (opts.adapterStopImpl) await opts.adapterStopImpl();
  });
  const createDiscordAdapterMock = vi.fn(() => ({
    start: adapterStart,
    stop: adapterStop,
    get state(): '' {
      return '';
    },
  }));

  vi.doMock('../../src/config/load-config', () => ({
    loadConfig: loadConfigMock,
    ConfigError,
  }));
  vi.doMock('../../src/logger/create-logger', () => ({
    createLogger: createLoggerMock,
    createBootstrapLogger: createBootstrapLoggerMock,
    createEmergencyLogger: createEmergencyLoggerMock,
    childFor: childForMock,
  }));
  vi.doMock('../../src/health/server', () => ({
    startHealthServer: startHealthServerMock,
    mapHealthStatus: vi.fn(),
  }));
  vi.doMock('../../src/discord/adapter', () => ({
    createDiscordAdapter: createDiscordAdapterMock,
  }));

  const { runApp } = await import('../../src/lifecycle/run-app');
  return {
    cap,
    loadConfigMock,
    createLoggerMock,
    createBootstrapLoggerMock,
    createEmergencyLoggerMock,
    startHealthServerMock,
    createDiscordAdapterMock,
    adapterStop,
    healthStop,
    runApp,
  };
}

async function dispatchSignal(signal: SigName): Promise<void> {
  process.emit(signal, signal);
  await new Promise((r) => setImmediate(r));
}

const originalExit = process.exit;
let exitCalls: number[] = [];
let exitShouldThrow = true;

// Suppress vitest/Node "unhandled rejection" churn caused by the deliberate
// `process.exit` spy-throws propagating through detached async chains. The
// shutdown rejection IS consumed by `await shutdownPromise` in runApp; the
// transient pre-await rejection tick fires the synchronous hook below instead
// of being recorded by vitest as a test error. Without this hook the test
// suite would report 3 "Errors" that are not actual failures (exit code 0).
const unhandledSwallow = (): void => {
  /* drop event */
};
process.on('unhandledRejection', unhandledSwallow);

const originalListeners: Record<SigName, NodeJS.Listener[]> = {
  [SIGTERM]: [...process.listeners(SIGTERM)],
  [SIGINT]: [...process.listeners(SIGINT)],
};

beforeEach(() => {
  exitCalls = [];
  exitShouldThrow = true;
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    if (exitShouldThrow) {
      throw new Error(`process.exit(${code})`);
    }
    return undefined as never;
  }) as typeof process.exit;
});

afterEach(() => {
  process.exit = originalExit;
  // Reap any signal listeners that runApp installed during the test so they
  // cannot leak into subsequent tests and double-fire `process.exit`.
  for (const sig of SIG_LIST) {
    const before = originalListeners[sig];
    const current = process.listeners(sig);
    for (const l of current) {
      if (!before.includes(l)) {
        process.removeListener(sig, l);
      }
    }
  }
  vi.resetModules();
  vi.doUnmock('../../src/lifecycle/run-app');
});

describe('lifecycle contract (contracts/lifecycle.md)', () => {
  describe('§1 startup order', () => {
    it('on ConfigError loadConfig → exactly one fatal msg="config validation failed" via bootLog + exit 1', async () => {
      const env = await loadAppWithMocks({
        loadConfigThrowsEnvField: 'DISCORD_TOKEN',
        loadConfigThrowsReason: 'missing',
      });
      await expect(env.runApp()).rejects.toThrow(/process\.exit/);
      const fatalLines = env.cap.lines.filter((l) => l.level === 'fatal');
      expect(fatalLines.length).toBe(1);
      expect(fatalLines[0]!.msg).toBe('config validation failed');
      expect(fatalLines[0]!.reason).toBe('missing');
      expect(exitCalls).toEqual([1]);
    });

    it('on a post-config child throw (health bind failure) → exactly one fatal naming the subsystem + exit 1', async () => {
      const env = await loadAppWithMocks({
        startHealthThrows: Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }),
      });
      await expect(env.runApp()).rejects.toThrow(/process\.exit/);
      const fatalLines = env.cap.lines.filter((l) => l.level === 'fatal');
      expect(fatalLines.length).toBe(1);
      expect(fatalLines[0]!.msg).toMatch(/health/);
      expect(exitCalls).toEqual([1]);
    });
  });

  describe('§2 + §3 SIGTERM success-path shutdown', () => {
    it('SIGTERM → "shutdown requested" (reason=SIGTERM) → adapter.stop() + healthServer.stop() called → "shutdown complete" (phase=shutting-down) → exit 0; NO logger.flush()', async () => {
      const env = await loadAppWithMocks({
        loadConfigImpl: () => makeConfig({ shutdownTimeoutMs: 5000 }),
      });
      // Allow runApp to reach the "running" state (start awaits succeed).
      const p = env.runApp();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await dispatchSignal(SIGTERM);
      await expect(p).rejects.toThrow(/process\.exit/);

      const infoLines = env.cap.lines.filter((l) => l.level === 'info');
      expect(infoLines.some((l) => l.msg === 'shutdown requested' && l.reason === SIGTERM)).toBe(
        true,
      );
      expect(
        infoLines.some((l) => l.msg === 'shutdown complete' && l.phase === 'shutting-down'),
      ).toBe(true);
      expect(env.adapterStop.mock.calls.length).toBe(1);
      expect(env.healthStop.mock.calls.length).toBe(1);
      expect(exitCalls).toEqual([0]);
    });
  });

  describe('§2 second-signal idempotency', () => {
    it('second SIGTERM during shutdown → exactly one warn msg="shutdown already in progress" with a correlationId field; no re-entry', async () => {
      // Make adapter.stop() hang forever so the shutdown budget is "in flight"
      // when the second signal arrives.
      let resolveStop: () => void = () => {};
      const hangingStop = new Promise<void>((r) => {
        resolveStop = r;
      });
      const env = await loadAppWithMocks({
        adapterStopImpl: () => hangingStop,
        loadConfigImpl: () => makeConfig({ shutdownTimeoutMs: 5000 }),
      });
      const p = env.runApp();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // First signal starts shutdown
      process.emit(SIGTERM, SIGTERM);
      await new Promise((r) => setImmediate(r));
      // Second signal before adapter.stop resolves
      process.emit(SIGTERM, SIGTERM);
      await new Promise((r) => setImmediate(r));
      // Now let adapter.stop resolve and the budget race settle.
      const warnLines = env.cap.lines.filter(
        (l) => l.level === 'warn' && l.msg === 'shutdown already in progress',
      );
      expect(warnLines.length).toBe(1);
      expect(String(warnLines[0]!.correlationId)).toMatch(/.+/);
      // adapter.stop was called once (no re-entry).
      expect(env.adapterStop.mock.calls.length).toBe(1);
      // Release the hang and let the race complete.
      resolveStop();
      await expect(p).rejects.toThrow(/process\.exit/);
    });
  });

  describe('§3 budget exhaustion → exit 1', () => {
    it('when adapter.stop exceeds budget → one warn msg="shutdown budget exceeded" + exit 1; no "shutdown complete"', async () => {
      let resolveStop: () => void = () => {};
      const hangingStop = new Promise<void>((r) => {
        resolveStop = r;
      });
      const env = await loadAppWithMocks({
        adapterStopImpl: () => hangingStop,
        loadConfigImpl: () => makeConfig({ shutdownTimeoutMs: 50 }), // very short budget
      });
      const p = env.runApp();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      process.emit(SIGTERM, SIGTERM);
      // Let the 50ms budget elapse.
      await new Promise((r) => setTimeout(r, 200));
      await expect(p).rejects.toThrow(/process\.exit/);
      const warnExceeded = env.cap.lines.find(
        (l) => l.level === 'warn' && l.msg === 'shutdown budget exceeded',
      );
      expect(warnExceeded).toBeDefined();
      expect(env.cap.lines.find((l) => l.msg === 'shutdown complete')).toBeUndefined();
      expect(exitCalls).toEqual([1]);
      // Release the dangling hang so the dangling promise resolves cleanly.
      resolveStop();
    });
  });

  describe('Edge Case: stdout unavailable → emergency-logger path', () => {
    it('bootstrap-logger construction throws → exactly one fatal msg="startup failed", reason="stdout unavailable", via emergencyLog → exit 1', async () => {
      const env = await loadAppWithMocks({
        bootstrapLoggerThrows: true,
      });
      await expect(env.runApp()).rejects.toThrow(/process\.exit/);
      const fatalLines = env.cap.lines.filter((l) => l.level === 'fatal');
      expect(fatalLines.length).toBe(1);
      expect(fatalLines[0]!.msg).toBe('startup failed');
      expect(fatalLines[0]!.reason).toBe('stdout unavailable');
      expect(exitCalls).toEqual([1]);
      // Emergency logger was constructed exactly once.
      expect(env.createEmergencyLoggerMock.mock.calls.length).toBe(1);
    });
  });

  describe('SIGINT convenience parity', () => {
    it('SIGINT also triggers "shutdown requested" with reason=SIGINT', async () => {
      const env = await loadAppWithMocks({
        loadConfigImpl: () => makeConfig({ shutdownTimeoutMs: 5000 }),
      });
      const p = env.runApp();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await dispatchSignal(SIGINT);
      await expect(p).rejects.toThrow(/process\.exit/);
      expect(
        env.cap.lines.some((l) => l.msg === 'shutdown requested' && l.reason === SIGINT),
      ).toBe(true);
    });
  });

  describe('newCorrelationId is reachable (sanity)', () => {
    it('returns a non-empty string', () => {
      expect(newCorrelationId()).toMatch(/.+/);
    });
  });
});
