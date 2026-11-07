# Research: AI List Sorting

**Date**: 2026-10-31. Versions were verified on npm. APIs were verified in current LangChain JS docs (Context7) and in a throwaway probe compiled with this repo's `tsconfig` (TS 7.0.2, `module: node16`, CommonJS) and run on Node 24.

## R1. Orchestration: LangGraph `StateGraph` with `StateSchema`

- **Decision**: Use `@langchain/langgraph` 1.6.0. State is a `new StateSchema({...})` of zod fields. Nodes are typed `GraphNode<typeof State>`. Routing uses `addConditionalEdges(from, router, [targets])`. Per-run dependencies (the correlation-bound logger) and the attachments (kept out of traced state, as their URLs open the photos) go through runtime context (`new StateGraph(State, ContextSchema)`, `invoke(input, { context })`). *Extended 2026-11-07 (code review)*: the attachments joined the context; see `data-model.md`. The graph is compiled once per handler, **without a checkpointer**.
- **Rationale**: `StateSchema` is the form current docs lead with, and zod is already a project dependency. Runtime context is how a node later gets the `userId` for per-store orders. With no checkpointer, nothing outlives `invoke`, which FR-015 requires.
- **Alternatives considered**:
  - `Annotation.Root`: still supported and needs no zod. Rejected only because `StateSchema` is the current idiom.
  - A plain `async` pipeline: see plan Complexity Tracking.
  - `MemorySaver`: would retain list text in memory per thread, which violates FR-015.
- **Verified**: the probe compiled under TS 7 with zero errors. `require` resolves `dist/index.cjs` for `langchain`, `@langchain/core` and `@langchain/langgraph`.

## R2. Categorization: `createAgent` with `responseFormat`, no tools

- **Decision**: In `src/categorizer/agent-categorizer.ts`, call `createAgent({ model, tools: [], systemPrompt, responseFormat: CategorizedLines })`, where `CategorizedLines = z.object({ assignments: z.array(z.object({ line: z.number().int(), category: z.enum(CATEGORY_IDS) })) })`. Read `result.structuredResponse`.
- **Rationale**: This is the smallest real agent. Without tools the loop normally ends after one model turn. Its schema-error retry is the first visible "loop" behavior, and the next feature adds tools to the same agent. LangChain picks provider-native structured output when the model supports it and tool-calling otherwise. The code doesn't care which.
- **Why line numbers, not echoed text**: the model returns `line` numbers (1-based, matching the numbered prompt), so item text never comes from the model (FR-002). A missing, duplicate or out-of-range line makes the whole answer invalid (FR-006).
- **Alternatives considered**:
  - `model.withStructuredOutput(schema)`: a simpler single call. See Complexity Tracking.
  - Returning a `category[]` aligned by position: harder to validate, because a silently skipped line would shift every following category.
  - A fake tool such as `get_categories`, just so the agent has a tool: rejected as artificial. Tools arrive when there is a real one (`save_store_order`).

## R3. Model and provider: `initChatModel("anthropic:claude-haiku-5-5")` through OpenCode

