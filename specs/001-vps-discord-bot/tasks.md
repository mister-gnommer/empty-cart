# Tasks: VPS-Hosted Discord Bot Skeleton

**Input**: Design documents from `/specs/001-vps-discord-bot/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md, `.specify/memory/constitution.md`

**Tests**: Constitution Principle I (Test-First) is non-negotiable for this project, so tests are included for every module. Each story's tests are written FIRST (red), then implementation (green).

**Organization**: Tasks grouped by user story so each story is independently implementable and testable.

## Format: `[ID] [P?] [Story?] Description (file path)`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: User story this task belongs to (US1, US2, US3)
- **Sub-letter IDs** (e.g., `T013a`): tasks inserted after the initial numbering; they slot immediately after their base task
- **Setup / Foundational / Polish phases**: NO story label
- Paths assume single-package repo at root (matches plan.md project structure)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project skeleton, pinned dependencies, tooling. No business logic.

- [X] T001 Create `package.json` at repo root with exact-pinned deps (no `^`/`~`) and scripts per plan.md Technical Context: prod `discord.js@14.27.0`, `pino@10.3.1`, `zod@4.4.3`; dev `typescript@7.0.2`, `@types/node@24.13.3`, `tsx@4.23.1`, `vitest@4.1.10`, `eslint@10.8.0`, `typescript-eslint@8.65.0` (peer range declares `typescript <6.1.0` — carry a package.json `overrides` entry for the typescript peer); scripts `build` (`tsc`), `dev` (`tsx src/index.ts`), `start` (`node dist/index.js`), `test` (`vitest run`), `lint` (`eslint`), `health` (`node dist/health-cli.js` — optional wrapper)
- [X] T002 [P] Create `tsconfig.json` compiling `src/` to `dist/` as CommonJS, `target`/`lib` matching Node 24 LTS, `strict: true`, `esModuleInterop: true`, `skipLibCheck: true`, `outDir: dist/`, `rootDir: src/`
- [X] T003 [P] Create `vitest.config.ts` with three-tier project glob: `tests/unit/**`, `tests/contract/**`, `tests/integration/**`; Node environment; reporters default
- [X] T004 [P] Create `eslint.config.js` (flat config) enforcing the import-boundary zones from research R10 (only `src/discord/` may import `discord.js`; only `src/config/`/`src/logger/` may import `pino`; only `src/config/` may import `zod`) using ESLint's **core** `no-restricted-paths` rule — NOTE: R10's syntax block imports `eslint-plugin-no-restricted-paths`, which is not published on npm (see the R10 availability-correction note); the core rule provides the same zone semantics, so adapt the R10 block to core syntax and verify the zones fire (negative test: a deliberate bad import must fail lint). If `typescript-eslint` cannot parse TS 7 sources, fall back to linting compiled `dist/**/*.js` (imports survive compilation as `require` calls, which the core rule also checks) and record the fallback in a config header comment. Invoke `eslint --max-warnings 0` via `npm run lint` and in CI (T031)
- [X] T005 [P] Create `.env.example` at repo root with the eight documented keys and defaults (per `research.md` R5 / `quickstart.md`); `DISCORD_TOKEN=` left empty with a `# required, never commit` comment

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared types + cross-cutting modules every user story depends on. MUST be complete before any story work begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 [P] Create shared types in `src/shared/types.ts` per `data-model.md` Entities 1–5: `Config`, `BotState`, `ProcessPhase` (`'starting'|'running'|'shutting-down'|'stopped'`), `ConnectionState` (`'disconnected'|'connected'|'reconnecting'|'destroyed'`), `UserCommand`, `EchoResult` (discriminated union), `HealthStatus`
- [X] T007 [P] Create correlation-id helper in `src/shared/correlation-id.ts` exporting `newCorrelationId(): string` wrapping `crypto.randomUUID()`
- [X] T008 [P] Create config zod schema in `src/config/schema.ts` per `data-model.md` Entity 1 + `research.md` R5 (env var table, defaults, ranges; `discordToken` non-empty, `logLevel` enum, `commandPrefix` 1–4 chars no whitespace, `echoCommandName` lowercase non-empty, `echoMaxLength` int 1–1900, `shutdownTimeoutMs` int 1000–30000, `healthHost` IPv4 literal, `healthPort` int 1–65535)
- [X] T009 [P] Implement `loadConfig(env): Config` + `ConfigError` in `src/config/load-config.ts` per `contracts/config.md` (pure validator; throws `ConfigError({envField, reason})` on first invalid field; does NOT log; freezes returned `Config`)
- [X] T010 [P] Implement logger in `src/logger/create-logger.ts` per `contracts/logger.md`: `createLogger(config)`, `createBootstrapLogger(env)`, `createEmergencyLogger()` (stderr sync, throws if stderr unavailable), `childFor(logger, correlationId, extra?)`; `redact.paths = ["discordToken","*.discordToken","*.token","token","*.*.token"]`, `redact.censor = "[Redacted]"`; pino default destination to stdout (SonicBoom, `sync: false`)

