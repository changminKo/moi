#!/usr/bin/env bash
# Post one Discord embed. Alerting must never break a deploy or a timer run:
# a missing DISCORD_WEBHOOK_URL is a silent no-op and a failed post exits 0.
#
#   notify.sh <ok|warn|fail|info> <title> [description]
#
# The webhook URL is a secret (sops file on the host, `DISCORD_WEBHOOK_URL`);
# it is read from the environment only and never printed.
set -uo pipefail
level="${1:-}"; title="${2:-}"; description="${3:-}"
case "$level" in
  ok)   color=3066993 ;;   # 0x2ecc71
  warn) color=16098596 ;;  # 0xf5a524
  fail) color=15026253 ;;  # 0xe5484d
  info) color=5793266 ;;   # 0x5865f2
  *) echo "notify: usage: notify.sh <ok|warn|fail|info> <title> [description]" >&2; exit 2 ;;
esac
[ -n "$title" ] || { echo "notify: title required" >&2; exit 2; }
[ -n "${DISCORD_WEBHOOK_URL:-}" ] || exit 0

# Discord caps descriptions at 4096 characters; keep the payload well under.
description="$(printf %s "$description" | head -c 3500)"
payload="$(jq -cn \
  --arg title "$title" \
  --arg description "$description" \
  --argjson color "$color" \
  --arg footer "$(hostname) · $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{embeds: [{title: $title, description: $description, color: $color, footer: {text: $footer}}]}')"

if ! curl -fsS --max-time 10 -o /dev/null -H 'Content-Type: application/json' \
     -d "$payload" "$DISCORD_WEBHOOK_URL"; then
  echo "notify: post failed (${level}: ${title})" >&2
fi
exit 0
