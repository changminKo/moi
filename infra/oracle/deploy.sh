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
# pull the images CI published to GHCR, 5. run the new image's migrations as a
# one-off job while the old release still serves, 6. restart the stack through
# systemd (compose recreates containers stop-then-start; the 45 s grace period
# lets the leader drain), 7. require readiness, both markets NORMAL and
# placement enabled — otherwise fail.
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

step "fetch ${REF}"
as_owner git fetch -q origin "$REF"
as_owner git checkout -q --detach FETCH_HEAD
as_owner git log --oneline -1

step toolchain
# Cap the V8 heap: the E2.1.Micro fallback host has 1 GB of RAM plus swap, and
# an uncapped heap thrashes swap instead of failing fast.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
# jq builds the Discord payloads; hosts bootstrapped before it joined the
# package list get it here.
command -v jq >/dev/null 2>&1 || apt-get install -y -qq jq >/dev/null
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
    sha="$(as_owner git rev-parse --short HEAD)"
    echo "$md"; echo "$tr"; echo "== done (${sha})"
    deploy_verified "$sha"
    exit 0
  fi
  sleep 3
done
echo "FAIL: markets did not reach NORMAL with placement enabled:"; echo "$md"; echo "$tr"; exit 1
