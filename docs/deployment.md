# Deployment Guide

How to install, configure, run, and upgrade the bot as a systemd service on a single Linux VPS.

What the bot does once configured:

- Answers the `!echo` command and serves a loopback health endpoint. These always work.
- Reads photos of handwritten shopping lists posted in Discord and replies with the recognized text (Google Cloud Vision). Off until `OCR_PROVIDER` is set.
- Groups the recognized lines under category headings in shop-walk order (an LLM picks each line's category). Off until `SORTING_MODEL` is set.
- Traces each list's steps to LangSmith. On whenever `LANGSMITH_API_KEY` is set, unless `TRACING=off`.

---

## 1. Prerequisites

- A Linux VPS with Node.js 24 LTS (`node -v` prints `v24.x`).
- A Discord application with a bot user, created at https://discord.com/developers/applications. Enable the **Message Content Intent** under *Bot → Privileged Gateway Intents*, and invite the bot to a server with a text channel it can read and send in.
- For photo recognition: a Google Cloud service-account key (§3.1).
- For list sorting: an API key for Anthropic or an Anthropic-compatible gateway (§3.2).
- For tracing: a LangSmith API key (§3.3).

## 2. Install the bot

```bash
git clone <repo-url> /opt/empty-cart
cd /opt/empty-cart
npm ci                  # installs exact pinned deps from package-lock.json
npm run build           # tsc → dist/
```

## 3. External accounts

Skip the parts for features you leave off.

### 3.1 Google Cloud Vision (photo recognition)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick an existing one).
2. Enable **billing** on the project (Vision requires it, even inside the free tier).
3. Enable the **Cloud Vision API** (*APIs & Services → Library → Cloud Vision API → Enable*).
4. Create a **service account** (*IAM & Admin → Service Accounts → Create*). No project role is needed to call the Vision API itself.
5. Create a **JSON key** for that service account (*Keys → Add key → JSON*). Make sure you have the right file before copying it. Google Cloud downloads several kinds of credential JSON, and only a service-account key works:

| File | Downloaded as | Top-level content |
|---|---|---|
| Service-account key (**the one you need**) | `<project-id>-<12 hex chars>.json` | `"type": "service_account"`, `client_email`, `private_key` |
| OAuth client secret (wrong) | `client_secret_<id>.apps.googleusercontent.com.json` | `{"installed": {...}}` or `{"web": {...}}` |

```bash
grep -l '"service_account"' ~/Downloads/*.json      # on your machine: find the right file
```

Copy it to the VPS and install it for the service user:

```bash
scp <project-id>-<hash>.json root@<vps>:/root/gcv-key.json          # on your machine
sudo install -o empty-cart -g empty-cart -m 0600 /root/gcv-key.json /etc/empty-cart/gcv-key.json
shred -u /root/gcv-key.json    # remove the temporary copy on the VPS
```

`install` copies the file and sets its owner, group, and mode in one step, so the key is never readable by other users. Delete the downloaded copy on your machine too: you can always create a new key in the console.

The key file is a secret: mode `0600`, owned by the service user, never committed, never copied into the repo directory. The bot logs the key **path**, never its contents.

6. **Cap spend.** Every recognized image is billed, and the bot doesn't rate-limit in code. It only rejects a second submission from a user who already has one in flight. So a user could keep sending multi-image messages back to back. Set both of these:
   - **Request quota** (*APIs & Services → Cloud Vision API → Quotas & System Limits*): lower the request quota to what one household's lists need. When it runs out, Vision rejects the call, the bot logs `quota-exhausted`, and the user gets the generic "service not available" reply.
   - **Billing budget with alerts** (*Billing → Budgets & alerts*): add a small monthly budget with email alerts. A budget only notifies you; it doesn't stop spending. The quota is the hard cap.

### 3.2 Model provider (list sorting)

The only supported provider prefix is `anthropic:`, so the model must be reachable through Anthropic's Messages API, either directly or through a gateway that speaks it:

| Route | `SORTING_BASE_URL` | `SORTING_MODEL` | `SORTING_API_KEY` |
|---|---|---|---|
| Anthropic directly | unset | `anthropic:claude-haiku-5-5` | Anthropic key |
| OpenCode | `https://opencode.ai/inference/anthropic` | `anthropic:claude-haiku-5-5` | OpenCode key |
| OpenRouter | `https://openrouter.ai/api` (no `/v1`) | `anthropic:<OpenRouter model id>`, e.g. `anthropic:anthropic/claude-haiku-5.5` | OpenRouter key |

The bot has no cost controls beyond the on/off switch. Set a spending limit with the provider or gateway if you want one.

### 3.3 LangSmith (tracing)

Create an API key in LangSmith. Traces go to the project named by `LANGSMITH_PROJECT` (default `empty-cart`).

**Traces contain list text.** Tracing is on by default only for the initial test period. [Issue #16](https://github.com/mister-gnommer/empty-cart/issues/16) switches the default off and deletes the test-period traces. Logs never contain list text, traced or not.

## 4. Environment variables

All configuration lives in one file, `/etc/empty-cart/empty-cart.env`, owned by the service user with mode `0600`. A complete file with every feature on:

```text
# Keep comments on their own lines: systemd keeps anything after the `=`,
# including a trailing `# comment`, as part of the value.

# Discord (required, secret)
DISCORD_TOKEN=<bot token>

# Core (all optional; these are the defaults)
LOG_LEVEL=info
COMMAND_PREFIX=!
ECHO_COMMAND_NAME=echo
ECHO_MAX_LENGTH=1900
SHUTDOWN_TIMEOUT_MS=5000
HEALTH_HOST=127.0.0.1
HEALTH_PORT=8081

# Photo recognition (leave OCR_PROVIDER blank to switch it off)
OCR_PROVIDER=gcp-vision
GCP_SA_KEY_PATH=/etc/empty-cart/gcv-key.json
# OCR_LANGUAGE_HINTS=en
# OCR_CHANNEL_ALLOWLIST=123456789012345678

# List sorting (leave SORTING_MODEL blank to switch it off); see §3.2 for routes
SORTING_MODEL=anthropic:claude-haiku-5-5
SORTING_BASE_URL=https://opencode.ai/inference/anthropic
SORTING_API_KEY=<provider or gateway key>

# Tracing (blank key = untraced, with one startup warning)
LANGSMITH_API_KEY=<LangSmith key>
# TRACING=off
# LANGSMITH_PROJECT=empty-cart
```

Do **not** set `LANGSMITH_TRACING` for the bot. The bot passes its tracer explicitly; that variable makes LangChain add a second one and trace every run twice. It is only for `npm run eval`.

### 4.1 Reference

| Variable | Required | Validation | Default | Secret |
|---|---|---|---|---|
| `DISCORD_TOKEN` | yes | non-empty | — | **yes** (redacted in logs) |
| `LOG_LEVEL` | no | `trace\|debug\|info\|warn\|error\|fatal` | `info` | no |
| `COMMAND_PREFIX` | no | 1–4 chars, no whitespace | `!` | no |
| `ECHO_COMMAND_NAME` | no | non-empty, lowercase | `echo` | no |
| `ECHO_MAX_LENGTH` | no | integer 1–1900 | `1900` | no |
| `SHUTDOWN_TIMEOUT_MS` | no | integer 1000–30000 | `5000` | no |
| `HEALTH_HOST` | no | IPv4 literal (loopback only) | `127.0.0.1` | no |
| `HEALTH_PORT` | no | integer 1–65535 | `8081` | no |
| `OCR_PROVIDER` | no | `gcp-vision\|none` | `none` (recognition off) | no |
| `GCP_SA_KEY_PATH` | iff `OCR_PROVIDER=gcp-vision` | non-empty path; the file must be readable at startup | — | the path is not; the file **is** |
| `OCR_LANGUAGE_HINTS` | no | comma-separated loose BCP-47 tags (`en`, `de`, `zh-Hans`, `en-t-i0-handwrit` for handwriting) | provider auto-detects | no |
| `OCR_CHANNEL_ALLOWLIST` | no | comma-separated Discord channel ids (17–20 digits) | every channel the bot can see | no |
| `SORTING_MODEL` | no | `<provider>:<model>`, no whitespace; supported provider: `anthropic` | sorting off | no |
| `SORTING_API_KEY` | iff `SORTING_MODEL` is set | non-empty | — | **yes** |
| `SORTING_BASE_URL` | no | absolute `https:` URL, no whitespace or `#` | the provider's own API | no |
| `TRACING` | no | `langsmith\|off` | `langsmith` (test period, see §3.3) | no |
| `LANGSMITH_API_KEY` | no | — | untraced, one startup warning | **yes** |
| `LANGSMITH_PROJECT` | no | non-empty | `empty-cart` | no |

### 4.2 Blank vs. absent

A variable set to an empty value (`VAR=`) does not always behave like a missing one:

| Variables | Blank (`VAR=`) |
|---|---|
| `DISCORD_TOKEN` | fails startup as *missing* |
| `LOG_LEVEL`, `COMMAND_PREFIX`, `ECHO_COMMAND_NAME`, `ECHO_MAX_LENGTH`, `SHUTDOWN_TIMEOUT_MS`, `HEALTH_HOST`, `HEALTH_PORT`, `LANGSMITH_PROJECT` | fails startup as *malformed* |
| `OCR_CHANNEL_ALLOWLIST` | fails startup as *malformed*: an empty allowlist would silently switch recognition off everywhere |
| `OCR_PROVIDER`, `GCP_SA_KEY_PATH`, `OCR_LANGUAGE_HINTS`, `SORTING_MODEL`, `SORTING_API_KEY`, `SORTING_BASE_URL`, `TRACING`, `LANGSMITH_API_KEY` | same as absent: the default applies |

### 4.3 Rules

- Comma-separated values are **not trimmed**: `en, de` is malformed. Write `en,de`.
- Credentials for a feature that is off are not checked, so a key or key path may be staged before switching the feature on. `GCP_SA_KEY_PATH` is ignored while `OCR_PROVIDER=none`; `SORTING_API_KEY` and `SORTING_BASE_URL` are ignored while `SORTING_MODEL` is blank.
- `OCR_CHANNEL_ALLOWLIST` only limits photo processing and the usage hint. Commands such as `!echo` work in every channel. Threads inherit their parent channel's entry; channel *category* ids have no effect.
- Variables are validated in the order of the table in §4.1, and only the **first** problem is reported.
- Fixed in code, not configurable: the 7 MB image ceiling, accepted formats (JPEG, PNG, WEBP), the ~25 s recognition budget, the separate 15 s sorting budget, the 200-line sorting limit, and Discord's 2000-char message limit.

## 5. systemd unit

Install `/etc/systemd/system/empty-cart.service`:

```ini
[Unit]
Description=empty-cart Discord bot
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
TimeoutStopSec=10            # see "Shutdown budget" below
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now empty-cart.service
sudo systemctl status empty-cart.service
sudo systemctl stop empty-cart.service       # graceful SIGTERM
```

### Shutdown budget

The bot's own shutdown budget is `SHUTDOWN_TIMEOUT_MS`. systemd's `TimeoutStopSec` is the outer limit: when it elapses, systemd sends `SIGKILL`. Keep `TimeoutStopSec` above the bot's budget:

```
TimeoutStopSec = ceil(SHUTDOWN_TIMEOUT_MS / 1000) + headroom
```

With the default 5 s budget, `TimeoutStopSec=10` leaves 5 s for signal delivery and the final log flush. The bot logs `shutdown complete` and exits 0 on success, or `shutdown budget exceeded` and exits 1 on timeout.

## 6. Verifying it works

```bash
curl -s http://127.0.0.1:8081/healthz
```

Expected: `{"status":"healthy", "phase":"running", "discord":"connected", "uptimeMs":..., "checkedAt":...}`. Other `status` values: `degraded` (Discord disconnected, process fine), `shutting-down` (503, mid-shutdown), `unhealthy` (503, stopped).

The startup log shows which optional features are on:

```bash
sudo journalctl -u empty-cart -o cat | grep -E '"(sorting|tracing) (enabled|disabled)"|"bot started"'
```

Then post `!echo hi` and a photo of a shopping list in a processed channel.

## 7. Behavior

### 7.1 Photo replies

| Situation | Reply |
|---|---|
| Oversized image or unsupported format (HEIC, GIF, PDF, …; also files whose bytes aren't JPEG/PNG/WEBP) | Too-large or unsupported-format message, no call to Google |
| Recognition off (`OCR_PROVIDER` blank or `none`) | *"Service is not available, please try again later or contact the admin."* |
| Recognition on, sorting off | The recognized text as written |
| Sorting on, model answered validly | Grouped list under `**Category**` headings in shop-walk order; every line keeps its exact wording |
| Sorting on, model unreachable, slow (> 15 s), invalid answer, or list > 200 lines | *"I couldn't sort this list this time, so here it is as written:"* followed by the recognized text |

Text-only messages in processed channels get a usage hint. Discord system messages (joins, pins, boosts, thread-created notices) are always ignored.

Sorting makes one agent run per list with at most three model calls (up to two retries after answers of the wrong shape). Each call may also resend a failed request once. All of it fits in the 15 s budget.

### 7.2 Startup failures

Configuration and construction problems fail the bot **at startup**. systemd shows the unit as failed, and `journalctl -u empty-cart` has exactly one `fatal` line:

| Problem | Fatal log line |
|---|---|
| Missing or malformed variable | `msg="config validation failed"`, `env="<VARIABLE>"`, `reason="missing"` or `"malformed"` (never the value) |
| `GCP_SA_KEY_PATH` file missing or not readable by the service user | `msg="ocr provider failed to construct: GCP_SA_KEY_PATH does not point to a readable service-account key file"` |
| Unsupported provider in `SORTING_MODEL` | `msg="list categorizer failed to construct: unsupported model provider \"<provider>\""` |

A missing `LANGSMITH_API_KEY` with tracing on does not fail startup; it logs one `tracing disabled` warning with `reason: "missing-key"`.

### 7.3 Failures that only show per request

These pass startup. Users get the generic or fallback reply, and the log carries the cause with the submission's `correlationId`. The bot stays responsive.

- **Vision:** an invalid, revoked, or unauthorized key, a disabled Vision API, or missing billing (`unauthorized`, `quota-exhausted`, …).
- **Wrong key file type:** a readable file that is not a service-account key (for example an OAuth client secret, see §3.1) fails each photo within milliseconds with `cause: "provider-error"` and `googleCode: 2`. Check the file without printing the private key:

  ```bash
  sudo -u empty-cart node -e 'const k=require("/etc/empty-cart/gcv-key.json");console.log(k.type,k.client_email)'
  # expected: service_account <name>@<project>.iam.gserviceaccount.com
  ```

- **Sorting:** a bad API key or an unreachable gateway gives the sorting fallback reply on every list.

After replacing a key, restart the service.

## 8. Logs and traces

```bash
sudo journalctl -u empty-cart -f             # follow live
sudo journalctl -u empty-cart --since "1 hour ago"
```

Each line is NDJSON (pino). Every user-initiated action carries a `correlationId`. Logs never contain recognized text, image bytes, or key material.

A photo submission logs `list submission received` → `image submitted` (once per image) → one `list step` line per step (`step`, `outcome`, `durationMs`; sorting failures add `cause` and `categorizerId`) → `list submission succeeded` (with `sorting: "sorted" | "fallback" | "off"`), `list submission failed`, or `list submission rejected busy`.

```bash
sudo journalctl -u empty-cart -o cat | grep '"correlationId"'
sudo journalctl -u empty-cart -o cat | grep '"list step"'
```

With tracing on, open the LangSmith project: each list is one `list-submission` run whose metadata `correlationId` matches the logs, with child runs `recognize → categorize → sort` (or `unsorted`) and the model calls inside `categorize`.

## 9. Upgrading

Run the repo commands as the user that owns `/opt/empty-cart` (check with `stat -c %U /opt/empty-cart`), not as root:

```bash
OWNER=$(stat -c %U /opt/empty-cart)
sudo -u "$OWNER" git -C /opt/empty-cart pull origin main
sudo -u "$OWNER" npm --prefix /opt/empty-cart ci          # picks up new or changed dependencies
sudo -u "$OWNER" npm --prefix /opt/empty-cart run build
sudo systemctl restart empty-cart
curl -s http://127.0.0.1:8081/healthz                     # expect "status":"healthy"
```

Compare your env file with §4 after pulling: a release may add variables.

If you run `git` as root in a repo owned by another user, it fails with `fatal: detected dubious ownership in repository`. `git config --global --add safe.directory /opt/empty-cart` silences the error, but then root's `npm ci` and `npm run build` leave root-owned `node_modules/` and `dist/` that the owner can't update later. Prefer `sudo -u`. If the owner can't authenticate to the remote, pull as root and run `chown -R "$OWNER":"$OWNER" /opt/empty-cart` before restarting.

`systemctl` and `journalctl` always run as root. The unit's `User=empty-cart` makes systemd drop privileges for the bot itself.

When a release adds a feature that is off by default, deploy the code first and confirm it's healthy. Then switch the feature on in the env file and restart. A failure is then clearly the feature's configuration, not the upgrade.

## 10. Optional: Caddy in front of the health endpoint

The health server binds to loopback only. To expose it to an external monitor, front it with Caddy:

```text
# /etc/caddy/Caddyfile fragment
example.com/healthz {
    reverse_proxy 127.0.0.1:8081
}
```

The bot has no awareness of Caddy.

## Out of scope

- Multi-instance, cluster, or managed-service deployment.
- Docker.
