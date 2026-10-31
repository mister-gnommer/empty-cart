# Data Model: AI List Sorting

All entities are transient: they live for one submission and none is persisted (FR-015).

## Category catalog (`src/list-sorting/category-catalog.ts`)

| ID (`CategoryId`) | Label (English, `CATEGORY_LABELS`) | Shop-walk position (`DEFAULT_SHOP_ORDER`) |
|---|---|---|
| `produce` | Fruit & vegetables | 1 |
| `bakery` | Bread & bakery | 2 |
| `meat-fish` | Meat & fish | 3 |
| `dairy-eggs` | Dairy & eggs | 4 |
| `frozen` | Frozen | 5 |
| `pantry` | Pantry | 6 |
| `drinks` | Drinks | 7 |
| `household` | Household & hygiene | 8 |
| `other` | Other | 9 (always last) |

- `CATEGORY_IDS` is the single list of valid IDs. The zod enum in the agent schema and `checkAssignments` both derive from it.
- Order and labels are separate maps keyed by ID. The model and the sort logic only ever see IDs. Translating headings later replaces `CATEGORY_LABELS` only.
- **Order invariant**: a shop order is a permutation of `CATEGORY_IDS` with `other` last. Any order passed into the graph is checked against this invariant; tests guard it.

## List item

- **Fields**: `text` (string, the exact recognized line, never trimmed or edited) and `line` (1-based position in recognition order).
- **Derived by** `splitItems(readablePages)`: pages joined in photo order, split on `\n`, with lines that are empty or whitespace-only dropped. `\r` is kept as part of the line text. A line that is `"milk\r"` stays `"milk\r"`, because the verbatim rule beats tidiness.

## Category assignment

- **Raw (from the model)**: `{ line: number; category: CategoryId }[]`.
- **Checked (`checkAssignments(raw, itemCount)`)** returns `CategoryId[]` aligned to items, or `null`. The answer is accepted only when:
  1. its length equals `itemCount`;
  2. every `line` is an integer from 1 to `itemCount`;
  3. every line appears exactly once;
  4. every `category` is in `CATEGORY_IDS`.

  Any violation returns `null`, and the whole answer is discarded (FR-006).

## Sorted list

- `{ category: CategoryId; items: string[] }[]`: only non-empty categories, in shop-order position. Items within a category keep their recognition order (a stable group-by).
- **Rendered** (`renderSortedList`): blocks separated by one blank line. Each block is `**<label>**` followed by its item lines, one per line, verbatim. The 2000-character split and mention neutralization stay in the Discord adapter, unchanged.

## Graph state (`src/shopping-list/list-graph.ts`, `StateSchema`)

| Field | Type | Written by | Meaning |
|---|---|---|---|
| `attachments` | `SubmissionAttachment[]` | invoke input | Photos to recognize, in message order. |
| `shopOrder` | `CategoryId[]` | invoke input | The order to sort by. It comes from `DEFAULT_SHOP_ORDER` today, and that is the single place to replace for per-store orders. |
| `readablePages` | `string[]` | `recognize` | Non-blank page texts, verbatim. Empty until recognition succeeds. |
| `items` | `string[]` | `recognize` | `splitItems(readablePages)`. |
| `categories` | `CategoryId[] \| null` | `categorize` | Checked assignments aligned to `items`; `null` when the AI step failed. |
| `sortingFailure` | `SortingFailureCause \| null` | `categorize` | `timeout` · `invalid-answer` · `error` · `skipped-too-long`. |
| `reply` | `string \| null` | `recognize` (early exit), `sort`, `unsorted` | Final reply text. Non-null means the run is done. |

**Runtime context** (not state): `{ log: Logger }`, the logger bound to the submission's correlation ID. It is kept out of state because it is a dependency, not data, and state should hold only plain data.

## Run outcomes (state transitions)

```text
START → recognize ─┬─ reply set (input problem / OCR failure / no readable text) ──────────► END   (002 reply, unchanged)
                   ├─ categorizer is null (sorting off) ─► unsorted ──────────────────────► END   (002 reply, no note)
                   └─ otherwise ─► categorize ─┬─ categories set ─► sort ─────────────────► END   (grouped reply)
                                               └─ sortingFailure set ─► unsorted ─────────► END   (note + 002 reply)
```

The logged step outcome per node is one of: `recognize: ok | ended`, `categorize: ok | failed:<cause>`, `sort: ok`, `unsorted: off | fallback`.
