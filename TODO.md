# TODO

## Human notes

- add updates flow as in cheatsheet


## Agent notes

### current


- [x] Simplify `unlessExpired` (`src/shopping-list/unless-expired.ts`) with `Promise.race`, about 25 → 12 lines, same behavior:
  ```ts
  const expired = new Promise<typeof BUDGET_EXPIRED>((resolve) => {
    if (budgetExpiry.aborted) { resolve(BUDGET_EXPIRED); }
    budgetExpiry.addEventListener('abort', () => resolve(BUDGET_EXPIRED), { once: true });
  });
  return Promise.race([expired, work]); // `expired` first: an already-aborted budget wins
  ```
  Race subscribes to `work`, so late rejections stay handled. The abort listener isn't removed when `work` wins (harmless: one signal per budget). Check that a test covers a late rejection of abandoned work.

### deferred


- [ ] (deferred after feature 003) add the mermaid graph to `docs/DEV_NOTES.md`, add to constitution it should be kept up to date.
  - Generate the graph with `(await graph.getGraphAsync()).drawMermaid()` on a graph built with stub deps (nothing runs when drawing). Do the edge-label item below first so the diagram reads on its own.
- [ ] (deferred after feature 003) Label the conditional edges in `src/shopping-list/list-graph.ts` so the Mermaid diagram shows them (today the dotted arrows have no labels). Pass the targets as an object instead of an array; the router returns a key, and the key becomes the edge label (tested, works):
  ```ts
  .addConditionalEdges('categorize', (state) => (state.categories === null ? 'failed' : 'categorized'), {
    categorized: 'sort',
    failed: 'unsorted',
  })
  ```
  Suggested labels after `recognize`: `ended` → END, `sorting-off` → unsorted, `sorting-on` → categorize. The labels are names you choose; the diagram can't show the conditions themselves.