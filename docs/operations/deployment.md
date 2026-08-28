# Deployment guide

Skipjack ships as two images and two managed data stores. This guide is
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

> **Release blocker:** the current `main.js` composition does not yet own the
> live provider adapter, fenced market-leader lifecycle, or outbox publisher.
> Without the explicitly test-only `MARKET_DATA_ADAPTER=fake`, it starts in
> `CANCEL_ONLY`. The topology and handoff rules below are the required target,
> not evidence that this candidate is approved for public deployment.

Run exactly one `paper-api` replica (one leader replica). The single `paper-api` process both serves HTTP and owns exactly one leader
per market (`skipjack.leader-markets` label). Running more than one
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

`web` reads `PUBLIC_API_ORIGIN` (bare HTTPS origin) and `PORT`. The server
validates the origin, serves it from `/runtime-config.js` with `no-store`, and
includes it in the CSP `connect-src`. No other variable reaches the browser.

### Secret injection

Secrets are injected at runtime by the platform's secret store (Compose:
required interpolation `${VAR:?}` from the shell or an untracked env file;
Kubernetes: `Secret` → `envFrom`; PaaS: the provider's secret manager). Never
bake a secret into an image, commit an `.env`, or pass a secret through CI
logs. Rotate `CSRF_SECRET` and `ADMIN_API_KEY` by redeploying;
rotate `SESSION_HASH_KEYS` by prepending the new key and removing the oldest
after `SESSION_MAX_AGE_SECONDS` has elapsed.

## Origins, TLS, cookies

- Terminate TLS at the platform edge for both public services; redirect HTTP
  to HTTPS. HSTS `max-age=31536000; includeSubDomains`.
- The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`. The web and
  API origins must therefore be **same-site** (for example
  `app.skipjack.example` and `api.skipjack.example`) so `SameSite=Lax`
  cookies accompany fetches. Cross-site origins are not supported.
- `PUBLIC_ORIGIN` on the API and `PUBLIC_API_ORIGIN` on the web must match the
  externally visible origins exactly (scheme, host, port).

## Rollout procedure

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
   fake provider, Docker required): `pnpm --filter @skipjack/paper-api build &&
   pnpm --filter @skipjack/paper-api test:drill`. It must pass three consecutive times
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

## Local run

```bash
export PUBLIC_ORIGIN=http://localhost:8080 PUBLIC_API_ORIGIN=http://localhost:3000 \
  POSTGRES_PASSWORD=$(openssl rand -hex 16) CSRF_SECRET=$(openssl rand -hex 32) \
  ADMIN_API_KEY=$(openssl rand -hex 32) SESSION_HASH_KEYS=$(openssl rand -hex 32)
export DATABASE_URL="postgres://skipjack:${POSTGRES_PASSWORD}@postgres:5432/skipjack"
docker compose -f infra/compose.yaml config --quiet
docker compose -f infra/compose.yaml up --build
```