**Checkpoint**: Foundation ready — config + logger + shared types available to all user stories.

---

## Phase 3: User Story 1 — Send a Command and Get an Echo Response (Priority: P1) :dart: MVP

**Goal**: A user types `!echo <text>` in a channel the bot can see; the bot replies in-channel with the echoed text, with no ghost-pings, length/empty handling, and per-command correlation IDs.

**Independent Test**: Drive a hand-built `Events.MessageCreate` through the discord adapter into a stubbed `channel.send`; assert the echoed payload, allowedMentions shape, and `correlationId` on every log line of the handler call (`tests/integration/echo.spec.ts`).

### Tests for User Story 1 (write FIRST, confirm RED)

- [X] T011 [P] [US1] Unit tests for echo core in `tests/unit/echo.spec.ts` per `contracts/echo.md` Test obligations: empty/whitespace → `usage-hint` with `reply` byte-equal to `Usage: ${commandPrefix}${echoCommandName} <text>` (canonical normative string — no `e.g.`); `echoMaxLength` boundary → `echoed`; `echoMaxLength+1` → `too-long` with `reply` byte-equal to `Input too long (max ${echoMaxLength} chars).` (canonical normative string); mention payloads (`<@123>`, `@everyone`, `<@&9>`, `@here`, raw `@user`) and markdown payloads (`**bold**`, `||spoiler||`, `>quote`) → `echoed` with `reply` unchanged and `transportShouldNeutralizeMentions: true`; two consecutive calls with different `args` → independent outputs
- [X] T012 [P] [US1] Contract tests for discord adapter in `tests/contract/discord.spec.ts` per `contracts/discord.md` Test obligations: every §2 state transition (`ClientReady`, `ShardDisconnect`, `ShardResumed`) over a real `Client` with stubbed `login`/`destroy`; assert that the `ShardDisconnect` warn line carries a fresh `correlationId` field and the subsequent `ShardResumed`/`ShardReady` info line carries the SAME `correlationId` (FR-012 "MUST log each reconnect attempt with a correlation identifier"); `allowedMentions: { parse: [], users: [], roles: [] }` on every send branch of §3/§5/§6; §5 echo-handler-throw → user-facing error reply sent with the canonical string `"An internal error occurred while processing your command."` (byte-equal; no exception text leaked) + `error` log `msg="command handler threw"`; §6 `channel.send` reject → bounded retry honoring `retryAttempts ≤ 3` and `retryTotalMs ≤ max(0, min(3000, shutdownTimeoutMs − 2000))`, cancellable by shutdown, no crash on final failure; §7 `stop()` sets stopping gate, removes `MessageCreate` listener, cancels in-flight retries, calls `client.destroy()`, sets `botState.discord='destroyed'`, logs `msg="discord disconnected"`; no log line contains raw `args`/`reply` text (only `argsLength`/`replyLength`)
- [X] T013 [P] [US1] Integration test for echo round trip in `tests/integration/echo.spec.ts` per `contracts/discord.md`: hand-driven `Events.MessageCreate` produces expected `reply` on a stubbed `channel.send`; every log line of that handler call carries the same `correlationId`
- [X] T013a [P] [US1] Contract test for echo module-scope purity in `tests/contract/echo.spec.ts` per `contracts/echo.md` Test obligations: static import-scan of `src/echo/handle-echo.ts` asserting no module-scoped mutable variable (`let`/`var` at module scope) is referenced by `handleEchoCommand` (the FR-008 / Principle IV structural purity check — distinct from T011's behavior tests and T012's adapter contract)
- [X] T013b [P] [US1] Static-scan contract test for FR-008 no-persistence in `tests/contract/no-persistence.spec.ts`: scan `src/` for any import or use of a persistence mechanism (`fs.writeFile`/`fs.appendFile`/`sqlite`/`level`/`redis`/`node:fs.promises.write*`/`localStorage`/`sessionStorage`/`globalThis.*` mutation that retains `UserCommand.args`/`EchoResult.reply`); assert none are reachable by the echo, discord, or lifecycle modules. Belt-and-suspenders to design discipline (FR-008 / spec Edge Cases): verifies "MUST NOT retain echo command payloads after the command has been handled".

