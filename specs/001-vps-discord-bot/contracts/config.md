# Contract — `config`

**Module path**: `src/config/`
**Depends on**: `zod`, `process.env`
**Depended on by**: `lifecycle`, `logger`, `discord`, `health`
**Spec refs**: FR-002, FR-003, FR-005

## Public surface

```typescript
export type Config = { /* see data-model.md Entity 1 */ };

/** Throws `ConfigError` (never returns undefined) on any missing/malformed env var. Does not log. */
export function loadConfig(env: NodeJS.ProcessEnv): Config;

export class ConfigError extends Error {
  readonly envField: string;   // e.g. "DISCORD_TOKEN"
  readonly reason: 'missing' | 'malformed';
}
```

## Behavioral contract

1. `loadConfig` validates `env` exactly once against the zod schema in `research.md` R5 / `data-model.md` Entity 1. It takes **no logger** — it is a pure validator that either returns `Config` or throws `ConfigError`.
2. On the **first** invalid field it MUST `throw new ConfigError({ envField: "<FIELD>", reason: "missing"|"malformed" })` immediately. It MUST NOT log; the composition root (`lifecycle`) catches `ConfigError` and emits the single `log fatal: msg="config validation failed"; fields: env, reason` line using the bootstrap logger, then `process.exit(1)` (per `lifecycle.md` §1). This decouples `config` from `logger` and resolves the startup-ordering cycle. It MUST NOT include any value, secret or otherwise, in the `ConfigError` message.
3. On success, no secret field (`discordToken`) value may leave this module in any loggable form — only the returned `Config` carries it.
4. The returned `Config` is frozen (`Object.freeze`) and treated as readonly by callers.

## Test obligations (Principle I)

- One unit test per env field covering `missing` and at least one `malformed` variant, each asserting a thrown `ConfigError` with the correct `envField`/`reason` (no logger mock needed — `loadConfig` is pure).
- One golden-path test asserting the inferred `Config` type and freeze.
- A redaction test: an accidental `log.info({ config })` MUST render `discordToken` as `[Redacted]` (lives in the `logger` test suite; referenced here for cross-module coverage).