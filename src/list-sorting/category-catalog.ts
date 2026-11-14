// The fixed category catalog. Identity (IDs), shop-walk order and display
// labels are kept apart on purpose: per-store orders will replace only the
// order, and translated headings will replace only the labels.

export const CATEGORY_IDS = [
  'produce',
  'bakery',
  'meat-fish',
  'dairy-eggs',
  'frozen',
  'pantry',
  'drinks',
  'household',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/** The one predefined shop walk. The single place a per-store order will later replace. */
export const DEFAULT_SHOP_ORDER: readonly CategoryId[] = Object.freeze([
  'produce',
  'bakery',
  'meat-fish',
  'dairy-eggs',
  'frozen',
  'pantry',
  'drinks',
  'household',
  'other',
]);

export const CATEGORY_LABELS: Readonly<Record<CategoryId, string>> = Object.freeze({
  produce: 'Fruit & vegetables',
  bakery: 'Bread & bakery',
  'meat-fish': 'Meat & fish',
  'dairy-eggs': 'Dairy & eggs',
  frozen: 'Frozen',
  pantry: 'Pantry',
  drinks: 'Drinks',
  household: 'Household & hygiene',
  other: 'Other',
});

const KNOWN_IDS: ReadonlySet<string> = new Set(CATEGORY_IDS);

/** Narrows an untrusted string (e.g. from a model answer) to a known category. */
export function isCategoryId(value: string): value is CategoryId {
  return KNOWN_IDS.has(value);
}
