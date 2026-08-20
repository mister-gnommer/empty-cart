#!/usr/bin/env bash
# SC-006 "secrets scan" helper (quickstart.md "Live-gateway smoke" step 6).
# Greps a captured log file for the literal value of the DISCORD_TOKEN
# environment variable and exits non-zero on match (leak), zero on clean.
#
# Usage:
#   set -a; source .env; set +a
#   node dist/index.js > run.log 2>&1 &
#   # ... exercise the bot, then stop it ...
#   scripts/secret-scan.sh run.log        # echo "clean" or "LEAK!"
#
# The script reads DISCORD_TOKEN from the current environment; if the
# variable is unset or empty, it errors out (a scan against nothing would
# silently pass even on a real leak).

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <logfile>" >&2
  exit 2
fi

LOG_FILE="$1"

if [[ -z "${DISCORD_TOKEN:-}" ]]; then
  echo "DISCORD_TOKEN is unset or empty — refusing to run a vacuous scan." >&2
  echo "Source your .env first (set -a; source .env; set +a)." >&2
  exit 2
fi

if [[ ! -f "$LOG_FILE" ]]; then
  echo "log file not found: $LOG_FILE" >&2
  exit 2
fi

if grep -F -- "$DISCORD_TOKEN" "$LOG_FILE" >/dev/null 2>&1; then
  echo "LEAK! DISCORD_TOKEN value appears in $LOG_FILE" >&2
  exit 1
fi

echo "clean"