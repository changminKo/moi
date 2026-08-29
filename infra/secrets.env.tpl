# Secret-manager template for `infra/compose.yaml` (docs/operations/deployment.md,
# "Secret injection"). Every value is a reference the secret manager resolves
# at run time; no secret is ever written to disk or committed.
#
#   1Password:  op run --env-file=infra/secrets.env.tpl -- docker compose -f infra/compose.yaml up -d
#   sops:       sops exec-env infra/secrets.enc.env 'docker compose -f infra/compose.yaml up -d'
#
# Rotate by changing the referenced item, then redeploy (stop-then-start).
PUBLIC_ORIGIN=op://Moi/paper-api/PUBLIC_ORIGIN
PUBLIC_API_ORIGIN=op://Moi/web/PUBLIC_API_ORIGIN
DATABASE_URL=op://Moi/postgres/DATABASE_URL
POSTGRES_PASSWORD=op://Moi/postgres/POSTGRES_PASSWORD
SESSION_HASH_KEYS=op://Moi/paper-api/SESSION_HASH_KEYS
CSRF_SECRET=op://Moi/paper-api/CSRF_SECRET
ADMIN_API_KEY=op://Moi/paper-api/ADMIN_API_KEY
# Read-only registry token (classic PAT, scope read:packages) for the private GHCR images.
GHCR_TOKEN=op://Moi/ghcr/READ_TOKEN
TOSS_CLIENT_ID=op://Moi/toss/CLIENT_ID
TOSS_CLIENT_SECRET=op://Moi/toss/CLIENT_SECRET
