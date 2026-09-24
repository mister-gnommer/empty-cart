import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AnnotatorClientLike,
  type BatchResponseLike,
  createGoogleVisionProvider,
} from '../../src/google-vision/provider';

// No test in this file contacts the real Vision API: every provider is built
// through the constructor seam with a recorded stub client.

let keyDir: string;
let keyPath: string;

beforeAll(() => {
  keyDir = mkdtempSync(join(tmpdir(), 'gcv-key-test-'));
  keyPath = join(keyDir, 'sa-key.json');
  writeFileSync(keyPath, '{"type":"service_account","project_id":"test-project"}');
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

type RecordedCall = {
  request: {
    requests: Array<{
      image?: { content?: Uint8Array };
      features?: Array<{ type?: string }>;
      imageContext?: { languageHints?: string[] };
    }>;
  };
  options: unknown;
};

class FakeGoogleError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'GoogleError';
    this.code = code;
  }
}

function setup(opts: { response?: BatchResponseLike; rejection?: unknown } = {}) {
  const calls: RecordedCall[] = [];
  const factoryArgs: Array<{ keyFilename: string }> = [];
  const client: AnnotatorClientLike = {
    batchAnnotateImages: (request, callOptions) => {
      calls.push({ request, options: callOptions });
      if (opts.rejection !== undefined) {
        return Promise.reject(opts.rejection);
      }
      return Promise.resolve([opts.response ?? { responses: [{}] }]);
    },
  };
  const provider = createGoogleVisionProvider({
    keyFile: keyPath,
    clientFactory: (clientOpts) => {
      factoryArgs.push(clientOpts);
      return client;
    },
  });
  return { provider, calls, factoryArgs };
}

const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22]);

describe('createGoogleVisionProvider identity and construction', () => {
  it('identifies itself as gcp-vision', () => {
    const { provider } = setup();
    expect(provider.id).toBe('gcp-vision');
  });

  it('passes the configured key path to the client constructor', () => {
    const { factoryArgs } = setup();
    expect(factoryArgs).toEqual([{ keyFilename: keyPath }]);
  });

  it('a nonexistent key file throws AT CONSTRUCTION naming GCP_SA_KEY_PATH, before any client is built', () => {
    expect(() =>
      createGoogleVisionProvider({
        keyFile: join(keyDir, 'does-not-exist.json'),
        clientFactory: () => {
          throw new Error('client must not be constructed when key validation fails');
        },
      }),
    ).toThrow(/GCP_SA_KEY_PATH/);
  });

  it('the construction failure message never contains key file contents', () => {
    let message = '';
    try {
      createGoogleVisionProvider({ keyFile: join(keyDir, 'does-not-exist.json') });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('service_account');
    expect(message).not.toContain('test-project');
  });
});

describe('recognize request shape', () => {
  it('issues one DOCUMENT_TEXT_DETECTION request with inline content bytes pass-through', async () => {
    const { provider, calls } = setup();
    await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: ['en'],
      timeoutMs: 4321,
    });
    expect(calls).toHaveLength(1);
    const sent = calls[0].request.requests;
    expect(sent).toHaveLength(1);
    expect(sent[0].features).toEqual([{ type: 'DOCUMENT_TEXT_DETECTION' }]);
    expect(sent[0].image?.content).toEqual(IMAGE_BYTES);
  });

  it('forwards non-empty languageHints as imageContext.languageHints', async () => {
    const { provider, calls } = setup();
    await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: ['en', 'de', 'en-t-i0-handwrit'],
      timeoutMs: 1000,
    });
    expect(calls[0].request.requests[0].imageContext).toEqual({
      languageHints: ['en', 'de', 'en-t-i0-handwrit'],
    });
  });

  it('omits imageContext when languageHints is empty (provider auto-detect)', async () => {
    const { provider, calls } = setup();
    await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'png' },
      languageHints: [],
      timeoutMs: 1000,
    });
    expect(calls[0].request.requests[0].imageContext).toBeUndefined();
  });

  it('call options carry the remaining budget as timeout and disable retries outright', async () => {
    const { provider, calls } = setup();
    await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 4321,
    });
    expect(calls[0].options).toEqual({ timeout: 4321, retry: null });
  });
});

