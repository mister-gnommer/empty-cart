# Contract: list graph and submission handler

**Module path**: `src/shopping-list/` (`list-graph.ts`, `recognize-list.ts`, `handle-list-submission.ts`, `messages.ts`)
**Depends on**: `@langchain/langgraph`, `zod`, `src/list-sorting/`, `src/categorizer/types.ts` (interface only), the existing image and OCR contracts
**Depended on by**: `src/lifecycle/run-app.ts`, the Discord adapter (unchanged `ListSubmissionHandler` surface)
**Spec refs**: FR-001…FR-009, FR-012, FR-013, FR-017
**Base**: extends the 002 `shopping-list` contract. Metadata checks, the busy guard, the 25 s recognition budget, every 002 message and the "any throw → generic reply" rule are unchanged and not restated here.

## Public surface

```typescript
// Unchanged for the transport:
type ListSubmissionHandler = (input: ListSubmissionInput) => Promise<ListReply>;

// Extended deps:
type ListSubmissionDeps = {
  /* ...002 fields... */
  categorizer: ItemCategorizer | null;   // null = sorting off (FR-009)
  callbacks: BaseCallbackHandler[];      // tracer from src/tracing; [] = untraced (FR-014)
};

// list-graph.ts
type RecognitionOutcome =
  | { status: 'ended'; reply: ListReply }             // any 002 early reply, incl. no-readable-text
  | { status: 'recognized'; readablePages: string[] };

function buildListGraph(deps: {
  recognize: (attachments: readonly SubmissionAttachment[], log: Logger) => Promise<RecognitionOutcome>;
  categorizer: ItemCategorizer | null;
  now: () => number;
}): CompiledListGraph;   // invoked as graph.invoke({ attachments, shopOrder }, { context: { log }, runName, metadata })
```

## Graph

Nodes: `recognize`, `categorize`, `sort`, `unsorted`. Edges and state are as in `data-model.md` (state fields table and transition diagram).

## Rules

1. The handler invokes the graph inside the existing busy guard and `try`. `shopOrder` = `DEFAULT_SHOP_ORDER`. The invoke config carries `callbacks` (the tracer, or `[]`), `runName: 'list-submission'` and `metadata: { correlationId }`. The graph and the agent inside `categorize` inherit the callbacks, so one trace shows every step.
2. **`recognize`** wraps the moved 002 recognition (`recognize-list.ts`). Its output is byte-identical to 002 for every early reply. The old `assembleReply` join (`readablePages.join('\n')`) now lives in `unsorted`.
3. **`categorize`**:
   - More than 200 items → `skipped-too-long`, with no model call.
   - Otherwise calls `categorizer.categorize({ items, signal })` with a 15 s budget. If the categorizer ignores the abort, the node abandons the call when the budget ends and maps it to `timeout`.
   - On `ok`, runs `checkAssignments`; `null` → `invalid-answer`.
4. **`sort`**: `renderSortedList(sortByShopOrder(items, categories, shopOrder))`.
5. **`unsorted`**:
   - Sorting off → `readablePages.join('\n')`, exactly the 002 reply.
   - Fallback → `LIST_MESSAGES.sortingFailedNote + '\n' + readablePages.join('\n')`.
6. **Logging**: each node logs one content-free line, `{ msg: 'list step', step, outcome, durationMs }`, plus `cause` and `categorizerId` for AI-step failures. Never item text, never the model's raw answer. The existing `list submission succeeded` line gains `sorting: 'sorted' | 'fallback' | 'off'`.
7. **New message**: `sortingFailedNote: "I couldn't sort this list this time, so here it is as written:"`.
8. The graph imports nothing from `discord.js`, OCR vendors or `langchain`. LangGraph is its only orchestration import.

## Test obligations

**Contract** (`tests/contract/list-graph.spec.ts`, stub recognize and stub categorizer):
- A recognition early reply → that reply, and the categorizer is never called.
- Sorting off → exactly `readablePages.join('\n')`.
- Categorizer ok → grouped reply.
- Categorizer `failed:*`, a partial or duplicate answer, or more than 200 items → note followed by the verbatim text.
- A categorizer that never settles → `timeout` fallback within the budget (fake timers).
- Each run logs one `list step` line per visited node, with no list text in any line.

**Integration** (`tests/integration/list-sorting.spec.ts`): Discord stub → stub OCR → stub categorizer → grouped reply in the same channel, split correctly when long, and mentions neutralized. All existing 002 integration specs pass unmodified, because their `categorizer` is `null`.

**Log scan**: the existing log-scan spec is extended to a sorted run and to a fallback run.

**Tracing**: a contract test passes a recording `BaseCallbackHandler` and asserts that it sees the `list-submission` run with `correlationId` metadata and the child node runs. No network is involved.