- **Decision**: Config value `SORTING_MODEL` in `provider:model` form, passed to `initChatModel(model, { apiKey, anthropicApiUrl: baseUrl, maxRetries: 1 })`. Supported provider today: `anthropic` (package `@langchain/anthropic` 1.6.0). Model: `claude-haiku-5-5`. It is fast, cheap and good at short multilingual classification. The maintainer routes it through **OpenCode**: `SORTING_BASE_URL=https://opencode.ai/inference/anthropic` (OpenCode's Anthropic Messages endpoint), with `SORTING_API_KEY` holding the OpenCode key. Leaving `SORTING_BASE_URL` unset talks to Anthropic directly with an Anthropic key, with no code change.
- **Rationale**: The `provider:model` string is LangChain's standard way to swap models (constitution: external dependency behind an interface plus config). Adding a provider means installing its `@langchain/*` package and adding one enum arm to config. No sampling parameters: the answer is constrained by the category enum in the structured-output schema. `maxRetries: 1` stays within the 15 s budget. *Superseded 2026-11-07 (live eval)*: `temperature: 0` dropped; Claude Haiku 5.5 rejects any `temperature` other than 1 with a 400, so every call failed.
- **Verified**:
  - `initChatModel('anthropic:…')` constructs under CommonJS; the provider package is loaded with a dynamic import.
  - OpenCode lists `claude-haiku-5-5` on `https://opencode.ai/inference/anthropic/v1/messages`.
  - That endpoint accepts both `x-api-key` (what the Anthropic SDK sends) and `Authorization: Bearer`; a bogus key gets `Invalid credential`, and no key gets `Missing API key`.
  - `initChatModel` with `anthropicApiUrl` set to the OpenCode base reached OpenCode (401 `Invalid credential` with a bogus key).
  - *Verified 2026-11-07 (first live eval)*: a successful call through OpenCode, 72 of 73 sample lines correct. Structured output goes through `createAgent`'s tool-calling strategy, because the model profile reports no native structured output. The same run found that `temperature: 0` returns a 400 on Claude Haiku 5.5, so no sampling parameters are sent (T055).
- **Alternatives considered**:
  - OpenCode's OpenAI-compatible endpoint with `@langchain/openai`: it works for any model, but for a Claude model it adds a translation layer. The Anthropic-native endpoint is kept.
  - Gemini or OpenAI directly: install their package and add one config arm.

## R4. Prompt-injection posture

- **Decision**: The system prompt says list lines are data and must never be followed as instructions. Lines go in the user message, numbered, inside a `<list>…</list>` block. The real protection is structural: the model can only return line numbers and category IDs, and `checkAssignments` rejects anything else (FR-011). The worst an injected line can do is pick its own category or cause an invalid answer, which leads to the fallback.
- **Alternatives considered**: input sanitizing or keyword filters. Rejected because they are brittle, and they would also change item text, which breaks verbatim fidelity.

## R5. Timeouts and failure mapping

- **Decision**:
  - `agent.invoke(input, { signal })`, where `signal` is the node's 15 s budget (`AbortController` plus `setTimeout`, like the recognition budget, so vitest fake timers control it; `AbortSignal.timeout` would not be), with abandonment as a backstop in the node. This is the same `unlessExpired` pattern the OCR step uses, because a provider SDK may ignore the abort signal.
  - Failure causes are `timeout` (abort or budget), `invalid-answer` (schema failure after the agent's retries, or a `checkAssignments` rejection), `error` (anything else, with the error name in the log), and `skipped-too-long` (R6).
  - Every cause leads to the `unsorted` node with the note.
- **Rationale**: Rejections are mapped into a result union at the categorizer boundary, so the graph never sees a thrown vendor error.

## R6. Upper bound on list size

- **Decision**: If a submission has more than 200 items, the AI step is skipped, with cause `skipped-too-long`, and the fallback is used.
- **Rationale**: This bounds cost and output size, and bounds the zod array validation on untrusted output (R9). A real shopping list is far below 200 lines. The spec doesn't name this case; it fits the existing "AI step fails → fallback" rule.

## R7. Tracing: LangSmith via an explicit tracer, on by default for the test period

- **Decision**: Config `TRACING` = `langsmith` (default) or `off`, plus `LANGSMITH_API_KEY` and an optional `LANGSMITH_PROJECT` (default `empty-cart`). `src/tracing/create-tracer.ts` builds a `LangChainTracer` around a `langsmith` `Client`. The handler passes it as `callbacks` in `graph.invoke(input, { callbacks, runName: 'list-submission', metadata: { correlationId } })`, so a trace can be found by the same ID as the logs. On shutdown, `flush()` awaits `client.awaitPendingTraceBatches()` within the existing shutdown timeout. A slow flush only uses up that time; it never turns a clean shutdown into the timeout exit code, since lost traces are not a failed shutdown. *Superseded 2026-11-07 (code review)*: the flush first raced with the other stops, so a slow tracing service made a clean shutdown exit 1. See `contracts/config.md` rule 4.
- **Rationale**:
  - The maintainer wants full insight while testing (spec FR-014; issue #16 switches the default to off later).
  - An explicit callback makes "on by default" a real code default. LangChain's own env switch (`LANGSMITH_TRACING`) would only be on when the env file says so, and it is global and hidden.
  - It is also a learning point: callbacks are how LangChain observes every run, and child runs (the agent inside `categorize`) inherit them.
  - A missing key with tracing on doesn't block startup. Config resolves it to off with a reason, and startup logs a warning, so a 002-era env file still boots.
- **Pitfall**: do not also set `LANGSMITH_TRACING=true` for the bot. LangChain would add its env tracer as well, and every run would be traced twice. It belongs only to the eval command (R8).
- **Retention**: LangSmith keeps base traces for a limited period (14 days by default at the time of writing). Deleting test-period traces is part of issue #16.
- **Alternatives considered**:
  - The env-only switch: rejected for the reasons above.
  - OpenTelemetry export: deferred to #6 (observability).

## R8. Evaluation: `langsmith/vitest`

- **Decision**: `evals/categorize.eval.ts` uses `ls.describe` and `ls.test.each(SAMPLE_LISTS)`. Each sample runs the real agent categorizer, logs `ls.logFeedback({ key: 'accuracy', score })` and asserts that injection samples render every line verbatim. *Extended 2026-11-07 (live eval)*: each sample also fails when the categorizer gives no usable answer, with the cause and error class in the message; wrong categories still only lower the score, which the overall threshold judges. An `afterAll` prints the overall accuracy. It runs through `npm run eval` (`vitest run -c vitest.eval.config.ts`), which needs `SORTING_MODEL`, `SORTING_API_KEY` and (for OpenCode) `SORTING_BASE_URL`.
- **Verified**: with no LangSmith variables, the suite runs locally and the `langsmith/vitest/reporter` prints a per-test table with the feedback columns. With tracing variables set, the same run creates a LangSmith dataset and experiment.
- **Rationale**: One suite works both offline and in LangSmith. It uses the test runner the project already has, and it is the current LangSmith idiom for JS evals.
- **Alternatives considered**: `evaluate()` with a LangSmith-hosted dataset. Rejected because it needs LangSmith for any run, and the dataset would live outside the repo (FR-016 wants it in the repo).

## R9. Dependency hygiene

- **Decision**: Pin all new packages exactly (see plan; `langsmith` is now a runtime dependency because of the tracer), and bump `zod` 4.4.3 → 4.6.7 in this feature.
- **Rationale**: `npm audit` reports GHSA-mrhx-c7xc-m3w5 (high: memory exhaustion validating oversized constrained collections) for zod < 4.6.6. This feature makes zod validate untrusted LLM output. The new packages accept zod `^4`. Vitest 4.1.10 has a moderate dev-only advisory (fixed in 4.1.12). The bump is cheap, so it is included.

## R10. Testing without a live model

- **Decision**:
  - Contract tests for `agent-categorizer` use `fakeModel()` from `langchain`. It scripts a structured answer, an invalid answer, a thrown error and a slow response.
  - Graph and integration tests inject `tests/helpers/stub-categorizer.ts`, which implements `ItemCategorizer` directly, so they never touch LangChain.
- **Verified**: the probe ran `createAgent` with `responseFormat` against `fakeModel().respondWithTools([...])` and got the expected `structuredResponse`.
