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
# readiness, runtime and placement are fine) is announced only once the window
# of the last MOI_STATUS_MARKET_WINDOW_TICKS observations (default 6 = 30 min)
# holds at least MOI_STATUS_MARKET_GRACE_TICKS bad ones (default 2): the feed
# reconnects on its own in a few minutes most of the time, and announcing every
# blip as FAIL + recovered buried the alerts that matter, while a feed that
# flaps every other tick must still be seen. Once announced, the recovery is
# held until the window is clean again, so a flapping feed is one FAIL line
# and a `(fail)` heartbeat, not a stream of pairs. The window lives in
# <state file>.grace as `<0/1 per tick, newest last> <epoch of last tick>` and
# is forgotten after a gap of more than two ticks (deploy lock, stopped
# timer). Held ticks still print their line to the journal. Every other fail
# posts at once, and so does any change while a fail is already announced.
#
# Every collector is overridable for tests:
#   MOI_STATUS_API_BASE         default https://$API_DOMAIN (the Caddy edge)
#   MOI_STATUS_STATE_FILE       default /var/lib/moi/status.last (line + epoch of last post; .grace beside it)
#   MOI_STATUS_HEARTBEAT_HOURS  default 24
#   MOI_STATUS_MARKET_GRACE_TICKS   default 2; 1 (or anything not a 1-3 digit count) switches the grace
#                                   off in both directions (post on first sight, recover at once)
#   MOI_STATUS_MARKET_WINDOW_TICKS  default 6 observations (1-3 digits)
#   MOI_STATUS_TICK_SEC             default 300; a gap over twice this forgets the window
#   (the production values live in /etc/moi/moi.env, the EnvironmentFile of moi-status.service)
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
case "$market_grace_ticks" in ''|*[!0-9]*|0|????*) market_grace_ticks=1 ;; esac
market_window_ticks="${MOI_STATUS_MARKET_WINDOW_TICKS:-6}"
case "$market_window_ticks" in ''|*[!0-9]*|0|????*) market_window_ticks=6 ;; esac
[ "$market_window_ticks" -ge "$market_grace_ticks" ] || market_window_ticks="$market_grace_ticks"
tick_sec="${MOI_STATUS_TICK_SEC:-300}"
case "$tick_sec" in ''|*[!0-9]*|0|???????*) tick_sec=300 ;; esac
grace_file="${state_file}.grace"
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
# Only a feed that is on its way back (DEGRADED/RECOVERING) is graced; an
# unknown or unexpected market state is a contract problem and fails closed.
hard_fail=0; market_fail=0
for market_state in "$kr" "$us"; do
  case "$market_state" in
    NORMAL) ;;
    DEGRADED|RECOVERING) market_fail=1 ;;
    *) hard_fail=1 ;;
  esac
done
if [ "$ready" != 200 ] || [ "$runtime" != SERVING ] || [ "$placement" != true ] \
   || { [ "$bot_status" != n/a ] && [ "$bot_status" != running ]; }; then
  hard_fail=1
fi

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
# of that post. Written only after a successful post.
previous=""; last_post=0
if [ -f "$state_file" ]; then
  previous="$(sed -n 1p "$state_file")"
  last_post="$(sed -n 2p "$state_file")"
  case "$last_post" in ''|*[!0-9]*) last_post=0 ;; esac
fi
prev_level="${previous%% *}"
# A delivered line that does not start with a level is a damaged file, not a
# status: treat it as "nothing delivered yet" so the current status is posted
# once and the file repaired, instead of feeding notify.sh an unknown level.
case "$prev_level" in
  ok|warn|fail) ;;
  *) previous=""; prev_level="" ;;
esac
heartbeat_due=0
[ $(( now - last_post )) -ge $(( heartbeat_hours * 3600 )) ] && heartbeat_due=1

post() { NOTIFY_STRICT=1 "$here/notify.sh" "$@"; }
ensure_dir() { [ -d "$1" ] || { mkdir -p "$1" && chmod 0700 "$1"; }; }
# Write-then-rename: a tick killed mid-write must not leave a truncated file
# that reads as "nothing delivered yet" and re-posts the current status.
write_file() {
  # A directory at the target would swallow the rename and report success.
  [ ! -d "$1" ] || return 1
  ensure_dir "$(dirname "$1")"
  printf '%s' "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"
}
record() { write_file "$state_file" "$1"$'\n'"$now"$'\n'; }
# A held tick still owes the heartbeat: it goes out with the level Discord is
# showing (the delivered one), the current line underneath, so "silence never
# means healthy" survives a 30-minute hold.
hold() {
  echo "status-check: $1, not posted" >&2
  if [ "$heartbeat_due" = 1 ] && [ -n "$prev_level" ]; then
    if post "$prev_level" "Moi status heartbeat ($prev_level)" "$line"$'\n'"$1"; then
      record "$previous"
    else
      echo "status-check: heartbeat post failed, will retry next tick" >&2
    fi
  fi
  exit 0
}

