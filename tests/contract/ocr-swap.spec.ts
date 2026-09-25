import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscordAdapter } from '../../src/discord/adapter';
import { handleEchoCommand } from '../../src/echo/handle-echo';
import { fetchAndValidateImage, MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import type { OcrProvider, OcrProviderResult, UnavailableCause } from '../../src/ocr/types';
import type { BotState, Config } from '../../src/shared/types';
import { createListSubmissionHandler } from '../../src/shopping-list/handle-list-submission';
import { LIST_MESSAGES, usageHintMessage } from '../../src/shopping-list/messages';
import { makeCapturingLogger } from '../helpers/logger';
import { createScriptedFetch, type ScriptedFetchEntry } from '../helpers/scripted-fetch';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
  undecodableResult,
  unavailableResult,
} from '../helpers/stub-ocr-provider';
import { emitMessage, makeStubbedClient } from '../helpers/stubbed-client';

// Provider swap guarantee: the active OCR provider is replaceable by a new
// module honoring the OcrProvider contract, with no change to image
// detection, ordering, or reply posting. Two parts:
//  1. Behavior parity — the full user-facing flow (real adapter + real
//     handler + real image validator) is driven through two independently
//     written OcrProvider implementations and must yield byte-identical
//     replies, all with zero external calls.
//  2. Static import scan — the vendor SDK stays confined to its own module
//     and no list-handling module knows which provider is active.

const SRC_ROOT = resolve(__dirname, '../../src');

const baseConfig: Config = {
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
  ocrLanguageHints: [],
  ocrChannelAllowlist: null,
};

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);
const EMPTY_MENTIONS = { parse: [], users: [], roles: [] };

type RecordingProvider = OcrProvider & { readonly callCount: () => number };
type ProviderFactory = (script: readonly StubScriptEntry[]) => RecordingProvider;

/**
 * A second, independently written provider standing in for "some other
 * vendor": a class with its own queue instead of the shared helper's closure.
 * If the flow's behavior depended on anything beyond the OcrProvider contract,
 * the two implementations would diverge.
 */
class QueueProvider implements OcrProvider {
  readonly id = 'alternate-vendor';
  private readonly queue: StubScriptEntry[];
  private calls = 0;

  constructor(script: readonly StubScriptEntry[]) {
    this.queue = [...script];
  }

  callCount(): number {
    return this.calls;
  }

  async recognize(): Promise<OcrProviderResult> {
    this.calls += 1;
    const entry = this.queue.shift();
    if (entry === undefined) {
      throw new Error('alternate provider: script exhausted');
    }
    return typeof entry === 'function' ? entry() : entry;
  }
}

const PROVIDERS: ReadonlyArray<[string, ProviderFactory]> = [
  [
    'shared stub provider',
    (script) => {
      const stub = createStubOcrProvider(script);
      return Object.freeze({
        id: stub.id,
        recognize: stub.recognize,
        callCount: () => stub.calls.length,
      });
    },
  ],
  ['independent alternate provider', (script) => new QueueProvider(script)],
];

type FakeAttachment = { url: string; proxyURL: string; size: number; contentType: string | null };

function attachment(url: string, contentType: string | null, size = 12): FakeAttachment {
  return { url, proxyURL: `https://media.proxy.test/proxy-of/${url}`, size, contentType };
}

function buildMessage(opts: { content?: string; attachments?: FakeAttachment[] }) {
  const send = vi.fn(async (..._args: unknown[]) => undefined);
  const raw = {
    author: { bot: false, id: 'user-1' },
    content: opts.content ?? '',
    guild: { id: 'guild-1' },
    channelId: 'chan-1',
    channel: { id: 'chan-1', send, isThread: () => false },
    attachments: new Map((opts.attachments ?? []).map((a, i) => [String(i), a])),
  };
  return { raw, send };
}

