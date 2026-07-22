# Implementation Plan: VPS-Hosted Discord Bot Skeleton

**Branch**: `001-vps-discord-bot` | **Date**: 2026-07-22 | **Spec**: `specs/001-vps-discord-bot/spec.md`

**Input**: Feature specification from `/specs/001-vps-discord-bot/spec.md`

## Summary

A single-operator Discord bot that echoes a user's text payload back into the originating channel, built to run unattended on a personal Linux VPS supervised by systemd. The thin `!echo <text>` slice (P1) is the vehicle that wires up the operability qualities the user really asked for: environment-variable configuration with strict startup validation, structured (NDJSON) logging with secret redaction and per-command correlation IDs, a side-effect-free health probe independent of the Discord gateway, auto-reconnect, and a bounded graceful shutdown. Phase 0 research (`research.md`) fixed every technology choice; Phase 1 (`data-model.md`, `contracts/`, `quickstart.md`) fixes the module contracts and validation path. No OCR, image processing, or AI-agent behavior is implemented (explicit scope exclusion).

## Technical Context

Filled from `research.md` (Phase 0). The few items initially flagged `NEEDS CLARIFICATION` are marked below and resolved in `research.md` R1–R9.

**Language/Version**: TypeScript 7.0.2 on Node.js 24 LTS ("Krypton"), compiled by `tsc` to CommonJS in `dist/`, run with `node dist/index.js`. (`research.md` R1)

**Primary Dependencies**:
- `discord.js@14.27.0` — gateway + REST transport (the only module importing it). *(NEEDS CLARIFICATION → resolved R2)*
- `pino@10.3.1` — structured NDJSON logger with `redact`. *(NEEDS CLARIFICATION → resolved R3)*
- `zod@4.4.3` — env-config validation with inferred typed `Config`. *(NEEDS CLARIFICATION → resolved R5)*
- `vitest@4.1.10` — test runner (unit + contract + integration). *(NEEDS CLARIFICATION → resolved R7)*
- `tsx@4.23.1`, `@types/node@26.1.1` — dev only.
All versions pinned exactly in `package.json` (no `^`/`~`), per AGENTS.md.

**Health surface**: a built-in `node:http` server on `127.0.0.1:8081` answering `GET /healthz`, plus an optional `npm run health` CLI wrapper. *(NEEDS CLARIFICATION → resolved R4)*

**Storage**: N/A. v1 persists no user data (FR-008); no database, file store, or cache.

**Testing**: Vitest, three tiers under `tests/` grouped by user story — see `research.md` R7 and `quickstart.md`.

**Target Platform**: A single personal Linux VPS with systemd as the process supervisor (FR-009). The bot binds its health probe to loopback only; the operator's existing Caddy reverse proxy MAY front the loopback health endpoint for external/dashboards use (documented in `docs/deployment.md`). The bot itself has no awareness of Caddy. No cluster, no managed services.

**Project Type**: Long-running background service / bot daemon (one process).

**Performance Goals**:
- Echo reply within 2 s at normal VPS load (SC-001).
- Graceful shutdown within 5 s and exit 0 in ≥95 % of trials (SC-003 / FR-006).
- Health probe responds within 1 s, 100 % healthy over a 1-hour 10 s polling (SC-004).
- 7-day unattended uptime with no operator intervention (SC-002).

**Constraints**: single-instance; loopback-only health endpoint; privileged Message Content Intent must be enabled in the Discord developer portal (documented prerequisite, not a code concern); ≤2000-char Discord message limit enforced via `ECHO_MAX_LENGTH` default 1900.

