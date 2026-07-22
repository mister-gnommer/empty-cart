# Phase 0 Research — VPS-Hosted Discord Bot Skeleton (`001-vps-discord-bot`)

**Date**: 2026-07-22 · **Branch**: `001-vps-discord-bot` · **Spec**: `specs/001-vps-discord-bot/spec.md`

This document resolves every `NEEDS CLARIFICATION` in the plan's Technical Context and justifies each technology choice against the Empty Cart Constitution (esp. Principle V — Simplicity & YAGNI) and the feature spec.

---

## R1. Runtime & language toolchain

**Decision**: Node.js 24 LTS ("Krypton") + TypeScript 7, compiled to CommonJS via `tsc` into `dist/`, executed with `node dist/index.js`.

**Rationale**: The Constitution's language policy mandates TypeScript. Node 24 LTS is the active LTS on the target date (entered LTS Oct 2025; support through Apr 2028) and is packaged for Debian/Ubuntu via NodeSource, matching the VPS/systemd deployment target invoked by FR-009. Compiling to plain `dist/` (rather than running via `tsx` in production) removes a runtime transpile step and an extra production dependency, improving cold-start determinism on the VPS. `tsx` is retained as a **dev**-only runner for fast iteration and for running tests if wanted.

**Alternatives considered**:
- *Bun/Deno*: faster startup, first-class TS, but non-systemd-native packaging story and fewer battle-tested Discord library builds — contradicts "operable by one person with the bundled docs".
- *Run TS directly via tsx in prod*: one fewer build step, but adds a production transpile dependency and warm-up variance at exact-version pinning time — rejected for determinism.

**Exact pinned versions** (AGENTS.md: no `^`/`~`; resolved fresh from the npm registry on 2026-07-22):

| Package | Version | Role |
|---|---|---|
| typescript | 7.0.2 | compiler (dev) |
| @types/node | 26.1.1 | Node typings (dev) |
| tsx | 4.23.1 | dev runner (dev) |
| discord.js | 14.27.0 | Discord gateway + REST (prod) |
| pino | 10.3.1 | structured logger (prod) |
| zod | 4.4.3 | env-config validation (prod) |
| vitest | 4.1.10 | test runner (dev) |

---

## R2. Discord library

**Decision**: `discord.js@14.27.0` with the `Guilds` + `MessageContent` (privileged) gateway intents, listening to `Events.MessageCreate`.

**Rationale**: discord.js is the canonical, actively maintained TS-native Discord library; it owns the only module the Constitution allows to know about the user-facing transport (Principle II). It provides the primitives every spec requirement maps onto:

- **FR-001 / echo**: `message.author.bot` filter + prefix check on `message.content`; reply via `message.channel.send`.
- **FR-013 / no ghost-ping**: `MessageCreateOptions.allowedMentions = { parse: [] }` (and empty `users`/`roles` arrays) guarantees the reply never triggers a notification render beyond the sender's own message. This is the library-supported, contract-level neutralization — we do **not** hand-roll string token stripping, which is fragile and locale/format-dependent.
- **FR-012 / auto-reconnect**: discord.js WebSocketShards reconnect/resume automatically; `Events.ShardDisconnect` / `Events.ShardReconnecting` are logged for observability (FR-004). No custom reconnect loop.
- **FR-006 / clean shutdown**: `client.destroy()` terminates the WebSocket cleanly and returns a Promise we can await inside the bounded shutdown budget (`Client.destroy(): Promise<void>` per the v14.26 docs; unchanged in 14.27).
- **Correlation**: a per-command `correlationId` is generated and bound into the pino child logger for the whole handler call (FR-004 / Principle III).

**Alternatives considered**:
- *`@discordjs/ws` + `@discordjs/rest` raw gateway*: smaller footprint, but re-implementing message parsing, reconnect, and sharding violates YAGNI (Principle V) and the "compose existing modules" rule.
- *Discordeno / Eris*: capable, less TS-idiomatic, smaller ecosystem around structured logs/shutdown hooks; discord.js is the lower-risk default for a single-operator VPS bot.

**Privileged intent note**: `MessageContent` requires enabling "Message Content Intent" in the Discord developer portal (and verification for bots in >100 guilds, which is out of v1 scope). This is recorded as a prerequisite in `quickstart.md` and the deployment doc, not a code concern.

---

