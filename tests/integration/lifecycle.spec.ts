import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drives the real lifecycle composition (runApp) with the real config
// validator, real logger, and real health server; only the Discord transport
// module is stubbed so no gateway connection is needed. Verifies the running
// bot serves a live health endpoint reporting phase "running", that child
// stop() calls happen at shutdown rather than during startup, and that a
// SIGTERM produces a clean exit 0.

const HOST = '127.0.0.1';
const PORT = 18200;

// Suppress unhandled-rejection churn from the deliberate `process.exit`
// spy-throw propagating through the detached shutdown chain when a test
// fails before awaiting runApp's promise. The rejection IS consumed by
// runApp's internal pre-attached catch; this hook only silences the
// transient warning tick for the unobserved outer promise.
process.on('unhandledRejection', () => undefined);

const SIG_LIST = ['SIGTERM', 'SIGINT'] as const;

const originalExit = process.exit;
const originalListeners: Record<(typeof SIG_LIST)[number], NodeJS.SignalsListener[]> = {
  SIGTERM: [...process.listeners('SIGTERM')],
  SIGINT: [...process.listeners('SIGINT')],
};

const ENV_OVERRIDES: Record<string, string> = {
  DISCORD_TOKEN: 'integration-test-token',
  LOG_LEVEL: 'fatal', // silence real logger output in the test console
  COMMAND_PREFIX: '!',
  ECHO_COMMAND_NAME: 'echo',
  ECHO_MAX_LENGTH: '1900',
  SHUTDOWN_TIMEOUT_MS: '5000',
  HEALTH_HOST: HOST,
  HEALTH_PORT: String(PORT),
};
const savedEnv: Record<string, string | undefined> = {};

let exitCalls: number[] = [];

beforeEach(() => {
  exitCalls = [];
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  };
  for (const [key, value] of Object.entries(ENV_OVERRIDES)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterEach(async () => {
  // Best-effort: drive shutdown if the test body did not, so the real health
  // server releases its port before the worker moves on.
  process.emit('SIGTERM', 'SIGTERM');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  process.exit = originalExit;
  for (const sig of SIG_LIST) {
    for (const l of process.listeners(sig)) {
      if (!originalListeners[sig].includes(l)) {
        process.removeListener(sig, l);
      }
    }
  }
  vi.resetModules();
  vi.doUnmock('../../src/discord/adapter');
  for (const key of Object.keys(ENV_OVERRIDES)) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

function healthGet(): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: HOST, port: PORT, path: '/healthz', timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('health request timed out')));
  });
}

describe('integration: runApp end-to-end (stubbed transport)', () => {
  it('serves a live health endpoint reporting phase "running" while the bot runs; children stop only at shutdown; SIGTERM exits 0', async () => {
    const adapterStart = vi.fn(async () => undefined);
    const adapterStop = vi.fn(async () => undefined);
    vi.doMock('../../src/discord/adapter', () => ({
      // The stub never touches botState.discord, so the health mapper sees
      // "process running, Discord disconnected" — the degraded distinction.
      createDiscordAdapter: vi.fn(() => ({
        start: adapterStart,
        stop: adapterStop,
        get state(): string {
          return 'disconnected';
        },
      })),
    }));
    const { runApp } = await import('../../src/lifecycle/run-app.js');

    const p = runApp();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Startup completed: the transport was started exactly once…
    expect(adapterStart).toHaveBeenCalledTimes(1);
    // …and, critically, nothing was stopped during startup — the bot stays
    // live (health endpoint listening, message routing active).
    expect(adapterStop).not.toHaveBeenCalled();

    // The health endpoint is alive and distinguishes "process running,
    // Discord disconnected" while the process phase reports "running".
    const r = await healthGet();
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.status).toBe('degraded');
    expect(body.phase).toBe('running');
    expect(body.discord).toBe('disconnected');

    // Graceful shutdown: SIGTERM stops each child exactly once and exits 0.
    process.emit('SIGTERM', 'SIGTERM');
    await expect(p).rejects.toThrow(/process\.exit/);
    expect(adapterStop).toHaveBeenCalledTimes(1);
    expect(exitCalls).toEqual([0]);
  });
});
