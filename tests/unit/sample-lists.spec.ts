import { describe, expect, it } from 'vitest';
import { SAMPLE_LISTS } from '../../evals/sample-lists';
import { CATEGORY_IDS } from '../../src/list-sorting/category-catalog';

// The eval scores the model against these lists; a malformed sample would
// silently skew every score, so the set's shape is checked without any model.
describe('sample lists for the categorization eval', () => {
  it('every sample pairs each non-blank line with one known category', () => {
    for (const sample of SAMPLE_LISTS) {
      expect(sample.expected, sample.name).toHaveLength(sample.lines.length);
      for (const line of sample.lines) {
        expect(line.trim(), sample.name).not.toBe('');
      }
      for (const category of sample.expected) {
        expect(CATEGORY_IDS, sample.name).toContain(category);
      }
    }
  });

  it('covers both languages, a mix, prompt injection and every category', () => {
    const count = (language: string) => SAMPLE_LISTS.filter((s) => s.language === language).length;
    expect(SAMPLE_LISTS.length).toBeGreaterThanOrEqual(10);
    expect(count('pl')).toBeGreaterThanOrEqual(3);
    expect(count('en')).toBeGreaterThanOrEqual(3);
    expect(count('mixed')).toBeGreaterThanOrEqual(1);
    expect(SAMPLE_LISTS.filter((s) => s.injection === true).length).toBeGreaterThanOrEqual(2);
    const used = new Set(SAMPLE_LISTS.flatMap((s) => s.expected));
    expect([...used].sort()).toEqual([...CATEGORY_IDS].sort());
  });

  it('sample names are unique, so per-sample scores can be told apart', () => {
    const names = SAMPLE_LISTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
