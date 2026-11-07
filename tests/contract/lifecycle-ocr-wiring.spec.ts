import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemCategorizer } from '../../src/categorizer/types';
import type { OcrProvider } from '../../src/ocr/types';
import type { Config, TracingConfig } from '../../src/shared/types';
import { makeConfig } from '../helpers/config-fixture';
import { makeCapturingLogger } from '../helpers/logger';

// Wiring contract: the composition root picks the OCR provider and the list
// categorizer from config and fails startup when either cannot be constructed.

const gvProviderSentinel: OcrProvider = { id: 'gcp-vision', recognize: vi.fn() };
const disabledProviderSentinel: OcrProvider = { id: 'disabled', recognize: vi.fn() };
const categorizerSentinel: ItemCategorizer = { id: 'anthropic:m', categorize: vi.fn() };
class SentinelHandler extends BaseCallbackHandler {
  name = 'tracer-sentinel';
}
const callbacksSentinel: BaseCallbackHandler[] = [new SentinelHandler()];

/**
 * Imports run-app with every collaborator mocked, so a test can drive runApp and
 * inspect which provider factory ran and what the handler and adapter received.
 * @param opts providerConstructionThrows / categorizerConstructionThrows make that factory throw
 */
async function loadAppWithMocks(opts: {
  config?: Config;
  providerConstructionThrows?: boolean;
  categorizerConstructionThrows?: boolean;
}) {
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
  const createAgentCategorizerMock = vi.fn(async (_opts: unknown): Promise<ItemCategorizer> => {
    if (opts.categorizerConstructionThrows) {
      throw new Error('unknown model provider');
    }
    return categorizerSentinel;
  });
  const createTracerMock = vi.fn((_config: TracingConfig) => ({
    callbacks: callbacksSentinel,
    flush: vi.fn(async () => undefined),
  }));
  const createListSubmissionHandlerMock = vi.fn(
    (_deps: {
      provider: OcrProvider;
      languageHints: readonly string[];
      categorizer: ItemCategorizer | null;
      callbacks: BaseCallbackHandler[];
    }) =>
      async () => ({
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
  vi.doMock('../../src/tracing/create-tracer', () => ({
    createTracer: createTracerMock,
  }));
  vi.doMock('../../src/categorizer/agent-categorizer', () => ({
    createAgentCategorizer: createAgentCategorizerMock,
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
    createAgentCategorizerMock,
    createTracerMock,
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

describe('categorizer wiring in the composition root', () => {
  it('sorting none → the handler gets no categorizer and no model is built', async () => {
    const env = await loadAppWithMocks({ config: makeConfig({ sorting: { kind: 'none' } }) });
    void env.runApp();
    await vi.waitFor(() => expect(env.createListSubmissionHandlerMock).toHaveBeenCalled());

    expect(env.createAgentCategorizerMock).not.toHaveBeenCalled();
    expect(env.createListSubmissionHandlerMock.mock.calls[0][0].categorizer).toBeNull();
    expect(env.cap.lines).toContainEqual(expect.objectContaining({ msg: 'sorting disabled' }));
  });

  it('sorting anthropic → the categorizer is built from the configured model, key and base URL', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({
        sorting: {
          kind: 'anthropic',
          model: 'anthropic:m',
          apiKey: 'sk-x',
          baseUrl: 'https://opencode.ai/inference/anthropic',
        },
      }),
    });
    void env.runApp();
    await vi.waitFor(() => expect(env.createListSubmissionHandlerMock).toHaveBeenCalled());

    expect(env.createAgentCategorizerMock).toHaveBeenCalledWith({
      model: 'anthropic:m',
      apiKey: 'sk-x',
      baseUrl: 'https://opencode.ai/inference/anthropic',
    });
    expect(env.createListSubmissionHandlerMock.mock.calls[0][0].categorizer).toBe(
      categorizerSentinel,
    );
    expect(env.cap.lines).toContainEqual(
      expect.objectContaining({ msg: 'sorting enabled', categorizerId: 'anthropic:m' }),
    );
    expect(JSON.stringify(env.cap.lines)).not.toContain('sk-x');
  });

  it('categorizer construction failure → one fatal naming the subsystem + exit 1', async () => {
    const env = await loadAppWithMocks({
      config: makeConfig({
        sorting: { kind: 'anthropic', model: 'anthropic:m', apiKey: 'k', baseUrl: null },
      }),
      categorizerConstructionThrows: true,
    });
    await expect(env.runApp()).rejects.toThrow(/process\.exit/);

    const fatalLines = env.cap.lines.filter((l) => l.level === 'fatal');
    expect(fatalLines).toHaveLength(1);
    expect(String(fatalLines[0].msg)).toMatch(/categorizer/i);
    expect(exitCalls).toEqual([1]);
    expect(env.createDiscordAdapterMock).not.toHaveBeenCalled();
  });
});

describe('tracer wiring in the composition root', () => {
  it.each([
    [
      { kind: 'langsmith', apiKey: 'ls-x', project: 'p' },
      { level: 'info', msg: 'tracing enabled', project: 'p' },
    ],
    [
      { kind: 'off', reason: 'missing-key' },
      { level: 'warn', msg: 'tracing disabled', reason: 'missing-key' },
    ],
    [
      { kind: 'off', reason: 'disabled' },
      { level: 'info', msg: 'tracing disabled', reason: 'disabled' },
    ],
  ] as const)(
    'tracing %j → tracer built from it, its callbacks reach the handler, one status line',
    async (tracing, line) => {
      const env = await loadAppWithMocks({ config: makeConfig({ tracing }) });
      void env.runApp();
      await vi.waitFor(() => expect(env.createListSubmissionHandlerMock).toHaveBeenCalled());

      expect(env.createTracerMock).toHaveBeenCalledWith(tracing);
      expect(env.createListSubmissionHandlerMock.mock.calls[0][0].callbacks).toBe(
        callbacksSentinel,
      );
      const tracingLines = env.cap.lines.filter((l) => String(l.msg).startsWith('tracing '));
      expect(tracingLines).toEqual([expect.objectContaining(line)]);
      expect(JSON.stringify(env.cap.lines)).not.toContain('ls-x');
    },
  );
});
