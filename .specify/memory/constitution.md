<!--
Sync Impact Report
==================
Version change: 1.4.0 → 1.5.0
Modified principles: none
Modified constraints: none
Modified workflow: Development Workflow item 7 "Validate on VPS" replaced with
  "Validate within the branch, deploy after merge" — a feature's tasks.md MUST
  NOT deploy the feature branch to the VPS or run live smoke tests against it;
  all pre-merge validation MUST be achievable within the branch; VPS
  deployment and smoke testing happen once, after merge to main. Added
  optional sub-point permitting a post-merge validation runbook when scope
  justifies it, authored after merge, not as a pre-merge artifact.
Added sections: none
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md      ✅ no update needed
  - .specify/templates/spec-template.md       ✅ no update needed
  - .specify/templates/tasks-template.md     ✅ no update needed (no VPS/smoke
    test references found; the prior guidance came from the constitution's
    now-amended item 7, not the template)
Follow-up TODOs: none
-->

# Empty Cart Constitution

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

All behavior MUST be specified by tests before implementation.

- TDD cycle (Red-Green-Refactor) is strictly enforced for every feature,
  module, and integration path.
- Tests MUST be written, reviewed, and shown to fail before production code is
  written.
- No merge of code without corresponding passing tests.

Rationale: A personal assistant that mishandles spending data or silently
drops a list update erodes trust fast; tests are the cheapest way to keep the
system honest as features accumulate.

### II. Modular Orchestration

Every capability (e.g., a receipt-parsing step, an agent node, a prepared
script, the user-facing transport, persistence) MUST be a self-contained
module with a declared contract.

- Modules MUST be independently runnable and independently testable.
- Inter-module communication MUST go through explicit, documented interfaces
  (typed inputs/outputs), never through hidden shared state.
- Adding a new feature MUST compose existing modules rather than
  re-implementing their logic.
- No module may know about the user-facing transport (e.g., the bot adapter)
  except the transport adapter itself.

Rationale: Orchestrating heterogeneous capabilities invites tight coupling;
treating each as a contract-bound module keeps the system replaceable and
debuggable piece by piece, and lets features be swapped without rewriting
neighbors.

### III. Observability

Every run MUST be reconstructable after the fact.

- Structured logs with correlation IDs MUST accompany every module step and
  every user-initiated action.
- Failures MUST be logged with enough context to reproduce without the user.
- User-facing interactions MUST be auditable end-to-end (request in → actions
  taken → response out).

Rationale: Orchestrated, asynchronous workflows fail in subtle ways; without
traces, debugging an opaque misstep (e.g., a misread receipt, a dropped list
update) becomes guesswork.

### IV. Data Privacy & Integrity

Personal data (spending, habits, and anything the assistant ingests about the
user) is sensitive and MUST be treated as such.

- All persisted user data MUST be user-scoped; cross-user access is
  forbidden by design.
- Secrets and credentials of any kind MUST NEVER be committed or logged.
- Destructive operations (e.g., deleting a list, wiping spendings) MUST be
  reversible or prompt explicit confirmation.
- Retention and deletion of personal data MUST follow a documented policy.

Rationale: The assistant ingests financial habits and receipts; a careless
leak or accidental wipe is the worst-case failure for this kind of tool.

### V. Simplicity & YAGNI

Start with the smallest thing that delivers value; justify every addition.

- A feature MUST NOT be built until a user story requires it.
- Complexity (a new module, dependency, or service) MUST be justified in the
  plan against a simpler rejected alternative.
- Deterministic code MUST be preferred over LLM agents whenever it can do the
  job; agents are a choice, not a default.

Rationale: A single-user personal VPS project has no customer to impress; dead
complexity is pure maintenance cost.

## Constraints

These are the *current* deployment boundaries; they MAY be revisited by
amendment when scope changes, but MUST hold until then.

- **Deployment target**: A single personal VPS. The system MUST be operable by
  one person and MUST NOT assume a cluster or managed services it does not
  have.
- **Primary interface**: A chat/bot transport (currently Discord). All
  user-facing flows MUST be reachable through it; other surfaces (CLI, web)
  are optional and MUST NOT become required.
- **Multi-user from day one**: The data model and module contracts MUST assume
  multiple users may exist; cross-user isolation rules in Principle IV MUST be
  enforced, not deferred. Multi-user *features* (sharing, administration UI)
  may still be deferred by user story, but never the underlying isolation.
- **Language policy**: New orchestration and scripts MUST be written in
  TypeScript unless a module's domain makes another language materially better
  — and that choice MUST be justified in the plan.
- **External dependencies**: Any external service (LLM, OCR, or otherwise)
  MUST be abstracted behind a local interface so it can be swapped or mocked
  without touching business logic.
- **Graceful degradation**: The system MUST report a clear error to the user
  when an external dependency is unreachable, never crash silently.

## Development Workflow

1. **Spec**: Every feature starts with a user story spec under
   `specs/[###-feature]/spec.md`.
