# Contract — `logger`

**Module path**: `src/logger/`
**Depends on**: `pino`
**Depended on by**: every other module (via injected `Logger`)
**Spec refs**: FR-004, FR-005, FR-008, SC-006, Constitution Principles III & IV

## Public surface

```typescript
import type { Logger } from 'pino';

export function createLogger(config: Pick<Config, 'logLevel'>): Logger;
export function childFor(logger: Logger, correlationId: string, extra?: Record<string, unknown>): Logger;
```

## Behavioral contract

This contract is the **authoritative source for the log format**. No other contract may prescribe a JSON shape for log events; modules describe only *what* an event contains (severity, `msg` text, named context fields) using the canonical form:

> `log <severity>: msg="<message text>"; fields: <comma-separated names>`

The logger contract below defines how such an event is realized on the wire.

1. The logger writes NDJSON to `process.stdout` (single sink; no transports in v1).
2. Every emitted line is a JSON object with the top-level keys `time` (epoch ms, pino default), `level` (numeric, see mapping in §5), `pid`, `hostname`, `msg` (string), plus any bound context fields (e.g. `correlationId` from `childFor`). Module-contract events named as `log <sev>: msg="..."` become a `msg` value of exactly that string, with the listed `fields` as sibling top-level keys. No module is permitted to invent top-level keys outside this shape; sub-objects are allowed for nested context (e.g. `{ cmd: { userId, channelId } }`).
3. `redact.paths` MUST include at minimum `["discordToken", "*.discordToken", "*.token", "token", "*.*.token"]`; `redact.censor = "[Redacted]"`. (*Not* `remove` — see research R3.) Redaction applies regardless of nesting depth or which module emitted the line — the format contract owns secret-redaction centralization (Constitution Principle IV).
4. `childFor` MUST bind `correlationId` so it appears on every subsequent line until the handler returns (FR-004 / Principle III correlation IDs). Callers MUST NOT set `correlationId` via ad-hoc fields; they MUST go through `childFor`.
5. `logger.flush()` is callable by `lifecycle` during shutdown (FR-006) and MUST drain the buffer to stdout before resolving.
6. Level mapping to pino defaults (numeric `level` values): `trace`→10, `debug`→20, `info`→30, `warn`→40, `error`→50, `fatal`→60. Module contracts use the symbolic name; the logger owns the numeric encoding.

## Test obligations

- A unit test logging an object shaped like `{ config: { discordToken: "x" } }` asserts the serialized line contains `"[Redacted]"` and never `"x"` (SC-006 enabler).
- A `childFor` test asserts every subsequent line carries the bound `correlationId`.
- A "pino-pretty is dev-only" guard test asserts the production build does not import `pino-pretty` (static import scan).