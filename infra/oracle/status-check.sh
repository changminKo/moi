#!/usr/bin/env bash
# Periodic host + stack health line for the Oracle reference host, run by
# moi-status.timer every 5 minutes under `sops exec-env` (so that
# DISCORD_WEBHOOK_URL is present). One line is computed:
#
#   <ok|warn|fail> ready=<code> runtime=<state> KR=<state> US=<state> \
#     placement=<bool> mem_avail=<pct>% swap_used=<pct>% disk_used=<pct>%
#
# and posted to Discord through notify.sh only when it differs from the last
# recorded line, so a steady state (good or bad) is announced once.
#
# Levels: fail when readiness is not 200, the runtime is not SERVING, a market
# is not NORMAL or placement is disabled; warn when memory available < 15 %,
# swap used > 50 % or the root disk > 85 %; ok otherwise.
#
# Every collector is overridable for tests:
#   MOI_STATUS_API_BASE   default https://$API_DOMAIN (the Caddy edge)
#   MOI_STATUS_STATE_FILE default /var/lib/moi/status.last
#   PATH                  `curl`, `free`, `df` are resolved from PATH
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api="${MOI_STATUS_API_BASE:-https://${API_DOMAIN:-localhost}}"
state_file="${MOI_STATUS_STATE_FILE:-/var/lib/moi/status.last}"

MEM_AVAIL_MIN=15
SWAP_USED_MAX=50
DISK_USED_MAX=85

ready="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$api/health/ready" 2>/dev/null || true)"
[ -n "$ready" ] || ready=000
md="$(curl -fsS --max-time 10 "$api/health/market-data" 2>/dev/null || true)"
tr="$(curl -fsS --max-time 10 "$api/api/v1/health/trading" 2>/dev/null || true)"

# `//` would turn a legitimate `false` into "unknown", hence the explicit null test.
field() {
  local value
  value="$(printf %s "$1" | jq -r "if $2 == null then \"unknown\" else $2 end" 2>/dev/null)" || value=""
  printf %s "${value:-unknown}"
}
runtime="$(field "$md" '.runtime')"
kr="$(field "$md" '.KR.state')"
us="$(field "$md" '.US.state')"
placement="$(field "$tr" '.placement')"

# free -m: "Mem: total used free shared buff/cache available" / "Swap: total used free"
read -r mem_total mem_avail < <(free -m | awk '/^Mem:/ {print $2, $7}')
read -r swap_total swap_used < <(free -m | awk '/^Swap:/ {print $2, $3}')
mem_avail_pct=$(( ${mem_total:-0} > 0 ? 100 * ${mem_avail:-0} / mem_total : 0 ))
swap_used_pct=$(( ${swap_total:-0} > 0 ? 100 * ${swap_used:-0} / swap_total : 0 ))
disk_used_pct="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
disk_used_pct="${disk_used_pct:-0}"

level=ok
if [ "$ready" != 200 ] || [ "$runtime" != SERVING ] || [ "$kr" != NORMAL ] \
   || [ "$us" != NORMAL ] || [ "$placement" != true ]; then
  level=fail
elif [ "$mem_avail_pct" -lt "$MEM_AVAIL_MIN" ] || [ "$swap_used_pct" -gt "$SWAP_USED_MAX" ] \
     || [ "$disk_used_pct" -gt "$DISK_USED_MAX" ]; then
  level=warn
fi

line="$level ready=$ready runtime=$runtime KR=$kr US=$us placement=$placement mem_avail=${mem_avail_pct}% swap_used=${swap_used_pct}% disk_used=${disk_used_pct}%"
echo "$line"

previous=""
[ -f "$state_file" ] && previous="$(cat "$state_file")"
if [ "$line" != "$previous" ]; then
  prev_level="${previous%% *}"
  title="Moi status $(printf %s "$level" | tr '[:lower:]' '[:upper:]')"
  if [ "$level" = ok ] && [ -n "$prev_level" ] && [ "$prev_level" != ok ]; then
    title="Moi status recovered"
  fi
  description="$line"
  [ -n "$previous" ] && description="$line"$'\n'"previous: $previous"
  "$here/notify.sh" "$level" "$title" "$description"
  dir="$(dirname "$state_file")"
  [ -d "$dir" ] || mkdir -p -m 0700 "$dir"
  printf '%s\n' "$line" > "$state_file"
fi
exit 0
