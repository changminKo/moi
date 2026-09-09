#!/usr/bin/env bash
# Periodic host + stack health line for the Oracle reference host, run by
# moi-status.timer every 5 minutes under `sops exec-env` (so that
# DISCORD_WEBHOOK_URL is present). One line is computed:
#
#   <ok|warn|fail> ready=<code> runtime=<state> KR=<state> US=<state> \
#     placement=<bool> mem_avail=<pct>% swap_used=<pct>% disk_used=<pct>%
#
# and posted to Discord through notify.sh when it differs from the last
# *delivered* line, so a steady state (good or bad) is announced once. The
# state file is written only after a successful post: a transition that hits a
# Discord outage is retried on the next tick instead of being lost. A
# heartbeat (`ok`) is posted when nothing has been delivered for
# MOI_STATUS_HEARTBEAT_HOURS (default 24), so silence never means "healthy".
#
# Levels: fail when readiness is not 200, the runtime is not SERVING, a market
# is not NORMAL or placement is disabled; warn when memory available < 15 %,
# swap used > 50 % or the root disk > 85 %; ok otherwise.
#
# A fail whose only cause is a market state (feed DEGRADED/RECOVERING while
# readiness, runtime and placement are fine) is held for
# MOI_STATUS_MARKET_GRACE_TICKS consecutive observations (default 2, so ≥ 5
# minutes on the 5-minute timer) before it is posted: the feed reconnects on
# its own in a few minutes most of the time, and announcing every blip as
# FAIL + recovered buried the alerts that matter. The held ticks still print
# their line to the journal. Every other fail posts at once.
#
# Every collector is overridable for tests:
#   MOI_STATUS_API_BASE         default https://$API_DOMAIN (the Caddy edge)
#   MOI_STATUS_STATE_FILE       default /var/lib/moi/status.last (line + epoch of last post + pending market ticks)
#   MOI_STATUS_HEARTBEAT_HOURS  default 24
#   MOI_STATUS_MARKET_GRACE_TICKS  default 2; 1 posts a market fail on first sight
#   MOI_STATUS_NOW              epoch seconds override (tests)
#   MOI_STATUS_DEPLOY_LOCK      default /run/moi-deploy.lock (fresh → exit 0, no probe)
#   MOI_STATUS_LOCK_MAX_AGE     default 1800 s; an older lock is ignored (stale deploy)
#   MOI_STATUS_BOT_STATE        "<status> <restartCount>" override for the bot probe (tests)
#   COMPOSE_PROFILES            from moi.env (systemd EnvironmentFile); `bot` turns the bot probe on
#   PATH                        `curl`, `free`, `df`, `jq`, `docker` are resolved from PATH
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api="${MOI_STATUS_API_BASE:-https://${API_DOMAIN:-localhost}}"
state_file="${MOI_STATUS_STATE_FILE:-/var/lib/moi/status.last}"
heartbeat_hours="${MOI_STATUS_HEARTBEAT_HOURS:-24}"
market_grace_ticks="${MOI_STATUS_MARKET_GRACE_TICKS:-2}"
case "$market_grace_ticks" in ''|*[!0-9]*|0) market_grace_ticks=1 ;; esac
now="${MOI_STATUS_NOW:-$(date -u +%s)}"

# deploy.sh holds this lock for the whole release (deploy-lib.sh); the restart
# window is announced by the deploy itself, not as an outage. A lock older than
# MOI_STATUS_LOCK_MAX_AGE seconds is a deploy that died without its trap
# (OOM, kill -9, power loss) and must not silence monitoring.
deploy_lock="${MOI_STATUS_DEPLOY_LOCK:-/run/moi-deploy.lock}"
lock_max_age="${MOI_STATUS_LOCK_MAX_AGE:-1800}"
if [ -e "$deploy_lock" ]; then
  lock_mtime="$(stat -c %Y "$deploy_lock" 2>/dev/null || stat -f %m "$deploy_lock" 2>/dev/null || echo 0)"
  if [ $(( now - lock_mtime )) -lt "$lock_max_age" ]; then
    exit 0
  fi
  echo "status-check: ignoring stale deploy lock $deploy_lock (age $(( now - lock_mtime ))s)" >&2
fi

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

# Phase D: the bot, when the host enables it (COMPOSE_PROFILES=bot in moi.env,
# which this timer's unit reads as well). Its own Discord channel would simply
# go quiet in a restart loop; the operational line must not stay ok while it
# does. Probed through docker labels rather than compose so a stray container
# left behind after the profile was removed is seen too.
bot=n/a; bot_status=n/a
case ",${COMPOSE_PROFILES:-}," in
  *,bot,*)
    if [ -n "${MOI_STATUS_BOT_STATE:-}" ]; then
      bot_state="$MOI_STATUS_BOT_STATE"
    else
      bot_id="$(docker ps -aq --filter label=com.docker.compose.project=moi --filter label=com.docker.compose.service=bot 2>/dev/null | head -1)"
      if [ -n "$bot_id" ]; then
        bot_state="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$bot_id" 2>/dev/null || echo 'unknown -1')"
      else
        bot_state="missing -1"
      fi
    fi
    bot_status="${bot_state%% *}"
    bot="${bot_status}/${bot_state#* }"
    ;;
esac

