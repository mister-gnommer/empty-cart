// Pure magic-byte format sniffing — three 12-byte checks, no sniffing
// library. Magic bytes are the source of truth; Discord's extension-derived
// contentType is only a cheap pre-filter elsewhere.

export type ImageFormat = 'jpeg' | 'png' | 'webp';

const MIN_SNIFF_BYTES = 12;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length < MIN_SNIFF_BYTES) {
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (PNG_SIGNATURE.every((expected, i) => bytes[i] === expected)) {
    return 'png';
  }
  // WEBP: 'RIFF' at offset 0 AND 'WEBP' at offset 8.
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}