function buildEnv(
  factory: ProviderFactory,
  fetchEntries: ScriptedFetchEntry[],
  script: StubScriptEntry[],
) {
  const cap = makeCapturingLogger();
  const client = makeStubbedClient();
  const botState: BotState = {
    phase: 'running',
    discord: 'connected',
    startedAt: Date.now(),
    lastStateChangeAt: Date.now(),
  };
  const scriptedFetch = createScriptedFetch(fetchEntries);
  const provider = factory(script);
  const listSubmission = createListSubmissionHandler({
    provider,
    fetchImage: (fetchInput) => fetchAndValidateImage(fetchInput, scriptedFetch.fetchImpl),
    languageHints: baseConfig.ocrLanguageHints,
    // Safe: the capturing logger satisfies pino's Logger call surface
    // structurally; `as never` only bridges the nominal pino import.
    logger: cap.logger as never,
    now: Date.now,
  });
  const adapter = createDiscordAdapter({
    config: baseConfig,
    // Safe: same structural bridge as above.
    logger: cap.logger as never,
    botState,
    echo: handleEchoCommand,
    clientFactory: () => client,
    listSubmission,
    usageHint: usageHintMessage(baseConfig.commandPrefix),
  });
  return { adapter, client, provider, scriptedFetch };
}

function sentPayloads(
  send: ReturnType<typeof vi.fn>,
): Array<{ content: string; allowedMentions: unknown }> {
  return send.mock.calls.map((call) => {
    // Safe: send is the stubbed channel.send; its first argument is the
    // documented { content, allowedMentions } payload.
    return call[0] as { content: string; allowedMentions: unknown };
  });
}

type Scenario = {
  name: string;
  fetchEntries: ScriptedFetchEntry[];
  script: StubScriptEntry[];
  message: { content?: string; attachments?: FakeAttachment[] };
  expectedReplies: string[];
  expectedProviderCalls: number;
};

const PNG_ATTACHMENT = attachment('https://cdn.test/list.png', 'image/png');

const unavailableScenarios: Scenario[] = (
  [
    'unreachable',
    'unauthorized',
    'quota-exhausted',
    'provider-error',
    'deadline-exceeded',
    'disabled',
  ] satisfies UnavailableCause[]
).map((cause) => ({
  name: `provider unavailable (${cause}) → generic message`,
  fetchEntries: [{ body: { bytes: PNG_BYTES } }],
  script: [unavailableResult(cause)],
  message: { attachments: [PNG_ATTACHMENT] },
  expectedReplies: [LIST_MESSAGES.serviceUnavailable],
  expectedProviderCalls: 1,
}));

const SCENARIOS: Scenario[] = [
  {
    name: 'happy path → recognized text byte-for-byte',
    fetchEntries: [{ body: { bytes: PNG_BYTES } }],
    script: [okResult('Milk\nEggs\n@everyone Bread')],
    message: { attachments: [PNG_ATTACHMENT] },
    expectedReplies: ['Milk\nEggs\n@everyone Bread'],
    expectedProviderCalls: 1,
  },
  {
    name: 'two images → text in attachment order',
    fetchEntries: [{ body: { bytes: JPEG_BYTES } }, { body: { bytes: PNG_BYTES } }],
    script: [okResult('First page'), okResult('Second page')],
    message: {
      attachments: [
        attachment('https://cdn.test/one.jpg', 'image/jpeg'),
        attachment('https://cdn.test/two.png', 'image/png'),
      ],
    },
    expectedReplies: ['First page\nSecond page'],
    expectedProviderCalls: 2,
  },
  {
    name: 'blank recognition → no-readable-text message',
    fetchEntries: [{ body: { bytes: PNG_BYTES } }],
    script: [okResult('   ')],
    message: { attachments: [PNG_ATTACHMENT] },
    expectedReplies: [LIST_MESSAGES.noReadableText],
    expectedProviderCalls: 1,
  },
  {
    name: 'provider cannot decode the image → unsupported-format message',
    fetchEntries: [{ body: { bytes: PNG_BYTES } }],
    script: [undecodableResult()],
    message: { attachments: [PNG_ATTACHMENT] },
    expectedReplies: [LIST_MESSAGES.unsupportedFormat],
    expectedProviderCalls: 1,
  },
  {
    name: 'locally unsupported format → unsupported-format message, provider never called',
    fetchEntries: [],
    script: [],
    message: { attachments: [attachment('https://cdn.test/anim.gif', 'image/gif')] },
    expectedReplies: [LIST_MESSAGES.unsupportedFormat],
    expectedProviderCalls: 0,
  },
  {
    name: 'oversize image → too-large message, provider never called',
    fetchEntries: [],
    script: [],
    message: {
      attachments: [attachment('https://cdn.test/huge.png', 'image/png', MAX_IMAGE_BYTES + 1)],
    },
    expectedReplies: [LIST_MESSAGES.imageTooLarge],
    expectedProviderCalls: 0,
  },
  {
    name: 'attachment download fails → generic message, provider never called',
    fetchEntries: [{ status: 500 }],
    script: [],
    message: { attachments: [PNG_ATTACHMENT] },
    expectedReplies: [LIST_MESSAGES.serviceUnavailable],
    expectedProviderCalls: 0,
  },
  ...unavailableScenarios,
  {
    name: 'text-only message → usage hint',
    fetchEntries: [],
    script: [],
    message: { content: 'what should I buy?' },
    expectedReplies: [usageHintMessage('!')],
    expectedProviderCalls: 0,
  },
];

