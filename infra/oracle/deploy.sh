#!/usr/bin/env bash
# Stop-then-start release on the Oracle reference host (docs/operations/deployment.md).
#
#   sudo /opt/moi/infra/oracle/deploy.sh [git-ref]
#
# Runs as root because /etc/moi (age key, encrypted secrets, moi.env) is root
# only; git and pnpm run as the repository owner. Steps: 1. fetch the exact ref
# and check it out detached, 2. production preflight (secrets, compose config,
# the host's real egress address — overrides are refused for production, and
# PUBLIC_ORIGIN / PUBLIC_API_ORIGIN must match WEB_DOMAIN / API_DOMAIN),
# 3. refresh the systemd units shipped in the repository, 4. docker login +
# pull the images CI published to GHCR and require every pulled runtime
# image's `org.opencontainers.image.revision` label to equal the checkout,
# 5. run the new image's migrations as a one-off job while the old release
# still serves, 6. restart the stack through systemd (compose recreates
# containers stop-then-start; the 45 s grace period lets the leader drain),
# 7. require readiness, both markets NORMAL, placement enabled and the running
# containers at the verified revision — otherwise fail.
# Start, success and failure are announced on Discord when the sops file
# carries DISCORD_WEBHOOK_URL (infra/oracle/notify.sh, docs "Alerting"); a
# deploy lock silences the status timer for the duration (deploy-lib.sh).
set -euo pipefail
[ "$(id -u)" = 0 ] || exec sudo -E "$0" "$@"
REF="${1:-main}"
REPO=/opt/moi
OWNER="$(stat -c %U "$REPO")"
as_owner() { sudo -u "$OWNER" -H env PATH="$PATH" "$@"; }
export SOPS_AGE_KEY_FILE=/etc/moi/age.key
set -a; . /etc/moi/moi.env; set +a
COMPOSE=(docker compose -f "$REPO/infra/compose.yaml" -f "$REPO/infra/oracle/compose.override.yaml")
withsecrets() { sops exec-env /etc/moi/secrets.enc.env "$*"; }
cd "$REPO"
# shellcheck source=infra/oracle/deploy-lib.sh
. "$REPO/infra/oracle/deploy-lib.sh"
deploy_begin "$REF"

if [ "${MOI_DEPLOY_REEXEC:-0}" != 1 ]; then
  step "fetch ${REF}"
  as_owner git fetch -q origin "$REF"
  as_owner git checkout -q --detach FETCH_HEAD
  as_owner git log --oneline -1
  deploy_reexec "$REPO/infra/oracle/deploy.sh" "$REF"
fi

step toolchain
# Cap the V8 heap: the E2.1.Micro fallback host has 1 GB of RAM plus swap, and
# an uncapped heap thrashes swap instead of failing fast.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
# jq builds the Discord payloads and perl masks them (infra/oracle/notify.sh);
# hosts bootstrapped before either joined the package list get them here. The
# deployment-contract checker reads notify.sh's own dependency guards and
# fails unless every one of them appears here or in bootstrap.sh, so a tool the
# alerting path needs cannot be added without being provisioned.
for tool in jq perl; do
  command -v "$tool" >/dev/null 2>&1 || apt-get install -y -qq "$tool" >/dev/null
done
as_owner node "$REPO/scripts/check-runtime.mjs"
as_owner corepack prepare pnpm@11.22.0 --activate >/dev/null
as_owner pnpm install --frozen-lockfile --silent

step "preflight (production)"
withsecrets "env WEB_DOMAIN='$WEB_DOMAIN' API_DOMAIN='$API_DOMAIN' pnpm preflight:deploy --environment production"

