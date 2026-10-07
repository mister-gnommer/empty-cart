import { describe, expect, it } from 'vitest';
import { sniffFormat } from '../../src/image/sniff-format';
import {
  ascii,
  bytes,
  JPEG_BYTES as JPEG,
  PNG_BYTES as PNG,
  WEBP_BYTES as WEBP,
} from '../helpers/image-fixtures';

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
