// The trust boundary for the model's answer. Pure and outside the AI module,
// so no categorizer, present or future, can skip it.
import { type CategoryId, isCategoryId } from './category-catalog';

/** One line/category pair as a categorizer returned it, before this check. */
export type UncheckedAssignment = { line: number; category: string };

/**
 * Accepts the answer only when every line from 1 to `itemCount` appears
 * exactly once with a known category. Takes plain strings on purpose: the
 * model's own schema validation is not trusted.
 * @param raw the categorizer's line/category pairs, in any order
 * @param itemCount how many items were sent
 * @returns categories aligned to the items, or null to discard the whole answer
 */
export function checkAssignments(
  raw: readonly UncheckedAssignment[],
  itemCount: number,
): CategoryId[] | null {
  if (raw.length !== itemCount) {
    return null;
  }
  const byLine = new Map<number, CategoryId>();
  for (const { line, category } of raw) {
    if (!Number.isInteger(line) || line < 1 || line > itemCount || byLine.has(line)) {
      return null;
    }
    if (!isCategoryId(category)) {
      return null;
    }
    byLine.set(line, category);
  }
  const aligned: CategoryId[] = [];
  for (let line = 1; line <= itemCount; line += 1) {
    const category = byLine.get(line);
    if (category === undefined) {
      return null;
    }
    aligned.push(category);
  }
  return aligned;
}
