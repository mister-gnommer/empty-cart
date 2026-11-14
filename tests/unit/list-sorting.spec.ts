import { describe, expect, it } from 'vitest';
import {
  CATEGORY_IDS,
  type CategoryId,
  DEFAULT_SHOP_ORDER,
} from '../../src/list-sorting/category-catalog';
import { checkAssignments } from '../../src/list-sorting/check-assignments';
import { renderSortedList } from '../../src/list-sorting/render-sorted-list';
import { sortByShopOrder, splitItems } from '../../src/list-sorting/sort-list';

describe('splitItems', () => {
  it('one item per non-blank line, photo order then line order, text untouched', () => {
    expect(splitItems(['milk\n\n  \napples', ' 2x  bread \r\nmilk'])).toEqual([
      'milk',
      'apples',
      ' 2x  bread \r',
      'milk',
    ]);
  });
});

describe('checkAssignments', () => {
  const answer = (pairs: [number, string][]) =>
    pairs.map(([line, category]) => ({ line, category }));

  it('accepts a complete answer in any order and aligns it to the items', () => {
    expect(
      checkAssignments(
        answer([
          [3, 'bakery'],
          [1, 'dairy-eggs'],
          [2, 'produce'],
        ]),
        3,
      ),
    ).toEqual(['dairy-eggs', 'produce', 'bakery']);
  });

  it.each([
    ['a missing line', answer([[1, 'produce']])],
    [
      'a duplicate line',
      answer([
        [1, 'produce'],
        [1, 'bakery'],
      ]),
    ],
    [
      'line 0',
      answer([
        [0, 'produce'],
        [1, 'bakery'],
      ]),
    ],
    [
      'a line past the end',
      answer([
        [1, 'produce'],
        [3, 'bakery'],
      ]),
    ],
    [
      'a non-integer line',
      answer([
        [1, 'produce'],
        [1.5, 'bakery'],
      ]),
    ],
    [
      'an unknown category',
      answer([
        [1, 'produce'],
        [2, 'snacks'],
      ]),
    ],
    [
      'extra entries',
      answer([
        [1, 'produce'],
        [2, 'bakery'],
        [2, 'bakery'],
      ]),
    ],
  ])('rejects %s', (_case, raw) => {
    expect(checkAssignments(raw, 2)).toBeNull();
  });
});

describe('sortByShopOrder', () => {
  it('groups by category in shop order, keeping recognition order within a group', () => {
    const items = ['milk', 'apples', 'bread', 'chicken', 'tomatoes'];
    const categories: CategoryId[] = ['dairy-eggs', 'produce', 'bakery', 'meat-fish', 'produce'];
    expect(sortByShopOrder(items, categories, DEFAULT_SHOP_ORDER)).toEqual([
      { category: 'produce', items: ['apples', 'tomatoes'] },
      { category: 'bakery', items: ['bread'] },
      { category: 'meat-fish', items: ['chicken'] },
      { category: 'dairy-eggs', items: ['milk'] },
    ]);
  });

  it('follows the order it is given, not the default one', () => {
    const reversed = [...DEFAULT_SHOP_ORDER].reverse();
    expect(
      sortByShopOrder(['apples', 'soap'], ['produce', 'household'], reversed).map(
        (g) => g.category,
      ),
    ).toEqual(['household', 'produce']);
  });

  it('throws on a category missing from the order (a programming error, never silent loss)', () => {
    expect(() => sortByShopOrder(['apples'], ['produce'], ['bakery', 'other'])).toThrow();
  });
});

describe('renderSortedList', () => {
  it('bold label headings, verbatim items, one blank line between blocks', () => {
    expect(
      renderSortedList([
        { category: 'produce', items: ['apples', 'tomatoes'] },
        { category: 'other', items: ['batteries'] },
      ]),
    ).toBe('**Fruit & vegetables**\napples\ntomatoes\n\n**Other**\nbatteries');
  });
});

describe('sorting never loses, adds or rewrites a line', () => {
  /**
   * Deterministic PRNG so failures reproduce.
   * @param seed starting state
   */
  function prng(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
      return state / 2 ** 31;
    };
  }

  it('the rendered item lines are a permutation of the input items', () => {
    const random = prng(42);
    const words = ['milk', 'mleko', '2x bread', 'milk', 'ser żółty', '**bold**', 'Other'];
    for (let run = 0; run < 50; run += 1) {
      const count = 1 + Math.floor(random() * 12);
      const items = Array.from({ length: count }, () => words[Math.floor(random() * words.length)]);
      const categories = items.map(() => CATEGORY_IDS[Math.floor(random() * CATEGORY_IDS.length)]);
      const sorted = sortByShopOrder(items, categories, DEFAULT_SHOP_ORDER);
      const renderedItems = sorted.flatMap((group) => group.items);
      expect([...renderedItems].sort()).toEqual([...items].sort());
      expect(renderSortedList(sorted).split('\n').length).toBe(
        count + sorted.length + (sorted.length - 1),
      );
    }
  });
});
