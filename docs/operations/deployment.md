# Deployment guide

Moi ships as two images and two managed data stores. This guide is
provider-neutral: `infra/compose.yaml` is the reference topology, and the
section *Mapping onto hosted platforms* explains how the same roles land on a
PaaS or Kubernetes. `pnpm check:deployment` enforces the invariants below
against the committed files.

## Topology

| Role | Image / service | Public | Replicas | Owns |
|------|-----------------|--------|----------|------|
| `web` | `apps/web/Dockerfile` → `node apps/web/server.mjs` | yes (HTTPS) | any | static bundle, `/runtime-config.js` |
| `paper-api` | `apps/paper-api/Dockerfile` → `node apps/paper-api/dist/main.js` | yes (HTTPS) | **exactly one** | public HTTP, PostgreSQL paper ledger, health and safety administration |
| `postgres` | PostgreSQL 17 | no | 1 (+ managed replica) | the ledger; authoritative |
| `redis` | Redis 7 | no | 1 | leader lease, quote fan-out |

Only `web` and `paper-api` publish ports. PostgreSQL and Redis are reachable
solely from `paper-api` on the private network and use health checks plus
persistent volumes.

> The `main.js` composition owns the live provider adapter, the fenced
> market-leader lifecycle and the outbox publisher (spec §16); with
> `MARKET_DATA_ADAPTER=toss` and the configured secrets it recovers from the
> provider and reaches `SERVING`. The release checklist records what remains
> open before a public launch.

Run exactly one `paper-api` replica (one leader replica). The single `paper-api` process both serves HTTP and owns exactly one leader
per market (`moi.leader-markets` label). Running more than one
`paper-api` replica is outside the MVP: a second replica would open a second
pair of Toss connections and race for the lease.

Both images run as the unprivileged `node` user, are built from a pinned
`node:24.19.0` base with pnpm 11.22.0 via corepack, and contain no `.env`,
tests, Git metadata, or developer control directories (`.dockerignore`).

## Runtime configuration

`paper-api` reads (see `apps/paper-api/src/config.ts`):

| Variable | Required | Notes |
|----------|----------|-------|
| `NODE_ENV` | yes | `production` |
| `HOST`, `PORT` | yes | `0.0.0.0`, `3000` inside the container |
| `PUBLIC_ORIGIN` | yes | the web origin, used for CORS and cookie scoping |
| `DATABASE_URL` | yes | secret |
| `REDIS_URL` | yes | private network only |
| `SESSION_HASH_KEYS` | yes | secret; comma-separated, newest first, rotate by prepending |
| `CSRF_SECRET` | yes | secret, ≥ 32 bytes |
| `ADMIN_API_KEY` | yes in production | secret, ≥ 32 bytes |
| `MARKET_DATA_ADAPTER` | yes in production | `toss` literal in compose; `fake` is refused in production and there is no implicit default |
| `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET` | with `toss` | secrets; the egress IP must be static and registered with the provider — record it next to the secret store |
| `TOSS_REST_BASE_URL`, `TOSS_WS_URL` | no | contract defaults; production may override only with a loopback host |
| `SHUTDOWN_DRAIN_DEADLINE_MS` | no | default 30000, must stay below `stop_grace_period` (45 s) |
| `RECOVERY_STABILITY_MS` | no | default 5000 |
| `FEE_SCHEDULE_VERSION`, `FEE_KR_COMMISSION_RATE`, `FEE_KR_SELL_TAX_RATE`, `FEE_US_COMMISSION_RATE`, `FEE_US_SELL_TAX_RATE` | yes in production | committed compose literals (v1: KR 0.015% + 0.15% sell tax, US 0.25%); published to `fee_model_versions` at boot and referenced by every fill. Changing a rate is a new `FEE_SCHEDULE_VERSION`; the process refuses to start if the same version is already published with different rates |

`web` reads `PUBLIC_API_ORIGIN` (bare HTTPS origin) and `PORT`. The server
validates the origin, serves it from `/runtime-config.js` with `no-store`, and
includes it in the CSP `connect-src`. No other variable reaches the browser.

### Secret injection

