import { describe, expect, it } from 'vitest';
import {
  type FullTextAnnotationLike,
  type ParagraphLike,
  type SymbolLike,
  toRecognition,
  type VertexLike,
  type WordLike,
} from '../../src/google-vision/to-recognition';

type BreakSpec = { type?: string | number | null; isPrefix?: boolean | null };

function sym(text: string, brk?: BreakSpec): SymbolLike {
  return brk === undefined ? { text } : { text, property: { detectedBreak: brk } };
}

function word(symbols: SymbolLike[], confidence?: number, vertices?: VertexLike[]): WordLike {
  return {
    symbols,
    confidence,
    boundingBox: vertices === undefined ? undefined : { vertices },
  };
}

function paragraph(...words: WordLike[]): ParagraphLike {
  return { words };
}

/** Single-page, single-block annotation wrapping the given paragraphs. */
function annotation(...paragraphs: ParagraphLike[]): FullTextAnnotationLike {
  return { pages: [{ blocks: [{ paragraphs }] }] };
}

function box(x1: number, y1: number, x2: number, y2: number): VertexLike[] {
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

describe('toRecognition line reconstruction', () => {
  it('multi-paragraph input with LINE_BREAK and EOL_SURE_SPACE yields ordered lines that rejoin to the page text byte-for-byte', () => {
    const rec = toRecognition(
      annotation(
        paragraph(
          word(
            [sym('M'), sym('i'), sym('l'), sym('k', { type: 'EOL_SURE_SPACE' })],
            0.8,
            box(10, 20, 50, 40),
          ),
          word(
            [sym('E'), sym('g'), sym('g'), sym('s', { type: 'LINE_BREAK' })],
            0.6,
            box(10, 50, 46, 70),
          ),
        ),
        paragraph(
          word([sym('B'), sym('r'), sym('e'), sym('a'), sym('d')], 0.9, box(10, 80, 60, 100)),
        ),
      ),
    );
    expect(rec.text).toBe('Milk\nEggs\nBread');
    expect(rec.lines.map((l) => l.text)).toEqual(['Milk', 'Eggs', 'Bread']);
    // Fidelity invariant: joined lines equal the page text byte-for-byte.
    expect(rec.lines.map((l) => l.text).join('\n')).toBe(rec.text);
  });

  it('SPACE and SURE_SPACE mid-line produce a single space without a line split', () => {
    const rec = toRecognition(
      annotation(
        paragraph(
          word([sym('A'), sym('b', { type: 'SPACE' })]),
          word([sym('C'), sym('d', { type: 'SURE_SPACE' })]),
          word([sym('E')]),
        ),
      ),
    );
    expect(rec.text).toBe('Ab Cd E');
    expect(rec.lines).toHaveLength(1);
  });

  it('HYPHEN, UNKNOWN and absent breaks contribute no synthesized characters', () => {
    const rec = toRecognition(
      annotation(
        paragraph(word([sym('A', { type: 'HYPHEN' }), sym('B', { type: 'UNKNOWN' }), sym('C')])),
      ),
    );
    expect(rec.text).toBe('ABC');
    expect(rec.lines.map((l) => l.text)).toEqual(['ABC']);
  });

  it('isPrefix break is emitted BEFORE its symbol', () => {
    const rec = toRecognition(
      annotation(
        paragraph(
          word([sym('A')]),
          word([sym('B', { type: 'LINE_BREAK', isPrefix: true }), sym('C')]),
        ),
      ),
    );
    expect(rec.text).toBe('A\nBC');
    expect(rec.lines.map((l) => l.text)).toEqual(['A', 'BC']);
  });

  it('terminal break drops exactly one trailing empty line and leaves the page text untouched', () => {
    const rec = toRecognition(annotation(paragraph(word([sym('X', { type: 'LINE_BREAK' })]))));
    expect(rec.text).toBe('X\n');
    expect(rec.lines.map((l) => l.text)).toEqual(['X']);
    // Fidelity invariant with the documented trailing-empty-line exception.
    expect(`${rec.lines.map((l) => l.text).join('\n')}\n`).toBe(rec.text);
  });

  it('numeric break enum codes decode like their string names', () => {
    // Proto enum ordinals: SPACE=1, SURE_SPACE=2, EOL_SURE_SPACE=3, LINE_BREAK=5.
    const rec = toRecognition(
      annotation(paragraph(word([sym('A', { type: 1 }), sym('B', { type: 5 })]))),
    );
    expect(rec.text).toBe('A B\n');
    expect(rec.lines.map((l) => l.text)).toEqual(['A B']);
  });
});

describe('toRecognition per-line confidence', () => {
  it('is the char-weighted mean of the constituent word confidences (hand-computed)', () => {
    // Line "ab cde": word "ab" (2 chars, conf 1.0) + word "cde" (3 chars, conf 0.5)
    // → (1.0*2 + 0.5*3) / 5 = 3.5 / 5 = 0.7
    const rec = toRecognition(
      annotation(
        paragraph(
          word([sym('a'), sym('b', { type: 'SPACE' })], 1.0),
          word([sym('c'), sym('d'), sym('e')], 0.5),
        ),
      ),
    );
    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0].confidence).toBeCloseTo(0.7, 10);
  });

  it('weights only the words that carry a confidence', () => {
    // "Milk" has no confidence, "Eggs" (4 chars) has 0.6 → line confidence 0.6.
    const rec = toRecognition(
      annotation(
        paragraph(
          word([sym('M'), sym('i'), sym('l'), sym('k', { type: 'SPACE' })]),
          word([sym('E'), sym('g'), sym('g'), sym('s')], 0.6),
        ),
      ),
    );
    expect(rec.lines[0].confidence).toBeCloseTo(0.6, 10);
  });

  it('reports 0 for a line with no confidence-bearing words', () => {
    const rec = toRecognition(annotation(paragraph(word([sym('A'), sym('B')]))));
    expect(rec.lines[0].confidence).toBe(0);
  });
});

describe('toRecognition per-line bounding box', () => {
  it('is the axis-aligned union envelope of the constituent word vertices', () => {
    const rec = toRecognition(
      annotation(
        paragraph(
          word([sym('A', { type: 'SPACE' })], 0.9, box(10, 20, 50, 40)),
          word([sym('B')], 0.9, box(60, 15, 100, 45)),
        ),
      ),
    );
    expect(rec.lines[0].boundingBox).toEqual({ x: 10, y: 15, width: 90, height: 30 });
  });

  it('reports a zero box for a line with no word boxes', () => {
    const rec = toRecognition(annotation(paragraph(word([sym('A')]))));
    expect(rec.lines[0].boundingBox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('ignores words with missing or empty vertices', () => {
    const rec = toRecognition(
      annotation(
        paragraph(
          word([sym('A', { type: 'SPACE' })], 0.9),
          word([sym('B')], 0.9, box(5, 5, 20, 9)),
        ),
      ),
    );
    expect(rec.lines[0].boundingBox).toEqual({ x: 5, y: 5, width: 15, height: 4 });
  });
});

describe('toRecognition empty input', () => {
  it('empty annotation yields an empty recognition', () => {
    expect(toRecognition({})).toEqual({ text: '', lines: [] });
  });

  it('annotation with no pages yields an empty recognition', () => {
    expect(toRecognition({ pages: [] })).toEqual({ text: '', lines: [] });
  });

  it('word without symbols yields an empty recognition', () => {
    expect(toRecognition(annotation(paragraph(word([]))))).toEqual({ text: '', lines: [] });
  });
});