**Scale/Scope**: one operator, one bot process, one or few test servers in v1. Multi-user isolation honored at the module-contract type level (Constitution Constraint), not via multi-user *features* (spec §Assumptions).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle / Constraint | How this plan satisfies it | Evidence |
|---|---|---|
| **I. Test-First (non-negotiable)** | Every module contract in `contracts/*.md` carries an explicit "Test obligations" section; `tasks.md` (Phase 2) will be grouped by user story so each increment is independently testable; quickstart proves the path without a live account first. | `contracts/*.md` "Test obligations"; `research.md` R7; `quickstart.md` "Automated validation" |
| **II. Modular Orchestration** | One module per capability, each with a declared contract in `contracts/`: `config`, `logger`, `health`, `echo`, `discord`, `lifecycle`. Only `discord` imports `discord.js`. Inter-module communication is via typed function calls over the in-memory `BotState`/`Config`/`UserCommand`/`EchoResult`/`HealthStatus` types; no hidden shared mutable state besides the single `BotState` snapshot with documented writers/reader. | `data-model.md` Relationships; `contracts/*.md` |
| **III. Observability** | Pino NDJSON on every module step and user action; per-command `correlationId` bound via `childFor(logger, correlationId)`; connection-state and shutdown transitions logged; flows auditable request-in → actions → response-out. | `contracts/logger.md`, `contracts/discord.md` (§3), `research.md` R3 |
| **IV. Data Privacy & Integrity** | No persisted user data (FR-008); secrets redacted at the logger boundary via `redact.paths` (never rely on "remembering not to log"); mention neutralization enforced at the send call (`allowedMentions: { parse: [], users: [], roles: [] }`) so the bot cannot ghost-ping (FR-013); `UserCommand.userId`/`guildId` are request-scoped inputs, never process-global → cross-user isolation by design even with no multi-user *features*. | `contracts/logger.md`, `contracts/discord.md` §4, `contracts/echo.md`, `data-model.md` "Multi-user isolation note" |
| **V. Simplicity & YAGNI** | Single package (no workspace/monorepo), no DB, no HTTP framework (`node:http`), no Docker/reverse proxy in v1, no pino-pretty in prod. Each added dep justified in `research.md` against a rejected simpler alternative. | `research.md` R1–R9 (each has "Alternatives considered") |
| **Constraint: Deployment target** | Single personal VPS + systemd only; one-operator install within 30 min via `docs/deployment.md` (SC-005, FR-009, FR-010). | `research.md` R8; `quickstart.md`; future `docs/deployment.md` |
| **Constraint: Primary interface** | Discord is the only user-facing transport; health is operator-only and loopback-only; no CLI/web surface becomes required. | `contracts/discord.md`, `contracts/health.md` |
| **Constraint: Multi-user from day one** | Module contracts type `UserCommand.userId`/`guildId` and forbid the echo core from process-global state; no cross-user access is possible. | `contracts/echo.md` §4, `data-model.md` Entity 3 + isolation note |
| **Constraint: Language policy** | TypeScript 7 chosen; no module deviates. | `research.md` R1 |
| **Constraint: External dependencies abstracted** | `discord.js` is isolated behind the `discord` adapter contract; everything else depends on the contract, not the library. Swappable/mockable without touching business logic (echo core is pure). | `contracts/discord.md`, `contracts/echo.md` |
| **Constraint: Graceful degradation** | Missing portal intent → warn (not crash); `channel.send` failure → one retry then stop (FR-011); health endpoint distinguishes Discord-down from process-dead. | `contracts/discord.md` §1,§5; `contracts/health.md` §3 |
| **Workflow: Validate on VPS** | `quickstart.md` "Live-gateway smoke" is the manual VPS validation; automated suites cover the rest. | `quickstart.md` |

**Gate verdict (pre-Phase 0)**: PASS — no unjustified violations.

## Project Structure

### Documentation (this feature)

```text
specs/001-vps-discord-bot/
├── plan.md              # this file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output — one declared contract per module
│   ├── config.md
│   ├── logger.md
│   ├── health.md
│   ├── echo.md
│   ├── discord.md
│   └── lifecycle.md
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── shared/
│   └── types.ts          # BotState, ProcessPhase, ConnectionState, Config (type), UserCommand, EchoResult, HealthStatus
├── config/
│   ├── schema.ts         # zod schema
│   ├── load-config.ts    # loadConfig(env, log): Config  → throws ConfigError
│   └── config.test.ts    # (unit)
├── logger/
│   ├── create-logger.ts  # createLogger(config): Logger (redact.paths)
│   └── logger.test.ts    # (unit) redaction + childFor correlation
├── echo/
│   ├── handle-echo.ts    # pure handleEchoCommand(cmd, config): EchoResult
│   └── echo.test.ts      # (unit) — RED first; FR-001/FR-008/FR-013
├── discord/
│   ├── adapter.ts        # createDiscordAdapter(deps): DiscordAdapter  (only importer of discord.js)
│   └── adapter.contract.test.ts
├── health/
│   ├── server.ts         # startHealthServer(deps); stop(); mapHealthStatus(state)
│   ├── server.unit.test.ts
│   └── server.integration.test.ts
├── lifecycle/
│   ├── run-app.ts        # runApp(): wiring + SIGTERM/SIGINT + bounded shutdown
│   └── lifecycle.contract.test.ts
├── app/
│   └── index.ts          # `node dist/index.js` entry: runApp()
docs/
└── deployment.md         # systemd unit, env, start/stop/log/health (FR-010)

tests/
├── unit/                 # mirrors src/ for pure-logic tests
├── contract/             # one contract test per contracts/*.md
└── integration/

.env.example              # template env (committed, no secrets)
package.json              # exact-pinned deps; scripts: build, dev (tsx), start, test, health
tsconfig.json             # → dist/ (CommonJS)
vitest.config.ts          # three-tier glob
eslint.config.*           # flat config; `no-restricted-paths` import-boundary rule (research R10)
```

