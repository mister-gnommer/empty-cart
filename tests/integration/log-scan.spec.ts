import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import { createDisabledProvider } from '../../src/ocr/disabled-provider';
import {
  type AnnotatorClientLike,
  type BatchResponseLike,
  createGoogleVisionProvider,
} from '../../src/ocr/google-vision/provider';
import type { OcrProvider, OcrProviderResult, UnavailableCause } from '../../src/ocr/types';
import { makeConfig } from '../helpers/config-fixture';
import {
  attachment,
  buildListFlowEnv,
  buildMessage,
  type FakeAttachment,
} from '../helpers/list-flow-env';
import type { ScriptedFetchEntry } from '../helpers/scripted-fetch';
import { makeStreamLogger } from '../helpers/stream-logger';
import {
  createStubOcrProvider,
  deferred,
  okResult,
  type StubScriptEntry,
  unavailableResult,
  undecodableResult,
} from '../helpers/stub-ocr-provider';
import { emitMessage } from '../helpers/stubbed-client';

// End-to-end content-free logging: representative list-submission lifecycles
// (happy, every failure class, busy rejection, disabled provider) run through
// the REAL adapter, handler, image validator, and Vision provider mapping into
// a real pino logger with the production redact config. No emitted line may
// carry recognized text, image bytes in any encoding, or service-account key
// contents — the key file PATH is allowed, its contents never.

const RECOGNIZED_TOKENS = [
  'Zucchini-LEAKCHECK-alpha',
  'Paprika-LEAKCHECK-bravo',
  'Oatmilk-LEAKCHECK-charlie',
  'Page2-LEAKCHECK-delta',
];
const HAPPY_TEXT = `${RECOGNIZED_TOKENS[0]} 2x\n${RECOGNIZED_TOKENS[1]}\n${RECOGNIZED_TOKENS[2]}`;
const SECOND_PAGE_TEXT = RECOGNIZED_TOKENS[3];

const IMAGE_SENTINEL = 'IMG-BYTES-SENTINEL-7f3a9c';
const IMAGE_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new TextEncoder().encode(IMAGE_SENTINEL),
]);
const CORRUPT_BYTES = new TextEncoder().encode(`GIF89a-${IMAGE_SENTINEL}`);

const KEY_SENTINEL = 'SENTINEL-KEY-MATERIAL-9d41e0';
const KEY_FILE_CONTENTS = JSON.stringify({
  type: 'service_account',
  private_key_id: `kid-${KEY_SENTINEL}`,
  private_key: `-----BEGIN PRIVATE KEY-----\nMIIE${KEY_SENTINEL}\n-----END PRIVATE KEY-----\n`,
  client_email: 'bot@project.iam.gserviceaccount.com',
});

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** Every serialized form image bytes could take in a JSON log line. */
function bytePatterns(bytes: Uint8Array): string[] {
  return [
    toBase64(bytes),
    toHex(bytes),
    // Array.from / Buffer#toJSON serialization.
    `[${Array.from(bytes.slice(0, 12)).join(',')}`,
    // Uint8Array JSON serialization ({"0":137,"1":80,...}).
    `"0":${bytes[0]},"1":${bytes[1]},"2":${bytes[2]}`,
  ];
}

class GoogleLikeError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const config = makeConfig({ logLevel: 'debug', ocrLanguageHints: ['en'] });

const PNG = attachment('https://cdn.test/list.png', 'image/png', IMAGE_BYTES.length);
const PAGE_2 = attachment('https://cdn.test/page2.png', 'image/png', IMAGE_BYTES.length);

