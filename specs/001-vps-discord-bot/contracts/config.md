# Contract — `config`

**Module path**: `src/config/`
**Depends on**: `zod`, `process.env`
**Depended on by**: `lifecycle`, `logger`, `discord`, `health`
**Spec refs**: FR-002, FR-003, FR-005

## Public surface

```typescript
export type Config = { /* see data-model.md Entity 1 */ };

/** Throws `ConfigError` (never returns undefined) on any missing/malformed env var. */
export function loadConfig(env: NodeJS.ProcessEnv, log: Logger): Config;

export class ConfigError extends Error {
  readonly envField: string;   // e.g. "DISCORD_TOKEN"
  readonly reason: 'missing' | 'malformed';
}
```

## Behavioral contract

1. `loadConfig` validates `env` exactly once against the zod schema in `research.md` R5 / `data-model.md` Entity 1.
2. On the **first** invalid field it MUST:
   - emit exactly one log event: `log fatal: msg="config validation failed"; fields: env, reason` (where `env` is the offending variable name like `DISCORD_TOKEN` and `reason` is `"missing"` or `"malformed"`). The wire-format shape (`time`, `level`, `pid`, `hostname`, `msg`, field encoding) is owned by `contracts/logger.md`.
   - `throw new ConfigError(...)` so the composition root can `process.exit(1)`.
   It MUST NOT log a second line, and MUST NOT log any value, secret or otherwise.
3. On success, no secret field (`discordToken`) value may appear in any log line produced by this module — only `Config` is returned.
4. The returned `Config` is frozen (`Object.freeze`) and treated as readonly by callers.

## Test obligations (Principle I)

- One unit test per env field covering `missing` and at least one `malformed` variant, each asserting exactly one `fatal` log line and a non-zero exit (mocked).
- One golden-path test asserting the inferred `Config` type and freeze.
- A redaction test: an accidental `log.info({ config })` MUST render `discordToken` as `[Redacted]`.