### Implementation for User Story 1

- [X] T014 [P] [US1] Implement `handleEchoCommand(cmd, config): EchoResult` in `src/echo/handle-echo.ts` per `contracts/echo.md` §Behavioral contract (pure; zero-byte-trim only; `usage-hint`/`too-long`/`echoed` mapping; `transportShouldNeutralizeMentions: true` unconditionally on `echoed`; no module-scoped mutable state)
- [X] T015 [US1] Implement `createDiscordAdapter(deps): DiscordAdapter` in `src/discord/adapter.ts` per `contracts/discord.md` (intents `Guilds|GuildMessages|MessageContent`; event→state mapping §2; message routing §3 with `childFor(logger, newCorrelationId())`, log `argsLength`/`replyLength` only; `allowedMentions` empty-parse on every send §4; FR-011 handler-throw user-facing error §5; bounded retry §6 with `AbortController` cancellable by `stop()`; clean-shutdown sequence §7) — depends on T006, T007, T010, T014

**Checkpoint**: User Story 1 fully functional and testable independently — `!echo` round-trip works against stubbed Discord.

---

## Phase 4: User Story 2 — Operator Runs the Bot Reliably on a VPS (Priority: P2)

**Goal**: An operator installs the bot as a systemd-managed background service, configures it via env vars, and gets clean startup-validation + bounded graceful shutdown on `SIGTERM`/`SIGINT`.

**Independent Test**: With all child modules mocked, dispatch `SIGTERM` to `runApp()`; assert `shutdown requested` log, `discord disconnected` log, exit code 0 within budget, no `logger.flush()` call. Dispatch a second `SIGTERM` mid-shutdown; assert idempotent warn. Force `loadConfig` to throw; assert exactly one `fatal` line via the bootstrap logger and exit 1.

### Tests for User Story 2 (write FIRST, confirm RED)

