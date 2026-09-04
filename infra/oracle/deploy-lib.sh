#!/usr/bin/env bash
# Sourced by deploy.sh: step tracking, Discord notifications, the deploy lock
# that silences the status timer, and an exit trap that can only report success
# after the verification step set VERIFIED=1. Kept separate so the trap logic
# is testable without a host (infra/oracle/status-check.test.mjs).
#
# Requires REPO. Uses withsecrets() when the caller defines it (deploy.sh runs
# notify.sh under sops exec-env so DISCORD_WEBHOOK_URL is present). Overrides
# for tests: NOTIFY_BIN, MOI_DEPLOY_LOCK, MOI_DEPLOY_MUTEX,
# MOI_DEPLOY_MANAGE_TIMER=0.
STEP=start
VERIFIED=0
DEPLOY_REF=""
DEPLOY_LOCK="${MOI_DEPLOY_LOCK:-/run/moi-deploy.lock}"
DEPLOY_MUTEX="${MOI_DEPLOY_MUTEX:-/run/moi-deploy.mutex}"
DEPLOY_OWNS_MUTEX=0
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
  if ! command -v flock >/dev/null 2>&1; then
    echo "FAIL: flock is required to serialize deploys (install util-linux)" >&2
    return 69
  fi
  if [ "${MOI_DEPLOY_REEXEC:-0}" = 1 ]; then
    if ! fd9_is_mutex || [ ! -e "$DEPLOY_LOCK" ] || ! flock -n 9; then
      echo "FAIL: deploy re-exec lost its inherited mutex or active marker (unset MOI_DEPLOY_REEXEC if it leaked from your shell)" >&2
      return 70
    fi
    DEPLOY_OWNS_MUTEX=1
    DEPLOY_REF="$1"
    return 0
  fi
  exec 9>"$DEPLOY_MUTEX"
  if ! flock -n 9; then
    echo "FAIL: another deploy is already in progress" >&2
    return 75
  fi
  DEPLOY_OWNS_MUTEX=1
  DEPLOY_REF="$1"
  : > "$DEPLOY_LOCK"
  notify info "deploy started: ${DEPLOY_REF}" "호스트 $(hostname)"
}

# True when descriptor 9 is open on the mutex file itself — not merely open.
# A re-exec guard leaked from an operator shell (`sudo -E`) arrives with no
# descriptor, or with one on some unrelated file; flock would happily lock
# either. perl is a bootstrap dependency (notify.sh masks with it).
fd9_is_mutex() {
  perl -e '
    my @file = stat($ARGV[0]) or exit 1;
    open(my $fd, "<&=", 9) or exit 1;
    my @held = stat($fd) or exit 1;
    exit(($file[0] == $held[0] && $file[1] == $held[1]) ? 0 : 1);
  ' "$DEPLOY_MUTEX"
}

# Replace the pre-fetch process with the script from the checked-out release.
# Descriptor 9 is intentionally inherited across exec; deploy_begin validates
# and adopts it in the replacement process without posting a second start.
deploy_reexec() {
  [ "${MOI_DEPLOY_REEXEC:-0}" = 1 ] && return 0
  # A failed `exec` ends a non-interactive shell with 127 and skips the EXIT
  # trap: the marker would stay, no failure alert, monitoring silent for
  # MOI_STATUS_LOCK_MAX_AGE. A missing file or execute bit is caught here and
  # fails through the trap like every other step; `execfail` covers the rest
  # (an executable whose interpreter is missing) — with it set, bash 5 treats
  # the failed exec as an ordinary failing command and errexit runs the trap.
  if [ ! -x "$1" ]; then
    echo "FAIL: cannot re-exec $1: not an executable file in the checked-out release" >&2
    return 1
  fi
  export MOI_DEPLOY_REEXEC=1
  shopt -s execfail
  exec "$@"
}

# The label publish.yml writes on every runtime image; the contract checker
# keeps the two spellings equal.
REVISION_LABEL="org.opencontainers.image.revision"
REVISION_FORMAT="{{ index .Config.Labels \"$REVISION_LABEL\" }}"

