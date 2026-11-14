// Deterministic split and sort. The AI only ever decides categories; which
// lines exist and where they go is decided here.
import type { CategoryId } from './category-catalog';

export type SortedGroup = { category: CategoryId; items: string[] };

/**
 * Splits the readable pages into items: one per non-blank line, in photo order
 * then line order. Text is never trimmed, merged or deduplicated, so a sorted
 * reply can only reorder what was recognized.
 * @param readablePages recognized page texts in attachment order
 */
export function splitItems(readablePages: readonly string[]): string[] {
  return readablePages.flatMap((page) => page.split('\n')).filter((line) => line.trim().length > 0);
}

/**
 * Groups items by category in the given shop order. Within a group, items keep
 * their recognition order; categories without items are left out.
 * @param items the list items in recognition order
 * @param categories one category per item, aligned by index
 * @param shopOrder the walk order to follow; must contain every category used
 */
export function sortByShopOrder(
  items: readonly string[],
  categories: readonly CategoryId[],
  shopOrder: readonly CategoryId[],
): SortedGroup[] {
  const groups = new Map<CategoryId, string[]>(shopOrder.map((id) => [id, []]));
  items.forEach((item, index) => {
    const group = groups.get(categories[index]);
    if (group === undefined) {
      throw new Error(`shop order has no position for category ${categories[index]}`);
    }
    group.push(item);
  });
  return [...groups]
    .filter(([, groupItems]) => groupItems.length > 0)
    .map(([category, groupItems]) => ({ category, items: groupItems }));
}
