import { describe, expect, it } from 'vitest';
import { CATEGORY_IDS, DEFAULT_SHOP_ORDER } from '../../src/list-sorting/category-catalog';

describe('category catalog', () => {
  it('the default shop order covers every category exactly once, with other last', () => {
    expect([...DEFAULT_SHOP_ORDER].sort()).toEqual([...CATEGORY_IDS].sort());
    expect(DEFAULT_SHOP_ORDER.at(-1)).toBe('other');
  });
});
