# Implementation Plan: AI List Sorting

**Branch**: `003-ai-list-sorting` | **Date**: 2026-10-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-ai-list-sorting/spec.md`

## Summary

After OCR, the list is split into one item per non-blank line. An LLM agent assigns each line a category ID from a fixed catalog, and plain code groups the lines by a fixed shop-walk order and renders them under headings. If the AI step fails, the bot replies with today's verbatim text plus a one-line note. If the AI step is switched off, it replies with exactly today's text.

The list flow becomes a small **LangGraph `StateGraph`** with four nodes: `recognize`, `categorize`, `sort` and `unsorted`, joined by two conditional edges. The `categorize` node calls a **LangChain `createAgent`** agent that has no tools and returns zod-typed structured output. **LangSmith** is used two ways: per-step tracing through an explicit `LangChainTracer` callback, **on by default** for the test period (issue #16 switches it off later), and a `langsmith/vitest` eval suite over synthetic sample lists. Model calls go through **OpenCode**'s Anthropic-compatible gateway to `claude-haiku-5-5`.

Learning goal (spec §Assumptions): every library touchpoint carries a one-line `// learn:` comment, and the graph wiring fits in one file that can be read in one sitting.

## Technical Context

**Language/Version**: TypeScript 7.0.2 on Node 24, CommonJS output (`module: node16`), unchanged.

**Primary Dependencies** (new, pinned exactly):
- `langchain` 1.6.0: `createAgent`, `initChatModel`, `fakeModel`
- `@langchain/core` 1.3.2: required peer of `langchain`
- `@langchain/langgraph` 1.6.0: `StateGraph`, `StateSchema`
- `@langchain/anthropic` 1.6.0: provider package that `initChatModel` loads for `anthropic:*`; it talks to OpenCode via a base-URL override
- `langsmith` 0.11.6, the same version `langchain` resolves: the tracer's `Client` at runtime, and `langsmith/vitest` for evals

Also bump the existing `zod` 4.4.3 → 4.6.7 (security advisory GHSA-mrhx-c7xc-m3w5; zod now parses untrusted model output). See research §R9.

**Storage**: None. No checkpointer and no store (FR-015).

**Testing**: Vitest 4 (existing unit/contract/integration projects). LangChain's `fakeModel` covers agent contract tests (plus one test that builds the real model against a local HTTP server, added 2026-11-07), a stub `ItemCategorizer` covers graph and flow tests, and a separate `vitest.eval.config.ts` runs the live-model eval suite outside `npm test`.

**Target Platform**: The existing single Linux VPS (systemd), unchanged.

**Project Type**: Single-project Node service (Discord bot).

**Performance Goals**: Sorted reply within 40 s for a typical list in ≥ 90 % of attempts (SC-003). That is the 25 s OCR budget plus the 15 s AI budget, and in practice it's far faster.

**Constraints**:
- AI step budget of 15 s (FR-008).
- Item text is never taken from the model (FR-002).
- No list text in logs (FR-013).
- Tracing on by default, can be switched off, and runs untraced with a warning when its key is missing (FR-014).
- Lists over 200 items skip the AI step (research §R6).

**Scale/Scope**: Single user in practice, multi-user-safe by design. One AI call per submission.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

| Principle | How this plan satisfies it |
|---|---|
| I. Test-First | Every new module has test obligations in its contract, written red first: pure sorting (unit), agent categorizer via `fakeModel` (contract), graph routing via stub categorizer (contract), Discord flow (integration). The suite never calls a live model. |
| II. Modular Orchestration | The AI sits behind a local `ItemCategorizer` interface (`src/categorizer/`). Sorting and rendering are pure (`src/list-sorting/`). The graph only composes them and knows nothing about Discord. Biome zones confine each new library to one module. |
| III. Observability | Each graph node logs one content-free `list step` line (step, outcome, duration, correlation ID). Optional LangSmith traces carry the correlation ID as metadata. |
| IV. Data Privacy & Integrity | Nothing is persisted (no checkpointer). Logs stay content-free (log scan extended). Tracing is on by default only for the test period, with the operator's documented consent and a tracked revert (issue #16); retention is noted in the spec. The API key is a redacted secret. No cross-user state. |
| V. Simplicity & YAGNI | AI only decides categories; split, check, sort and render are deterministic. The graph and agent are heavier than a plain function plus one SDK call. This is justified in Complexity Tracking. |
| Constraint: external deps abstracted | `ItemCategorizer` interface; the provider is chosen by a `provider:model` config string. |
| Constraint: graceful degradation | Every AI-step failure produces the unsorted fallback with a note, never the generic error and never silence. |
| Workflow 7: validate in branch | No VPS deploy or live smoke tasks. The live-model eval is an operator tool, not a merge gate. |

**Gate result**: PASS, with two justified complexity entries.

## Project Structure

### Documentation (this feature)

