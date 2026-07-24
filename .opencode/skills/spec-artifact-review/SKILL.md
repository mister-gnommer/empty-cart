---
name: spec-artifact-review
description: >-
  Review Spec Kit design artifacts (spec, plan, research, data-model,
  contracts, quickstart, tasks) under specs/[###-feature]/ for coherence
  and implementability. Use ONLY when the user explicitly asks to review
  them — never auto-invoke after running a Spec Kit command.
---

# Spec Kit Artifact Review

**Announce at start:** "I'm using the spec-artifact-review skill to review the Spec Kit artifacts."

## What this is

A pragmatic reviewer for the design phase of Spec Kit — `specify`, `clarify`, `plan`, `tasks` — anything before real code appears. Surfaces real issues (composition holes, unverified library claims, deferred invariants, broken references and so on), skips nits.

**Read-only.** No editing artifacts, no build/test runs, no Spec Kit command invocations. `grep`/`rg` and other read-only inspection tools are fine. Return a findings list and stop.

**Never recommend removing work that appears orphaned from its source.** When an artifact has no traceable origin — an FR with no user story or edge case, a contract field with no spec backing, a task with no contract test obligation — it may be because the user added it during work without backfilling the source. This skill flags such cases in the findings but does not recommend removal -- it recommends that whoever acts on the review (the user, or a later agent) should ask the user whether to add the missing source or remove the addition, as both outcomes may be valid.

**Explicit user request only.** Triggers: "review the spec/plan/contracts", "check the artifacts under specs/NNN-…", "perform a Spec Kit review". Never auto-invoke after `/speckit.plan`, `/speckit.tasks`, etc. If no spec number/name is provided, assume the user is asking to review the latest (higher number).

## What this is not

This skill should not be used to review code — use `pragmatic-code-reviewer` or similar for that. Pushback if user tries to use this skill to review code.

## Sources of truth

Always read these if they exist, regardless of scope:

- `specs/[###-feature]/spec.md` — the original feature spec, every other artifact descends from it
- `.specify/memory/constitution.md` — supersedes all other practices; violations are high-severity

## Methodology

1. Inventory the feature directory to detect the phase:
   - `specify`/`clarify` — `spec.md` alone
   - `plan` — adds `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md` (not all are always present)
   - `tasks` — adds `tasks.md` on top of plan-phase artifacts
2. Run every check for the detected phase and all prior phases — later phases build on earlier ones, so cross-phase verification (e.g. tasks reflecting contracts, plan implementing spec) is baked into the per-phase check lists. Within a single phase, checks are independent — run them in parallel. Each check yields `file:line` citations and a concrete fix.
3. Skip checks for artifacts that don't exist in this feature directory (e.g. no `tasks.md` → skip tasks-phase checks). That's expected — not every plan creates every artifact. But never skip a check for an artifact that *does* exist.
4. Compile findings into the Output format, ordered by severity.

---

## Cross-phase coherence

Before running detail checks, dispatch parallel sub-agents to verify the chain of reasoning across phases. The parent agent chooses model tiers based on task complexity — cross-phase coherence requires comprehension and synthesis (medium tier), while detail checks A–F are mechanical (basic tier suffices). Avoid high-tier models for rote tasks.

Each sub-agent reads the relevant artifacts independently and returns a gap analysis — not just "are the references correct" but "does the later phase actually solve what the earlier phase asked for."

### Spec → Plan

Sub-agent reads `spec.md` and all plan-phase artifacts. Questions:

- Does the plan address every user story and edge case in the spec, or are some dropped?
- Does the plan introduce scope (modules, behaviors, constraints) not traceable to any spec requirement?
- Do the design choices serve the spec's Success Criteria, or do they optimize for something unrelated?
- Are there spec requirements the plan hand-waves ("will be handled later," "TBD") without a concrete resolution path?

### Plan → Tasks

Sub-agent reads all plan-phase artifacts and `tasks.md`. Questions:

- Does every contract have implementation tasks, or are there contracts with no path to code?
- Do task groups map to user-story-aligned increments, or do they mix unrelated concerns?
- Are there tasks with no contract or spec backing (orphan work)?
- Do the tasks preserve the plan's architectural decisions, or do they quietly diverge (e.g. plan says "single config module," tasks scatter config across five modules)?

### End-to-end sanity

Sub-agent reads `spec.md` and `tasks.md` only (skips plan). Questions:

- Would completing these tasks, as described, deliver the spec? Or did something get lost between phases?
- Are there spec edge cases that no task addresses?
- If you only had the spec and the task list, would you understand what to build and why?

Compile the gaps found, then proceed to detail checks below.

---

## Checks — Specify / Clarify phase (spec.md)

1. Every user story has acceptance scenarios (Given/When/Then).
2. Every functional requirement traces to a user story or edge case. Orphan FRs (added without a source) flag a finding — see the top-level "orphaned from source" rule.
3. No scope creep beyond the user description; explicitly excluded items are named.
4. Edge cases list real failure modes — not just happy-path reversals — that the plan/contracts must then handle.
5. Constitution alignment — each Principle and Constraint is addressed or a justified exception is recorded.
6. Success Criteria are measurable (numbers, time bounds, percentages — not "feels good").
7. Key Entities (if present) have fields, validation rules, and relationships.

## Checks — Plan phase (plan, research, data-model, contracts, quickstart)

Run all six passes. They're independent — fan them out in parallel. Pass labels reflect historical yield, not "skip me" — low yield ≠ zero yield.

### A — Cross-contract composition

For every pair of contracts that reference each other:

1. **Signature alignment** — caller's call shape matches callee's declared surface (params, return type, thrown errors, exports).
2. **Startup/shutdown orderability** — if any contract specifies an initialization or teardown order, every step's inputs must be produced by an earlier step. Cycles (A needs B's output, B needs A's output — neither can start first) are blockers because no topological sort exists; the ordering is impossible to satisfy at implementation time.
3. **Promised behavior is committed** — if contract A says "module B does X on stop()", contract B must commit to X in its own behavioral contract. Asymmetric promises are bugs — implementation works off contracts, not intent.
4. **Quickstart-referenced events exist** — every observable event the quickstart tells the operator to look for (log entries, status transitions, CLI output, emitted messages) MUST be specified by some contract. Quickstart cannot invent observable events.
5. **Test obligations match the public surface** — a test obligation referencing a field/param the surface doesn't expose is a contradiction.
6. **Shared state has exactly documented writers/readers** — if shared state is declared, its writers and readers must match across all contracts. Scan every contract for hidden reads or writes.

### B — Library/runtime API claims

For every behavioral claim about an external library or platform API (pino's `flush()`/`redact`, Node's `server.close()`/`closeAllConnections()`, discord.js's `destroy()`/`allowedMentions`, zod/vitest APIs, anything pinned in `research.md`):

Verify against **current** docs via Context7 (`resolve-library-id` → `query-docs`); for platform APIs, the platform's official docs are canonical. Record the consulted source. "I knew this" is not verification — if you can't cite it, you didn't verify.

Common failure shapes: "X drains the buffer" when X is a no-op for the chosen config; "method returns a Promise" when it returns undefined/takes a callback; "glob covers any depth" when fixed-depth; "close() aborts in-flight" when it only stops new connections.

### C — Dependency pins

Re-resolve every pin against the package registry (e.g. `npm view <pkg> version` for Node projects). Flag: unreachable versions; type-definition package majors not matching the runtime package major (type stubs track runtime majors, not `latest`); aggressive majors without a "verified reachable on YYYY-MM-DD" note in `research.md`.

### D — Deferred invariants

Any number/threshold/constraint that **either** appears in two or more contracts **or** gates a spec Success Criterion MUST be pinned now, not deferred to `tasks.md`. Cross-contract or SC-gating numbers are contract-level invariants.

### E — References, typos, and diagrams

Every `contracts/foo.md` / `research.md` / `data-model.md` path mentioned resolves to a real file with that exact name (common bug: stale filename from earlier naming pass). Every "see §N" / "see R<N>" cross-reference resolves. Spot typos and nonsense placeholder text. For every Mermaid ` ```mermaid ` block: state IDs with hyphens/special chars must use `state "label" as id` — otherwise the parser silently drops the whole block. Edges must reference declared states.

### F — Plan-document internal quality

- `research.md`: every technology choice has Decision + Rationale + Alternatives-considered.
- `plan.md`: every "NEEDS CLARIFICATION" resolves to a finding in `research.md`.
- `plan.md`: Constitution Check cites every Principle/Constraint with either satisfaction evidence or a Complexity Tracking justification.
- `data-model.md`: relationship diagrams are parseable (pass E) and types match the public surfaces declared in `contracts/`.

## Checks — Tasks phase (tasks.md, on top of plan-phase artifacts)

1. Tasks are grouped by user story, each group delivering an independently testable increment.
2. Test-First ordering — every implementation task has a test task preceding it (Red → Green → Refactor).
3. Orphan tasks (no contract test obligation or spec FR trace) flag a finding — see the top-level "orphaned from source" rule.
4. Contracts with no implementation task flag a finding — either the task is missing, or the contract is genuinely unused. See the top-level "orphaned from source" rule.
5. Task ordering respects lifecycle (config before logger before dependent modules; shutdown tasks last).
6. Numbers deferred from contracts are now pinned (Pass D follow-through).
7. Names referenced in `tasks.md` (module paths, function names, types) match those in `contracts/` and `data-model.md`.

---

## Output

```markdown
## Spec Kit Review — [feature]

**Scope:** [files reviewed — note if narrower than full bundle]
**Phase detected:** [specify | clarify | plan | tasks]
**Verdict:** [N blockers, M important, K minor — artifact is / is not ready for the next phase]

### Findings

1. 🔴 **Blocker** [Pass X] `file:line` — finding. **Fix:** fix description.

2. 🟡 **Important** [Pass Y] `file:line` — finding. **Fix:** fix description.

3. 🟢 **Minor** [Pass Z] `file:line` — finding. **Fix:** fix description.

### Cluster summary
[One line per check group — e.g. "Plan phase: 3 composition (A), 2 library-API (B), 1 broken-ref (E)"]

### Notes for next time
[Patterns worth fixing in the writing process.]

### Strengths
[Load-bearing design choices the implementer should preserve.]

### Advisement (optional)
[Parent agent's synthesis across all findings — patterns, risks not captured by individual checks, concrete recommendations for the next phase.]
```

---

## Guardrails

- Don't skip a check because the scope "looks fine." If an artifact exists, check it.
- Don't drop findings as "too minor" — list them.
- Don't edit artifacts, run build commands, or invoke Spec Kit commands. (Read-only tools are fine.)
- Don't accept "I'm confident this works" without a cited source for library-API claims.
- Severity reflects risk to implementability, not the pass label — typos aren't blockers, composition bugs aren't minor.

## What this skill is NOT

- Not `pragmatic-code-reviewer` — that's for implementation-phase code review. Push back if asked to review code.
- Not `plan-review` — that reviews implementation plans against project rules/skills/agents. Push back if asked to do configuration review.
