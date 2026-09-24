# Empty Cart

A single-VPS Discord bot (systemd-supervised) built feature-by-feature from the specs
under [`specs/`](specs/):

- **`001-vps-discord-bot`** — connection lifecycle, `!echo` command, health endpoint,
  graceful shutdown, structured logging with correlation ids.
- **`002-shopping-list-ocr`** *(in progress)* — post a photo of a handwritten shopping
  list in a processed channel and get the recognized text back, via Google Cloud Vision
  behind a provider-agnostic OCR contract.

## Development

Requires Node.js 24 LTS.

```bash
npm ci                  # exact pinned dependencies (no ^/~ ranges)
npm run dev             # tsx src/index.ts
npm run typecheck       # src + tests
npm test                # vitest: unit + contract + integration
npm run lint            # biome (incl. per-directory import boundaries)
```

Operator runbook (install, systemd unit, health checks, logs):
[`docs/deployment.md`](docs/deployment.md).

## Configuration

All configuration comes from environment variables — in production via the systemd
`EnvironmentFile`; see [`.env.example`](.env.example) for a sample file. On any
missing/malformed variable the bot refuses to start, emits exactly one structured
`fatal` log line naming the offending variable, and exits non-zero. Error messages
never contain the offending value.

### Empty values vs. absent variables

Whether a variable is **absent** or **set to an empty string** (`VAR=`) matters, and
the behavior is not the same for every variable:

| Variable | Absent | Explicitly empty (`VAR=`) |
|---|---|---|
| `DISCORD_TOKEN` | fails startup: *missing* | fails startup: *missing* (a blank token is treated as not set) |
| `LOG_LEVEL`, `COMMAND_PREFIX`, `ECHO_COMMAND_NAME`, `ECHO_MAX_LENGTH`, `SHUTDOWN_TIMEOUT_MS`, `HEALTH_HOST`, `HEALTH_PORT` | documented default applies | fails startup: *malformed* |
| `OCR_PROVIDER` | default `none` (recognition disabled) | treated as absent → `none` (the sample env file ships it blank on purpose) |
| `GCP_SA_KEY_PATH` | `null` — unless `OCR_PROVIDER=gcp-vision`, then fails startup: *missing* | treated as absent (same rule as the absent column) |
| `OCR_LANGUAGE_HINTS` | `[]` — the OCR provider auto-detects | `[]`; empty entries between commas are skipped as well |
| `OCR_CHANNEL_ALLOWLIST` | `null` — every channel the bot can see is processed | fails startup: *malformed* — an empty allowlist would silently disable recognition everywhere, so it is treated as operator error |

With recognition disabled (`OCR_PROVIDER` unset, blank, or `none`), the bot still
answers every image submission and is never silent. Input checks run first, so an
oversized or unsupported file gets its own message; any other image gets the generic
"service not available" reply. A key path may be pre-staged while the provider is `none`; it is stored
and used once the provider is switched on.

### List and pattern rules

- Comma-separated variables are **not trimmed**: an entry with surrounding whitespace
  (e.g. `en, de`) is malformed. Write `en,de`.
- `OCR_LANGUAGE_HINTS` entries are loose BCP-47 tags
  (`^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`), e.g. `en`, `zh-Hans`, `en-t-i0-handwrit`
  (the handwriting form).
- `OCR_CHANNEL_ALLOWLIST` entries are Discord channel snowflakes (17–20 digits). Threads under an allowlisted channel are processed too.
- Variables are validated in a fixed documented order (discord token → logging →
  command → health → OCR), so with several problems at once the **first** variable in
  that order is the one reported.
- `GCP_SA_KEY_PATH` is a path, not a secret value: the path may appear in logs, the
  key file's contents never do. Config validation does not touch the filesystem — when
  recognition is enabled, the OCR provider checks the key file at startup (boot-time
  failure, not first-photo-time).

Full variable reference (validation ranges, defaults, secrets, systemd unit):
[`docs/deployment.md` §3](docs/deployment.md#3-environment-variables).
