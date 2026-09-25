# Deployment Guide — `001-vps-discord-bot`

Operator runbook for installing the bot as a systemd-managed background service on a single Linux VPS (FR-009, FR-010, SC-005).

> **30-minute install target (SC-005).** This guide is sequenced so a single operator with no prior exposure to the codebase can reach a healthy, SIGTERM-clean bot in 30 minutes. Finalized in implementation task `T021` against `specs/001-vps-discord-bot/tasks.md`; the install commands, env-var reference, systemd unit text, and shutdown-budget mapping below match the implementation reality in `src/`.

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

## 8. OCR operations (`002-shopping-list-ocr`)

The bot reads photos of shopping lists posted in Discord and replies with the recognized text. Recognition is performed by Google Cloud Vision. It is **off by default** — a 001-era env file keeps working unchanged.

### 8.1 Google Cloud provisioning (one-time)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick an existing one).
2. Enable **billing** on the project (Vision requires it, even inside the free tier).
3. Enable the **Cloud Vision API** (*APIs & Services → Library → Cloud Vision API → Enable*).
4. Create a **service account** (*IAM & Admin → Service Accounts → Create*). No project role is needed to call the Vision API itself.
5. Create a **JSON key** for that service account (*Keys → Add key → JSON*) and copy it to the VPS:

```bash
sudo install -o empty-cart -g empty-cart -m 0600 gcv-key.json /etc/empty-cart/gcv-key.json
shred -u gcv-key.json          # remove the local copy
```

The key file is a secret: mode `0600`, owned by the service user, never committed, never copied into the repo directory. The bot logs the key **path**, never its contents.

6. **Cap spend.** Every recognized image is billed, and the bot doesn't rate-limit in code. It only rejects a second submission from a user who already has one in flight. So a user could keep sending multi-image messages back to back. Set both of these:
   - **Request quota** (*APIs & Services → Cloud Vision API → Quotas & System Limits*): lower the request quota to what one household's lists need. When it runs out, Vision rejects the call, the bot logs `quota-exhausted`, and the user gets the generic "service not available" reply.
   - **Billing budget with alerts** (*Billing → Budgets & alerts*): add a small monthly budget with email alerts. A budget only notifies you; it doesn't stop spending. The quota is the hard cap.

### 8.2 OCR environment variables

Append to `/etc/empty-cart/empty-cart.env`:

```text
OCR_PROVIDER=gcp-vision
GCP_SA_KEY_PATH=/etc/empty-cart/gcv-key.json
# OCR_LANGUAGE_HINTS=en                       # optional; omit for auto-detect
# OCR_CHANNEL_ALLOWLIST=123456789012345678    # optional; omit = all channels
```

| Variable | Required | Validation | Default | Secret |
|---|---|---|---|---|
| `OCR_PROVIDER` | no | enum `gcp-vision\|none` | `none` | no |
| `GCP_SA_KEY_PATH` | iff `OCR_PROVIDER=gcp-vision` | non-empty path; the file must be readable at startup | — | the path is not secret; the file **is** |
| `OCR_LANGUAGE_HINTS` | no | comma-separated loose BCP-47 tags (`en`, `de`, `zh-Hans`, `en-t-i0-handwrit`) | empty = provider auto-detect | no |
| `OCR_CHANNEL_ALLOWLIST` | no | comma-separated Discord channel ids (17–20 digits); an explicitly empty value is rejected | unset = every channel the bot can see | no |

Notes:

- With `OCR_PROVIDER=none`, `GCP_SA_KEY_PATH` may still be set (pre-staging a key before switching on); a blank value counts as unset, and a set value is otherwise ignored.
- `OCR_CHANNEL_ALLOWLIST` only limits photo processing and the usage hint. Commands such as `!echo` keep working in every channel. Threads inherit their parent channel's entry, so a photo posted in a thread under an allowlisted channel is processed. List category ids have no effect.
- Discord system messages (member joins, pins, boosts, thread-created notices) are always ignored: they never get the usage hint.
- The 7 MB image ceiling, the ~25 s per-submission budget, and Discord's 2000-char message limit are fixed in code and not configurable.
- Accepted formats are JPEG, PNG, and WEBP. HEIC, GIF, PDF, and other files receive the unsupported-format reply without any call to Google.

### 8.3 Behavior with `OCR_PROVIDER=none`

Recognition is disabled but the bot never goes silent. Input checks still run first: an oversized image gets the too-large reply, and an unsupported file gets the unsupported-format reply. That includes a file whose downloaded bytes are not JPEG/PNG/WEBP, so a passing image is still downloaded. Every other image submission is answered with the generic *"Service is not available, please try again later or contact the admin."* message. Text-only messages in processed channels still get the usage hint, and all commands work normally. No call is made to Google.

### 8.4 Startup failures

Key problems fail the bot **at startup**, not when the first photo arrives. systemd will show the unit as failed, and `journalctl -u empty-cart` contains exactly one `fatal` line:

| Problem | Fatal log line |
|---|---|
| `OCR_PROVIDER=gcp-vision` without `GCP_SA_KEY_PATH` | `msg="config validation failed"`, `env="GCP_SA_KEY_PATH"`, `reason="missing"` |
| `OCR_PROVIDER` set to an unknown value | `msg="config validation failed"`, `env="OCR_PROVIDER"`, `reason="malformed"` |
| Key file missing or not readable by the service user | `msg="ocr provider failed to construct: GCP_SA_KEY_PATH does not point to a readable service-account key file"` |

Only file readability is checked at startup. An invalid, revoked, or unauthorized key (and a disabled Vision API or missing billing) shows up at request time instead: users get the generic message, and the log carries the specific cause (`unauthorized`, `quota-exhausted`, …) with the submission's `correlationId`. The bot stays responsive.

### 8.5 Viewing OCR activity

Every photo submission logs `list submission received` → `image submitted` (once per image) → `list submission succeeded` / `list submission failed` (or `list submission rejected busy`), all sharing one `correlationId`:

```bash
sudo journalctl -u empty-cart -o cat | grep '"correlationId"'
```

Logs never contain recognized text, image bytes, or key material.

### 8.6 Switching OCR providers

The list flow depends only on the provider-agnostic `OcrProvider` contract in `src/ocr/types.ts`. Adding another provider takes exactly three changes:

1. **A new sibling module** (e.g. `src/<vendor>/provider.ts`) that implements `OcrProvider` and maps the vendor's responses and errors to the contract's result types (`ok` / `undecodable-image` / `unavailable` with a cause). If it uses a vendor SDK, add a matching `noRestrictedImports` boundary in `biome.json` so only that module can import it.
2. **A new config enum value** for `OCR_PROVIDER` (in `src/config/schema.ts`, `src/config/load-config.ts`, and the `Config` type in `src/shared/types.ts`), plus any credentials the provider needs.
3. **One wiring branch** in the provider-selection block of `src/lifecycle/run-app.ts`.

Image detection (`src/image/`), ordering and reply logic (`src/shopping-list/`), and reply posting (`src/discord/`) need **no** changes. `tests/contract/ocr-swap.spec.ts` enforces this: it runs the full user-facing flow against two different provider implementations and requires identical replies, and it statically checks that only the lifecycle wiring knows which provider is active.

After switching, restart the service (`sudo systemctl restart empty-cart`) and send a test photo.

---

## Out of scope of this guide

- Multi-instance, cluster, or managed-service deployment (FR-009 forbids).
- Docker containerization (research R9 excludes for v1).
- OAuth, slash-command registration, or non-echo commands (future specs).