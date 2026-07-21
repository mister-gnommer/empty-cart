<!--
Sync Impact Report
==================
Version change: 1.0.1 → 1.1.0
Modified principles (no semantic change to principle text):
  - none (Principle IV's cross-user isolation rule now has real consequence)
Modified constraints:
  - Removed: "Single-user scope (v1)" — contradicted Principle IV by implying
    single-user data is fine for now.
  - Added:  "Multi-user from day one" — data model and contracts MUST assume
    multiple users from the start; only multi-user *features* may be deferred.
Added sections: none
Removed sections: none
Templates requiring updates:
  - .specify/templates/plan-template.md      ✅ no update needed
  - .specify/templates/spec-template.md       ✅ no update needed
  - .specify/templates/tasks-template.md     ✅ no update needed
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
6. **Validate on VPS**: A feature is not "done" until it has been exercised
   against the real VPS deployment, not only locally.

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

**Version**: 1.1.0 | **Ratified**: 2026-07-21 | **Last Amended**: 2026-07-21