# verify_revisions <image|container> <expected sha> <subject>... — every
# subject must carry REVISION_LABEL equal to the checkout. A container's
# Config.Labels are its image's labels, so the same read works for both.
verify_revisions() {
  local kind="$1" expected="$2"
  local subject revision
  shift 2
  if [ "$#" -lt 2 ]; then
    echo "FAIL: revision verification requires at least the two public release ${kind}s" >&2
    return 64
  fi
  for subject in "$@"; do
    if [ "$kind" = image ]; then
      revision="$(docker image inspect --format "$REVISION_FORMAT" "$subject")" || revision=__inspect_failed__
    else
      revision="$(docker inspect --format "$REVISION_FORMAT" "$subject")" || revision=__inspect_failed__
    fi
    if [ "$revision" = __inspect_failed__ ]; then
      echo "FAIL: cannot inspect release $kind $subject" >&2
      return 1
    fi
    # Images published before the label existed never reach this line: a
    # rollback to such a ref re-execs that ref's own deploy.sh, which has no
    # revision check. Every image a checkout with this check can name was
    # labelled at build, so a missing label is a hand-pushed image.
    if [ -z "$revision" ] || [ "$revision" = "<no value>" ]; then
      echo "FAIL: $subject has no $REVISION_LABEL label" >&2
      return 1
    fi
    if [ "$revision" != "$expected" ]; then
      echo "FAIL: $subject revision does not match checkout (expected $expected, got $revision)" >&2
      return 1
    fi
  done
  echo "release ${kind}s verified at $expected"
}

# Pulled images, before migrations: a mutable tag is only a selector.
verify_release_image_revisions() { verify_revisions image "$@"; }

# Running containers, after the restart: systemd starts the stack from
# /etc/moi/moi.env alone, so an image tag pinned only on the deploy command
# line would verify one release and run another. The containers themselves
# are the last word.
verify_running_container_revisions() { verify_revisions container "$@"; }

