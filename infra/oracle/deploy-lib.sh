#!/usr/bin/env bash
# Sourced by deploy.sh: step tracking, Discord notifications, the deploy lock
# that silences the status timer, and an exit trap that can only report success
# after the verification step set VERIFIED=1. Kept separate so the trap logic
# is testable without a host (infra/oracle/status-check.test.mjs).
#
# Requires REPO. Uses withsecrets() when the caller defines it (deploy.sh runs
# notify.sh under sops exec-env so DISCORD_WEBHOOK_URL is present). Overrides
# for tests: NOTIFY_BIN, MOI_DEPLOY_LOCK, MOI_DEPLOY_MANAGE_TIMER=0.
STEP=start
VERIFIED=0
DEPLOY_REF=""
DEPLOY_LOCK="${MOI_DEPLOY_LOCK:-/run/moi-deploy.lock}"
MANAGE_TIMER="${MOI_DEPLOY_MANAGE_TIMER:-1}"

step() { STEP="$1"; echo "== $1"; }

# Never able to fail the deploy: notify.sh is fail-open by default and the
# call is guarded anyway. Arguments are %q-quoted for the sh -c that
# `sops exec-env` uses, so keep them ASCII.
notify() {
  local bin="${NOTIFY_BIN:-$REPO/infra/oracle/notify.sh}"
  if declare -F withsecrets >/dev/null 2>&1; then
    withsecrets "$bin $(printf '%q ' "$@")" || true
  else
    "$bin" "$@" || true
  fi
}

# Phase D: is the bot container *steadily* up? A runner that refuses its
# configuration lives for a moment and is restarted by Docker, so one `running`
# proves nothing; this wants `running` with a RestartCount of 0 for
# MOI_BOT_STEADY_POLLS consecutive polls. `$1` is a command that prints
# "<status> <restartCount>" (docker inspect -f '{{.State.Status}} {{.RestartCount}}').
bot_steady() {
  local probe="$1" need="${MOI_BOT_STEADY_POLLS:-5}" max="${MOI_BOT_STEADY_MAX:-20}"
  local pause="${MOI_BOT_STEADY_SLEEP:-3}" steady=0 state i
  for ((i = 0; i < max; i++)); do
    state="$(eval "$probe" 2>/dev/null || echo 'missing -1')"
    if [ "$state" = "running 0" ]; then steady=$((steady + 1)); else steady=0; fi
    [ "$steady" -ge "$need" ] && return 0
    sleep "$pause"
  done
  return 1
}

# The status timer must not report the restart window as an outage.
status_timer() {
  [ "$MANAGE_TIMER" = 1 ] || return 0
  command -v systemctl >/dev/null 2>&1 || return 0
  systemctl "$1" moi-status.timer >/dev/null 2>&1 || true
}

deploy_begin() {
  DEPLOY_REF="$1"
  : > "$DEPLOY_LOCK"
  notify info "deploy started: ${DEPLOY_REF}" "host $(hostname)"
}

# Called by deploy.sh only after readiness, both markets NORMAL and placement
# were observed; the exit trap treats any other exit 0 as a failure.
deploy_verified() {
  VERIFIED=1
  notify ok "deploy finished: $1" "ref ${DEPLOY_REF}, KR/US NORMAL, placement enabled"
}

on_exit() {
  local code=$?
  trap - EXIT INT TERM HUP
  rm -f "$DEPLOY_LOCK"
  status_timer start
  if [ "$code" = 0 ] && [ "$VERIFIED" = 1 ]; then exit 0; fi
  # Reaching the end without verification is a failure, never a silent success.
  [ "$code" = 0 ] && code=1
  notify fail "deploy failed: ${DEPLOY_REF:-unknown}" "step: ${STEP} (exit ${code}) on $(hostname)"
  exit "$code"
}
trap on_exit EXIT
# Signals must surface as failures with their conventional codes; without these
# the EXIT trap would observe $?=0 after an interrupt.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