```text
specs/003-ai-list-sorting/
├── plan.md              # this file
├── research.md          # Phase 0: library and design decisions
├── data-model.md        # Phase 1: entities, graph state, validation rules
├── quickstart.md        # Phase 1: how to validate locally
├── contracts/
│   ├── list-sorting.md  # pure catalog/split/check/sort/render
│   ├── categorizer.md   # ItemCategorizer + agent implementation
│   ├── list-graph.md    # graph state, nodes, edges, reply shapes
│   └── config.md        # SORTING_*, TRACING, LANGSMITH_*
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── list-sorting/                     # NEW: pure, no AI libraries
│   ├── category-catalog.ts           # CategoryId, DEFAULT_SHOP_ORDER, CATEGORY_LABELS
│   ├── sort-list.ts                  # splitItems, sortByShopOrder
│   ├── check-assignments.ts          # trust boundary for the model's answer
│   └── render-sorted-list.ts         # headings + lines → reply text
├── categorizer/                      # NEW: the ONLY place for langchain + provider packages
│   ├── types.ts                      # ItemCategorizer interface (no vendor imports)
│   ├── categorizer-prompt.ts         # system prompt + numbered, delimited user message
│   └── agent-categorizer.ts          # initChatModel + createAgent + responseFormat (zod)
├── shopping-list/
│   ├── handle-list-submission.ts     # CHANGED: guard + metadata checks, then graph.invoke
│   ├── recognize-list.ts             # MOVED from the handler: budget, download, OCR
│   ├── list-graph.ts                 # NEW: StateSchema + 4 nodes + edges (the learning file)
│   └── messages.ts                   # + sortingFailedNote
├── config/                           # CHANGED: SORTING_*, TRACING, LANGSMITH_*
├── tracing/                          # NEW: the ONLY place for the langsmith Client
│   └── create-tracer.ts              # LangChainTracer callbacks + flush() for shutdown
├── logger/create-logger.ts           # CHANGED: redact *.apiKey
├── shared/types.ts                   # CHANGED: SortingConfig + TracingConfig unions on Config
└── lifecycle/run-app.ts              # CHANGED: build categorizer (or null) and tracer, inject; flush traces on shutdown

evals/                                # NEW: operator-only, never run by `npm test`
├── sample-lists.ts                   # ≥10 synthetic PL/EN lists with expected categories
└── categorize.eval.ts                # langsmith/vitest suite, per-sample + overall accuracy

tests/
├── unit/list-sorting.spec.ts         # NEW
├── contract/agent-categorizer.spec.ts# NEW (fakeModel)
├── contract/list-graph.spec.ts       # NEW (stub categorizer)
├── helpers/stub-categorizer.ts       # NEW
├── integration/list-sorting.spec.ts  # NEW (Discord stub → sorted reply / fallback)
└── (existing list-ocr, log-scan, config specs extended; all existing replies unchanged when sorting is off)

vitest.eval.config.ts                 # NEW: includes evals/**, langsmith reporter
```

**Structure Decision**: Keep the single-project layout and add two modules (`list-sorting`, `categorizer`). The graph lives inside `src/shopping-list/` because it is the list flow's orchestrator. It replaces the old in-handler `recognizeAll` call and keeps the busy guard and metadata checks in front of it, so 002 behavior is untouched. Recognition is injected into the graph builder as a function, so the graph does not import Discord, OCR vendors or LangChain.

Biome zones gain these entries:
- `langchain`, `@langchain/core` and `@langchain/anthropic`: only `src/categorizer/**`.
- `@langchain/langgraph`: only `src/shopping-list/**`.
- `zod`: additionally `src/categorizer/**` and `src/shopping-list/**`. The schemas used by `StateSchema` and `responseFormat` are zod.
- `langsmith` and `@langchain/core/tracers/*`: only `src/tracing/**` (plus `evals/**` and `tests/**`).
- `@langchain/core` type-only imports (`BaseCallbackHandler`): also `src/shopping-list/**`, so the handler can accept the tracer's callbacks.

The zone sentence in `AGENTS.md` is updated to match.

**Learning comments**: in `list-graph.ts`, `agent-categorizer.ts`, `create-tracer.ts` and `categorize.eval.ts`, plus the `graph.invoke` call in `handle-list-submission.ts`, every library call gets a one-line `// learn:` comment (spec §Assumptions). Example: `// learn: compile() freezes the wiring into a runnable; no checkpointer means state dies after invoke`. They are excluded from the usual "comment only the why" rule and can be removed with one grep.

**Extension points kept open** (spec §Assumptions "Built to extend"):
- **Shop order:** enters the graph as state input `shopOrder`. Today the handler fills it from `DEFAULT_SHOP_ORDER`; later a `chooseStore` node or a store lookup fills it.
- **Category IDs and labels:** kept separate, so translating headings swaps only `CATEGORY_LABELS`.
- **Graph composition:** the compiled list graph can later become a subgraph node behind a photo/chat router.
- **The agent:** later receives tools (`save_store_order`) and a store without changing its contract.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| LangGraph `StateGraph` for a 4-step linear flow with 2 branches | The maintainer's explicit learning goal (spec §Assumptions). It's also the foundation the next features need: a chat path, a checkpointer for conversations, and a store for per-store orders. | Plain sequential `await`s would be fine for this feature alone, but would be thrown away when the chat/agent path arrives, which the spec forbids ("built to extend, not to replace"). |
| `createAgent` with no tools instead of one `model.withStructuredOutput()` call | Learning goal, plus the next feature adds tools to the same agent. `createAgent` also re-asks the model when its structured answer fails the schema, which a bare call does not. | A bare structured-output call would need re-plumbing into an agent once tools arrive; the difference today is ~5 lines. |

## Post-Design Constitution Re-check

Re-checked after writing `data-model.md` and `contracts/`. The design holds every row above:
- The trust boundary (`checkAssignments`) is pure and outside the AI module.
- The fallback path reuses the verbatim 002 reply.
- No new persistence was introduced.
- The new secrets (`SORTING_API_KEY`, `LANGSMITH_API_KEY`) are redacted.

**Gate result**: PASS.
