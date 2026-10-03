import { describe, expect, it } from 'vitest';
import { splitReply } from '../../src/discord/split-reply';

const MARKER = '…';

/** Rejoins chunks after stripping the continuation markers added at mid-line cuts. */
function unmark(chunks: string[]): string {
  return chunks
    .map((chunk, i) => {
      const start = i > 0 ? MARKER.length : 0;
      const end = i < chunks.length - 1 ? chunk.length - MARKER.length : chunk.length;
      return chunk.slice(start, end);
    })
    .join('');
}

describe('splitReply', () => {
  it('text within the limit is a single byte-identical chunk', () => {
    const text = 'Milk\nEggs\nBread';
    expect(splitReply(text)).toEqual([text]);
  });

  it('text of exactly the limit length is a single chunk', () => {
    const text = 'x'.repeat(2000);
    expect(splitReply(text)).toEqual([text]);
  });

  it('the default limit is 2000', () => {
    const chunks = splitReply('x'.repeat(2001));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('line-boundary splits: every chunk within limit, no line split, concatenation equals the original', () => {
    const text = `${'a'.repeat(1200)}\n${'b'.repeat(1200)}\n${'c'.repeat(100)}`;
    const chunks = splitReply(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    // No line was split across chunks: every chunk except the last ends at a line boundary.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith('\n')).toBe(true);
    }
    // Line-boundary splitting adds nothing — byte-for-byte reconstruction.
    expect(chunks.join('')).toBe(text);
  });

  it('a 5000-char single line splits with continuation markers on both sides of every cut', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitReply(text);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith(MARKER)).toBe(true);
    }
    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith(MARKER)).toBe(true);
    }
    expect(unmark(chunks)).toBe(text);
  });

  it('a window whose only newline sits at position 0 is treated as mid-line (marker path)', () => {
    const text = `\n${'x'.repeat(3000)}`;
    const chunks = splitReply(text);
    expect(chunks.length).toBeGreaterThan(1);
    // The newline at position 0 is NOT used as a split boundary; the first cut
    // is a marked mid-line cut.
    expect(chunks[0].endsWith(MARKER)).toBe(true);
    expect(chunks[1].startsWith(MARKER)).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('honors a custom limit', () => {
    const text = 'abcdefghij';
    const chunks = splitReply(text, 4);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4);
    }
    expect(unmark(chunks)).toBe(text);
  });

  it('a mid-line cut never splits a surrogate pair', () => {
    const text = 'ab😀😀😀😀😀😀';
    const chunks = splitReply(text, 4);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4);
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(unmark(chunks)).toBe(text);
  });

  it('rejects a limit too small to guarantee progress past a surrogate pair', () => {
    expect(() => splitReply('abcdef', 3)).toThrow(RangeError);
  });
});
