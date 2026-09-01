#!/usr/bin/env bash
# Post one Discord embed. Alerting must never break a deploy or a timer run:
# a missing DISCORD_WEBHOOK_URL is a silent no-op and, by default, a failed
# post exits 0. With NOTIFY_STRICT=1 a failed (or impossible) post exits 1 so
# a caller that needs delivery — the status check — can retry later.
#
#   notify.sh <ok|warn|fail|info> <title> [description]
#
# The webhook URL is a secret (sops file on the host, `DISCORD_WEBHOOK_URL`);
# it is read from the environment only and never printed. Title and
# description are masked before they leave the host: credentials in URLs,
# KEY/TOKEN/SECRET/PASSWORD-style assignments and Discord webhook URLs.
set -uo pipefail
level="${1:-}"; title="${2:-}"; description="${3:-}"
strict="${NOTIFY_STRICT:-0}"
case "$level" in
  ok)   color=3066993 ;;   # 0x2ecc71
  warn) color=16098596 ;;  # 0xf5a524
  fail) color=15026253 ;;  # 0xe5484d
  info) color=5793266 ;;   # 0x5865f2
  *) echo "notify: usage: notify.sh <ok|warn|fail|info> <title> [description]" >&2; exit 2 ;;
esac
[ -n "$title" ] || { echo "notify: title required" >&2; exit 2; }
[ -n "${DISCORD_WEBHOOK_URL:-}" ] || exit 0

soft_fail() { echo "notify: $1" >&2; [ "$strict" = 1 ] && exit 1; exit 0; }
command -v jq >/dev/null 2>&1 || soft_fail "jq missing, nothing posted (${level}: ${title})"
command -v curl >/dev/null 2>&1 || soft_fail "curl missing, nothing posted (${level}: ${title})"

# Masking (AGENTS.md rule 2: secrets never reach chat). Applied to every
# outbound field; the journal tail sent by alert-unit-failed.sh can carry
# connection strings or environment dumps.
#
# The session, CSRF, Set-Cookie, idempotency-key and Bearer rules come from
# strategy-runner design §7.4, which requires the same four patterns on both
# sides: here and in the runner's reporter (packages/strategy-reporter,
# src/masking.ts). infra/oracle/notify.test.mjs holds this half to it.
mask() {
  printf %s "$1" | sed -E \
    -e 's#(https?://discord(app)?\.com/api/webhooks/)[^[:space:]"]*#<webhook>#g' \
    -e 's#([a-zA-Z][a-zA-Z0-9+.-]*://[^/:@[:space:]]+:)[^@[:space:]]+@#\1***@#g' \
    -e 's#[Bb]earer[[:space:]]+[^[:space:]]+#Bearer ***#g' \
    -e 's#(moi_session=)[^;[:space:],"]+#\1***#g' \
    -e 's#([Ss]et-[Cc]ookie|[Xx]-[Cc][Ss][Rr][Ff]-[Tt]oken|[Cc][Ss][Rr][Ff]-[Tt]oken|[Ii]dempotency-[Kk]ey)([[:space:]]*[:=][[:space:]]*)[^[:space:],;]+#\1\2***#g' \
    -e 's#([A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|WEBHOOK|key|token|secret|password|passwd|webhook)[A-Za-z0-9_]*[[:space:]]*[=:][[:space:]]*)[^[:space:]]+#\1***#g'
}
title="$(mask "$title")"
# Discord caps descriptions at 4096 characters; a journal tail needs far less.
description="$(mask "$description" | head -c 1500)"

payload="$(jq -cn \
  --arg title "$title" \
  --arg description "$description" \
  --argjson color "$color" \
  --arg footer "$(hostname) · $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{embeds: [{title: $title, description: $description, color: $color, footer: {text: $footer}}]}' 2>/dev/null)"
[ -n "$payload" ] || soft_fail "empty payload, nothing posted (${level}: ${title})"

# The URL travels to curl as a config file on stdin (-K -), not as an argument
# visible in the process list.
if ! printf 'url = "%s"\n' "$DISCORD_WEBHOOK_URL" \
   | curl -fsS --max-time 10 -o /dev/null -K - -H 'Content-Type: application/json' -d "$payload"; then
  soft_fail "post failed (${level}: ${title})"
fi
exit 0