## R3. Structured logging & secret redaction

**Decision**: `pino@10.3.1`, JSON to stdout, `redact.paths` covering every secret-shaped field, child loggers carrying `correlationId`.

**Rationale**: Pino emits newline-delimited JSON by default (timestamp, level, pid, hostname, msg, plus bound context) — directly satisfies Principle III and FR-004 ("machine-parseable"). It is the only logging dependency. Secret redaction (FR-005, FR-008, Constitution Principle IV) is enforced at the logger boundary, not by remembering-not-to-log:

```text
redact.paths = ["discordToken", "token", "*.token", "config.discordToken", ...]
redact.censor = "[Redacted]"
```

A `redact.remove` option is **not** used: keeping the censored key makes a misrouted secret visible-as-redacted in self-completing audit (a missing `discordToken` key after a refactor is a louder signal than a present-and-redacted one). `logger.flush()` is called in the shutdown path so buffered logs reach stdout before exit code 0 (FR-006).

**Alternatives considered**:
- *Winston*: heavier, slower, transport model adds complexity; Pino is strictly simpler for one stdout sink.
- *console.log + custom JSON.stringify*: re-implements redaction, child bindings, and flushing — violates YAGNI and is exactly the kind of "secret logged by accident" footgun Principle IV forbids.
- *pino-pretty in prod*: rejected; pretty output is dev-only. Production logs are raw NDJSON so a post-run secret scan (SC-006) can run deterministically.

---

## R4. Health check surface

**Decision**: A tiny localhost HTTP server built on Node's built-in `node:http` module (no framework) listening on `127.0.0.1:$HEALTH_PORT` and answering `GET /healthz` with a compact JSON body. A thin CLI `npm run health` is also provided (a ~20-line script that fetches the endpoint) for manual triage.

**Rationale**: An HTTP endpoint is what systemd's `ExecStart=`, watchdog, and external probes (curl, Uptime Kuma) speak natively, satisfying the "programmatically (for a monitoring/service-manager health probe)" branch of User Story 3. Building it on `node:http` adds **zero** production dependencies (Principle V). The CLI is optional operator sugar; it is not a required surface, so it does not violate the "primary interface is the bot transport" constraint.

The health module is **fully independent of discord.js** — it only reads a shared, in-memory `BotState` snapshot that the lifecycle/discord modules write to. This is what lets it satisfy FR-007's "no Discord round-trip" rule and the "distinguish process-healthy-but-Discord-disconnected from process-unhealthy" requirement: the Discord adapter updates `BotState.discord = 'connected' | 'disconnected' | 'reconnecting' | 'destroyed'`, and the lifecycle updates `BotState.phase = 'starting' | 'running' | 'shutting-down' | 'stopped'`.