# free -m: "Mem: total used free shared buff/cache available" / "Swap: total used free"
read -r mem_total mem_avail < <(free -m | awk '/^Mem:/ {print $2, $7}')
read -r swap_total swap_used < <(free -m | awk '/^Swap:/ {print $2, $3}')
mem_avail_pct=$(( ${mem_total:-0} > 0 ? 100 * ${mem_avail:-0} / mem_total : 0 ))
swap_used_pct=$(( ${swap_total:-0} > 0 ? 100 * ${swap_used:-0} / swap_total : 0 ))
disk_used_pct="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
disk_used_pct="${disk_used_pct:-0}"

# hard_fail posts at once; market_fail alone waits out the grace window below.
hard_fail=0; market_fail=0
if [ "$ready" != 200 ] || [ "$runtime" != SERVING ] || [ "$placement" != true ] \
   || { [ "$bot_status" != n/a ] && [ "$bot_status" != running ]; }; then
  hard_fail=1
fi
[ "$kr" = NORMAL ] && [ "$us" = NORMAL ] || market_fail=1

level=ok
if [ "$hard_fail" = 1 ] || [ "$market_fail" = 1 ]; then
  level=fail
elif [ "$mem_avail_pct" -lt "$MEM_AVAIL_MIN" ] || [ "$swap_used_pct" -gt "$SWAP_USED_MAX" ] \
     || [ "$disk_used_pct" -gt "$DISK_USED_MAX" ]; then
  level=warn
fi

line="$level ready=$ready runtime=$runtime KR=$kr US=$us placement=$placement bot=$bot mem_avail=${mem_avail_pct}% swap_used=${swap_used_pct}% disk_used=${disk_used_pct}%"
echo "$line"

# Change detection compares a *signature* — level, probe results and which
# thresholds are breached — never the raw percentages, which drift a little
# every tick and would turn "post on change" into a post every five minutes.
mem_flag=ok; [ "$mem_avail_pct" -lt "$MEM_AVAIL_MIN" ] && mem_flag=low
swap_flag=ok; [ "$swap_used_pct" -gt "$SWAP_USED_MAX" ] && swap_flag=high
disk_flag=ok; [ "$disk_used_pct" -gt "$DISK_USED_MAX" ] && disk_flag=high
signature="$level ready=$ready runtime=$runtime KR=$kr US=$us placement=$placement bot=$bot_status mem=$mem_flag swap=$swap_flag disk=$disk_flag"

# State file: line 1 = signature of the last delivered status, line 2 = epoch
# of that post, line 3 = consecutive ticks a market-only fail has been observed
# (0 or absent when the markets are NORMAL or something harder is failing).
previous=""; last_post=0; pending=0
if [ -f "$state_file" ]; then
  previous="$(sed -n 1p "$state_file")"
  last_post="$(sed -n 2p "$state_file")"
  pending="$(sed -n 3p "$state_file")"
  case "$last_post" in ''|*[!0-9]*) last_post=0 ;; esac
  case "$pending" in ''|*[!0-9]*) pending=0 ;; esac
fi
stored_pending="$pending"
heartbeat_due=0
[ $(( now - last_post )) -ge $(( heartbeat_hours * 3600 )) ] && heartbeat_due=1

post() { NOTIFY_STRICT=1 "$here/notify.sh" "$@"; }
write_state() {
  local dir; dir="$(dirname "$state_file")"
  [ -d "$dir" ] || mkdir -p -m 0700 "$dir"
  printf '%s\n%s\n%s\n' "$1" "$2" "$3" > "$state_file"
}
record() {
  write_state "$signature" "$now" "$pending"
  previous="$signature"; last_post="$now"; stored_pending="$pending"
}

# Market grace: count the ticks a market-only fail has lasted and stay quiet
# until the window is full. Lines 1–2 (the delivered status) are untouched, so
# a blip that heals on the next tick leaves no trace in Discord.
if [ "$market_fail" = 1 ] && [ "$hard_fail" = 0 ]; then
  pending=$(( pending + 1 ))
  if [ "$pending" -lt "$market_grace_ticks" ]; then
    echo "status-check: market fail pending ($pending/$market_grace_ticks), not posted" >&2
    write_state "$previous" "$last_post" "$pending"
    exit 0
  fi
  pending="$market_grace_ticks"
else
  pending=0
fi

if [ "$signature" != "$previous" ]; then
  prev_level="${previous%% *}"
  title="Moi status $(printf %s "$level" | tr '[:lower:]' '[:upper:]')"
  if [ "$level" = ok ] && [ -n "$prev_level" ] && [ "$prev_level" != ok ]; then
    title="Moi status recovered"
  fi
  description="$line"
  [ -n "$previous" ] && description="$line"$'\n'"이전: $previous"
  if post "$level" "$title" "$description"; then
    record
  else
    echo "status-check: post failed, will retry next tick" >&2
  fi
elif [ "$heartbeat_due" = 1 ]; then
  if post "$level" "Moi status heartbeat ($level)" "$line"; then
    record
  else
    echo "status-check: heartbeat post failed, will retry next tick" >&2
  fi
fi
# The pending count is state of its own: a heal that posts nothing must still
# reset it, or the next blip would inherit the old count and post at once.
[ "$pending" = "$stored_pending" ] || write_state "$previous" "$last_post" "$pending"
exit 0