describe('integration: submission lifecycles never log content', () => {
  const sink = makeStreamLogger('debug');
  let keyDir: string;
  let keyPath: string;

  beforeAll(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'log-scan-key-'));
    keyPath = join(keyDir, 'sa-key.json');
    writeFileSync(keyPath, KEY_FILE_CONTENTS);
  });

  afterAll(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  function buildEnv(opts: { provider: OcrProvider; fetchEntries: ScriptedFetchEntry[] }) {
    return buildListFlowEnv({ ...opts, config, logger: sink.logger });
  }

  function visionProvider(respond: () => Promise<[BatchResponseLike]>): OcrProvider {
    const client: AnnotatorClientLike = { batchAnnotateImages: respond };
    return createGoogleVisionProvider({ keyFilePath: keyPath, clientFactory: () => client });
  }

  function stubProvider(script: StubScriptEntry[]): OcrProvider {
    return createStubOcrProvider(script);
  }

  async function run(opts: {
    provider: OcrProvider;
    fetchEntries: ScriptedFetchEntry[];
    attachments?: FakeAttachment[];
    content?: string;
  }): Promise<void> {
    const env = buildEnv(opts);
    try {
      const msg = buildMessage({ attachments: opts.attachments ?? [PNG], content: opts.content });
      emitMessage(env.client, msg.raw);
      await vi.waitFor(() => expect(msg.send).toHaveBeenCalled());
    } finally {
      await env.adapter.stop();
    }
  }

  beforeAll(async () => {
    // Happy recognition through the real Vision provider mapping.
    await run({
      provider: visionProvider(async () => [
        { responses: [{ fullTextAnnotation: { text: HAPPY_TEXT } }] },
      ]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    // Multi-image happy path.
    await run({
      provider: stubProvider([okResult(HAPPY_TEXT), okResult(SECOND_PAGE_TEXT)]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }, { body: { bytes: IMAGE_BYTES } }],
      attachments: [PNG, PAGE_2],
    });
    // No readable text.
    await run({
      provider: stubProvider([okResult('   ')]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    // Unsupported format by metadata, by content sniffing, and by the provider.
    await run({
      provider: stubProvider([]),
      fetchEntries: [],
      attachments: [attachment('https://cdn.test/list.pdf', 'application/pdf', IMAGE_BYTES.length)],
    });
    await run({
      provider: stubProvider([]),
      fetchEntries: [{ body: { bytes: CORRUPT_BYTES } }],
    });
    await run({
      provider: stubProvider([undecodableResult()]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    // Too large.
    await run({
      provider: stubProvider([]),
      fetchEntries: [],
      attachments: [attachment('https://cdn.test/huge.png', 'image/png', MAX_IMAGE_BYTES + 1)],
    });
    // Download failure after partial success: page 1's text must not surface.
    await run({
      provider: stubProvider([okResult(HAPPY_TEXT)]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }, { status: 500 }],
      attachments: [PNG, PAGE_2],
    });
    // Every service-side cause.
    const causes: UnavailableCause[] = [
      'unreachable',
      'unauthorized',
      'quota-exhausted',
      'provider-error',
      'deadline-exceeded',
    ];
    for (const cause of causes) {
      await run({
        provider: stubProvider([unavailableResult(cause)]),
        fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
      });
    }
    // A vendor rejection whose message embeds request details (text, key id).
    await run({
      provider: visionProvider(async () => {
        throw new GoogleLikeError(
          7,
          `7 PERMISSION_DENIED: ${RECOGNIZED_TOKENS[0]} kid-${KEY_SENTINEL}`,
        );
      }),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    // Unexpected provider throw.
    await run({
      provider: stubProvider([
        () => {
          throw new Error('unexpected internal failure');
        },
      ]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    // Disabled provider.
    await run({
      provider: createDisabledProvider(),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    // Busy rejection, then the held submission completes with text.
    const gate = deferred<OcrProviderResult>();
    const env = buildEnv({
      provider: stubProvider([() => gate.promise]),
      fetchEntries: [{ body: { bytes: IMAGE_BYTES } }],
    });
    try {
      const first = buildMessage({ attachments: [PNG] });
      const second = buildMessage({ attachments: [PNG] });
      emitMessage(env.client, first.raw);
      await vi.waitFor(() =>
        expect(sink.chunks().some((l) => l.msg === 'image submitted')).toBe(true),
      );
      emitMessage(env.client, second.raw);
      await vi.waitFor(() => expect(second.send).toHaveBeenCalled());
      gate.resolve(okResult(HAPPY_TEXT));
      await vi.waitFor(() => expect(first.send).toHaveBeenCalled());
    } finally {
      await env.adapter.stop();
    }
    // Non-submission traffic in the same channel.
    await run({ provider: stubProvider([]), fetchEntries: [], attachments: [], content: 'hi' });
  });

  it('exercised every lifecycle transition (the scan is not vacuous)', () => {
    const msgs = new Set(sink.chunks().map((l) => l.msg));
    for (const expected of [
      'list submission received',
      'image submitted',
      'list submission succeeded',
      'list submission failed',
      'list submission cancelled',
      'list submission rejected busy',
    ]) {
      expect(msgs, `missing log line: ${expected}`).toContain(expected);
    }
    for (const line of sink.chunks().filter((l) => l.msg === 'list submission received')) {
      expect(line.correlationId).toEqual(expect.stringMatching(/.+/));
    }
  });

  it('no log line contains recognized text', () => {
    for (const line of sink.chunks()) {
      const json = JSON.stringify(line);
      for (const token of RECOGNIZED_TOKENS) {
        expect(json, `recognized text leak:\n${json}`).not.toContain(token);
      }
    }
  });

  it('no log line contains image bytes in any serialized form', () => {
    const patterns = [IMAGE_SENTINEL, ...bytePatterns(IMAGE_BYTES), ...bytePatterns(CORRUPT_BYTES)];
    for (const line of sink.chunks()) {
      const json = JSON.stringify(line);
      for (const pattern of patterns) {
        expect(json, `image byte leak (${pattern}):\n${json}`).not.toContain(pattern);
      }
    }
  });

  it('no log line contains service-account key contents', () => {
    for (const line of sink.chunks()) {
      const json = JSON.stringify(line);
      expect(json, `key material leak:\n${json}`).not.toContain(KEY_SENTINEL);
      expect(json).not.toContain('BEGIN PRIVATE KEY');
    }
  });
});
