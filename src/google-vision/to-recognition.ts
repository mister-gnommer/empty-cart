// Pure mapper: Google Cloud Vision document-text annotation → the
// provider-agnostic recognition contract. No client, no I/O — exported for
// unit tests. The reconstruction is byte-faithful by design: the page text is
// rebuilt from symbol texts plus their detected breaks, which is the same
// mechanism the provider's own `text` field is built from.

import type { Recognition, RecognizedLine } from '../ocr/types';

/**
 * Break types arrive as string names or numeric proto enum ordinals
 * (UNKNOWN=0, SPACE=1, SURE_SPACE=2, EOL_SURE_SPACE=3, HYPHEN=4, LINE_BREAK=5)
 * depending on the transport; both forms are accepted.
 */
export type DetectedBreakLike = {
  type?: string | number | null;
  isPrefix?: boolean | null;
};

export type SymbolLike = {
  text?: string | null;
  property?: { detectedBreak?: DetectedBreakLike | null } | null;
};

export type VertexLike = { x?: number | null; y?: number | null };

export type WordLike = {
  confidence?: number | null;
  boundingBox?: { vertices?: VertexLike[] | null } | null;
  symbols?: SymbolLike[] | null;
};

export type ParagraphLike = { words?: WordLike[] | null };
export type BlockLike = { paragraphs?: ParagraphLike[] | null };
export type PageLike = { blocks?: BlockLike[] | null };

export type FullTextAnnotationLike = {
  text?: string | null;
  pages?: PageLike[] | null;
};

const NEWLINE_BREAKS = new Set<string | number>(['EOL_SURE_SPACE', 'LINE_BREAK', 3, 5]);
const SPACE_BREAKS = new Set<string | number>(['SPACE', 'SURE_SPACE', 1, 2]);

/** HYPHEN, UNKNOWN, unrecognized, and absent breaks synthesize no characters. */
function translateBreak(type: string | number | null | undefined): string {
  if (type === null || type === undefined) {
    return '';
  }
  if (NEWLINE_BREAKS.has(type)) {
    return '\n';
  }
  if (SPACE_BREAKS.has(type)) {
    return ' ';
  }
  return '';
}

type BoxAcc = { minX: number; minY: number; maxX: number; maxY: number };

type LineAcc = {
  text: string;
  /** Total characters contributed by confidence-bearing words. */
  confidenceWeight: number;
  /** Σ(wordConfidence × charsOfWordInLine). */
  confidenceSum: number;
  box: BoxAcc | null;
};

function newLine(): LineAcc {
  return { text: '', confidenceWeight: 0, confidenceSum: 0, box: null };
}

function unionBoxes(a: BoxAcc | null, b: BoxAcc | null): BoxAcc | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function verticesBox(vertices: VertexLike[] | null | undefined): BoxAcc | null {
  let box: BoxAcc | null = null;
  for (const vertex of vertices ?? []) {
    const x = vertex?.x;
    const y = vertex?.y;
    if (typeof x !== 'number' || typeof y !== 'number') {
      continue;
    }
    box = unionBoxes(box, { minX: x, minY: y, maxX: x, maxY: y });
  }
  return box;
}

export function toRecognition(annotation: FullTextAnnotationLike): Recognition {
  const lines: LineAcc[] = [];
  let current = newLine();
  lines.push(current);
  let text = '';

  const closeLine = (): void => {
    current = newLine();
    lines.push(current);
  };

  for (const page of annotation.pages ?? []) {
    for (const block of page?.blocks ?? []) {
      for (const paragraph of block?.paragraphs ?? []) {
        for (const word of paragraph?.words ?? []) {
          const confidence = typeof word?.confidence === 'number' ? word.confidence : null;
          const wordBox = verticesBox(word?.boundingBox?.vertices);
          let charsInLine = 0;

          // Attribute the word's characters (and box) to the line(s) they land
          // in; a word split by an interior break contributes to both lines.
          const flushWordToLine = (): void => {
            if (charsInLine === 0) {
              return;
            }
            if (confidence !== null) {
              current.confidenceSum += confidence * charsInLine;
              current.confidenceWeight += charsInLine;
            }
            current.box = unionBoxes(current.box, wordBox);
            charsInLine = 0;
          };

          for (const symbol of word?.symbols ?? []) {
            const brk = symbol?.property?.detectedBreak;
            if (brk && brk.isPrefix === true) {
              const translated = translateBreak(brk.type);
              if (translated === '\n') {
                flushWordToLine();
                text += translated;
                closeLine();
              } else {
                text += translated;
                current.text += translated;
              }
            }
            const symbolText = symbol?.text ?? '';
            if (symbolText.length > 0) {
              text += symbolText;
              current.text += symbolText;
              charsInLine += symbolText.length;
            }
            if (brk && brk.isPrefix !== true) {
              const translated = translateBreak(brk.type);
              if (translated === '\n') {
                flushWordToLine();
                text += translated;
                closeLine();
              } else {
                text += translated;
                current.text += translated;
              }
            }
          }
          flushWordToLine();
        }
      }
    }
  }

  // Drop exactly one trailing empty line produced by a terminal break; the
  // page text itself keeps the provider's own break semantics.
  const last = lines[lines.length - 1];
  if (lines.length > 0 && last !== undefined && last.text === '') {
    lines.pop();
  }

  const recognizedLines: RecognizedLine[] = lines.map((acc) => ({
    text: acc.text,
    confidence: acc.confidenceWeight > 0 ? acc.confidenceSum / acc.confidenceWeight : 0,
    boundingBox: acc.box
      ? {
          x: acc.box.minX,
          y: acc.box.minY,
          width: acc.box.maxX - acc.box.minX,
          height: acc.box.maxY - acc.box.minY,
        }
      : { x: 0, y: 0, width: 0, height: 0 },
  }));

  return { text, lines: recognizedLines };
}