step "systemd units"
# The status timer and failure alert live in the repository; refresh them once
# preflight accepted the release so a unit change ships with the code that
# needs it. Units removed from the repository are not uninstalled here.
install -m 0644 "$REPO"/infra/oracle/*.service "$REPO"/infra/oracle/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable moi-status.timer >/dev/null

step "registry login + pull (${MOI_IMAGE_TAG:-main})"
# Private GHCR: the read-only token comes from the sops file over stdin only;
# docker keeps it in root's config.json (0600).
withsecrets 'printf %s "$GHCR_TOKEN" | docker login ghcr.io -u changminko --password-stdin >/dev/null'
withsecrets "${COMPOSE[*]} pull --quiet"

step "verify image revisions"
# A mutable tag such as `main` is only a selector. The immutable OCI revision
# label is the release identity, and every runtime image the stack pulls must
# agree with the exact checkout before any migration can change the database.
# `compose config --images` resolves the active profiles — the bot image is
# listed (and verified) exactly when COMPOSE_PROFILES=bot pulled it — and
# prints image references only, so no rendered secret ever lands in a shell
# variable (the full `config` output carries every environment value).
checkout_sha="$(as_owner git rev-parse HEAD)"
mapfile -t release_images < <(withsecrets "${COMPOSE[*]} config --images" | grep '^ghcr.io/changminko/moi-' | sort -u)
for required in paper-api web; do
  printf '%s\n' "${release_images[@]}" | grep -q "^ghcr.io/changminko/moi-${required}:" \
    || { echo "FAIL: compose config lists no ghcr.io/changminko/moi-${required} image"; exit 1; }
done
verify_release_image_revisions "$checkout_sha" "${release_images[@]}"

step "migrations (new image, old release still serving)"
# First deploy: no release is running yet, so the datastore the job connects to
# must be started here. --no-recreate leaves an already running postgres/redis
# untouched; --wait blocks until their healthchecks pass.
withsecrets "${COMPOSE[*]} up -d --no-recreate --wait postgres redis"
withsecrets "${COMPOSE[*]} run --rm --no-deps -T paper-api node apps/paper-api/dist/migrate-cli.js"

step stop-then-start
status_timer stop
systemctl restart moi

step verify
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "https://${API_DOMAIN}/health/ready"; then ready=1; break; fi
  sleep 3
done
[ "$ready" = 1 ] || { echo "FAIL: /health/ready never returned 200"; journalctl -u moi --no-pager -n 30; exit 1; }
for _ in $(seq 1 40); do
  md="$(curl -fsS "https://${API_DOMAIN}/health/market-data")"
  tr="$(curl -fsS "https://${API_DOMAIN}/api/v1/health/trading")"
  if printf %s "$md" | grep -q '"runtime":"SERVING"' \
     && [ "$(printf %s "$md" | grep -o '"state":"NORMAL"' | wc -l)" -ge 2 ] \
     && printf %s "$tr" | grep -q '"placement":true'; then
    # The bot is opt-in through COMPOSE_PROFILES=bot in /etc/moi/moi.env. When
    # it is on, a release is not done until the runner is up: a configuration
    # it refuses (no runner.json, a limit outside exact money) is a container in
    # a restart loop, and that has to fail the deploy, not hide behind
    # `restart: unless-stopped`.
    case ",${COMPOSE_PROFILES:-}," in *,bot,*) bot_enabled=1 ;; *) bot_enabled=0 ;; esac
    if [ "$bot_enabled" = 1 ]; then
      # One `running` is not proof: a refused configuration is a container
      # that lives for a moment between restarts. `bot_steady` (deploy-lib.sh)
      # wants running with RestartCount 0 for consecutive polls.
      bot_id="$(withsecrets "${COMPOSE[*]} ps -q bot")"
      [ -n "$bot_id" ] || { echo "FAIL: COMPOSE_PROFILES enables the bot but no bot container exists"; exit 1; }
      if ! bot_steady "docker inspect -f '{{.State.Status}} {{.RestartCount}}' $bot_id"; then
        echo "FAIL: COMPOSE_PROFILES enables the bot but the bot container is not steadily running (a refused configuration is a restart loop):"
        docker inspect -f 'state={{.State.Status}} restarts={{.RestartCount}}' "$bot_id" || true
        withsecrets "${COMPOSE[*]} logs --no-color --tail 20 bot" || true
        exit 1
      fi
      echo "bot: running"
    else
      # The symmetric mistake: the profile line was removed but the container
      # was not. Compose no longer sees a disabled service, so `stop` and `up`
      # leave it running — an old image trading against the new release, with
      # nothing watching it.
      stray="$(docker ps -aq --filter label=com.docker.compose.project=moi --filter label=com.docker.compose.service=bot)"
      [ -z "$stray" ] || { echo "FAIL: COMPOSE_PROFILES does not enable the bot but a bot container exists; remove it first: COMPOSE_PROFILES=bot ${COMPOSE[*]} rm -sf bot"; exit 1; }
    fi
    # The images were verified before migrations, but systemd started the
    # stack from /etc/moi/moi.env alone: a MOI_IMAGE_TAG pinned only on this
    # command line would have verified one release and run another. The
    # running containers are the last word.
    running_services=(paper-api web)
    [ "$bot_enabled" = 1 ] && running_services+=(bot)
    mapfile -t running_ids < <(withsecrets "${COMPOSE[*]} ps -q ${running_services[*]}")
    verify_running_container_revisions "$checkout_sha" "${running_ids[@]}"
    sha="$(as_owner git rev-parse --short HEAD)"
    echo "$md"; echo "$tr"; echo "== done (${sha})"
    deploy_verified "$sha"
    exit 0
  fi
  sleep 3
done
echo "FAIL: markets did not reach NORMAL with placement enabled:"; echo "$md"; echo "$tr"; exit 1
