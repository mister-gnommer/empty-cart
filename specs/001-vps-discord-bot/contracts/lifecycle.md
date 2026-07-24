# Contract — `lifecycle` (composition root + shutdown)

**Module path**: `src/lifecycle/` plus `src/app/index.ts` (the single entrypoint `node dist/index.js` invokes).
**Depends on**: `config`, `logger`, `health`, `discord`, `src/shared/types`
**Depended on by**: the OS process supervisor (systemd)
**Spec refs**: FR-003, FR-006, FR-010, User Story 2 #1–#3, SC-003, Edge Cases double-signal & log-destination-unavailable

## Public surface

```typescript
export function runApp(): Promise<void>;   // the only top-level export invoked from src/app/index.ts
```

`runApp` is the single thing the entrypoint calls; it constructs all modules and owns the process-signal listeners and the shutdown budget. No other module installs a `process.on('SIGTERM', ...)` or calls `process.exit`.

## Behavioral contract

1. **Startup order** (each step on failure → exactly one `fatal` log line + `process.exit(1)`; no explicit flush is needed because `fatal` auto-sync-flushes and SonicBoom's exit handler covers other levels — see `logger.md` §5):
   0. `bootLog = createBootstrapLogger(process.env)` — pre-validation logger so step 1's fatal path can emit a line before any `Config` exists (`loadConfig` takes no logger; the bootstrap logger breaks the startup-ordering cycle). If stdout is unavailable (Edge Case: log destination unavailable), constructing the bootstrap logger throws; `runApp` catches it, constructs `emergencyLog = createEmergencyLogger()` (writes NDJSON to `process.stderr` — see `logger.md` §7), emits exactly one `log fatal: msg="startup failed"; fields: reason="stdout unavailable"` via `emergencyLog`, and `process.exit(1)`. If `process.stderr` is also unavailable (emergency logger construction throws), `runApp` exits non-zero without logging as a last resort.
   1. `config = loadConfig(process.env)` — throws `ConfigError` on first invalid field. `runApp` catches it, emits exactly one `log fatal: msg="config validation failed"; fields: env, reason` via `bootLog` (the FR-003 line), and `process.exit(1)`.
   2. `log = createLogger(config)` — replace the bootstrap logger with the validated one. All subsequent steps use `log`.
   3. Construct `botState = { phase: 'starting', discord: 'disconnected', startedAt: Date.now(), lastStateChangeAt: ... }`.
   4. `startHealthServer(...)` — phase stays `starting` until Discord connects; health already serves `degraded` (process healthy, Discord disconnected) per FR-007 scenario 2.
   5. `createDiscordAdapter(...)`; `adapter.start()`. On `ClientReady` set `phase = 'running'`.
   6. Emit `log info: msg="bot started"; fields: healthAddress, prefix, echoCommandName` (no secrets).
2. **Signal handling** (installed once, in `runApp`):
   - `SIGTERM` (FR-006) and `SIGINT` (dev convenience) both call the same `requestShutdown(reason)` once-guard.
   - First invocation → emit one `log info: msg="shutdown requested"; fields: reason` (the event `quickstart.md` step 5 asserts) and proceed to §3.
   - Second invocation → emit exactly one `log warn: msg="shutdown already in progress"` and return (Edge Case: no restart mid-shutdown).
3. **Shutdown budget** (`config.shutdownTimeoutMs`, default 5000, SC-003):
   ```
   set botState.phase = 'shutting-down'        // health flips to 503 shutting-down immediately
   adapter.stop() commits to: remove MessageCreate listener + gate stopping flag (see discord.md §7)
   race(
     Promise.all([ adapter.stop(), healthServer.stop() ]),
     timeout(shutdownTimeoutMs)
   )
   log fatal|warn line (see below)              // fatal auto-sync-flushes; no explicit flush call
   process.exit(exitOk ? 0 : 1)
   ```
   On budget timeout: emit `log warn: msg="shutdown budget exceeded"; fields: phase` and exit `1` (SonicBoom's `process.on('exit')` handler flushes the buffer before the process terminates; see `logger.md` §1).
4. **No explicit flush**: `runApp` MUST NOT call `logger.flush()` (callback-based, returns `undefined`, not a Promise — see `logger.md` §5). Pino's default destination (SonicBoom) flushes its buffer on `process.exit` via its `process.on('exit')` handler, so every log line (including the last `warn`/`fatal` before exit) reaches stdout before the process terminates. If a future feature introduces a non-SonicBoom destination, that feature MUST amend `logger.md` and this contract with a real drain primitive.
5. **Exit discipline**: `runApp` is the only module that may call `process.exit`. All other modules communicate failure by throwing or by setting `botState` (not by exiting). The startup-fatal path (§1 step 1) and shutdown path (§3) are the only `process.exit` call sites.

## Test obligations

- Contract: with all child modules mocked, a `SIGTERM` dispatch emits `log info: msg="shutdown requested"; fields: reason="SIGTERM"`, races and resolves within a (test-short) budget, calls `adapter.stop()`, `healthServer.stop()`, and `process.exit(0)` — and does NOT call `logger.flush()`.
- Contract: second `SIGTERM` during shutdown logs exactly one `warn` with `msg="shutdown already in progress"` and does not re-enter shutdown (Edge Case idempotency).
- Contract: budget exhaustion → exactly one `warn` with `msg="shutdown budget exceeded"` + `process.exit(1)` (bounded, non-hanging).
- Contract: `loadConfig` throwing `ConfigError` → exactly one `fatal` with `msg="config validation failed"`, `fields: env, reason` taken from the error, `bootLog` used (not a validated logger), and `process.exit(1)`.
- Contract: a child throwing on a post-config startup step (e.g. health bind failure) → exactly one `fatal` log line naming the subsystem in `msg` and `process.exit(1)`.
- (Integrating against the real VPS is a `quickstart.md` manual step, not an automated test — Constitution "validate on VPS".)