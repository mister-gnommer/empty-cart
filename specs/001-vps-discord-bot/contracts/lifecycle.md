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

1. **Startup order** (each step on failure → exactly one `fatal` log line + `process.exit(1)`):
   1. `createLogger(config)` — fails fast if stdout is unavailable (Edge Case: log destination unavailable → refuse to start, do not drop logs).
   2. `loadConfig(process.env, log)` — emits the FR-003 validation line.
   3. Construct `botState = { phase: 'starting', discord: 'disconnected', startedAt: Date.now(), lastStateChangeAt: ... }`.
   4. `startHealthServer(...)` — phase stays `starting` until Discord connects; health already serves `degraded` (process healthy, Discord disconnected) per FR-007 scenario 2.
   5. `createDiscordAdapter(...)`; `adapter.start()`. On `ClientReady` set `phase = 'running'`.
   6. Emit `log info: msg="bot started"; fields: healthAddress, prefix, echoCommandName` (no secrets).
2. **Signal handling** (installed once, in `runApp`):
   - `SIGTERM` (FR-006) and `SIGINT` (dev convenience) both call the same `requestShutdown(reason)` once-guard.
   - Second invocation of `requestShutdown` → emit exactly one `log warn: msg="shutdown already in progress"` and return (Edge Case: no restart mid-shutdown).
3. **Shutdown budget** (`config.shutdownTimeoutMs`, default 5000, SC-003):
   ```
   set botState.phase = 'shutting-down'        // health flips to 503 shutting-down immediately
   stop accepting new Discord events            // adapter removes listeners / gate
   race(
     Promise.all([ adapter.stop(), healthServer.stop() ]),
     timeout(shutdownTimeoutMs)
   )
   logger.flush()
   process.exit(exitOk ? 0 : 1)
   ```
   On budget timeout: emit `log warn: msg="shutdown budget exceeded"; fields: phase` and exit `1`.
4. **Log flushing**: `logger.flush()` MUST be awaited before `process.exit` so buffered NDJSON reaches stdout (guarantees SC-006 can scan a complete log tail). The wire-format shape of every log event above is owned by `contracts/logger.md`; this contract specifies only the events' contents.
5. **Exit discipline**: `runApp` is the only module that may call `process.exit`. All other modules communicate failure by throwing or by setting `botState` (not by exiting).

## Test obligations

- Contract: with all child modules mocked, a `SIGTERM` dispatch races and resolves within a (test-short) budget, calls `adapter.stop()`, `healthServer.stop()`, `logger.flush()`, and `process.exit(0)`.
- Contract: second `SIGTERM` during shutdown logs exactly one `warn` with `msg="shutdown already in progress"` and does not re-enter shutdown (Edge Case idempotency).
- Contract: budget exhaustion → exactly one `warn` with `msg="shutdown budget exceeded"` + `process.exit(1)` (bounded, non-hanging).
- Contract: a child throwing on startup (e.g. health bind failure) → exactly one `fatal` log line naming the subsystem in `msg` and `process.exit(1)`.
- (Integrating against the real VPS is a `quickstart.md` manual step, not an automated test — Constitution "validate on VPS".)