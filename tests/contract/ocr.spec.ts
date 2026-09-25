import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisabledProvider } from '../../src/ocr/disabled-provider';
import type {
  OcrProvider,
  OcrProviderResult,
  Recognition,
  RecognizedLine,
} from '../../src/ocr/types';

function line(text: string, confidence = 0.9): RecognizedLine {
  return { text, confidence, boundingBox: { x: 0, y: 0, width: 100, height: 20 } };
}

const fidelityFixtures: { name: string; recognition: Recognition }[] = [
  { name: 'empty page', recognition: { text: '', lines: [] } },
  {
    name: 'single line without terminal break',
    recognition: { text: 'Milk', lines: [line('Milk')] },
  },
  {
    name: 'multiple lines',
    recognition: { text: 'Milk\nEggs\nBread', lines: [line('Milk'), line('Eggs'), line('Bread')] },
  },
  {
    name: 'interior blank line preserved',
    recognition: { text: 'Milk\n\nBread', lines: [line('Milk'), line(''), line('Bread')] },
  },
  {
    name: 'terminal break keeping one trailing empty line',
    recognition: { text: 'Milk\nEggs\n', lines: [line('Milk'), line('Eggs'), line('')] },
  },
  {
    name: 'terminal break with the single trailing empty line dropped',
    recognition: { text: 'Milk\n', lines: [line('Milk')] },
  },
  {
    name: 'whitespace and unicode preserved verbatim',
    recognition: {
      text: '  spaces  \tkept \nżółć — tästä',
      lines: [line('  spaces  \tkept '), line('żółć — tästä')],
    },
  },
];

function fidelityHolds(recognition: Recognition): boolean {
  const joined = recognition.lines.map((l) => l.text).join('\n');
  // Exact equality, or exactly one trailing empty line from a terminal break dropped.
  return joined === recognition.text || `${joined}\n` === recognition.text;
}

describe('recognition fidelity invariant', () => {
  for (const fixture of fidelityFixtures) {
    it(`joined lines reconstruct the page text: ${fixture.name}`, () => {
      expect(fidelityHolds(fixture.recognition)).toBe(true);
    });
  }

  it('every fixture line carries in-range confidence and a finite bounding box', () => {
    for (const fixture of fidelityFixtures) {
      for (const l of fixture.recognition.lines) {
        expect(l.confidence).toBeGreaterThanOrEqual(0);
        expect(l.confidence).toBeLessThanOrEqual(1);
        for (const value of Object.values(l.boundingBox)) {
          expect(Number.isFinite(value)).toBe(true);
        }
      }
    }
  });
});

describe('createDisabledProvider', () => {
  const request: Parameters<OcrProvider['recognize']>[0] = {
    image: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), format: 'jpeg' },
    languageHints: [],
    timeoutMs: 1000,
  };
  const disabledResult: OcrProviderResult = { status: 'unavailable', cause: 'disabled' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('identifies itself as disabled', () => {
    expect(createDisabledProvider().id).toBe('disabled');
  });

  it('every call resolves unavailable/disabled', async () => {
    const provider = createDisabledProvider();
    await expect(provider.recognize(request)).resolves.toEqual(disabledResult);
    await expect(provider.recognize(request)).resolves.toEqual(disabledResult);
  });

  it('performs no network access (sabotaged global fetch is never reached)', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('disabled provider must not touch the network');
    });
    const provider = createDisabledProvider();
    await expect(provider.recognize(request)).resolves.toEqual(disabledResult);
  });
});