2. **Plan**: `plan.md` MUST pass the Constitution Check gate before Phase 0
   research proceeds; re-check after Phase 1 design.
3. **Tasks**: `tasks.md` MUST be grouped by user story so each delivers an
   independently testable increment.
4. **Tests first**: Tests written → user-approved → red → implement → green.
5. **Review**: No work is merged until tests pass and the Constitution Check
   is satisfied; complexity violations MUST be logged in the plan's
   Complexity Tracking table with a justification.
6. **Code comments and test names**: MUST NOT reference spec document
   identifiers (FR-XXX, SC-XXX, contracts/*.md, data-model.md, quickstart.md,
   research.md, T### task IDs). Describe the behavior or constraint directly.
   If a reference truly saves space, use the feature name (e.g.
   `001-vps-discord-bot`).
7. **Validate within the branch, deploy after merge**: A feature's `tasks.md`
   MUST NOT include deploying the feature branch to the VPS or running live
   smoke tests against a VPS deployment of that branch. All validation
   required for a feature to be "done" (tests, local runs, mocked/stubbed
   external services) MUST be achievable within the branch itself. Live VPS
   deployment and smoke testing happen exactly once, after the feature is
   merged to `main`, as a separate step owned by the maintainer — not as a
   task generated by SpecKit for the feature.
   - **Optional post-merge runbook**: If a feature's scope justifies it, a
     runbook describing how to validate the feature on the VPS after
     deployment (smoke tests, manual checks, rollback steps, etc.) MAY be
     prepared. This runbook MUST be authored after the feature is merged into
     `main`, not as part of the feature branch's `tasks.md` or other
     pre-merge artifacts.

### Supplementary Discovery Artifacts & Precedence

1. **Working & Discovery Artifacts**: Contributors and agents may generate
   auxiliary working files (such as interview transcripts, grilling ledgers
   like `grilling-ledger.md`, or exploratory notes) located alongside feature
   specifications.
2. **Strict Precedence**: The primary feature specification (`spec.md`) is the
   sole canonical source of truth for requirements, scope, and acceptance
   criteria.
3. **No Direct Consumption by Downstream Phases**: Downstream phases
   (`/speckit-plan`, `/speckit-tasks`, `/speckit-implement`) must consume
   requirements strictly from `spec.md`. They must not parse or implement
   directly from supplementary ledgers or interview notes.
4. **Mandatory Consolidation**: Any decision, edge case, or constraint recorded
   in a supplementary artifact must be explicitly consolidated into `spec.md`
   before planning begins. In the event of any contradiction, `spec.md` strictly
   supersedes all auxiliary artifacts.

### Late-Stage Decisions & Supersession

Pre-code artifacts exist to make intent reviewable early; they need not be
reviewed exhaustively before coding. The binding review point is code review,
when behavior is unambiguous.

1. **Pre-code review MAY be light**: A contributor MAY skim, defer, or skip
   detailed review of planning-phase artifacts (`plan.md`, `research.md`,
   `data-model.md`, `contracts/`). This is a deliberate trade, accepted because
   the code review is the backstop.
2. **Contradictions MUST be surfaced, never silent**: Any code change that
   contradicts a decision recorded in `spec.md`, `plan.md`, or a contract MUST
   be flagged explicitly during review. It MUST NOT be silently accepted, and
   it MUST NOT be silently reverted on the grounds that "the spec says
   otherwise."
3. **Approval updates the source**: If the change is approved, the affected
   source artifact(s) MUST be revised in the same unit of work, with a dated
   note recording that the earlier decision was deliberately superseded (what
   changed and why).
4. **`spec.md` remains canonical**: This section defines the only sanctioned way
   to change `spec.md` — by explicit amendment — not whether it is canonical.
   Silent divergence between the code and `spec.md` stays forbidden; only
   recorded supersession is allowed.
5. **Tooling findings are inputs, not orders**: A finding that code contradicts
   an artifact (e.g. from `/speckit-analyze` or `/speckit-converge`) records a
   contradiction for this adjudication. It does not by itself mean the code
   must change.

## Governance

This constitution supersedes all other project practices. Where a spec or plan
conflicts with it, the constitution wins.

- **Amendments**: Any change to this document MUST be recorded as a version
  bump (see below), with a short migration note if existing work is affected.
- **Versioning policy**: MAJOR for principle removal/redefinition, MINOR for a
  new principle or materially expanded guidance, PATCH for clarifications and
  wording.
- **Compliance review**: The Constitution Check in `plan.md` is the primary
  enforcement point. Every plan MUST cite which principles it satisfies and
  explain any justified violation in the Complexity Tracking table.
- **Runtime guidance**: When day-to-day development guidance is needed, prefer
  the AGENTS.md file at the repository root over ad-hoc decisions.

**Version**: 1.5.0 | **Ratified**: 2026-07-21 | **Last Amended**: 2026-09-25