# Market window: `<history> <last tick epoch>`; history is one 0/1 per tick,
# newest last, trimmed to the window. Anything unreadable starts a fresh window,
# as does a gap of more than two ticks — a count that survived a deploy or a
# stopped timer would fire on the first blip afterwards.
history=""; last_tick=0
if [ -f "$grace_file" ]; then
  read -r history last_tick _ < "$grace_file" || true
fi
case "$history" in ''|*[!01]*) history="" ;; esac
case "$last_tick" in ''|*[!0-9]*) last_tick=0 ;; esac
# A clock that went backwards (NTP step, snapshot restore) is a gap too.
# A window whose age is unknown (no epoch) is not trusted either.
if [ "$last_tick" -eq 0 ] || [ $(( now - last_tick )) -gt $(( 2 * tick_sec )) ] || [ "$now" -lt "$last_tick" ]; then
  history=""
fi
history="${history}${market_fail}"
history="${history:$(( ${#history} > market_window_ticks ? ${#history} - market_window_ticks : 0 ))}"
bad_ticks="${history//0/}"; bad_ticks="${#bad_ticks}"
# A window that cannot be persisted would restart from one tick every run and
# never announce anything — nor release a delivered FAIL: fail open in both
# directions by switching the grace off for this tick, as grace=1 does.
if ! write_file "$grace_file" "$history $now"$'\n'; then
  echo "status-check: cannot write $grace_file, posting market changes without grace" >&2
  market_grace_ticks=1
fi

# The grace only delays the *first* announcement of a market-only fail; once a
# fail of any kind has been delivered, every later change (a hard cause clearing
# while the market stays bad, DEGRADED→RECOVERING) posts at once.
if [ "$market_fail" = 1 ] && [ "$hard_fail" = 0 ] && [ "$prev_level" != fail ] \
   && [ "$bad_ticks" -lt "$market_grace_ticks" ]; then
  hold "market fail pending ($bad_ticks/$market_grace_ticks bad ticks in the last $market_window_ticks)"
fi
# Hysteresis: a delivered market fail stays on the board until the window has
# been clean for its whole length, so a flapping feed is one line, not pairs.
# The signature writes the two markets side by side (`KR=… US=…`), so one
# adjacent literal is the test; two separate globs would never match.
case "$previous" in
  ''|*" KR=NORMAL US=NORMAL "*) prev_market_fail=0 ;;
  *) prev_market_fail=1 ;;
esac
# MOI_STATUS_MARKET_GRACE_TICKS=1 switches the whole mechanism off, this half too.
if [ "$market_grace_ticks" -gt 1 ] && [ "$level" != fail ] && [ "$prev_level" = fail ] \
   && [ "$prev_market_fail" = 1 ] && [ "$bad_ticks" -gt 0 ]; then
  hold "market recovery pending ($bad_ticks bad ticks in the last $market_window_ticks)"
fi

if [ "$signature" != "$previous" ]; then
  title="Moi status $(printf %s "$level" | tr '[:lower:]' '[:upper:]')"
  if [ "$level" = ok ] && [ -n "$prev_level" ] && [ "$prev_level" != ok ]; then
    title="Moi status recovered"
  fi
  description="$line"
  [ -n "$previous" ] && description="$line"$'\n'"이전: $previous"
  # A market fail arrives late by design; show the window so the operator can
  # line the alert up with the feed's own timeline.
  [ "$market_fail" = 1 ] && description="$description"$'\n'"시장 창: $history (최근 ${market_window_ticks}틱, 불량 $bad_ticks — ${market_grace_ticks}틱부터 게시)"
  if post "$level" "$title" "$description"; then
    record "$signature"
  else
    echo "status-check: post failed, will retry next tick" >&2
  fi
elif [ "$heartbeat_due" = 1 ]; then
  if post "$level" "Moi status heartbeat ($level)" "$line"; then
    record "$signature"
  else
    echo "status-check: heartbeat post failed, will retry next tick" >&2
  fi
fi
exit 0
