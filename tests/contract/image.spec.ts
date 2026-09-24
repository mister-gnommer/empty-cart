import { describe, expect, it } from 'vitest';
import { fetchAndValidateImage, MAX_IMAGE_BYTES } from '../../src/image/fetch-image';
import { createScriptedFetch } from '../helpers/scripted-fetch';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

const JPEG_BYTES = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01);
const PNG_BYTES = bytes(0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);

const URL_1 = 'https://cdn.discord.test/attachments/1.png';

function input(overrides: Partial<Parameters<typeof fetchAndValidateImage>[0]> = {}) {
  return {
    url: URL_1,
    reportedSize: null,
    reportedContentType: null,
    ...overrides,
  };
}

describe('fetchAndValidateImage local gates (no download)', () => {
  it('reportedSize over the cap is too-large and fetch is NEVER called', async () => {
    const scripted = createScriptedFetch([]);
    const result = await fetchAndValidateImage(
      input({ reportedSize: MAX_IMAGE_BYTES + 1 }),
      scripted.fetchImpl,
    );
    expect(result).toEqual({ status: 'too-large' });
    expect(scripted.requestedUrls).toEqual([]);
  });

  it('reportedSize exactly at the cap still proceeds to download', async () => {
    const scripted = createScriptedFetch([{ body: { bytes: JPEG_BYTES } }]);
    const result = await fetchAndValidateImage(
      input({ reportedSize: MAX_IMAGE_BYTES }),
      scripted.fetchImpl,
    );
    expect(result.status).toBe('ok');
    expect(scripted.requestedUrls).toEqual([URL_1]);
  });

  it.each(['image/gif', 'application/pdf', 'video/mp4'])(
    'contentType %s is unsupported-format and fetch is NEVER called',
    async (contentType) => {
      const scripted = createScriptedFetch([]);
      const result = await fetchAndValidateImage(
        input({ reportedContentType: contentType }),
        scripted.fetchImpl,
      );
      expect(result).toEqual({ status: 'unsupported-format' });
      expect(scripted.requestedUrls).toEqual([]);
    },
  );

  it('a MISSING content type proceeds to download', async () => {
    const scripted = createScriptedFetch([{ body: { bytes: JPEG_BYTES } }]);
    const result = await fetchAndValidateImage(
      input({ reportedContentType: null }),
      scripted.fetchImpl,
    );
    expect(result.status).toBe('ok');
    expect(scripted.requestedUrls).toEqual([URL_1]);
  });
});

describe('fetchAndValidateImage download failures', () => {
  it('a rejecting fetch is unretrievable', async () => {
    const scripted = createScriptedFetch([{ reject: new Error('connection reset') }]);
    const result = await fetchAndValidateImage(input(), scripted.fetchImpl);
    expect(result).toEqual({ status: 'unretrievable' });
  });

  it.each([403, 404, 500])('non-OK status %i is unretrievable', async (status) => {
    const scripted = createScriptedFetch([{ status, body: { bytes: JPEG_BYTES } }]);
    const result = await fetchAndValidateImage(input(), scripted.fetchImpl);
    expect(result).toEqual({ status: 'unretrievable' });
  });

  it('Content-Length over the cap is too-large with the body reader cancelled', async () => {
    const scripted = createScriptedFetch([
      {
        headers: { 'Content-Length': String(MAX_IMAGE_BYTES + 1) },
        body: { bytes: JPEG_BYTES },
      },
    ]);
    const result = await fetchAndValidateImage(input(), scripted.fetchImpl);
    expect(result).toEqual({ status: 'too-large' });
    expect(scripted.cancelled[0]).toBe(true);
  });

  it('a chunked stream exceeding the cap mid-body is too-large, cancelled, and NOT fully buffered', async () => {
    const oneMb = new Uint8Array(1024 * 1024);
    const chunks = Array.from({ length: 10 }, () => oneMb);
    const scripted = createScriptedFetch([{ body: { chunks } }]);
    const result = await fetchAndValidateImage(input(), scripted.fetchImpl);
    expect(result).toEqual({ status: 'too-large' });
    expect(scripted.cancelled[0]).toBe(true);
    // Bounded accumulation: the consumer stopped pulling before the body ended.
    expect(scripted.pulled[0]).toBeLessThan(chunks.length);
  });

  it('downloaded bytes that fail the magic-byte sniff are unsupported-format', async () => {
    const gif = bytes(...ascii('GIF89a'), 0x01, 0x00, 0x01, 0x00, 0x00, 0x00);
    const scripted = createScriptedFetch([{ body: { bytes: gif } }]);
    const result = await fetchAndValidateImage(input(), scripted.fetchImpl);
    expect(result).toEqual({ status: 'unsupported-format' });
  });
});

describe('fetchAndValidateImage success', () => {
  it('magic bytes beat the reported content type (PNG bytes claiming webp)', async () => {
    const scripted = createScriptedFetch([
      { headers: { 'content-type': 'image/webp' }, body: { bytes: PNG_BYTES } },
    ]);
    const result = await fetchAndValidateImage(
      input({ reportedContentType: 'image/webp' }),
      scripted.fetchImpl,
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.format).toBe('png');
    }
  });

  it('an under-cap JPEG body is ok with sizeBytes equal to the actual length and bytes returned intact', async () => {
    const scripted = createScriptedFetch([{ body: { bytes: JPEG_BYTES } }]);
    const result = await fetchAndValidateImage(
      input({ reportedSize: JPEG_BYTES.length, reportedContentType: 'image/jpeg' }),
      scripted.fetchImpl,
    );
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.format).toBe('jpeg');
      expect(result.sizeBytes).toBe(JPEG_BYTES.length);
      expect(result.bytes).toEqual(JPEG_BYTES);
    }
  });

  it('reassembles a chunked body in order', async () => {
    const part1 = JPEG_BYTES.subarray(0, 6);
    const part2 = JPEG_BYTES.subarray(6);
    const scripted = createScriptedFetch([{ body: { chunks: [part1, part2] } }]);
    const result = await fetchAndValidateImage(input(), scripted.fetchImpl);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.bytes).toEqual(JPEG_BYTES);
      expect(result.sizeBytes).toBe(JPEG_BYTES.length);
    }
    expect(scripted.pulled[0]).toBe(2);
  });
});

// 🤖 AI-start
describe('fetchAndValidateImage abort signal', () => {
  it('forwards the caller abort signal to the download', async () => {
    const scripted = createScriptedFetch([{ body: { bytes: JPEG_BYTES } }]);
    const controller = new AbortController();
    await fetchAndValidateImage(input({ signal: controller.signal }), scripted.fetchImpl);
    expect(scripted.signals[0]).toBe(controller.signal);
  });

  it('an aborted signal stops body accumulation: reader cancelled, unretrievable', async () => {
    const scripted = createScriptedFetch([
      { body: { chunks: [JPEG_BYTES.subarray(0, 6), JPEG_BYTES.subarray(6)] } },
    ]);
    const controller = new AbortController();
    controller.abort();
    // The scripted fetch ignores the signal, so the module's own check is what stops it.
    const result = await fetchAndValidateImage(
      input({ signal: controller.signal }),
      scripted.fetchImpl,
    );
    expect(result.status).toBe('unretrievable');
    expect(scripted.cancelled[0]).toBe(true);
  });
});
// 🤖 AI-end
