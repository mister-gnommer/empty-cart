import { describe, expect, it } from 'vitest';
import { sniffFormat } from '../../src/image/sniff-format';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** ASCII helper for container magic strings. */
function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01);
const PNG = bytes(0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const WEBP = bytes(...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WEBP'));

describe('sniffFormat', () => {
  it('detects JPEG from the FF D8 FF prefix', () => {
    expect(sniffFormat(JPEG)).toBe('jpeg');
  });

  it('detects PNG from the 8-byte signature', () => {
    expect(sniffFormat(PNG)).toBe('png');
  });

  it('detects WEBP from RIFF at offset 0 AND WEBP at offset 8', () => {
    expect(sniffFormat(WEBP)).toBe('webp');
  });

  it('rejects a RIFF container that is not WEBP (e.g. AVI)', () => {
    const avi = bytes(...ascii('RIFF'), 0x00, 0x00, 0x00, 0x00, ...ascii('AVI '));
    expect(sniffFormat(avi)).toBeNull();
  });

  it('rejects GIF', () => {
    const gif = bytes(...ascii('GIF89a'), 0x01, 0x00, 0x01, 0x00, 0x00, 0x00);
    expect(sniffFormat(gif)).toBeNull();
  });

  it('rejects BMP', () => {
    const bmp = bytes(...ascii('BM'), 0x36, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x36);
    expect(sniffFormat(bmp)).toBeNull();
  });

  it('rejects TIFF in both endians', () => {
    const littleEndian = bytes(
      0x49,
      0x49,
      0x2a,
      0x00,
      0x08,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    );
    const bigEndian = bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00);
    expect(sniffFormat(littleEndian)).toBeNull();
    expect(sniffFormat(bigEndian)).toBeNull();
  });

  it('rejects a HEIC ftyp box', () => {
    const heic = bytes(0x00, 0x00, 0x00, 0x18, ...ascii('ftyp'), ...ascii('heic'));
    expect(sniffFormat(heic)).toBeNull();
  });

  it('rejects random bytes', () => {
    const random = bytes(0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98);
    expect(sniffFormat(random)).toBeNull();
  });

  it('rejects anything shorter than 12 bytes, even a valid-looking JPEG prefix', () => {
    expect(sniffFormat(JPEG.subarray(0, 11))).toBeNull();
    expect(sniffFormat(JPEG.subarray(0, 3))).toBeNull();
    expect(sniffFormat(bytes())).toBeNull();
  });
});
