# Contract — `logger`

**Module path**: `src/logger/`
**Depends on**: `pino`
**Depended on by**: every other module (via injected `Logger`)
**Spec refs**: FR-004, FR-005, FR-008, SC-006, Constitution Principles III & IV

## Public surface

```typescript
import type { Logger } from 'pino';

export function createLogger(config: Pick<Config, 'logLevel'>): Logger;
export function createBootstrapLogger(env: NodeJS.ProcessEnv): Logger;   // pre-validation logger for startup ordering (see lifecycle.md §1 step 0)
export function createEmergencyLogger(): Logger;   // stderr-only logger for the stdout-unavailable path (see lifecycle.md §1 step 0); takes no env, no config
export function childFor(logger: Logger, correlationId: string, extra?: Record<string, unknown>): Logger;
```

`createBootstrapLogger` reads `env.LOG_LEVEL ?? 'info'` directly (no `Config`, no validation) and returns a logger equivalent to `createLogger({ logLevel: 'info' })`. It exists solely so `lifecycle` can log the FR-003 validation-fatal line before `loadConfig` has produced a `Config`; it is replaced by a validated logger on successful startup. It MUST NOT perform any env validation (that is `config`'s job).

## Behavioral contract

This contract is the **authoritative source for the log format**. No other contract may prescribe a JSON shape for log events; modules describe only *what* an event contains (severity, `msg` text, named context fields) using the canonical form:

> `log <severity>: msg="<message text>"; fields: <comma-separated names>`

The logger contract below defines how such an event is realized on the wire.

1. The logger writes NDJSON to `process.stdout` using pino's **default destination** (single sink; no transports in v1). Pino's default destination is a SonicBoom stream with `sync: false` (asynchronous), but SonicBoom registers a `process.on('exit')` handler that synchronously flushes its buffer before the process terminates. This means every log line (including those at `info`/`warn`/`error` level) reaches stdout before `process.exit` completes — there is no risk of lost lines at shutdown. `logger.flush()` is callback-based and returns `undefined` (not a Promise); it triggers an async buffer flush but MUST NOT be awaited by callers. (If a future feature introduces a non-SonicBoom destination or custom transport, that feature MUST amend this contract with a real drain primitive — pino's `logger.fatal` already sync-flushes, and `pino.destination({ sync: true })` is an alternative if explicit sync behavior is needed.)
2. Every emitted line is a JSON object with the top-level keys `time` (epoch ms, pino default), `level` (numeric, see mapping in §6), `pid`, `hostname`, `msg` (string), plus any bound context fields (e.g. `correlationId` from `childFor`). Module-contract events named as `log <sev>: msg="..."` become a `msg` value of exactly that string, with the listed `fields` as sibling top-level keys. No module is permitted to invent top-level keys outside this shape; sub-objects are allowed for nested context (e.g. `{ cmd: { userId, channelId } }`).
3. `redact.paths` MUST include at minimum `["discordToken", "*.discordToken", "*.token", "token", "*.*.token"]`; `redact.censor = "[Redacted]"`. (*Not* `remove` — see research R3.) These are pino's **fixed-depth** glob paths (no recursive/deep operator): `discordToken` matches a top-level key; `*.discordToken` matches `<anything>.discordToken` (depth 2); `*.token` matches `<anything>.token` (depth 2); `*.*.token` matches depth 3. Redaction applies to exactly these structurally-occurring paths. The only v1 secret is `discordToken` on `Config`, so the listed paths cover it; modules MUST NOT pass a differently-named or deeper-nested secret to any log call — the "no Secrets object may be passed to log" rule is the primary control, and `redact.paths` is a defense-in-depth backstop, not a recursive catch-all (Constitution Principle IV).
4. `childFor` MUST bind `correlationId` so it appears on every subsequent line until the handler returns (FR-004 / Principle III correlation IDs). Callers MUST NOT set `correlationId` via ad-hoc fields; they MUST go through `childFor`.
5. **Shutdown / fatal path**: `logger.fatal(...)` auto-sync-flushes the destination per pino's API, so startup-fatal and shutdown-fatal log lines reach stdout before `process.exit` without any explicit flush call. For non-fatal last lines (e.g., `warn` on budget timeout), SonicBoom's `process.on('exit')` handler guarantees the buffer is flushed before the process terminates. Callers MUST use `fatal`-level for the last line before exit when possible; they MUST NOT call `logger.flush()` (callback-based, returns `undefined`, not a Promise — awaiting it would await `undefined`).
6. Level mapping to pino defaults (numeric `level` values): `trace`→10, `debug`→20, `info`→30, `warn`→40, `error`→50, `fatal`→60. Module contracts use the symbolic name; the logger owns the numeric encoding.
7. **Emergency logger** (`createEmergencyLogger`): writes NDJSON to `process.stderr` using a pino sync stderr destination (no `process.stdout` dependency), with the same `redact.paths` as §3 and level fixed to `fatal` (the only level used on this path). It takes **no arguments** and performs **no env validation**, so it remains usable when both `Config` and the stdout-backed bootstrap logger are unavailable. It exists solely to satisfy the spec Edge Case "log destination unavailable → refuse to start with a clear log entry" (see `lifecycle.md` §1 step 0). If `process.stderr` is also unavailable, this constructor throws and the caller exits non-zero without logging as a last resort.

## Test obligations

- A unit test logging an object shaped like `{ config: { discordToken: "x" } }` asserts the serialized line contains `"[Redacted]"` and never `"x"` (SC-006 enabler, depth-2 path `*.discordToken`).
- A unit test logging a deep/deeply-nested or differently-named secret (e.g. `{ app: { bot: { apiKey: "x" } } }`) asserts the contract's stated limitation: redaction does NOT cover it, and the test documents this as the reason the "no Secrets object passed to log" rule is load-bearing. The test should assert the value appears unredacted (proving the backstop's limits) OR confirm the documented module rule forbids the call entirely — implementer picks the assertion shape, but the limit must be covered.
- A `childFor` test asserts every subsequent line carries the bound `correlationId`.
- A "pino-pretty is dev-only" guard test asserts the production build does not import `pino-pretty` (static import scan).
- A test asserting `logger.flush()` is not awaited by any module (it returns no Promise); optional, can be a static import-scan over `src/` for `.flush(`.
- An emergency-logger test asserts `createEmergencyLogger()` writes a `fatal` line to `process.stderr` (not stdout) with the standard `redact.paths` (§3) applied, and that the constructor throws when `process.stderr` is unavailable.