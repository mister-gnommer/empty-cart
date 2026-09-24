import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrProvider, OcrProviderResult } from '../../src/ocr/types';
import type { Config } from '../../src/shared/types';
import { makeCapturingLogger } from '../helpers/logger';

// Wiring contract: the composition root selects the provider from config,
// builds the list-submission handler with the real image downloader and the
// configured language hints, and hands the adapter the constructed handler
// plus the pre-interpolated usage hint.

const DEFAULT_CONFIG: Config = {
  discordToken: 'tok',
  logLevel: 'info',
  commandPrefix: '!',
  echoCommandName: 'echo',
  echoMaxLength: 1900,
  shutdownTimeoutMs: 5000,
  healthHost: '127.0.0.1',
  healthPort: 8081,
  ocrProvider: 'none',
  gcpSaKeyPath: null,
  ocrLanguageHints: ['en', 'de'],
  ocrChannelAllowlist: null,
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides };
}

const gvProviderSentinel: OcrProvider = {
  id: 'gcp-vision',
  recognize: async (): Promise<OcrProviderResult> => ({
    status: 'unavailable',
    cause: 'provider-error',
  }),
};

const disabledProviderSentinel: OcrProvider = {
  id: 'disabled',
  recognize: async (): Promise<OcrProviderResult> => ({
    status: 'unavailable',
    cause: 'disabled',
  }),
};

const handlerSentinel = async (): Promise<{ text: string }> => ({ text: '' });

type ListHandlerDeps = {
  provider: OcrProvider;
  fetchImage: unknown;
  languageHints: readonly string[];
  logger: unknown;
  now?: () => number;
};

type AdapterDepsLike = {
  listSubmission: unknown;
  usageHint: string;
};

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
  const childForMock = vi.fn((l: unknown, correlationId: string) => {
    void l;
    return cap.child({ correlationId });
  });
  const startHealthServerMock = vi.fn(() => ({
    stop: vi.fn(async () => undefined),
    address: '127.0.0.1:8081',
  }));
  const createDiscordAdapterMock = vi.fn((_deps: AdapterDepsLike) => ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    get state(): '' {
      return '';
    },
  }));
  const createGoogleVisionProviderMock = vi.fn((_deps: { keyFile: string }): OcrProvider => {
    if (opts.providerConstructionThrows) {
      throw new Error('GCP_SA_KEY_PATH does not point to a readable key file');
    }
    return gvProviderSentinel;
  });
  const createDisabledProviderMock = vi.fn((): OcrProvider => disabledProviderSentinel);
  const createListSubmissionHandlerMock = vi.fn((_deps: ListHandlerDeps) => handlerSentinel);

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
  vi.doMock('../../src/google-vision/provider', () => ({
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

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setImmediate(r));
  }
}

const SIG_LIST = ['SIGTERM', 'SIGINT'] as const;
const originalExit = process.exit;
let exitCalls: number[] = [];

// Suppress unhandled-rejection churn from the deliberate process.exit
// spy-throws propagating through detached async chains (001 lifecycle-suite
// pattern).
const unhandledSwallow = (): void => {
  /* drop event */
};
process.on('unhandledRejection', unhandledSwallow);

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
  vi.doUnmock('../../src/lifecycle/run-app');
});

describe('OCR wiring in the composition root', () => {
  it('OCR_PROVIDER=gcp-vision → provider built via createGoogleVisionProvider with the configured key path', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({
        ocrProvider: 'gcp-vision',
        gcpSaKeyPath: '/etc/empty-cart/gcv-key.json',
      }),
    });
    void env.runApp();
    await settle();

    expect(env.createGoogleVisionProviderMock).toHaveBeenCalledTimes(1);
    expect(env.createGoogleVisionProviderMock).toHaveBeenCalledWith({
      keyFile: '/etc/empty-cart/gcv-key.json',
    });
    expect(env.createDisabledProviderMock).not.toHaveBeenCalled();

    const deps = env.createListSubmissionHandlerMock.mock.calls[0][0];
    expect(deps.provider).toBe(gvProviderSentinel);
  });

  it('OCR_PROVIDER=none → createDisabledProvider, no google-vision construction', async () => {
    const env = await loadAppWithMocks({ config: makeConfig({ ocrProvider: 'none' }) });
    void env.runApp();
    await settle();

    expect(env.createDisabledProviderMock).toHaveBeenCalledTimes(1);
    expect(env.createGoogleVisionProviderMock).not.toHaveBeenCalled();
    const deps = env.createListSubmissionHandlerMock.mock.calls[0][0];
    expect(deps.provider).toBe(disabledProviderSentinel);
  });

  it('a default (recognition-disabled) config wires the disabled provider', async () => {
    const env = await loadAppWithMocks({ config: makeConfig() });
    void env.runApp();
    await settle();

    expect(env.createDisabledProviderMock).toHaveBeenCalledTimes(1);
    expect(env.createGoogleVisionProviderMock).not.toHaveBeenCalled();
  });

  it('the handler receives the configured language hints, the REAL image downloader, a clock, and the validated logger', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({ ocrLanguageHints: ['en', 'en-t-i0-handwrit'] }),
    });
    void env.runApp();
    await settle();

    const { fetchAndValidateImage } = await import('../../src/image/fetch-image.js');
    const deps = env.createListSubmissionHandlerMock.mock.calls[0][0];
    expect(deps.languageHints).toEqual(['en', 'en-t-i0-handwrit']);
    expect(deps.fetchImage).toBe(fetchAndValidateImage);
    expect(typeof deps.now).toBe('function');
    expect(deps.logger).toBe(env.cap.logger);
  });

  it('the adapter receives the constructed handler and the usage hint pre-interpolated from the command prefix', async () => {
    const env = await loadAppWithMocks({ config: makeConfig({ commandPrefix: '??' }) });
    void env.runApp();
    await settle();

    const { usageHintMessage } = await import('../../src/shopping-list/messages.js');
    const adapterDeps = env.createDiscordAdapterMock.mock.calls[0][0];
    expect(adapterDeps.listSubmission).toBe(handlerSentinel);
    expect(adapterDeps.usageHint).toBe(usageHintMessage('??'));
  });

  it('provider construction failure (bad key path) → exactly one fatal naming the subsystem + exit 1, adapter never constructed', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({
        ocrProvider: 'gcp-vision',
        gcpSaKeyPath: '/nonexistent/key.json',
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
