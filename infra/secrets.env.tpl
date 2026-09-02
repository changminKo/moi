# Secret-manager template for `infra/compose.yaml` (docs/operations/deployment.md,
# "Secret injection"). Every value is a reference the secret manager resolves
# at run time; no secret is ever written to disk or committed.
#
#   1Password:  op run --env-file=infra/secrets.env.tpl -- docker compose -f infra/compose.yaml up -d
#   sops:       sops exec-env infra/secrets.enc.env 'docker compose -f infra/compose.yaml up -d'
#
# Rotate by changing the referenced item, then redeploy (stop-then-start).
# PUBLIC_ORIGIN is also the strategy runner's `Origin` header (BOT_PUBLIC_ORIGIN
# in infra/compose.yaml, design §4.2). The runner's *connect target*
# (BOT_API_ORIGIN) is not here and is not a secret: it is the committed literal
# http://paper-api:3000, the internal service its allow-list permits. Both are
# refused as environment variables by `pnpm preflight:deploy`.
PUBLIC_ORIGIN=op://Moi/paper-api/PUBLIC_ORIGIN
PUBLIC_API_ORIGIN=op://Moi/web/PUBLIC_API_ORIGIN
DATABASE_URL=op://Moi/postgres/DATABASE_URL
POSTGRES_PASSWORD=op://Moi/postgres/POSTGRES_PASSWORD
SESSION_HASH_KEYS=op://Moi/paper-api/SESSION_HASH_KEYS
CSRF_SECRET=op://Moi/paper-api/CSRF_SECRET
ADMIN_API_KEY=op://Moi/paper-api/ADMIN_API_KEY
# Read-only registry token (classic PAT, scope read:packages) for the private GHCR images.
GHCR_TOKEN=op://Moi/ghcr/READ_TOKEN
# Optional: Discord channel webhook for host status, deploy and stack-failure
# alerts (infra/oracle/notify.sh). Alerting is skipped when it is absent.
DISCORD_WEBHOOK_URL=op://Moi/discord/WEBHOOK_URL
# Optional: the strategy runner's own Discord channel (compose service `bot`,
# strategy-runner design §7.4). It must be a DIFFERENT channel from
# DISCORD_WEBHOOK_URL above — trading traffic must not bury an incident alert —
# and the preflight refuses a deploy that points both names at one webhook.
# Absent, the runner's reporter is a silent no-op and the runner still starts.
DISCORD_WEBHOOK_TRADE_URL=op://Moi/discord/TRADE_WEBHOOK_URL
TOSS_CLIENT_ID=op://Moi/toss/CLIENT_ID
TOSS_CLIENT_SECRET=op://Moi/toss/CLIENT_SECRET
