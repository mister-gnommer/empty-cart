// Minimal byte sequences that pass (or deliberately fail) the 12-byte
// magic-byte sniff.

export function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Char codes of an ASCII string, for spelling container magic strings. */
export function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

export const JPEG_BYTES = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF'), 0x00, 0x01);
const PNG_SIGNATURE = [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
export const PNG_BYTES = bytes(...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d);
export const WEBP_BYTES = bytes(...ascii('RIFF'), 0x24, 0x00, 0x00, 0x00, ...ascii('WEBP'));