describe('recognize response handling', () => {
  it('in-band error with the decode-failure signature becomes undecodable-image, NOT empty text', async () => {
    const { provider } = setup({
      response: {
        responses: [{ error: { code: 3, message: 'INVALID_ARGUMENT: Bad image data.' } }],
      },
    });
    const result = await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: 'undecodable-image' });
    expect(result.status).not.toBe('ok');
  });

  it('in-band error without the decode signature maps through the taxonomy', async () => {
    const { provider } = setup({
      response: { responses: [{ error: { code: 14, message: 'unreachable' } }] },
    });
    const result = await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: 'unavailable', cause: 'unreachable' });
  });

  it('fullTextAnnotation is passed through the line reconstruction', async () => {
    const { provider } = setup({
      response: {
        responses: [
          {
            fullTextAnnotation: {
              text: 'Hi',
              pages: [
                {
                  blocks: [
                    {
                      paragraphs: [
                        {
                          words: [{ symbols: [{ text: 'H' }, { text: 'i' }], confidence: 0.9 }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const result = await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 1000,
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.recognition.text).toBe('Hi');
      expect(result.recognition.lines.map((l) => l.text)).toEqual(['Hi']);
    }
  });

  it('missing or empty annotation resolves ok with an empty recognition (the orchestrator owns the no-text decision)', async () => {
    for (const response of [
      { responses: [{}] },
      { responses: [{ fullTextAnnotation: {} }] },
      { responses: [] },
      {},
    ]) {
      const { provider } = setup({ response });
      const result = await provider.recognize({
        image: { bytes: IMAGE_BYTES, format: 'jpeg' },
        languageHints: [],
        timeoutMs: 1000,
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.recognition).toEqual({ text: '', lines: [] });
      }
    }
  });

  it('a thrown GoogleError is mapped, never leaked across the module boundary', async () => {
    const thrown = new FakeGoogleError(16, 'Invalid credentials');
    const { provider } = setup({ rejection: thrown });
    const result = await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({ status: 'unavailable', cause: 'unauthorized' });
    expect(result).not.toBe(thrown);
  });

  it('a thrown deadline error maps to deadline-exceeded', async () => {
    const { provider } = setup({ rejection: new FakeGoogleError(4, 'Deadline exceeded') });
    const result = await provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 10,
    });
    expect(result).toMatchObject({ status: 'unavailable', cause: 'deadline-exceeded' });
  });
});

// 🤖 AI-start
describe('recognize fidelity self-check against the provider page text', () => {
  const oneWord = (providerText: string | undefined) => ({
    responses: [
      {
        fullTextAnnotation: {
          ...(providerText === undefined ? {} : { text: providerText }),
          pages: [
            {
              blocks: [
                {
                  paragraphs: [
                    {
                      words: [
                        {
                          symbols: [
                            { text: 'H' },
                            { text: 'i', property: { detectedBreak: { type: 'LINE_BREAK' } } },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });

  async function recognizeWith(response: BatchResponseLike) {
    const { provider } = setup({ response });
    return provider.recognize({
      image: { bytes: IMAGE_BYTES, format: 'jpeg' },
      languageHints: [],
      timeoutMs: 1000,
    });
  }

  it('reconstruction equal to the provider text → match', async () => {
    const result = await recognizeWith(oneWord('Hi\n'));
    expect(result).toMatchObject({ status: 'ok', fidelityCheck: 'match' });
  });

  it("reconstruction differing from the provider text → mismatch; the provider's own page text is returned", async () => {
    const result = await recognizeWith(oneWord('Hi there\n'));
    expect(result).toMatchObject({ status: 'ok', fidelityCheck: 'mismatch' });
    if (result.status === 'ok') {
      expect(result.recognition.text).toBe('Hi there\n');
      // The per-line breakdown still comes from the reconstruction.
      expect(result.recognition.lines.map((l) => l.text)).toEqual(['Hi']);
    }
  });

  it('no provider page text → the reconstruction is returned', async () => {
    const result = await recognizeWith(oneWord(undefined));
    expect(result.status === 'ok' && result.recognition.text).toBe('Hi\n');
  });

  it('no provider page text → no self-check reported', async () => {
    const result = await recognizeWith(oneWord(undefined));
    expect(result.status).toBe('ok');
    expect('fidelityCheck' in result).toBe(false);
  });
});
// 🤖 AI-end