**Structure Decision**: a single-package repo (Option 1 — single project) is the smallest thing that works; no monorepo/workspace (rejected under YAGNI in `research.md` R8). Each `src/<module>/` directory corresponds 1:1 to a `contracts/<module>.md` declared contract, so Principle II's "independently runnable and independently testable" holds module-by-module. **No application framework** (NestJS considered and deferred — `research.md` R11): Nest's DI graph would weaken Principle II's transport-isolation discipline into review-only, and its module ceremony is unjustified cost for capabilities that are mostly pure functions (echo) or individually-runnable agent nodes (future langgraph). The next spec/plan that introduces features genuinely needing DI or a multi-command router MUST re-open R11 and re-decide against real evidence, with a Complexity Tracking row justifying the Principle II/V crossing.

**Growth & boundary enforcement** (research R10): the layout grows by **adding sibling modules under flat `src/`** — future `src/ocr/`, `src/agent-foo/` slot in the same way `src/echo/` did, and each gets its own spec/plan/contracts per Constitution Workflow §1–2 (no pre-specification of those features' internals here). To keep that growth from quietly violating Principle II's "no module may know about the user-facing transport except the transport adapter", **import boundaries are machine-enforced** via `no-restricted-paths` (e.g. only `src/discord/` may import `discord.js`; only `src/config/`/`src/logger/` may import `pino`; only `src/config/` may import `zod`). The rule runs in CI; adding a new module that needs a new library appends one rule entry. This is the lower-cost equivalent of a monorepo's hard package boundary and survives any future folder reorg. See `research.md` R10 for the full analysis and rejected alternatives.

## Complexity Tracking

> Filled because, while the Constitution Check passes, two choices warrant an explicit YAGNI justification line per Principle V.

| Choice | Why needed | Simpler alternative rejected because |
|---|---|---|
| `zod@4.4.3` for env validation | FR-003 requires rejecting "missing **or malformed**" with a logged field name on the first offense; `Config` must be statically typed for Principle II contracts. | Hand-written `if (env.X == null) throw` loses enum/range validation and the inferred `Config` type, and re-introduces the integer-parse footgun; the lib is reused for inbound-arg schemas so it is one dep, not two. |
| `pino@10.3.1` (vs console+JSON.stringify) | Secret redaction (`redact.paths`) must be enforced at the logger boundary, not by discipline (FR-005/SC-006). Child-logger `correlationId` binding and `flush()` on shutdown are contract requirements. | `console.log` hand-rolling redacts + correlation + flush by hand — exactly the "secret logged by accident" footgun Principle IV forbids, and re-implements what pino already ships. |
| ESLint `no-restricted-paths` import-boundary rule (research R10) | Principle II's "no module may know about the user-facing transport except the transport adapter" must hold as OCR + multiple langgraph agents land — review-only enforcement would not survive that growth. The rule runs in CI and is extensible per library (one entry per future module/lib pair). | *No rule, rely on reviews* (simpler) was rejected as insufficient against the operator's stated growth trajectory; *domain subdirs now* and *pnpm workspaces* (also rejected, see R10) bike-shed category names before the features that justify them exist and/or pay hard-package-boundary overhead before there is any independently-consumable artifact. The static rule gives the same protection for one config block. |

No other complexity additions: no ORM/DB, no HTTP framework (`node:http`), no Docker, no monorepo, no production pretty-printer.

## Post-Phase-1 Constitution re-check

Re-evaluated after `data-model.md` + `contracts/` + `quickstart.md` were drafted:
- **Principle I**: every contract now has a concrete "Test obligations" block; quickstart gives a red-first automated path → still satisfied.
- **Principle II**: the 1:1 `src/<module>` ↔ `contracts/<module>.md` mapping is explicit; `discord.js` import is contractually confined to `src/discord/`, AND that confinement is now machine-enforced via `no-restricted-paths` (research R10) rather than review-only → still satisfied and strengthened.
- **Principle III**: `correlationId` binding and the "logs never contain message content, only lengths" rule are written into `contracts/discord.md` §3 → satisfied and tightened beyond the pre-Phase-0 check.
- **Principle IV**: redaction paths enumerated in `contracts/logger.md`; mention-neutralization enforcement point pinned to the send call in `contracts/discord.md` §4; multi-user isolation note added to `data-model.md` → satisfied.
- **Principle V**: Complexity Tracking table justifies the only two non-trivial deps; no new modules or services were introduced in design → satisfied.
- **Constraints**: loopback-only health, single-VPS/systemd, TS, abstracted Discord, graceful degradation — all reflected in contracts → satisfied.

**Post-design gate verdict**: PASS. No Constitutional violation remains unjustified; Phase 2 (`tasks.md`) may proceed under the `/speckit.tasks` command.