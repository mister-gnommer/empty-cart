# Contract: `list-sorting` (pure)

**Module path**: `src/list-sorting/`
**Depends on**: nothing (no AI, logging, or vendor imports)
**Depended on by**: `src/shopping-list/list-graph.ts`, `src/categorizer/`, `evals/`
**Spec refs**: FR-001, FR-003, FR-004, FR-005, FR-006; §Assumptions "Heading language" and "Built to extend"

## Public surface

```typescript
type CategoryId =
  | 'produce' | 'bakery' | 'meat-fish' | 'dairy-eggs' | 'frozen'
  | 'pantry' | 'drinks' | 'household' | 'other';

const CATEGORY_IDS: readonly CategoryId[];
const DEFAULT_SHOP_ORDER: readonly CategoryId[];        // data-model.md order
const CATEGORY_LABELS: Readonly<Record<CategoryId, string>>;

function splitItems(readablePages: readonly string[]): string[];
type UncheckedAssignment = { line: number; category: string };   // the categorizer's answer before the check
function checkAssignments(
  raw: readonly UncheckedAssignment[],
  itemCount: number,
): CategoryId[] | null;
function sortByShopOrder(
  items: readonly string[],
  categories: readonly CategoryId[],
  shopOrder: readonly CategoryId[],
): { category: CategoryId; items: string[] }[];
function renderSortedList(sorted: ReturnType<typeof sortByShopOrder>): string;
```

## Rules

1. `splitItems` keeps every non-blank line byte for byte and in order. It never trims, merges or dedupes.
2. `checkAssignments` is the trust boundary for model output. It accepts the answer only when every line from 1 to `itemCount` appears exactly once with a known category ID; anything else returns `null`. It takes `category: string`, so it does not trust the model's own schema validation.
3. `sortByShopOrder` is a stable group-by. It includes only non-empty categories and orders them by `shopOrder`. A category ID missing from `shopOrder` is a programming error and throws (guarded by the catalog invariant test).
4. `renderSortedList` output contains each item exactly once, verbatim. Headings are `**<CATEGORY_LABELS[id]>**`, and blocks are separated by one blank line.

## Test obligations (unit, written first)

- Catalog: `DEFAULT_SHOP_ORDER` is a permutation of `CATEGORY_IDS` with `other` last, and every ID has a label.
- `splitItems`: drops blank and whitespace-only lines, keeps duplicates and inner whitespace, preserves photo-then-line order.
- `checkAssignments`: accepts a valid permutation in any order. Returns `null` on a missing line, a duplicate line, line 0, line `itemCount + 1`, a non-integer line, an unknown category, or extra entries.
- `sortByShopOrder`: the spec's "milk / apples / bread / chicken / tomatoes" example gives produce [apples, tomatoes] → bakery → meat-fish → dairy-eggs. Within-group order is stable, and empty categories are omitted.
- Property: for any items and valid categories, the multiset of rendered item lines equals the multiset of input items (SC-001).
