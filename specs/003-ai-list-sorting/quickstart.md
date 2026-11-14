# Quickstart: validating AI List Sorting

Everything here runs inside the branch. VPS deployment happens after merge (constitution, workflow item 7).

## 1. Automated suite (no external network, no API keys)

```bash
npm ci
npm run typecheck && npm test && npm run lint
```

**Expected**: all green. The suite covers the unit, contract and integration obligations in [contracts/](./contracts/). Every existing 002 spec passes unmodified, because their categorizer is `null` (sorting off).

## 2. Eval against the real model (operator, costs a few cents)

```bash
export SORTING_MODEL=anthropic:claude-haiku-5-5
export SORTING_BASE_URL=https://opencode.ai/inference/anthropic
export SORTING_API_KEY=...          # OpenCode key, never commit
npm run eval
```

Or put the three `SORTING_*` lines (without `export`) in `.env` at the repo root, which is gitignored: `npm run eval` loads it, and variables already set in the shell win. *Added 2026-11-14*: the exports were lost with the terminal, so the setup had to be rediscovered.

**Expected**:
- a table with one row per sample list (≥ 10) and an `accuracy` column;
- an overall accuracy line ≥ 0.90 (SC-002);
- the injection samples pass, with every line rendered verbatim (SC-006);
- every sample passes. A failed sample means the model call itself failed, and its message names the cause and error class (e.g. `BadRequestError`).

**Optional, to see the run in LangSmith**: also set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY=...` (for this command only, never for the bot). The same command then creates a dataset and an experiment in LangSmith.

## 3. Local bot run

Set `SORTING_MODEL`, `SORTING_BASE_URL` and `SORTING_API_KEY`, plus `LANGSMITH_API_KEY` (tracing is on by default; do **not** set `LANGSMITH_TRACING`), plus the existing `DISCORD_TOKEN`, `OCR_PROVIDER=gcp-vision` and `GCP_SA_KEY_PATH`, in `.env`. Then run `npm run dev` and send a list photo in an allowed channel.

| Check | Expected |
|---|---|
| A list photo such as "milk / apples / bread / chicken / tomatoes" | `**Fruit & vegetables**` apples, tomatoes → `**Bread & bakery**` bread → `**Meat & fish**` chicken → `**Dairy & eggs**` milk |
| Unset `SORTING_MODEL`, restart, send the same photo | Exactly the 002 reply (verbatim text, no note) |
| Set `SORTING_API_KEY=invalid`, restart, send the photo | The note "I couldn't sort this list this time…" followed by the verbatim text |
| Unset `LANGSMITH_API_KEY`, restart | One `tracing disabled` warning at startup; lists still work, untraced |
| `TRACING=off` with the key set, restart | No new runs appear in LangSmith |
| `grep -i apples` over the bot's stdout logs | No matches; only `list step` lines with outcomes and durations |
| Open the `empty-cart` LangSmith project | A `list-submission` run whose metadata `correlationId` matches the logs, with child runs `recognize → categorize → sort` |

## 4. Learning pass

~~`grep -rn "learn:" src evals` lists every annotated LangGraph, LangChain and LangSmith call.~~ *Superseded 2026-11-13 (PR review)*: the learning pass is done and the `learn:` comments are removed. The reading order stays useful: `src/shopping-list/list-graph.ts` → `src/categorizer/agent-backed-categorizer.ts` → `evals/categorize.eval.ts`.
