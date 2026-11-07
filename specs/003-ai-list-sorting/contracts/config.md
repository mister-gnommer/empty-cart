# Contract: `config` (003 extensions)

**Module path**: `src/config/`, `src/shared/types.ts`, `src/logger/create-logger.ts`
**Spec refs**: FR-009, FR-010, FR-014
**Base**: extends the 002 `config` contract. Field-order, `missing`/`malformed`, frozen-result and empty-equals-absent rules are unchanged.

## Public surface

```typescript
type SortingConfig =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'anthropic';
      model: string;            // full 'anthropic:<name>' string
      apiKey: string;           // secret: an OpenCode key when baseUrl points at OpenCode
      baseUrl: string | null;   // null = the provider's own API
    }>;

type TracingConfig =
  | Readonly<{ kind: 'off'; reason: 'disabled' | 'missing-key' }>
  | Readonly<{ kind: 'langsmith'; apiKey: string; project: string }>;

type Config = Readonly<{ /* ...002 fields... */ sorting: SortingConfig; tracing: TracingConfig }>;
```

## Env mapping & validation

| Env var | Field | Rule |
|---|---|---|
| `SORTING_MODEL` | `sorting.kind` / `sorting.model` | Optional. Absent or empty → `{ kind: 'none' }` (sorting off). Otherwise it must match `^<provider>:<name>$`, where `<provider>` is a supported kind (today only `anthropic`) and `<name>` is non-empty with no whitespace. Anything else → `malformed`. |
| `SORTING_API_KEY` | `sorting.apiKey` | **Required iff sorting is on**: absent or empty → `missing`. Ignored when sorting is off. Secret. |
| `SORTING_BASE_URL` | `sorting.baseUrl` | Optional; absent or empty → `null`. Must be an absolute `https:` URL with no whitespace and no `#` → else `malformed`. The second rule catches a trailing `# comment`, which systemd's `EnvironmentFile` keeps as part of the value and `URL.parse` would otherwise accept. *Revised 2026-11-07 (code review)*: added after the deployment guide's own sample line passed startup with a broken URL. The maintainer's value: `https://opencode.ai/inference/anthropic`. |
| `TRACING` | `tracing.kind` | Optional; default **`langsmith`** (test period, issue #16). The value `off` gives `{ kind: 'off', reason: 'disabled' }`. Anything else → `malformed`. |
| `LANGSMITH_API_KEY` | `tracing.apiKey` | Used iff `TRACING` resolves to `langsmith`. Absent or empty → **not an error**: `tracing` becomes `{ kind: 'off', reason: 'missing-key' }`, and startup logs one warning. Secret. |
| `LANGSMITH_PROJECT` | `tracing.project` | Optional; default `empty-cart`. Must be non-empty → else `malformed`. |

1. The new fields validate after all 002 fields, in table order.
2. **Secrets**: `*.apiKey` and `*.*.apiKey` are added to the logger's `REDACT_PATHS`. Neither key is ever logged, including in `ConfigError` text.
3. **`LANGSMITH_TRACING` is not read** by config. It MUST NOT be set for the bot, or LangChain adds its own env tracer and every run is traced twice. It is only for the eval command. `.env.example` says so.
4. `run-app.ts`:
   - It builds the categorizer exhaustively over `sorting.kind`: `none` → `null`; `anthropic` → `await createAgentCategorizer(...)`. A construction failure is fatal at startup, following the OCR provider pattern.
   - It always calls `createTracer(config.tracing)`, which returns no callbacks for `off`. It logs exhaustively over `tracing`:
     - `langsmith` → `{ msg: 'tracing enabled', project }` at `info`;
     - `off`/`missing-key` → `{ msg: 'tracing disabled', reason: 'missing-key' }` at `warn`;
     - `off`/`disabled` → `{ msg: 'tracing disabled', reason: 'disabled' }` at `info`.
   - **Shutdown** (extends 001 `contracts/lifecycle.md` §3): `tracer.flush()` starts with the stops and is bounded by the same `shutdownTimeoutMs` timer, but only `adapter.stop()` and `healthServer.stop()` decide the outcome. Stops done in time → wait for the flush, at most until the timer fires, then `shutdown complete` and exit 0. Stops over budget → `shutdown budget exceeded` and exit 1, as before. A failed or hanging flush loses traces, never the clean exit. *Superseded 2026-11-07 (code review)*: the flush used to race alongside the stops, so a slow tracing service turned a clean shutdown into exit 1.
5. An env file from feature 002 still loads, with sorting off and tracing `off`/`missing-key` (plus one warning line).

## Test obligations

- Defaults: only `DISCORD_TOKEN` set → `sorting.kind === 'none'`, `tracing` = `{ kind: 'off', reason: 'missing-key' }`.
- `LANGSMITH_API_KEY` set, `TRACING` absent → `langsmith`, project `empty-cart`. `TRACING=off` → `off`/`disabled` even with a key. `TRACING=yes` → `malformed`.
- `SORTING_MODEL=anthropic:claude-haiku-5-5` without `SORTING_API_KEY` → `missing SORTING_API_KEY`. With the key and `SORTING_BASE_URL=https://opencode.ai/inference/anthropic` → parsed.
- `SORTING_MODEL=openai:gpt-x`, `anthropic:`, `anthropic` and `anthropic: x` → `malformed`. `SORTING_BASE_URL=http://…`, `opencode.ai` or `https://opencode.ai/inference/anthropic   # OpenCode` → `malformed`.
- A logged config object shows `[Redacted]` for both keys.