- [X] T016 [P] [US2] Unit tests for config loader in `tests/unit/config.spec.ts` per `contracts/config.md` Test obligations: one `missing` + one `malformed` variant per env field asserting a thrown `ConfigError` with correct `envField`/`reason` (no logger mock — pure); golden-path test asserting inferred `Config` shape and `Object.freeze`
- [X] T017 [P] [US2] Unit tests for logger in `tests/unit/logger.spec.ts` per `contracts/logger.md` Test obligations: object shaped `{ config: { discordToken: "x" } }` serializes with `"[Redacted]"` and never `"x"`; deep-nested differently-named secret `{ app: { bot: { apiKey: "x" } } }` documents the redaction limit (asserts backstop's limits OR documents the no-Secret-passed rule); `childFor` binds `correlationId` on every subsequent line; static-scan test that `pino-pretty` is not imported in production build; static-scan that `logger.flush(` is not awaited in `src/`; emergency-logger writes a `fatal` line to `process.stderr` (captured via spy) with `redact.paths` applied and its constructor throws when stderr is unavailable
- [X] T018 [P] [US2] Contract tests for lifecycle in `tests/contract/lifecycle.spec.ts` per `contracts/lifecycle.md` Test obligations: mocked children, `SIGTERM` dispatch → `log info: msg="shutdown requested"; fields: reason="SIGTERM"`, race resolves within (test-short) budget, `adapter.stop()`/`healthServer.stop()` called, then `log info: msg="shutdown complete"; fields: phase="shutting-down"`, then `process.exit(0)` (exit spy — no real exit), NO `logger.flush()` called; second `SIGTERM` during shutdown → exactly one `warn msg="shutdown already in progress"` carrying a `correlationId` field and no re-entry (contracts/lifecycle.md §2); budget-exceeded → one `warn msg="shutdown budget exceeded"` + `process.exit(1)` (no `shutdown complete` line); `loadConfig` throws `ConfigError` → one `fatal msg="config validation failed"` via `bootLog` (not validated logger) with `fields: env, reason`, exit 1; post-config step throws (e.g. health bind failure) → one `fatal` naming subsystem in `msg`, exit 1; **emergency-logger path**: bootstrap-logger construction throws (simulating stdout unavailable at startup) → exactly one `fatal` line written to `process.stderr` via `createEmergencyLogger()` with `msg="startup failed"` and `fields: reason="stdout unavailable"`, and `process.exit(1)` (the Edge Case "log destination unavailable → refuse to start with a clear log entry").

### Implementation for User Story 2

- [X] T019 [P] [US2] Implement `runApp()` in `src/lifecycle/run-app.ts` per `contracts/lifecycle.md`: startup order §1 (bootstrap logger → `loadConfig` fatal → validated logger → BotState construct → health server → discord adapter.start → `log info: msg="bot started"; fields: healthAddress, prefix, echoCommandName`); signal handling §2 (single `requestShutdown` once-guard, `SIGTERM`+`SIGINT`, second signal idempotent warn); shutdown race §3 against `config.shutdownTimeoutMs` (set `phase='shutting-down'` first → health flips; `Promise.all([adapter.stop(), healthServer.stop()])` raced with timeout; success → `log info: msg="shutdown complete"; fields: phase`; timeout → `log warn: msg="shutdown budget exceeded"; fields: phase`); no `logger.flush()` §4 — rely on SonicBoom exit handler + `fatal` auto-sync; exit discipline §5 — only `runApp` calls `process.exit`. (depends on T006, T007, T009, T010, T014, T025) — T007 supplies `newCorrelationId()` for the §2 idempotent-warn `correlationId` field; T025 supplies `startHealthServer`, which `runApp` constructs at startup step §1.4 and races in §3 per contracts/lifecycle.md (health wiring lives here, not in a separate US3 task). T014 is required transitively because `runApp` constructs `createDiscordAdapter({ echo: handleEchoCommand, ... })`, whose type imports `typeof handleEchoCommand` from `src/echo/handle-echo.ts`; for US2 contract tests T018 this is satisfied by mocking the adapter, but the build of `runApp` itself depends on the echo core's exported type.
- [X] T020 [US2] Implement entrypoint in `src/index.ts` — single `runApp().catch(() => { /* fatal already logged upstream; ensure non-zero */ process.exit(1); });` (per `contracts/lifecycle.md`: `node dist/index.js` invokes `runApp`)
- [X] T021 [US2] Finalize `docs/deployment.md` (scaffold created during spec/plan phase) against the implementation reality: systemd unit file (with `EnvironmentFile=` and `TimeoutStopSec=` mapping to `SHUTDOWN_TIMEOUT_MS` — see the scaffold's §Shutdown-budget mapping), env-var reference table, install/start/stop commands, log viewing (`journalctl -u`), `/healthz` probe via curl, Caddy-reverse-proxy optional fronting of the loopback health endpoint, and the bundled-shutdown-budget explanation (research R8, R9)

**Checkpoint**: User Story 2 fully functional — bot starts via `node dist/index.js`, validates env on startup, shuts down cleanly on SIGTERM within budget, deployable via bundled `docs/deployment.md`.

---

## Phase 5: User Story 3 — Operator Verifies the Bot Is Healthy (Priority: P3)

**Goal**: A side-effect-free `GET /healthz` on `127.0.0.1:8081` returns a machine-readable status distinguishing `healthy` / `degraded` / `shutting-down` / `unhealthy` without any Discord round-trip.

**Independent Test**: Spin a real `node:http` server against an in-process `BotState`; assert the full `connected → disconnected → shutting-down → stopped` transition matrix over real HTTP within 1 s each; assert a second `/healthz` during `shutting-down` returns 503 (no stale healthy); assert 404 for non-`/healthz` paths.

### Tests for User Story 3 (write FIRST, confirm RED)

- [X] T022 [P] [US3] Unit tests for the health status mapper in `tests/unit/health.spec.ts` per `contracts/health.md` Test obligations: every cell of the `data-model.md` Entity 5 mapper table (phase ∈ {starting, running, shutting-down, stopped} × discord ∈ {connected, disconnected, reconnecting, destroyed}) → correct HTTP code + `status` string; `uptimeMs = checkedAt - startedAt`; no I/O performed
- [X] T023 [P] [US3] Integration tests for health server in `tests/integration/health.spec.ts` per `contracts/health.md` Test obligations: real `node:http` against an in-process `BotState`; flip phase/discord between requests and assert the transition matrix over real HTTP within 1 s each; `/healthz` during `shutting-down` returns 503 (no stale healthy, User Story 3 #3); non-`/healthz` path → 404 `{error:"not found"}`; non-`GET` method → 404; response body contains ONLY documented fields (no `discordToken`, no `correlationId`, no env)
- [X] T023a [P] [US3] Integration tests for the health CLI in `tests/integration/health-cli.spec.ts`: spawn the CLI (`tsx src/health-cli.ts`) against a stub `node:http` server returning a canned `HealthStatus` JSON body; assert stdout carries the response body and exit code 0 on 200; assert exit code 1 on a 503 response and on connection refused; assert the CLI issues GET requests only (no side effects, FR-007)

### Implementation for User Story 3

- [X] T024 [P] [US3] Implement `mapHealthStatus(state, now?): { httpStatus; body: HealthStatus }` in `src/health/server.ts` per `contracts/health.md` §3 mapper (read-only, no I/O; `uptimeMs` computed from `startedAt`)
- [X] T025 [US3] Implement `startHealthServer(deps): HealthServer` + `HealthServer.stop()` in `src/health/server.ts` per `contracts/health.md`: bind `node:http` to `config.healthHost:config.healthPort` (loopback-only default); route `GET /healthz` → `mapHealthStatus`; 404 for everything else; `stop()` calls `server.closeAllConnections()` (http.Server method per Node 18.2+) then `server.close()`; bind failure throws a single `Error` carrying the OS error code (depends T024)
- [X] T026 [US3] Implement thin `src/health-cli.ts` (compiles to `dist/health-cli.js`, invoked by the `npm run health` script from T001; tests T023a written FIRST, confirmed RED): a standalone process that HTTP-GETs `http://$HEALTH_HOST:$HEALTH_PORT/healthz` (env-driven, defaults `127.0.0.1:8081` when unset), prints the response body verbatim to stdout, and exits 0 on a 2xx response, 1 on any non-2xx response or connection failure. No Discord dependency, no writes — the loopback `/healthz` endpoint remains the only health surface (contracts/health.md); this CLI is optional operator convenience (the operator can also `curl http://127.0.0.1:8081/healthz`; spec US3 independent-test alternative)

**Checkpoint**: User Story 3 fully functional — `/healthz` distinguishes the four states and survives the full lifecycle.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: End-to-end validation that ties all stories together.

- [X] T027 [P] Add `tests/integration/logger.redaction.spec.ts` end-to-end SC-006 path: log a representative startup → echo-handle → shutdown event sequence through the real logger to a captured stdout sink and assert no log line contains the literal `DISCORD_TOKEN` value
- [X] T028 [P] Add a `scripts/secret-scan.sh` (or npm script) that greps a captured log file for the literal `DISCORD_TOKEN` env value and exits non-zero on match (the `quickstart.md` "Live-gateway smoke" step 6 SC-006 helper)
- [X] T029 Run `npm run lint` and fix any violations; confirm final zero-warning state — the `no-restricted-paths` zones (T004) are CI-enforced via T031
- [ ] T030 Walk `quickstart.md` end-to-end: `npm ci && npm run build && set -a; source .env; set +a && node dist/index.js`; verify automated-validation matrix (all unit/contract/integration suites green), then the live-gateway smoke steps 1–6 against a test server; record any deviations as follow-up tasks
- [X] T031 Add `.github/workflows/ci.yml` (Node 24, on push + pull_request) running `npm ci`, `npm run lint`, `npm run build`, `npm test` — the CI enforcement point referenced by T004/T029, plan.md "Growth & boundary enforcement", and contracts/discord.md
- [ ] T032 Manual VPS soak validation gating SC-002 / SC-003 (≥95% shutdown budget) / SC-004 (1-hour × 10 s polling 100% healthy): install via `docs/deployment.md`, start the service, poll `/healthz` for ≥1 hour (SC-004), run ≥20 graceful stops asserting budget + exit 0 (SC-003 ≥95%), then leave the bot running for ≥7 days unattended confirming echo responsiveness throughout (SC-002); record result + any deviations in a `docs/soak-results.md` entry. Not parallelizable — sequential manual gate ran after T021/T030.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–5)**: All depend on Foundational completion
  - US1 (Phase 3): no inter-story dependency — can start immediately after Foundational
  - US2 (Phase 4): can start in parallel with US1 (different files); tests T016/T017/T018 are independent of US1/US3 (mocked children); impl **T019 depends on T025 (US3 health server)** — the only cross-story wiring dependency
  - US3 (Phase 5): can start in parallel with US1/US2 for tests T022/T023/T023a and impls T024/T025/T026; no US3 task waits on another story
- **Polish (Phase 6)**: depends on all three stories complete

### User Story Dependencies

- **US1 (P1)**: depends only on Foundational (shared types T006, correlationId T007, logger T010). No story-to-story dependency.
- **US2 (P2)**: depends only on Foundational *for tests* (T016/T017/T018 mock child modules). The T019 implementation transitively depends on T014 (echo types) because `runApp` constructs `createDiscordAdapter({ echo: handleEchoCommand, ... })` whose parameter type is `typeof handleEchoCommand`. So US2 *tests* can begin in parallel with US1 (mocks), but the T019 *implementation* requires T014 to have shipped its exported type — see the task-level note on T019. T019 also depends on T025 (`startHealthServer`): `runApp` constructs the health server at startup step §1.4 and races `healthServer.stop()` in §3 per contracts/lifecycle.md, so the health wiring lives in T019 rather than a separate US3 wiring task.
- **US3 (P3)**: T022/T023/T023a tests and T024/T025/T026 impls depend only on Foundational. The only cross-story ordering constraint points into US3, not out of it: T019 (US2) depends on T025 for the health-server construction.

### Within Each User Story

- Tests written FIRST, confirmed RED before implementation
- Models/types before services before endpoints/adapters
- Pure logic before I/O-bearing code
- A story is "done" when its `Independent Test` passes against the real (in-process) modules, not only mocks

### Parallel Opportunities

- All Phase 1 tasks marked `[P]` can run in parallel (T002–T005 are independent files; T001 first to define scripts others invoke)
- All Phase 2 tasks marked `[P]` can run in parallel — they touch distinct files
- Once Foundational completes, US1 / US2 / US3 test/impl tasks can begin in parallel by different developers (tests within each story are `[P]`; impls depend on that story's tests completing red)
- Across stories: T011/T012/T013/T013a/T013b (US1 tests), T016/T017/T018 (US2 tests), T022/T023/T023a (US3 tests) are ALL independent and can run in parallel

---

## Parallel Example: User Story 1

```text
# Launch all tests for User Story 1 together:
Task: T011 — unit tests for echo in tests/unit/echo.spec.ts
Task: T012 — contract tests for discord adapter in tests/contract/discord.spec.ts
Task: T013 — integration test for echo round trip in tests/integration/echo.spec.ts

# Once tests are RED, launch pure impls in parallel:
Task: T014 — handleEchoCommand in src/echo/handle-echo.ts
# Then the adapter (depends on T014's types):
Task: T015 — createDiscordAdapter in src/discord/adapter.ts
```

## Parallel Example: All Three Stories at Once (team of three)

```text
# After Foundational + Setup are complete:
Dev A (US1): T011 → T012/T013 (parallel) → T014 → T015
Dev B (US2): T016 → T017/T018 (parallel) → wait for Dev C's T025 → T019 → T020 → T021
Dev C (US3): T022 → T023/T023a (parallel) → T024 → T025 → T026 (after T023a is RED)
# Polish (Phase 6) after all three stories pass their independent tests.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: drive a hand-built `Events.MessageCreate` through `src/discord/adapter.ts` into a stubbed `channel.send`; confirm echoed reply, `allowedMentions` empty-parse, `correlationId` on every log line. This is the thinnest end-to-end slice and the foundation for growth.
5. Optionally demo with a live gateway smoke (skip until US2/US3 land for a true VPS demo).

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. + User Story 1 → echo round trip green (intellectual MVP, locally testable)
3. + User Story 2 → real lifecycle: env validation, signals, bounded shutdown, systemd-deployable. **This is the operational MVP** — bot runs unattended on the VPS.
4. + User Story 3 → health probe flips with the real Discord connection state; systemd can auto-restart on `unhealthy`
5. + Polish → SC-006 secret scan, lint clean, quickstart walk-through signed off

### Parallel Team Strategy

See "Parallel Example: All Three Stories at Once" above. The only cross-story ordering constraint is T019 (US2 lifecycle) waiting on T025 (US3 health server).

---

## Notes

- `[P]` = different files, no dependency on an incomplete task
- Story label maps task to a user story for traceability (Setup/Foundational/Polish tasks have none)
- Every story is independently completable and testable against in-process real modules (Constitution Principle I)
- Verify each story's tests fail (RED) before writing the implementation
- Commit after each task or logical group; never commit secrets in `.env`
- `discord.js` importation is machine-enforced to `src/discord/` only via the eslint rule from T004 (research R10)
- No `logger.flush()` is awaited anywhere — SonicBoom's `process.on('exit')` handler + `fatal`'s auto-sync covers it (see `contracts/logger.md` §5)
- Stop at any checkpoint to validate a story independently before proceeding