> Accepted exposure: the unit decrypts secrets into the environment of
> `docker compose`, and Docker records container environment in its own
> metadata (`/var/lib/docker`, `docker inspect`), readable by root on the
> host. Nothing in this repository writes a secret to a file; moving to
> file-based secrets / systemd credentials is tracked as follow-up work.

Secrets are injected at runtime by the platform's secret store (Compose:
required interpolation `${VAR:?}` resolved by a secret manager at run time;
Kubernetes: `Secret` → `envFrom`; PaaS: the provider's secret manager). Never
bake a secret into an image, commit an `.env`, or pass a secret through CI
logs. Rotate `CSRF_SECRET` and `ADMIN_API_KEY` by redeploying;
rotate `SESSION_HASH_KEYS` by prepending the new key and removing the oldest
after `SESSION_MAX_AGE_SECONDS` has elapsed.

Concrete recipes for the Compose reference topology — every one resolves the
`${VAR:?}` interpolations in the process environment of `docker compose` and
writes nothing to disk:

| Store | Command |
|-------|---------|
| 1Password CLI | `op run --env-file=infra/secrets.env.tpl -- docker compose -f infra/compose.yaml up -d` — [`infra/secrets.env.tpl`](../../infra/secrets.env.tpl) holds only `op://vault/item/field` references and is checked by `pnpm check:deployment` |
| sops (age/KMS) | `sops exec-env infra/secrets.enc.env 'docker compose -f infra/compose.yaml up -d'` — the encrypted file lives outside this repository |
| CI / PaaS store | GitHub Environments, Fly/Render/Railway secrets, AWS/GCP secret managers: expose the same variable names to the deploy job; the workflow itself never references `TOSS_*` |

Rotating `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`: issue the new credential in the
Toss developer console, update the referenced item, run the preflight below,
then perform the stop-then-start handoff. The old process keeps its cached
access token until it exits; a `401` after the handoff means the new secret
was rejected (see the market-data runbook).

### Preflight (`pnpm preflight:deploy`)

Run immediately before `docker compose up`, with the production environment
resolved by the secret manager (for example `op run --env-file=infra/secrets.env.tpl -- pnpm preflight:deploy`).
It exits non-zero unless all three hold, and never prints a secret value:

1. every required variable is present, well-formed, and not a placeholder;
   `MARKET_DATA_ADAPTER`, `TOSS_REST_BASE_URL`, `TOSS_WS_URL` are *not* set
   (the compose file owns them);
2. `docker compose -f infra/compose.yaml config` accepts the environment;
3. the machine's egress address is registered with the provider (below).

`--skip-compose` / `--skip-egress` print what was skipped; `--egress-ip <ip>`
(or `EGRESS_IP`) supplies the address when the deploy host is not the egress
host; `--environment staging` checks against staging registrations.

### Egress allow list

Toss serves only registered source addresses: an unregistered `paper-api`
gets `403 access_denied` on every REST snapshot and WebSocket handshake and
the markets never leave `RECOVERING`. Therefore:

