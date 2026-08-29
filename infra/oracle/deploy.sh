#!/usr/bin/env bash
# Stop-then-start release on the Oracle reference host (docs/operations/deployment.md).
#
#   /opt/moi/infra/oracle/deploy.sh [git-ref]
#
# 1. fetch the ref, 2. production preflight (secrets, compose config, and the
# host's real egress address against infra/provider-allowlist.yaml — overrides
# are refused for production), 3. pull the images CI published to GHCR,
# 4. restart the stack through systemd so the old leader drains before the new
# one starts (compose recreates containers stop-then-start; no surge).
set -euo pipefail
REF="${1:-main}"
cd /opt/moi
export SOPS_AGE_KEY_FILE=/etc/moi/age.key
set -a; . /etc/moi/moi.env; set +a

echo "== fetch ${REF}"
git fetch -q origin
git checkout -q "$REF"
git pull -q --ff-only origin "$REF" 2>/dev/null || true
git log --oneline -1

echo "== toolchain"
[ "$(node -p 'process.versions.node.split(".")[0]')" = "24" ] || { echo "Node 24 required (run infra/oracle/bootstrap.sh)"; exit 1; }
command -v pnpm >/dev/null || sudo corepack enable
corepack prepare pnpm@11.22.0 --activate >/dev/null
pnpm install --frozen-lockfile --silent

echo "== preflight (production)"
sops exec-env /etc/moi/secrets.enc.env 'pnpm preflight:deploy --environment production'

echo "== pull images (${MOI_IMAGE_TAG:-main})"
# Hosts never build (a 1 GB Micro cannot); CI publishes multi-arch images.
sops exec-env /etc/moi/secrets.enc.env 'docker compose -f infra/compose.yaml -f infra/oracle/compose.override.yaml pull --quiet'

echo "== stop-then-start"
sudo systemctl restart moi
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "https://${API_DOMAIN}/health/ready"; then break; fi
  sleep 3
done
curl -fsS "https://${API_DOMAIN}/health/market-data"; echo
echo "== done; watch: sudo journalctl -u moi -f ; docker compose -f infra/compose.yaml -f infra/oracle/compose.override.yaml logs -f paper-api"
