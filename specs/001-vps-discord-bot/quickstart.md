# Quickstart — `001-vps-discord-bot`

**Spec**: `specs/001-vps-discord-bot/spec.md` · **Research**: `specs/001-vps-discord-bot/research.md` · **Data model**: `specs/001-vps-discord-bot/data-model.md` · **Contracts**: `specs/001-vps-discord-bot/contracts/`

This is a **validation guide**, not the deployment runbook. For installing as a managed background service on the VPS, see `docs/deployment.md` (FR-010; created in Phase 2 / implementation). Here we prove the feature works end-to-end without a live Discord account first, then with one.

---

## Prerequisites

- Node.js 24 LTS installed (`node -v` prints `v24.x`).
- A Discord application + bot created at https://discord.com/developers/applications with the **Message Content Intent** enabled under *Bot → Privileged Gateway Intents* (research R2). You need the bot token and the right to invite the bot to a throwaway test server.
- The bot invited to a test server with at least one text channel it can read/send in.

## Setup

```bash
npm ci                      # installs exact pinned deps from package-lock.json
cp .env.example .env        # create the local env file
# edit .env: set DISCORD_TOKEN=<your bot token>; leave others at defaults
npm run build               # tsc → dist/
```

`.env` keys (see `research.md` R5 for validation; `contracts/config.md` for the contract):

```text
DISCORD_TOKEN=        # required, secret. Never commit.
LOG_LEVEL=info
COMMAND_PREFIX=!
ECHO_COMMAND_NAME=echo
ECHO_MAX_LENGTH=1900
SHUTDOWN_TIMEOUT_MS=5000
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8081
```

> Load `.env` only in your shell before running locally (e.g. `set -a; source .env; set +a`). The application reads `process.env`; it does not parse `.env` itself (FR-002: configuration via environment, not files). In production systemd injects these via the unit's `EnvironmentFile=` — see `docs/deployment.md`.

## Automated validation (no live Discord account required)

```bash
npm test
```

Expected: all unit + contract + integration suites green. In particular these exercises prove the spec:

| Suite | Proves | Spec ref |
|---|---|---|
| `tests/unit/echo.*` | empty→usage-hint, too-long→error boundary, mention payload echoed unchanged with `neutralizedMentions:true` | Story 1 #1–#4, FR-001, FR-013 |
| `tests/unit/config.*` | every missing/malformed env var → exactly one `fatal` log line naming it + non-zero exit | FR-003 |
| `tests/contract/discord.*` | every `channel.send` carries `allowedMentions: { parse: [], users: [], roles: [] }` | FR-013 |
| `tests/contract/health.*` | full `phase × discord` matrix over real HTTP; `shutting-down` returns 503 (no stale healthy) | FR-007, Story 3 #1–#3 |
| `tests/contract/lifecycle.*` | SIGTERM completes within budget, exit 0 (no `logger.flush()` called — SonicBoom exit-flush handles it, see `logger.md` §5), `msg="shutdown requested"` emitted; second SIGTERM idempotent; budget-exceeded → exit 1 | FR-006, SC-003, Edge Cases |
| `tests/integration/health.*` | round trips over a real in-process `node:http` server within 1 s | SC-004 |
| `tests/integration/echo.*` | hand-driven `Events.MessageCreate` → echoed reply on a stubbed `channel.send`; correlation id on every log line of the call | FR-001, FR-004 (Principle III) |

SC-006 (zero secrets in logs) is mechanically enforced by the logger's `redact.paths` — see `tests/unit/logger.redaction.*` and run the post-run scan in the live-gateway step below.

## Live-gateway smoke (real Discord, manual) — the "Validate on VPS" step

```bash
set -a; source .env; set +a
node dist/index.js &
BOT_PID=$!
```

1. **Health, starting → healthy**: in another shell, repeatedly:
   ```bash
   curl -s http://127.0.0.1:8081/healthz
   ```
   Observe `{"status":"degraded",...}` briefly while the gateway connects, then `{"status":"healthy",...}`.
2. **Echo round trip** (User Story 1 #1): in the test-server channel, type `!echo hello world` → the bot replies `hello world` in the same channel within ~2 s (SC-001). Try an empty `!echo` → usage hint (Story 1 #2). Try `!echo $(perl -e 'print "a"x1901')` → clear "too long" error (Story 1 #3).
3. **No ghost-ping (FR-013 / Story 1 #4)**: type `!echo <@YOUR_OWN_ID> @everyone` → confirm your own client does NOT light up a new mention notification for the bot's reply (the only notification was your own original message). Inspect the bot's reply in the channel: the text is echoed verbatim but no mention pill renders.
4. **Health during gateway loss (Edge Case)**: temporarily block network to Discord (firewall the gateway host) and watch `curl /healthz` flip to `{"status":"degraded"}` without the process crashing; on restoring network it returns to `healthy` (FR-012 auto-reconnect).
5. **Graceful shutdown (FR-006 / SC-003)**: `kill -TERM $BOT_PID`. Within ~5 s observe, in the logs:
   - one `info` log line with `msg="shutdown requested"` (and a `reason` field like `"SIGTERM"`),
   - one `info` log line with `msg="discord disconnected"`,
   - the process exits with status 0 (`echo $?`),
   - `curl /healthz` during the window returns 503 `shutting-down` (User Story 3 #3).
6. **Secret scan (SC-006)**: pipe the full run's stdout to a file and run:
   ```bash
   grep -F "$DISCORD_TOKEN" run.log && echo "LEAK!" || echo "clean"
   ```
   Expect `clean`.

## Wiring summary (where things live)

- Entry point & signal handling: `src/lifecycle/` + `src/app/index.ts` — `contracts/lifecycle.md`.
- Config: `src/config/` — `contracts/config.md`.
- Logging: `src/logger/` — `contracts/logger.md`.
- Health: `src/health/` — `contracts/health.md`.
- Echo logic (pure): `src/echo/` — `contracts/echo.md`.
- Discord transport (only place that imports `discord.js`): `src/discord/` — `contracts/discord.md`.
- Shared types (`BotState`, `Config`, `UserCommand`, `EchoResult`, `HealthStatus`): `src/shared/types.ts` — `data-model.md`.

## What this guide intentionally omits

Per the plan template's quickstart rules: no full implementation bodies, no migrations, no full test suites. Concrete steps and code live in `tasks.md` (Phase 2) and the implementation; the systemd unit file, log-rotation, and VPS install steps live in `docs/deployment.md`.