- `paper-api` egresses through **one static address** (NAT gateway / elastic
  IP / the platform's dedicated egress). Autoscaling egress pools are not
  acceptable for this process.
- The address is registered in the Toss developer console **and** recorded in
  [`infra/provider-allowlist.yaml`](../../infra/provider-allowlist.yaml) in the
  same change (address, environment, date, who registered it). The file holds
  addresses only; `pnpm check:deployment` validates its shape and
  `pnpm preflight:deploy` refuses to deploy from an address that is not
  listed for the target environment.
- Changing the egress address is a release: register the new address first,
  record it, preflight, then move the process; remove the old address from
  the console and the file afterwards.

## Origins, TLS, cookies

- Terminate TLS at the platform edge for both public services; redirect HTTP
  to HTTPS. HSTS `max-age=31536000; includeSubDomains`.
- The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`. The web and
  API origins must therefore be **same-site** (for example
  `app.moi.example` and `api.moi.example`) so `SameSite=Lax`
  cookies accompany fetches. Cross-site origins are not supported.
- `PUBLIC_ORIGIN` on the API and `PUBLIC_API_ORIGIN` on the web must match the
  externally visible origins exactly (scheme, host, port).

## Rollout procedure

0. **Preflight.** `pnpm preflight:deploy` with the resolved production
   environment (see *Preflight* above) must pass; a missing secret or an
   unregistered egress address stops the release before the old leader is
   touched.
1. **Migrations run before traffic.** Run `migrateToLatest`
   (`apps/paper-api/src/db/migrate.ts`) as a one-off job against the target
   database using the new image, and let it finish before the new `paper-api`
   starts. Migrations are additive and stay compatible with the previous
   release so a rollback of the process never requires a schema rollback.
2. **Readiness gates traffic.** `/health/live` answers as soon as the process
   is up; `/health/ready` answers 200 only when PostgreSQL and the audit path
   are usable. Route traffic only to ready instances and restart only on
   liveness failure. The two probes are distinct on purpose.
3. **Leader handoff (one leader at a time).** Because the leader owns the
   Toss connections, the release is a *stop-then-start* handoff, never a
   rolling one:

   `CANCEL_ONLY → old leader disconnect → new leader recover → NORMAL`

   - **Precondition:** do not send `SIGTERM` to the old process (P1) until the
     new process (P2) answers `/health/ready` with 200 and
     `/api/v1/health/trading` lists `ACQUIRING_LEASES` in `reasons`. P1 closes
     its HTTP ingress while draining, so P2 is what serves cancellations
     during the handoff; while P2 waits for the lease bundle it makes no
     provider calls, claims no outbox rows, and accepts no user WebSockets.
   - Send `SIGTERM` to the old `paper-api`. Its `ShutdownCoordinator` enters
     CANCEL_ONLY, closes admission, drains in-flight transactions and the
     outbox (30 s deadline), closes sockets, and releases the leases.
     `stop_grace_period` (45 s) exceeds that deadline.
   - Only after the old process has exited, start the new image. It acquires
     a higher leader epoch per market, runs recovery (REST snapshot +
     reconnect), and returns the markets to NORMAL.
   - **A rolling handoff that creates a third Toss connection is forbidden.**
     Two processes alive at once means two connection pairs; upstream limits
     and duplicate fills follow. Platforms that default to surge upgrades must
     be configured for `maxSurge: 0` / `Recreate` for `paper-api`.
   - `web` may roll normally; it is stateless.
4. **Verify** — before a release, run the two-process handoff drill (loopback
   fake provider, Docker required): `pnpm --filter @moi/paper-api build &&
   pnpm --filter @moi/paper-api test:drill`. It must pass three consecutive times
   with `peakConcurrentConnections === 2` and `evictions === 0`; evidence is
   written to `apps/paper-api/test-results/leader-handoff/`. Then verify with
   the checks in any runbook's *Verification* section:
   reservations, leader fence, outbox lag, user-stream recovery.

## Rollback

Rollback redeploys the previous `paper-api` image using the same
stop-then-start handoff. The database is **not** rolled back: schema changes
are additive and the previous image must tolerate the newer schema (this is
verified in CI by running the previous release's tests against the migrated
schema before a migration is merged). Rolling back a migration requires
restore from backup with a full stop.

Roll back when: any `InvariantViolation` or `TransactionalAuditFailure`
within 30 minutes of a deploy; markets fail to reach NORMAL after two recovery
cycles; readiness never turns green within `start_period`.

## Observability and retention

- `GET /metrics` on `paper-api` (private scrape only; do not expose publicly).
  Rules: `infra/monitoring/prometheus-alerts.yaml`; routing:
  `infra/monitoring/alertmanager.yaml`; every alert links a runbook in
  `docs/runbooks/`.
- Structured application logs go to the platform log sink with **14-day
  retention**. Audit rows live in PostgreSQL partitions and follow the
  database retention policy, not the log policy.

## Backup and restore

- Daily full backup plus WAL/PITR of PostgreSQL, retained 30 days, stored in
  a different failure domain from the database.
- Redis is rebuilt from PostgreSQL on recovery; back it up only for forensics,
  never restore an old snapshot into a live system (a stale lease could
  resurrect).
- **Quarterly restore drill:** restore the latest backup into a scratch
  database, run `migrateToLatest`, run the reservation/leader-fence queries
  from the runbooks, and record the time-to-restore. A drill that fails blocks
  the next release.

## Mapping onto hosted platforms

| Compose concept | Kubernetes | PaaS (Fly/Render/Railway-style) |
|-----------------|-----------|---------------------------------|
| `web` service, `ports` | Deployment + Service + Ingress (TLS) | web service, autoscale allowed |
| `paper-api`, `deploy.replicas: 1`, `stop_grace_period: 45s` | Deployment `replicas: 1`, `strategy: Recreate`, `terminationGracePeriodSeconds: 45` | single-instance service, no rolling deploy, grace ≥ 45 s |
| healthcheck `/health/ready` vs label `/health/live` | readinessProbe / livenessProbe | health-check path `/health/ready`; restart policy on `/health/live` |
| `postgres`, `redis` with volumes, no `ports` | managed PostgreSQL / Redis, private networking | managed add-ons on the private network |
| `${VAR:?}` | `Secret` + `envFrom` | provider secret store |

## Reference production host: Oracle Cloud Always Free

The reference production deployment is one Oracle Cloud *Always Free* VM
running the compose stack behind a Caddy TLS edge (`infra/oracle/`). It costs
nothing, the VM's reserved public IP is the static egress address Toss
requires, and the artefacts are the same ones the local smoke uses.

1. **VM.** The tenancy's **home region**: Always Free compute exists only
   there, and the home region is chosen when the tenancy is created and can
   never be changed afterwards — so the host's region is whatever the account
   was opened with (the reference host is `ap-osaka-1`). Moving to another
   region therefore means a new tenancy, a new reserved IP and an egress
   release (*Egress allow list* above); a paid instance in a subscribed
   region is the only alternative. Shape `VM.Standard.A1.Flex` at
   2 OCPU / 12 GB, which is the entire Always Free Ampere allowance since
   Oracle halved it on 2026-06-15 (1,500 OCPU-hours and 9,000 GB-hours a
   month, previously 4 OCPU / 24 GB); Ampere A1 is not offered in
   `ap-chuncheon-1`, and a new tenancy is only ever given the home regions
   Oracle currently opens to signups (`ap-seoul-1` was not among them on
   2026-09-01). Image Ubuntu 24.04 (aarch64), boot volume 50–100 GB. If A1
   capacity is unavailable retry later or use `VM.Standard.E2.1.Micro`
   (amd64, 1 GB — workable because images are pulled, not built, and the
   bootstrap adds a 4 GB swap file). Assign a **reserved** public IP so it
   survives stop/start.
2. **Network.** In the VCN security list allow ingress TCP 22 (your IP only),
   80 and 443 from `0.0.0.0/0`. Nothing else: PostgreSQL and Redis stay on the
   compose network. The OS firewall is opened by the bootstrap script.
3. **DNS.** Point one A record at the reserved IP, e.g. `moi.<domain>`
   (`WEB_DOMAIN`), and set `API_DOMAIN` to the same value: the Caddy edge
   serves the app and the API from **one origin** and routes `/api/*`,
   `/health/*` and `/admin/*` to `paper-api`, everything else to `web`
   (`infra/oracle/Caddyfile`). This is deliberate — free DNS providers such as
   DuckDNS are on the Public Suffix List, so two subdomains there are different
   *sites* and the `SameSite=Lax` session cookie would never reach the API
   (spec §16.29). Caddy obtains certificates from Let's Encrypt on first
   start.
4. **Bootstrap** (once, as the default `ubuntu` user):

   ```bash
   curl -fsSL https://raw.githubusercontent.com/changminKo/moi/main/infra/oracle/bootstrap.sh | bash
   ```

   It installs Docker, sops and age, clones the repository to `/opt/moi`,
   creates the host's own age identity at `/etc/moi/age.key`, writes a
   placeholder `/etc/moi/moi.env`, installs `moi.service`, and prints the host
   age **public** key. Log out and back in once for docker group membership.
5. **Secrets.** On your workstation, encrypt the production secrets for the
   host key (add the host's `age1…` as a second recipient so you can still
   decrypt locally) and copy only the encrypted file:

   ```bash
   sops --encrypt --age <host age1…>,<your age1…> --input-type dotenv --output-type dotenv \
     ~/.config/moi/secrets.prod.env > ~/.config/moi/secrets.prod.enc.env
   scp ~/.config/moi/secrets.prod.enc.env ubuntu@<ip>:/tmp/ && \
     ssh ubuntu@<ip> 'sudo install -m 0600 /tmp/secrets.prod.enc.env /etc/moi/secrets.enc.env && rm /tmp/secrets.prod.enc.env'
   ```

   `PUBLIC_ORIGIN=https://moi.<domain>`, `PUBLIC_API_ORIGIN=https://moi.<domain>`
   (same origin, see step 3),
   `DATABASE_URL=postgres://moi:<pw>@postgres:5432/moi`. Set `WEB_DOMAIN` /
   `API_DOMAIN` in `/etc/moi/moi.env`.
6. **Egress registration.** Register the reserved IP in the Toss developer
   console and record it in `infra/provider-allowlist.yaml` with
   `environment: production` in a commit. The production preflight refuses
   `--skip-egress` / `--egress-ip`, so it can only pass from the host itself.
7. **Deploy** (each release):

   ```bash
   sudo /opt/moi/infra/oracle/deploy.sh main
   ```

   It runs as root (`/etc/moi` is root-only; git and pnpm run as the
   repository owner) and fails — never reports success — unless readiness,
   both markets `NORMAL` and `placement: true` are observed.

   fetch the exact ref (detached checkout; a non-fast-forward is an error,
   never a silent stale deploy) → `preflight --environment production`
   (also requires `PUBLIC_ORIGIN`/`PUBLIC_API_ORIGIN` to equal
   `https://$WEB_DOMAIN` / `https://$API_DOMAIN`) → docker login + pull the
   images CI
   published to GHCR (`.github/workflows/publish.yml`, `linux/amd64` and
   `linux/arm64`; the host never builds — a 1 GB Micro cannot) →
   start postgres/redis if absent (first deploy; running ones are left
   untouched) → one-off migration job with the new image
   (`node dist/migrate-cli.js`) while the old release still serves → `systemctl restart moi` (compose
   recreates containers stop-then-start, the 45 s grace period lets the leader
   drain) → readiness, both markets `NORMAL`, placement enabled.
   Roll back by pinning `MOI_IMAGE_TAG=<commit sha>` in `/etc/moi/moi.env`.
   The GHCR packages are private: create a classic PAT with only
   `read:packages`, store it as `GHCR_TOKEN` in the sops file, and `deploy.sh`
   logs docker in with it before pulling. Every published image is scanned by
   Trivy (fixable HIGH/CRITICAL fail the publish) and carries an SBOM and
   provenance attestation; the `main` tag moves only after a clean scan.
8. **Operate.** `sudo journalctl -u moi -f`, the runbooks in `docs/runbooks/`,
   and `pg_dump` through `docker compose exec postgres` for backups (see
   *Backup and restore*). Oracle may reclaim Always Free compute that stays
   idle; a serving `paper-api` is never idle by that measure.

## Alerting (Discord)

One Discord channel webhook carries CI results, deploys and host status. The
webhook URL is a secret: it goes into the GitHub repository secrets and the
host's sops file — never into the repository, chat, or a shell history line
that echoes it.

1. **Channel webhook.** Discord → channel → *Edit channel* → *Integrations* →
   *Webhooks* → *New webhook* → *Copy URL*.
2. **GitHub Actions** (`.github/workflows/notify.yml`): in a terminal,
   `gh secret set DISCORD_WEBHOOK` and paste the URL at the prompt. The
   workflow posts every `CI` / `Publish images` failure and every success on
   `main`; with the secret absent it exits without posting.
3. **Host** (`infra/oracle/notify.sh`): add `DISCORD_WEBHOOK_URL` to the
   production sops file on the workstation
   (`sops set … '["DISCORD_WEBHOOK_URL"]' '"<url>"'`), copy it to
   `/etc/moi/secrets.enc.env` as in step 5 above, then `deploy.sh` (or
   `systemctl restart moi-status.timer`). Three producers use it:
   - `moi-status.timer` → `status-check.sh` every 5 minutes: readiness,
     runtime, KR/US states, placement, memory, swap, disk → one status line,
     posted when it differs from the last **delivered** line (`FAIL` / `WARN` /
     `recovered`); the state file is written only after a successful post, so
     a transition that hits a Discord outage is retried on the next tick. A
     `heartbeat` embed goes out when nothing has been delivered for 24 hours
     (`MOI_STATUS_HEARTBEAT_HOURS`), so silence is never mistaken for health.
     This is the only producer that sees a container dying after start-up
     (compose `restart: unless-stopped` restarts it; a restart loop shows up as
     readiness/market flapping in the status line). The check is skipped while
     `deploy.sh` holds `/run/moi-deploy.lock`.
   - `OnFailure=moi-alert@%n.service` on `moi.service` and
     `moi-status.service`: fires **only** when systemd fails to start or stop
     the oneshot unit (sops key, compose interpolation, Docker down) and posts
     the unit's journal tail. `moi.service` is `RemainAfterExit=yes`, so a
     container crash later does not fail the unit and does not fire this.
   - `deploy.sh`: `deploy started`, `deploy finished: <sha>` (only after the
     verification step observed readiness, both markets `NORMAL` and
     placement enabled), or `deploy failed` with the step that broke —
     including an interrupted deploy (SIGINT/SIGTERM/SIGHUP) and a run that
     ended without reaching verification.
   Without the variable every producer is a silent no-op. `notify.sh` is
   fail-open by default (a rejected post is logged, exit 0) so a Discord outage
   can never fail a deploy; only the status check runs it with `NOTIFY_STRICT=1`
   to drive its retry. Titles and descriptions are masked before leaving the
   host (credentials in URLs, `KEY|TOKEN|SECRET|PASSWORD=…` assignments,
   webhook URLs) and capped at 1,500 characters. The deployment-contract
   checker scans `notify.yml` and every `infra/oracle/*.{sh,service,timer}` for
   a literal webhook URL.
4. **Test**: `sudo SOPS_AGE_KEY_FILE=/etc/moi/age.key sops exec-env /etc/moi/secrets.enc.env '/opt/moi/infra/oracle/notify.sh info test'`.

What each alert means and the first response: `docs/runbooks/alerting.md`.
Host-down detection needs an external probe (the timer cannot report a dead
host); a free external monitor pointed at `https://<domain>/health/ready`
with its own Discord integration covers that gap.

## Local run

The compose file is the production shape (`MARKET_DATA_ADAPTER=toss`, secrets
by required interpolation), so a local run is the production run pointed at a
local Docker daemon. Resolve the secrets with the manager of your choice —
the sops/age flow below is what the release checklist's live smoke used:

```bash
brew install sops age && age-keygen -o ~/.config/sops/age/keys.txt
# fill ~/.config/moi/secrets.env with the variables of infra/secrets.env.tpl
# (PUBLIC_ORIGIN / PUBLIC_API_ORIGIN as https origins, DATABASE_URL using the
# compose host `postgres`, generated CSRF_SECRET / ADMIN_API_KEY / SESSION_HASH_KEYS
# / POSTGRES_PASSWORD, and the Toss client id / secret), then encrypt it:
sops --encrypt --age <age public key> --input-type dotenv --output-type dotenv \
  ~/.config/moi/secrets.env > ~/.config/moi/secrets.enc.env && rm ~/.config/moi/secrets.env

# register this machine's egress address in the Toss console and in
# infra/provider-allowlist.yaml (environment `local`), then:
sops exec-env ~/.config/moi/secrets.enc.env 'pnpm preflight:deploy --environment local'
API_PORT=3001 WEB_PORT=8081 \
  sops exec-env ~/.config/moi/secrets.enc.env 'docker compose -f infra/compose.yaml up -d --build'
curl -s http://127.0.0.1:3001/health/market-data   # runtime: SERVING once recovery completes
sops exec-env ~/.config/moi/secrets.enc.env 'docker compose -f infra/compose.yaml down -v'
```

The age private key is the single secret that unlocks everything else: keep
it out of the repository and back it up. Deterministic development and every
automated test use the in-process fake feed instead (`pnpm test`,
`pnpm --filter @moi/e2e test:e2e`); nothing here contacts Toss.
