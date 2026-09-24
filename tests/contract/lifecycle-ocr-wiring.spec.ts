import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrProvider } from '../../src/ocr/types';
import type { Config } from '../../src/shared/types';
import { makeConfig } from '../helpers/config-fixture';
import { makeCapturingLogger } from '../helpers/logger';

// Wiring contract: the composition root picks the OCR provider from config and
// fails startup when the chosen provider cannot be constructed.

const gvProviderSentinel: OcrProvider = { id: 'gcp-vision', recognize: vi.fn() };
const disabledProviderSentinel: OcrProvider = { id: 'disabled', recognize: vi.fn() };

/**
 * Imports run-app with every collaborator mocked, so a test can drive runApp and
 * inspect which provider factory ran and what the handler and adapter received.
 * @param opts providerConstructionThrows makes the Vision provider factory throw like a bad key path
 */
async function loadAppWithMocks(opts: { config?: Config; providerConstructionThrows?: boolean }) {
  const cap = makeCapturingLogger();

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

  const loadConfigMock = vi.fn((): Config => opts.config ?? makeConfig());
  const createLoggerMock = vi.fn(() => cap.logger);
  const createBootstrapLoggerMock = vi.fn(() => cap.logger);
  const createEmergencyLoggerMock = vi.fn(() => cap.logger);
  const childForMock = vi.fn((_l: unknown, correlationId: string) => cap.child({ correlationId }));
  const startHealthServerMock = vi.fn(() => ({
    stop: vi.fn(async () => undefined),
    address: '127.0.0.1:8081',
  }));
  const createDiscordAdapterMock = vi.fn(() => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    get state(): '' {
      return '';
    },
  }));
  const createGoogleVisionProviderMock = vi.fn((_deps: { keyFilePath: string }): OcrProvider => {
    if (opts.providerConstructionThrows) {
      throw new Error('GCP_SA_KEY_PATH does not point to a readable key file');
    }
    return gvProviderSentinel;
  });
  const createDisabledProviderMock = vi.fn((): OcrProvider => disabledProviderSentinel);
  const createListSubmissionHandlerMock = vi.fn(
    (_deps: { provider: OcrProvider; languageHints: readonly string[] }) => async () => ({
      text: '',
    }),
  );

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
  vi.doMock('../../src/ocr/google-vision/provider', () => ({
    createGoogleVisionProvider: createGoogleVisionProviderMock,
  }));
  vi.doMock('../../src/ocr/disabled-provider', () => ({
    createDisabledProvider: createDisabledProviderMock,
  }));
  vi.doMock('../../src/shopping-list/handle-list-submission', () => ({
    createListSubmissionHandler: createListSubmissionHandlerMock,
  }));

  const { runApp } = await import('../../src/lifecycle/run-app.js');
  return {
    cap,
    runApp,
    createGoogleVisionProviderMock,
    createDisabledProviderMock,
    createListSubmissionHandlerMock,
    createDiscordAdapterMock,
  };
}

const SIG_LIST = ['SIGTERM', 'SIGINT'] as const;
const originalExit = process.exit;
let exitCalls: number[] = [];

const originalListeners: Record<string, Array<(signal: NodeJS.Signals) => void>> = {
  SIGTERM: [...process.listeners('SIGTERM')],
  SIGINT: [...process.listeners('SIGINT')],
};

beforeEach(() => {
  exitCalls = [];
  process.exit = (code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`process.exit(${code})`);
  };
});

afterEach(() => {
  process.exit = originalExit;
  for (const sig of SIG_LIST) {
    const before = originalListeners[sig];
    for (const l of process.listeners(sig)) {
      if (!before.includes(l)) {
        process.removeListener(sig, l);
      }
    }
  }
  vi.resetModules();
});

describe('OCR wiring in the composition root', () => {
  it('OCR_PROVIDER=gcp-vision → provider built via createGoogleVisionProvider with the configured key path; the handler gets the configured language hints', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({
        ocrProvider: { kind: 'gcp-vision', keyFilePath: '/etc/empty-cart/gcv-key.json' },
        ocrLanguageHints: ['pl'],
      }),
    });
    void env.runApp();
    await vi.waitFor(() => expect(env.createListSubmissionHandlerMock).toHaveBeenCalled());

    expect(env.createGoogleVisionProviderMock).toHaveBeenCalledTimes(1);
    expect(env.createGoogleVisionProviderMock).toHaveBeenCalledWith({
      keyFilePath: '/etc/empty-cart/gcv-key.json',
    });
    expect(env.createDisabledProviderMock).not.toHaveBeenCalled();

    const deps = env.createListSubmissionHandlerMock.mock.calls[0][0];
    expect(deps.provider).toBe(gvProviderSentinel);
    // A dropped hint degrades recognition silently, so the pass-through is pinned.
    expect(deps.languageHints).toEqual(['pl']);
  });

  it('OCR_PROVIDER=none → createDisabledProvider, no google-vision construction', async () => {
    const env = await loadAppWithMocks({ config: makeConfig({ ocrProvider: { kind: 'none' } }) });
    void env.runApp();
    await vi.waitFor(() => expect(env.createListSubmissionHandlerMock).toHaveBeenCalled());

    expect(env.createDisabledProviderMock).toHaveBeenCalledTimes(1);
    expect(env.createGoogleVisionProviderMock).not.toHaveBeenCalled();
    const deps = env.createListSubmissionHandlerMock.mock.calls[0][0];
    expect(deps.provider).toBe(disabledProviderSentinel);
  });

  it('provider construction failure (bad key path) → exactly one fatal naming the subsystem + exit 1, adapter never constructed', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({
        ocrProvider: { kind: 'gcp-vision', keyFilePath: '/nonexistent/key.json' },
      }),
      providerConstructionThrows: true,
    });
    await expect(env.runApp()).rejects.toThrow(/process\.exit/);

    const fatalLines = env.cap.lines.filter((l) => l.level === 'fatal');
    expect(fatalLines).toHaveLength(1);
    expect(String(fatalLines[0].msg)).toMatch(/ocr provider/i);
    expect(String(fatalLines[0].msg)).toContain('GCP_SA_KEY_PATH');
    expect(exitCalls).toEqual([1]);
    expect(env.createDiscordAdapterMock).not.toHaveBeenCalled();
  });
});
