# Deployment Guide — `001-vps-discord-bot`

Operator runbook for installing the bot as a systemd-managed background service on a single Linux VPS (FR-009, FR-010, SC-005).

> **30-minute install target (SC-005).** This guide is sequenced so a single operator with no prior exposure to the codebase can reach a healthy, SIGTERM-clean bot in 30 minutes. The `docs/deployment.md` outline is fixed here during the spec/plan phase; concrete install commands and the canonical systemd unit text are finalized in the implementation task `T021` against `tasks.md`.

---

## 1. Prerequisites

- A Linux VPS (the documented target; other OSes are out of scope per spec §Assumptions).
- Node.js 24 LTS installed (`node -v` prints `v24.x`).
- A Discord application + bot created at https://discord.com/developers/applications with the **Message Content Intent** enabled under *Bot → Privileged Gateway Intents* (research R2).
- The bot invited to a test server with at least one text channel it can read/send in.

## 2. Install the bot

```bash
git clone <repo-url> /opt/empty-cart
cd /opt/empty-cart
npm ci                  # installs exact pinned deps from package-lock.json (no ^/~)
npm run build           # tsc → dist/
```

## 3. Environment variables

Create `/etc/empty-cart/empty-cart.env` (readable only by the service user; mode `0600`):

```text
DISCORD_TOKEN=                 # required, secret. Never commit.
LOG_LEVEL=info
COMMAND_PREFIX=!
ECHO_COMMAND_NAME=echo
ECHO_MAX_LENGTH=1900
SHUTDOWN_TIMEOUT_MS=5000
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8081
```

| Variable | Required | Validation | Default | Secret |
|---|---|---|---|---|
| `DISCORD_TOKEN` | yes | non-empty string | — | yes (redacted in logs) |
| `LOG_LEVEL` | no | enum `trace\|debug\|info\|warn\|error\|fatal` | `info` | no |
| `COMMAND_PREFIX` | no | 1–4 chars, no whitespace | `!` | no |
| `ECHO_COMMAND_NAME` | no | non-empty, lowercase | `echo` | no |
| `ECHO_MAX_LENGTH` | no | integer 1–1900 | `1900` | no |
| `SHUTDOWN_TIMEOUT_MS` | no | integer 1000–30000 | `5000` | no |
| `HEALTH_HOST` | no | IPv4 literal (loopback only) | `127.0.0.1` | no |
| `HEALTH_PORT` | no | integer 1–65535 | `8081` | no |

On any missing/malformed variable the bot refuses to start, emits exactly one structured `fatal` log line naming the offending variable, and exits non-zero (FR-003).

## 4. systemd unit

Install `/etc/systemd/system/empty-cart.service`:

```ini
[Unit]
Description=empty-cart Discord bot (001-vps-discord-bot)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=empty-cart
Group=empty-cart
WorkingDirectory=/opt/empty-cart
EnvironmentFile=/etc/empty-cart/empty-cart.env
ExecStart=/usr/bin/node /opt/empty-cart/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=10            # see §Shutdown-budget mapping below
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### Shutdown-budget mapping

SC-003 requires shutdown to complete within 5 s and exit 0 in ≥95 % of trials. The bot's internal budget is `SHUTDOWN_TIMEOUT_MS` (default `5000` ms). systemd's `TimeoutStopSec` is the *outer* supervisor timeout — when it elapses systemd sends `SIGKILL` (ungraceful). To give the bot the full budget to exit gracefully:

```
TimeoutStopSec = ceil(SHUTDOWN_TIMEOUT_MS / 1000) + headroom
```

Recommended: `SHUTDOWN_TIMEOUT_MS=5000` (5 s budget) → `TimeoutStopSec=10` (5 s headroom for SIGTERM propagation + final log flush). The bot's `lifecycle` module races `adapter.stop()` + `healthServer.stop()` against `SHUTDOWN_TIMEOUT_MS` and emits `log info: msg="shutdown complete"` on success or `log warn: msg="shutdown budget exceeded"` + exit 1 on timeout (see `contracts/lifecycle.md` §3).

### Install / start / stop

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now empty-cart.service
sudo systemctl status empty-cart.service
sudo systemctl stop empty-cart.service       # graceful SIGTERM
```

## 5. Verifying health

```bash
curl -s http://127.0.0.1:8081/healthz
```

Expected response: `{"status":"healthy", "phase":"running", "discord":"connected", "uptimeMs":..., "checkedAt":...}`. The `status` field distinguishes `healthy` / `degraded` (Discord disconnected, process fine) / `shutting-down` (503, mid-shutdown) / `unhealthy` (503, stopped). See `contracts/health.md` §3 for the full matrix.

## 6. Viewing logs

```bash
sudo journalctl -u empty-cart -f             # follow live
sudo journalctl -u empty-cart --since "1 hour ago"
```

Each line is NDJSON (pino, see `contracts/logger.md`). Every user-initiated action carries a `correlationId` (FR-004 / Principle III).

## 7. Optional: Caddy reverse proxy in front of the health endpoint

The health server binds to `127.0.0.1:8081` (loopback only). If the operator wants to expose it for an external dashboard/monitor, front it with the existing Caddy:

```text
# /etc/caddy/Caddyfile fragment
example.com/healthz {
    reverse_proxy 127.0.0.1:8081
}
```

This is a deployment-time concern only; the bot has no awareness of Caddy and the contract/code does not change. (US3-relevant — included here per FR-010 "bundled deployment documentation".)

---

## Out of scope of this guide

- Multi-instance, cluster, or managed-service deployment (FR-009 forbids).
- Docker containerization (research R9 excludes for v1).
- OAuth, slash-command registration, or non-echo commands (future specs).