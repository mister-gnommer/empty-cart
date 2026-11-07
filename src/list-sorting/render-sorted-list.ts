import { CATEGORY_LABELS } from './category-catalog';
import type { SortedGroup } from './sort-list';

/**
 * Renders the sorted groups as the reply text: a bold label heading per group,
 * its items verbatim one per line, groups separated by one blank line.
 * @param groups non-empty groups in shop order
 */
export function renderSortedList(groups: readonly SortedGroup[]): string {
  return groups
    .map((group) => [`**${CATEGORY_LABELS[group.category]}**`, ...group.items].join('\n'))
    .join('\n\n');
}