# #25: every other verification here talks to the API. The browser app is a
# second image with its own configuration, and the first Oracle release passed
# all of them while `/trade` was unusable: `POST /api/v1/sessions/anonymous`
# reached the static server (405, GET/HEAD only) and the page showed nothing
# but "Retry session".
#
# The cause was the served configuration, not the client. `createApiClient`
# has read `/runtime-config.js` since the session bootstrap first shipped; it
# called the page's own origin because that is what the config it was given
# named — `apps/web/public/runtime-config.js` assigns
# `window.location.origin`, and the issue's own summary blaming the client is
# wrong.
#
# What this adds is narrower than it first looks, and worth stating exactly:
#
#   * On the reference host `API_DOMAIN` equals `WEB_DOMAIN` (the single-origin
#     Caddy edge, spec §16.29), so there the check reduces to "the served
#     `/runtime-config.js` names `https://$WEB_DOMAIN`". The origin is only
#     discriminating in a two-host deployment, which is what the base compose
#     is (`PUBLIC_ORIGIN` and `PUBLIC_API_ORIGIN` on different origins).
#   * It is not what catches a mis-set `PUBLIC_API_ORIGIN` either: the
#     preflight already refuses to deploy unless `PUBLIC_ORIGIN` and
#     `PUBLIC_API_ORIGIN` name `WEB_DOMAIN` and `API_DOMAIN`
#     (`scripts/preflight-deploy.mjs`), and that runs before any of this.
#   * Its real value is that this is the only request the whole deploy makes
#     to `WEB_DOMAIN` at all. Everything else addresses `API_DOMAIN`. So it is
#     the first proof that the edge routes the web container, that the
#     container came up, and that it generated and served this file rather
#     than the unconfigured copy in `apps/web/public` — which assigns
#     `window.location.origin` and names no origin whatsoever.
#
# So, concretely, what it catches: an edge that does not route the web
# container and a container that never came up (the fetch fails); the
# unconfigured `apps/web/public` copy deployed in place of the generated one
# (several lines, so the prefix cannot match); and an `apiOrigin` naming a
# different host, port or scheme.
#
# What it does not catch: anything about the API path. That `/api/*` reaches
# paper-api is what the `/api/v1/health/trading` probe above says, since that
# path is itself under `/api/*`. And neither of them says the browser can
# complete a session: a POST-only edge fault, a CSP that blocks the bundle, a
# stale asset hash, a JavaScript error. Only the operator browser smoke
# (`pnpm smoke:prod`) covers that, and it is the check that would have caught
# #25 outright.
verify_runtime_config_origin() {
  local web_domain="$1" api_origin="$2" body
  # --max-time as everywhere else a deploy or the status timer calls curl
  # (status-check.sh, notify.sh): a hung edge must fail the step, not the run.
  if ! body="$(curl -fsS --max-time 10 "https://${web_domain}/runtime-config.js")"; then
    echo "FAIL: cannot fetch https://${web_domain}/runtime-config.js" >&2
    return 1
  fi
  # apps/web/server.mjs emits exactly one controlled assignment,
  #   window.__MOI_RUNTIME_CONFIG__ = Object.freeze({"apiOrigin":"<origin>"});
  # so the guard parses that shape and compares the value for equality. A
  # substring test accepted an origin that merely began or ended with the
  # expected one, or the expected one mentioned anywhere else in the body
  # (Codex review of #25). No eval: the body is never executed. The contract
  # checker pins this prefix to the template in apps/web/server.mjs.
  local prefix='window.__MOI_RUNTIME_CONFIG__ = Object.freeze({"apiOrigin":"'
  local suffix='"});'
  local named_origin
  case "$body" in
    "${prefix}"*"${suffix}") ;;
    *)
      echo "FAIL: https://${web_domain}/runtime-config.js is not the runtime config apps/web/server.mjs emits; refusing to guess the API origin" >&2
      return 1
      ;;
  esac
  named_origin="${body#"$prefix"}"
  named_origin="${named_origin%"$suffix"}"
  # A quote inside the value means the object carried more than apiOrigin.
  case "$named_origin" in
    *'"'*)
      echo "FAIL: https://${web_domain}/runtime-config.js is not the runtime config apps/web/server.mjs emits; refusing to guess the API origin" >&2
      return 1
      ;;
  esac
  if [ "$named_origin" != "$api_origin" ]; then
    echo "FAIL: https://${web_domain}/runtime-config.js does not name ${api_origin} (apiOrigin is ${named_origin}); the browser app would call some other origin" >&2
    return 1
  fi
  echo "runtime config: ${web_domain} names ${api_origin}"
}

# Called by deploy.sh only after readiness, both markets NORMAL and placement
# were observed; the exit trap treats any other exit 0 as a failure.
deploy_verified() {
  VERIFIED=1
  notify ok "deploy finished: $1" "ref ${DEPLOY_REF}, KR/US NORMAL, placement 활성"
}

on_exit() {
  local code=$?
  trap - EXIT INT TERM HUP
  # A process rejected by the mutex owns none of the active deploy's state.
  # In particular it must not remove the marker that silences status alerts.
  if [ "$DEPLOY_OWNS_MUTEX" != 1 ]; then exit "$code"; fi
  rm -f "$DEPLOY_LOCK"
  status_timer start
  if [ "$code" = 0 ] && [ "$VERIFIED" = 1 ]; then
    flock -u 9 || true
    exit 0
  fi
  # Reaching the end without verification is a failure, never a silent success.
  [ "$code" = 0 ] && code=1
  notify fail "deploy failed: ${DEPLOY_REF:-unknown}" "단계: ${STEP} (exit ${code}), 호스트 $(hostname)"
  flock -u 9 || true
  exit "$code"
}
trap on_exit EXIT
# Signals must surface as failures with their conventional codes; without these
# the EXIT trap would observe $?=0 after an interrupt.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