describe('provider swap: behavior parity with zero external calls', () => {
  // Any stray network access (anything bypassing the scripted fetch seam)
  // fails the test loudly instead of silently reaching a real service.
  const sabotagedFetch = vi.fn(() => Promise.reject(new Error('unexpected network access')));

  beforeEach(() => {
    sabotagedFetch.mockClear();
    vi.stubGlobal('fetch', sabotagedFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function runScenario(factory: ProviderFactory, scenario: Scenario) {
    const env = buildEnv(factory, scenario.fetchEntries, scenario.script);
    const msg = buildMessage(scenario.message);
    emitMessage(env.client, msg.raw);
    await vi.waitFor(() => expect(msg.send).toHaveBeenCalledTimes(scenario.expectedReplies.length));
    await env.adapter.stop();
    return {
      payloads: sentPayloads(msg.send),
      providerCalls: env.provider.callCount(),
      requestedUrls: env.scriptedFetch.requestedUrls,
    };
  }

  it.each(SCENARIOS)('$name', async (scenario) => {
    const outcomes = [];
    for (const [, factory] of PROVIDERS) {
      outcomes.push(await runScenario(factory, scenario));
    }

    for (const outcome of outcomes) {
      expect(outcome.payloads.map((p) => p.content)).toEqual(scenario.expectedReplies);
      for (const payload of outcome.payloads) {
        expect(payload.allowedMentions).toEqual(EMPTY_MENTIONS);
      }
      expect(outcome.providerCalls).toBe(scenario.expectedProviderCalls);
      // Every fetched url was scripted; the scripted seam rejects anything else.
      expect(outcome.requestedUrls).toHaveLength(scenario.fetchEntries.length);
    }
    // Swapping the provider changes nothing the user can observe.
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(sabotagedFetch).not.toHaveBeenCalled();
  });

  it.each(PROVIDERS)('busy rejection is identical with the %s', async (_name, factory) => {
    const gate = deferred<OcrProviderResult>();
    const env = buildEnv(
      factory,
      [{ body: { bytes: PNG_BYTES } }, { body: { bytes: PNG_BYTES } }],
      [() => gate.promise, okResult('never')],
    );
    const first = buildMessage({ attachments: [PNG_ATTACHMENT] });
    const second = buildMessage({ attachments: [PNG_ATTACHMENT] });

    emitMessage(env.client, first.raw);
    await vi.waitFor(() => expect(env.provider.callCount()).toBe(1));
    emitMessage(env.client, second.raw);
    await vi.waitFor(() => expect(second.send).toHaveBeenCalledTimes(1));
    expect(sentPayloads(second.send).map((p) => p.content)).toEqual([LIST_MESSAGES.busy]);

    gate.resolve(okResult('first list'));
    await vi.waitFor(() => expect(first.send).toHaveBeenCalledTimes(1));
    expect(sentPayloads(first.send).map((p) => p.content)).toEqual(['first list']);
    expect(env.provider.callCount()).toBe(1);
    expect(env.scriptedFetch.requestedUrls).toHaveLength(1);
    expect(sabotagedFetch).not.toHaveBeenCalled();
    await env.adapter.stop();
  });
});

// --- static import scan ----------------------------------------------------

const VENDOR_SDK = '@google-cloud/vision';
const VENDOR_MODULE_DIR = join(SRC_ROOT, 'google-vision');
const WIRING_DIR = join(SRC_ROOT, 'lifecycle');
// Modules that handle the list flow and must stay provider-agnostic.
const PROVIDER_AGNOSTIC_DIRS = ['shopping-list', 'image', 'discord', 'ocr'].map((d) =>
  join(SRC_ROOT, d),
);

// Static `from '…'`, side-effect `import '…'`, dynamic `import('…')`, and
// `require('…')` — multi-line import lists end in `from '…'`, so they match too.
const SPECIFIER_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function extractSpecifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER_PATTERN)].map((m) => m[1]);
}

function listTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listTs(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

type ImportEdge = { file: string; specifier: string; target: string };

/** Every import in src/, with relative specifiers resolved to absolute paths. */
function allImports(): ImportEdge[] {
  return listTs(SRC_ROOT).flatMap((file) =>
    extractSpecifiers(readFileSync(file, 'utf8')).map((specifier) => ({
      file,
      specifier,
      target: specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier,
    })),
  );
}

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function describeEdge(edge: ImportEdge): string {
  return `${relative(SRC_ROOT, edge.file)} imports '${edge.specifier}'`;
}

describe('provider swap: static import scan', () => {
  it('the import extractor recognizes every import form (guards against a vacuous pass)', () => {
    const sample = [
      "import { a } from './a';",
      'import {',
      '  b,',
      '  c,',
      "} from '../b';",
      "import type { T } from '@scope/pkg';",
      "import 'side-effect';",
      "const lazy = await import('./lazy');",
      "const legacy = require('legacy');",
    ].join('\n');
    expect(extractSpecifiers(sample)).toEqual([
      './a',
      '../b',
      '@scope/pkg',
      'side-effect',
      './lazy',
      'legacy',
    ]);
  });

  it('the scanned module trees exist and contain sources', () => {
    for (const dir of [VENDOR_MODULE_DIR, WIRING_DIR, ...PROVIDER_AGNOSTIC_DIRS]) {
      expect(listTs(dir).length, relative(SRC_ROOT, dir)).toBeGreaterThan(0);
    }
  });

  it(`${VENDOR_SDK} is imported only under src/google-vision/`, () => {
    const edges = allImports().filter((e) => e.specifier.startsWith(VENDOR_SDK));
    expect(edges.length).toBeGreaterThan(0);
    const offenders = edges.filter((e) => !isUnder(e.file, VENDOR_MODULE_DIR)).map(describeEdge);
    expect(offenders).toEqual([]);
  });

  it('list-handling modules never import the vendor module or the vendor SDK', () => {
    const offenders = allImports()
      .filter((e) => PROVIDER_AGNOSTIC_DIRS.some((dir) => isUnder(e.file, dir)))
      .filter((e) => isUnder(e.target, VENDOR_MODULE_DIR) || e.specifier.startsWith(VENDOR_SDK))
      .map(describeEdge);
    expect(offenders).toEqual([]);
  });

  it('list-handling modules do not name the active provider anywhere', () => {
    const offenders: string[] = [];
    for (const dir of PROVIDER_AGNOSTIC_DIRS) {
      for (const file of listTs(dir)) {
        if (/gcp-vision|google/i.test(readFileSync(file, 'utf8'))) {
          offenders.push(relative(SRC_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the lifecycle wiring is the only importer of the vendor module', () => {
    const importers = allImports()
      .filter((e) => isUnder(e.target, VENDOR_MODULE_DIR) && !isUnder(e.file, VENDOR_MODULE_DIR))
      .map((e) => relative(SRC_ROOT, e.file));
    expect([...new Set(importers)]).toEqual(['lifecycle/run-app.ts']);
  });

  it('the vendor module depends on nothing but the provider contract among project modules', () => {
    const offenders = allImports()
      .filter((e) => isUnder(e.file, VENDOR_MODULE_DIR) && e.specifier.startsWith('.'))
      .filter((e) => !isUnder(e.target, VENDOR_MODULE_DIR))
      .filter((e) => e.target !== join(SRC_ROOT, 'ocr/types'))
      .map(describeEdge);
    expect(offenders).toEqual([]);
  });
});
