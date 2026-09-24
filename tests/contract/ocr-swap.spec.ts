import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrProvider, OcrProviderResult } from '../../src/ocr/types';
import { LIST_MESSAGES } from '../../src/shopping-list/messages';
import { PNG_BYTES } from '../helpers/image-fixtures';
import {
  attachment,
  buildListFlowEnv,
  buildMessage,
  EMPTY_MENTIONS,
  type FakeAttachment,
  sentPayloads,
} from '../helpers/list-flow-env';
import type { ScriptedFetchEntry } from '../helpers/scripted-fetch';
import {
  createStubOcrProvider,
  okResult,
  type StubScriptEntry,
  unavailableResult,
} from '../helpers/stub-ocr-provider';
import { emitMessage } from '../helpers/stubbed-client';

// Provider swap guarantee: the active OCR provider is replaceable by a new
// module honoring the OcrProvider contract, with no change to image
// detection, ordering, or reply posting. Two parts:
//  1. Behavior parity — the full user-facing flow (real adapter + real
//     handler + real image validator) is driven through two independently
//     written OcrProvider implementations and must yield byte-identical
//     replies, all with zero external calls.
//  2. Static import scan — the vendor module stays confined behind the wiring
//     and no list-handling module knows which provider is active.

const SRC_ROOT = resolve(__dirname, '../../src');

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

type Scenario = {
  name: string;
  fetchEntries: ScriptedFetchEntry[];
  script: StubScriptEntry[];
  message: { content?: string; attachments?: FakeAttachment[] };
  expectedReplies: string[];
  expectedProviderCalls: number;
};

const PNG_ATTACHMENT = attachment('https://cdn.test/list.png', 'image/png');

// One success and one failure: the per-outcome replies are covered by the
// integration suites; this only proves a second provider changes none of them.
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
    name: 'provider unavailable → generic message',
    fetchEntries: [{ body: { bytes: PNG_BYTES } }],
    script: [unavailableResult('unreachable')],
    message: { attachments: [PNG_ATTACHMENT] },
    expectedReplies: [LIST_MESSAGES.serviceUnavailable],
    expectedProviderCalls: 1,
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

  /** Runs one scenario through the real list flow over the given provider. */
  async function runScenario(factory: ProviderFactory, scenario: Scenario) {
    const provider = factory(scenario.script);
    const env = buildListFlowEnv({ provider, fetchEntries: scenario.fetchEntries });
    try {
      const msg = buildMessage(scenario.message);
      emitMessage(env.client, msg.raw);
      await vi.waitFor(() =>
        expect(msg.send).toHaveBeenCalledTimes(scenario.expectedReplies.length),
      );
      return {
        payloads: sentPayloads(msg.send),
        providerCalls: provider.callCount(),
        requestedUrls: env.scriptedFetch.requestedUrls,
      };
    } finally {
      await env.adapter.stop();
    }
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
});

// --- static import scan ----------------------------------------------------

const VENDOR_MODULE_DIR = join(SRC_ROOT, 'ocr', 'google-vision');
const WIRING_DIR = join(SRC_ROOT, 'lifecycle');
// Modules that handle the list flow and must stay provider-agnostic. `ocr` holds
// the provider implementations as subdirectories, which are carved out below.
const PROVIDER_AGNOSTIC_DIRS = ['shopping-list', 'image', 'discord', 'ocr'].map((d) =>
  join(SRC_ROOT, d),
);

function isProviderAgnostic(file: string): boolean {
  return (
    !isUnder(file, VENDOR_MODULE_DIR) && PROVIDER_AGNOSTIC_DIRS.some((dir) => isUnder(file, dir))
  );
}

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

  // The vendor SDK itself is fenced off by the lint import boundaries; this
  // covers the relative imports those boundaries cannot express.
  it('list-handling modules never import the vendor module', () => {
    const offenders = allImports()
      .filter((e) => isProviderAgnostic(e.file))
      .filter((e) => isUnder(e.target, VENDOR_MODULE_DIR))
      .map(describeEdge);
    expect(offenders).toEqual([]);
  });

  it('list-handling modules do not name the active provider anywhere', () => {
    const offenders: string[] = [];
    for (const dir of PROVIDER_AGNOSTIC_DIRS) {
      for (const file of listTs(dir).filter(isProviderAgnostic)) {
        if (/gcp-vision|google-vision|@google-cloud/i.test(readFileSync(file, 'utf8'))) {
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
