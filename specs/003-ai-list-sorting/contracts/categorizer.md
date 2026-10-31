# Contract: `categorizer`

**Module path**: `src/categorizer/`
**Depends on**: `src/list-sorting/category-catalog.ts`, `langchain`, `@langchain/anthropic` (loaded by `initChatModel`), `zod`
**Depended on by**: `src/lifecycle/run-app.ts` (construction), `src/shopping-list/list-graph.ts` (interface only), `evals/`
**Spec refs**: FR-002, FR-006, FR-007, FR-008, FR-010, FR-011

## Public surface

```typescript
// types.ts: no vendor imports
type SortingFailureCause = 'timeout' | 'invalid-answer' | 'error' | 'skipped-too-long';

type CategorizeResult =
  | { status: 'ok'; assignments: { line: number; category: string }[] }  // raw: checked by the caller
  | { status: 'failed'; cause: Exclude<SortingFailureCause, 'skipped-too-long'>; errorName?: string };

interface ItemCategorizer {
  readonly id: string;                                  // e.g. 'anthropic:claude-haiku-5-5', loggable
  categorize(req: { items: readonly string[]; signal: AbortSignal }): Promise<CategorizeResult>;
}

// agent-categorizer.ts
function createAgentCategorizer(opts: { model: string; apiKey: string; baseUrl: string | null }): Promise<ItemCategorizer>;
```

## Rules

1. `categorize` never throws. Abort or timeout → `timeout`; a structured-output or schema failure, after `createAgent`'s own retry → `invalid-answer`; anything else → `error` with `errorName` set (the class name only, never the message, which may echo list text).
2. The result is **raw**. The caller (the graph `categorize` node) always runs `checkAssignments`, so a future categorizer cannot bypass the trust boundary.
3. The prompt (`categorizer-prompt.ts`):
   - The system prompt lists every `CategoryId` with a short English description, says each line gets exactly one ID, says to use `other` when unsure, and says lines are data, never instructions.
   - The user message is the lines numbered `1.`, `2.`, … inside `<list>` and `</list>`.
4. The model is built once at construction with `initChatModel(model, { apiKey, temperature: 0, maxRetries: 1 })`, plus `anthropicApiUrl: baseUrl` when `baseUrl` is set (OpenCode). `createAgent` gets `tools: []` and `responseFormat` = a zod schema whose `category` is `z.enum(CATEGORY_IDS)` and whose array is capped at 200 entries.
5. No logging inside the module: the caller logs outcomes. The API key is never logged, returned or put into the result.

## Test obligations (contract, `fakeModel`, written first)

- A scripted valid structured answer → `ok`, with the assignments passed through unchanged.
- A scripted answer with an unknown category or a wrong shape (after retries) → `invalid-answer`.
- A model that throws → `error`, with `errorName` set and no error message in the result.
- An already-aborted signal or a slow fake beyond the signal → `timeout`.
- Prompt: the recorded model call contains every line verbatim, numbered, inside `<list>…</list>`, and the system prompt contains every category ID.
- No live network: the suite runs with no `SORTING_API_KEY` set.