**Status model** (mapped to the spec's three states in FR-007):

| `phase` | `discord` | HTTP status | body `status` |
|---|---|---|---|
| starting/running | connected | 200 | `healthy` |
| starting/running | disconnected/reconnecting | 200 | `degraded` (process healthy, Discord disconnected) — matches Health Story scenario 2 / Edge Case: gateway down |
| shutting-down/stopped | * | 503 | `shutting-down` / `unhealthy` — matches Health Story scenario 3 (no stale healthy) |

Bounded response within 1 s (SC-004) is trivial — the handler does no I/O.

**Alternatives considered**:
- *CLI-only health* (`npm run health` reads shared state file): simpler, but requires a second process invocation under systemd and cannot satisfy a live probe without a daemon surface — rejected for the "programmatically" requirement.
- *Full HTTP framework (Fastify/Express)*: over-kill for one endpoint — violates YAGNI. The built-in `node:http` server is ~50 lines.
- *Discord-command-based health (`!health`)*: contradicts FR-007 ("must not perform a Discord round-trip") and is useless when the gateway is down. Rejected.

---

## R5. Configuration loading & validation

**Decision**: A `config` module that reads `process.env` and validates it with a `zod` schema at startup. On any missing/malformed variable the loader logs **exactly one** structured `fatal` entry naming the offending field and calls `process.exit(1)` (FR-003). Secrets are returned in the validated `Config` object but are never logged: the logger's `redact.paths` covers them (R3) and the config module's own log lines log only field names, never values.

**Env schema** (v1):

| Variable | Required | Validation | Default | Secret |
|---|---|---|---|---|
| `DISCORD_TOKEN` | yes | non-empty string | — | yes |
| `LOG_LEVEL` | no | enum `trace\|debug\|info\|warn\|error\|fatal` | `info` | no |
| `COMMAND_PREFIX` | no | non-empty string, 1–4 chars, no whitespace | `!` | no |
| `ECHO_COMMAND_NAME` | no | non-empty string, lowercase | `echo` | no |
| `ECHO_MAX_LENGTH` | no | int ≥1, ≤1900 (Discord 2000-char reply budget minus prefix/footer) | `1900` | no |
| `SHUTDOWN_TIMEOUT_MS` | no | int ≥1000, ≤30000 | `5000` | no |
| `HEALTH_HOST` | no | IPv4 literal | `127.0.0.1` | no |
| `HEALTH_PORT` | no | port int 1–65535 | `8081` | no |

**Rationale**: zod gives static-type inference for `Config` (Principle II "typed inputs/outputs") with one small, widely-used dependency, and produces field-level error messages for free — directly enabling the "single log entry identifying the offending variable" requirement of FR-003. The defaults and bounded ranges encode the spec's stated constants (5 s shutdown budget §Assumptions; the 1 s / 2 s performance goals are not env-tunable to avoid operator-induced regressions).

**Alternatives considered**:
- *Manual `if (env === undefined) throw`*: equivalent in lines, but loses the inferred `Config` type and Enum validation → more boilerplate and an integer-parse footgun. zod pays for itself with the union/enum/threshold validations the spec explicitly demands (FR-003 "missing **or malformed**").
- *`envalid`*: purpose-built and lighter, but zod is reused later for validating inbound command payloads (Echo command) where a schema lib is genuinely needed; reusing one schema lib keeps the dependency surface minimal (YAGNI).

---

## R6. Bounded graceful shutdown

**Decision**: A `lifecycle` module owns process-signal handling and the shutdown budget. On `SIGTERM` (and `SIGINT` as dev convenience, per FR-006) it:

1. sets `BotState.phase = 'shutting-down'` (so the health endpoint flips to 503 `shutting-down` immediately — Health scenario 3),
2. stops accepting new Discord events by removing listeners / marking a `stopping` gate,
3. awaits, in parallel with `Promise.race` against a `SHUTDOWN_TIMEOUT_MS` timer:
   - `discordAdapter.stop()` → `client.destroy()` (clean WS close),
   - `healthServer.stop()` (stop accepting health probes),
4. calls `logger.flush()` so buffered NDJSON reaches stdout,
5. `process.exit(0)`.

If the budget elapses, we log a `warn` with the unmet step, then `process.exit(1)` (still bounded; the 95%-within-5 s target SC-003 is met by the happy path, and a failure surfaces noisily rather than hanging the service manager). A second signal is idempotent: a `shuttingDown` boolean short-circuits further handlers and logs one `warn`.

**Rationale**: This is the only module that may call `process.exit` and the only listener on `SIGTERM`/`SIGINT`; concentrating signal handling avoids the well-known "two modules race to shut down" bug and satisfies Edge Case "two stop signals in quick succession".

---

## R7. Test strategy (Constitution Principle I — Test-First)

**Decision**: Vitest with the test files mirroring `src/` under `tests/`, grouped **by user story** (Constitution "Tasks grouped by user story so each delivers an independently testable increment"). Three tiers, all runnable without a live Discord account:

1. **unit** — pure logic, no I/O. Primary targets: the `echo` command (length validation, mention-neutralization via the `allowedMentions` contract, empty-arg usage hint), the `config` zod schema (every "missing or malformed" branch of FR-003), the `health` status mapper (every `phase × discord` cell of the R4 table).
2. **contract** — the documented module contracts in `contracts/` are each exercised against a fake/spy of the neighbouring module, proving inter-module wiring without Discord: e.g. the discord adapter's `stop()` calls `client.destroy()` and sets `BotState.discord = 'destroyed'`; the lifecycle's shutdown race resolves within the budget with mocked children. Contract tests are the enforcement point for Principle II.
3. **integration** — a single end-to-end test that spins up the health HTTP server against a real in-process `BotState`, asserts the full state-transition matrix over the HTTP endpoint, and asserts a hand-driven `Events.MessageCreate` payload is echoed back through a stub `channel.send` (no real gateway connection) — proving the echo round trip + correlation-id logging without a Discord account.

A live-gateway smoke test against a real test server is described in `quickstart.md` as the manual VPS validation step (Constitution "Validate on VPS"), not part of the automated suite.

**Alternatives considered**:
- *jest*: heavier, slower cold start, native-TS config overhead; vitest 4 is faster and TS-first with no extra compile step.
- *Mocha + chai*: simpler core but re-introduces the assertion/TS/mocking jigsaw vitest bundles — rejected for YAGNI.

---

## R8. Repository / module layout

**Decision**: a single-package repo (`package.json` at repo root) with this layout:

```text
src/
  config/        loadConfig(env) → Config            (zod)
  logger/        createLogger(config) → Logger        (pino, redact)
  health/        startHealthServer(state, cfg); stop; status mapper  (node:http)
  echo/          handleEchoCommand(payload) → Result   (pure; mention-neutralization contract)
  discord/       DiscordAdapter: connects, routes echo, emits ConnectionState  (discord.js)
  lifecycle/     run(): wires modules, owns SIGTERM/SIGINT + shutdown budget
  app/           composition root (index.ts) invoked by `node dist/index.js`
  shared/        BotState type, ConnectionState enum, correlation-id helper
tests/
  unit/  contract/  integration/
contracts/        one .md per module (the module-by-module declared contracts)
docs/
  deployment.md   systemd unit, env, start/stop/log/health (FR-010)
```

**Rationale**: one package is the smallest thing that works (YAGNI); a monorepo/workspace is unjustified for a single bot. Each directory is exactly one Constitution "module" with one declared contract in `contracts/`, so every capability is independently runnable/testable (Principle II). `shared/` holds only tiny cross-module *types* and the correlation-id helper — no behavior, so it is not a "module" that the transport may not know about; it is the documented interface surface.

**Re-evaluated against Constitution**: Principle II ✓ (one module per capability, contracts in `contracts/`, no module other than `discord/` touches the transport). Principle V ✓ (no workspace, no extra package, no DB, no HTTP framework). Multi-user-from-day-one (Constraint) ✓ — contracts are typed with `userId`/`guildId` context fields and the echo handler treats them as request-scoped inputs, never global state, even though v1 has no multi-user *features* (per spec §Assumptions).

---

## R9. Explicit non-decisions / out-of-scope confirmations

Confirming the user description's exclusions, to keep YAGNI honest in the plan:

- **No OCR / image processing / AI-agent behaviour** in v1 (user description; spec Edge Cases). The `echo` handler inspects only `message.content` text; `attachments`, `embeds`, and `stickerItems` are ignored. Any future capability requires its own spec + Constitution Check.
- **No persisted user data** (FR-008). No database, file store, or cache is introduced; `tests/test-seeding` skill does not apply here.
- **No per-user authorization model** (spec Edge Cases / §Assumptions) beyond Discord's own channel/server permissions in v1.
- **No Docker in v1**; systemd is the documented deployment shape (FR-009). The operator's existing Caddy reverse proxy MAY front the loopback health endpoint for external/dashboards use; that is documented in `docs/deployment.md` and is invisible to the bot. A `docs/deployment.md` is the single source of truth for VPS ops.

---

## R10. Module-structure & import-boundary enforcement (growth strategy)

**Triggered by a plan review**: the operator flagged that the flat single-package layout (`src/<module>/`) risks being outgrown once OCR and several langgraph-agent modules land. This entry records the analysis and the chosen mitigation, honoring Constitution Principle V (YAGNI) and Principle II (modular orchestration).

**Decision**: keep the flat `src/<module>/` layout (no domain subdirs, no monorepo/workspaces in v1) AND add **static import-boundary enforcement** via ESLint's `no-restricted-paths` rule so Constitution Principle II's "no module may know about the user-facing transport except the transport adapter itself" is enforced by the build, not only by review.

**How enforcement works** (one config block, no runtime cost):

```text
// .eslintrc excerpt (illustrative — concrete syntax chosen in tasks.md)
{
  "rules": {
    "no-restricted-paths": ["error", {
      "zones": [
        { "target":      "src/(?!(discord)/)(.*)",
          "from":        "discord.js",
          "message":     "Only src/discord may import discord.js (Principle II)." },
        { "target":      "src/(?!(config|logger)/)(.*)",
          "from":        "pino",
          "message":     "Only src/config and src/logger may import pino." },
        { "target":      "src/(?!(config)/)(.*)",
          "from":        "zod",
          "message":     "Only src/config may import zod (keep schema ownership local)." }
      ]
    }]
  }
}
```

The rule runs in CI (`npm test` invokes `eslint --max-warnings 0`), so a future agent module that tries to import `discord.js` fails the build. The matrix is extensible: when OCR/agents arrive, append rules like "only `src/<agent>/` may import `@langchain/*` or `tesseract.js`".

**Cost**: ~one config file + one CI invocation. **Zero** restructuring risk, **zero** opinion-prediction about future folder categories (capability-vs-agent-vs-tool focus), and **zero** build/copmatrix overhead. It survives any future folder reorg because the rules are path-pattern-based.

**Why this beats the rejected alternatives**:

- *Status-quo flat, rule-by-review only* (Approach A): identical cosmetic surface but the very coupling risk the operator is worried about (future langgraph nodes importing `discord.js` directly) stays un-detected until review — rejected as insufficient.
- *Domain subdirs now* (`src/transports/`, `src/capabilities/`, `src/infra/`, … — Approach C): front-loads bikeshed about whether OCR is a "capability" or an "agent", guesses category names before the features that would justify them exist, risks a forced rename later. Mild Principle V violation. Rejected.
- *pnpm workspaces* (`packages/bot`, `packages/agents/ocr`, … — Approach D): real hard package boundary, but pays the build/CI/version-sync/hot-iteration overhead before there is any independently-consumable artifact or multi-team ownership. Re-evaluate the day one of those conditions holds. Rejected for now.
- *Pre-built domain subdirs with empty parents* (Approach E): same risks as C with no extra boundary payoff over Approach B's static rule. Rejected.

**Growth mechanism** (Constitution-recognized — Workflow §1–2): OCR and each agent require their **own** spec → plan → `tasks.md` → Constitution Check cycle. Spec/feature separation is honored: this plan does not pre-specify those features' internals. What this plan *does* is install a static guard that makes whatever folder shape they eventually land in safe-by-construction. By the time the first agent is specced, we'll know whether it lives at `src/agent-foo/` (sibling) or motivates a domain reorg — and the boundary rule travels with that decision rather than blocking it.

**Re-evaluated against Constitution**:
- Principle II ✓ — the discipline is now machine-enforced, not aspirational.
- Principle V ✓ — no premature restructuring; one config file is justified against a rejected `no-rule` simpler alternative. Logged in `plan.md` Complexity Tracking.
- Constraint "external dependencies abstracted behind a local interface" ✓ — a library may only be imported from the module that owns the abstraction; this is exactly what the rule enforces.

---

## R11. Framework adoption — NestJS considered and deferred

**Triggered by a plan review** (operator flagged whether NestJS would be a better fit given the v1 scope overlaps heavily with Nest's built-in concerns: DI, module boundaries, lifecycle hooks, `@nestjs/config` validation, `@nestjs/terminus` health, structured logging). This entry records the analysis so the decision is in-repo rather than only in chat.

**Decision**: stay framework-less in v1. Defer NestJS adoption to the spec/plan cycle that produces real evidence for it (see trigger below).

**Why Nest was tempting — and the honest overlap**:

- `@nestjs/config` + zod covers FR-002/FR-003.
- `@nestjs/terminus` covers FR-007 with health-indicator ergonomics.
- DI + `OnApplicationShutdown` covers FR-006 lifecycle cleanly.
- NestJS's module system *appears* to enforce Principle II's modular orchestration via `@Module({ providers, imports })` boundaries.
- Structured-logger integration (`nestjs-pino`) gives pino + redaction via a DI-scoped logger.

On a spec-feature coverage sheet, NestJS is close to ~1:1 with our requirements. The rejection is not about feature count; it is about **what Nest's "module" actually enforces vs. what the Constitution's "module" requires**, and about YAGNI (Principle V).

**Why rejected for v1**:

1. **Nest's "module" ≠ Constitution's "module".** Nest's DI graph makes every provider transitively reachable from the root. Principle II's "no module may know about the user-facing transport except the transport adapter" therefore becomes a *runtime-discipline* you fight against the framework, not a *structural fact*. The `no-restricted-paths` rule added in R10 is trivial against flat files (linter sees imports); against Nest's module graph it becomes "don't register the DiscordService in any non-transport module's providers array", which the linter cannot see and review must. The framework erodes the very enforcement we just installed.
2. **Framework ceremony for capabilities that don't need it.** The echo handler is a **pure function** — that's the Constitution's explicit preference (`Simplicity & YAGNI`: deterministic code preferred over agents/frameworks). Nest would wrap it in a `EchoModule` + `EchoService` + `EchoController` trinity with decorators and DI, paying ceremony cost for behavior that is one pure function. OCR and langgraph agent modules are individually-runnable capabilities too; they want explicit typed inputs/outputs and a runnable interface, not Nest decoration. Adding `@langchain/*` to a flat `src/agent-foo/` folder is one R10 rule entry; doing it inside a Nest module adds the trinity *plus* a module-graph decision for each.
3. **The health surface is one `node:http` route.** `@nestjs/terminus` is the right tool at ~20 endpoints with multiple indicators; at one `GET /healthz` reading an in-process `BotState`, it is pure overhead. The integration test today spins a real `node:http` server against an in-process `BotState` snapshot — stays trivial without a framework boot.
4. **Shutdown / config / logs are already paid for.** FR-006 = `process.on('SIGTERM')` + `Promise.race` (~25 lines in `lifecycle`). FR-003 = `zod` + one `fatal` log + `process.exit(1)` (~15 lines). FR-004/FR-005 = `pino` redact (already a dep). Replacing each with its Nest equivalent gives the same behavior boxed, plus a DI container, plus decorators, plus a test harness that bootstraps the entire framework per test — a net cost for a single-deployable bot orchestrating internal agents.
5. **Test-first friction (Principle I).** Contract tests today construct one module with mocked neighbours. A Nest contract test bootstraps `TestingModule` per case; for six modules with a handful of contract tests each, that is real CI weight added with no added confidence. TDD red-green speed matters more here than enterprise-scale fixture sharing.

**The growth argument cuts the other way.** OCR and agents arrive via their own spec → plan → `tasks.md` → Constitution Check (Constitution Workflow §1–2). *That* plan is the right place to revisit NestJS:
- If 5+ agents genuinely need DI to compose, Nest's `@Module` boundaries become load-bearing — adopt it then, with evidence.
- If agents are individually-runnable typed-inputs/outputs nodes (langgraph's native shape), they fit flat modules under R10's enforced boundary and Nest adoption would be ceremony cost. The decision should be made against the agent spec's actual structure, not pre-empted by this skeleton plan.

**Where Nest would actually win** (recorded for the future plan that reopens this):

- A multi-command router with slash commands, permission middleware, rate limiting, scheduled jobs, and an HTTP admin API. That's a real product, not an echo skeleton; Nest's `@nestjs/bullmq`, `@nestjs/schedule`, `ScheduleModule`, guards, and interceptors start paying back.
- A team of ~3+ people onboarding via the DI graph and IDE tooling.
- A required secondary web surface in addition to the bot. Today's Constraint ("primary interface is the bot transport; other surfaces MUST NOT become required") rules this out for v1; a Constraint amendment would re-open it.

**Re-evaluated against Constitution**:

- Principle II (modular orchestration) — *weakened* under Nest as in §1 above; flat-+-R10 strengthens it. ✗ for Nest.
- Principle V (YAGNI / simplicity) — Nest's ceremony for vast-majority-pure-function modules is unjustified at v1 scale. ✗ for Nest.
- Constraint (deployment target — one personal VPS, one operator) — Nest's startup cost and bundle size are real but not decisive; the deciding constraints are II and V. ✗ for Nest via II/V.
- Principle I (test-first) — framework bootstrapping per test slows the red-green loop without adding confidence at this scale. ✗ (mild) for Nest.

**Net**: NestJS is a record-considered-and-deferred alternative. The next spec/plan cycle that introduces features genuinely needing DI or a router (multi-command, scheduled jobs, web admin) MUST re-open this entry and decide against real evidence — at which point a Constitution Check + Complexity Tracking row is required to justify crossing Principles II and V.

---

## Phase 0 Summary

All `NEEDS CLARIFICATION` entries from the plan's Technical Context are resolved above and are folded back into **plan.md**'s Technical Context and Constitution Check. Phase 1 (data model, contracts, quickstart) may now proceed.