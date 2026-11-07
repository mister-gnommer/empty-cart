# Dev notes

## Decisions

### No retry when the categorizer's answer fails `checkAssignments` (2026-11-07)

**Today:** the model answers through a tool call, and LangChain's `createAgent` checks the answer against the schema. If the shape or a category is wrong, it sends the error back and the model tries again. If the answer passes the schema but fails `checkAssignments` (wrong number of lines, or a line missing, repeated or out of range), the list goes straight to the unsorted fallback with no retry.

**Why not retry:** LangChain checks answers against the JSON Schema it builds from the zod schema, so a zod `.refine` is dropped. JSON Schema can't say "each line number exactly once" for an array of `{ line, category }` objects, so the retry can't be extended to those mistakes just by tightening the schema. The other options cost more than a failure we haven't seen yet.

**Spotting it:** `list step` log lines with `step: "categorize"`, `cause: "invalid-answer"`. That cause also covers answers that never passed the schema; the LangSmith trace tells them apart (`checkAssignments` failures have a structured response, schema failures don't).

**If it becomes a problem, options:**

- **Answer keyed by line number:** `{ "1": "dairy-eggs", "2": "produce", … }`, with a strict schema built per list that requires exactly the keys `1`…`n`. JSON Schema enforces that, so LangChain's retry covers every count, gap, repeat and range mistake. The categorizer converts the answer back to today's assignments. Cost: the schema repeats the 9 category IDs for each line, about 50 input tokens per line (~10k at the 200-line cap), and the agent is built per list.
- **Exact count only:** keep the current shape and add an exact length and a `1`…`n` line range to a per-list schema. Smallest change, but a repeated line (which means another is missing) still isn't retried.
- **Own retry loop:** when `checkAssignments` fails, the categorizer sends the problem back to the model and asks once more, within the 15 s sorting budget. Covers everything with no extra schema tokens, at the cost of about 20 lines that sit next to LangChain's own retry.

Any retry is another model call inside the same 15 s budget. Keep `checkAssignments` as the final gate whichever option is chosen.
