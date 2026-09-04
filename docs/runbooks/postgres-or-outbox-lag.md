# Runbook: PostgreSQL trouble or outbox lag

Alerts: `TransactionErrors`, `DbLockWaitHigh`, `OutboxLagHigh`.

## Symptoms

- `transaction_error_total{tx_type}` increasing; `transaction_duration_seconds` and `db_lock_wait_seconds{lock_type}` elevated.
- `outbox_oldest_pending_seconds` above 30 and rising: orders confirm over REST but the web app's open-orders list lags until the next snapshot.
- `GET /health/ready` returns 503 with `db: false` or `audit: false`.

## Safe first action

Confirm the database is reachable from outside the process (`pg_isready`). If it is not, the ledger is protected by design: every order mutation is a single transaction, so nothing partial is committed. Do not restart `paper-api` yet; the outbox publisher will catch up on its own once the database returns.

## How to enter or preserve CANCEL_ONLY

If lock waits or transaction errors persist for more than 5 minutes while the database is *up*, reduce write pressure by pinning CANCEL_ONLY globally:

```bash
curl -sS -X POST "$API_ORIGIN/admin/incidents" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"scopeType":"GLOBAL","scope":"*","causeGroup":"DATABASE","reason":"sustained lock waits / tx errors"}'
```

Cancellations still write, but they release reservations rather than create them.

## Read-only diagnosis

```sql
select pid, state, wait_event_type, wait_event, now() - xact_start as age, left(query, 120)
from pg_stat_activity where datname = current_database() and state <> 'idle'
order by xact_start;
select count(*) pending, min(created_at) oldest from outbox_events where published_at is null;
select relname, n_dead_tup, last_autovacuum from pg_stat_user_tables order by n_dead_tup desc limit 10;
```

```bash
curl -sS "$API_ORIGIN/metrics" | grep -E 'transaction_(error|duration)|db_lock_wait|outbox_oldest_pending'
```

## Recovery preconditions

- `pg_isready` succeeds and `/health/ready` reports `db: true, audit: true`.
- No long-running transaction older than 60s remains in `pg_stat_activity` (terminate only with DBA approval; record the pid and query).
- Disk usage on the PostgreSQL volume below 85%.

## Verification: reservations, leader fence, outbox lag, user-stream recovery, market session

Run all of these before declaring the incident over, and after a deploy.
Every query is read-only.

1. **Reservations** — no unreleased reservation may outlive its order, and every wallet's `reserved` must equal its unreleased CASH reservations (the same check `paper-api` runs at RESTORING):
   ```sql
   select r.id, r.order_id, o.status
   from reservations r
   join orders o on o.id = r.order_id
   where o.status in ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED')
     and r.released = false;
   select w.session_id, w.currency, w.reserved,
          coalesce((select sum(r.amount) from reservations r
                    where r.session_id = w.session_id and r.kind = 'CASH'
                      and r.currency = w.currency and r.released = false), 0) as open_reservations
   from wallets w
   where w.reserved <> coalesce((select sum(r.amount) from reservations r
                    where r.session_id = w.session_id and r.kind = 'CASH'
                      and r.currency = w.currency and r.released = false), 0);
   ```
   Expected: zero rows from both.
2. **Leader fence** — exactly one live epoch per market and the running process holds it:
   ```sql
   select market, max(epoch) as epoch, bool_or(released_at is null) as live
   from leader_epochs group by market;
   ```
   Compare with `GET /health/market-data` (`leaderEpoch` per market). A mismatch means a stale process still believes it is leader: stop it before continuing.
3. **Outbox lag** — the publisher is keeping up:
   ```sql
   select count(*) as pending,
          extract(epoch from now() - min(created_at)) as oldest_pending_seconds
   from outbox_events where published_at is null;
   ```
   Expected: `oldest_pending_seconds` below 30 and falling; `outbox_oldest_pending_seconds` on `/metrics` agrees.
4. **User-stream recovery** — open the web app in a fresh anonymous session, place and cancel one small order, and confirm the order list reconciles without a manual refresh. In `/metrics`, `rest_snapshot_request_total{result="ok"}` must increase (gap-triggered snapshot) and `order_event_total{status="error"}` must not.
5. **Market session** — the phase each market reports matches the wall clock in
   that market's own time zone:
   ```bash
   curl -sS "$API_ORIGIN/api/v1/markets/KR/session" | jq
   curl -sS "$API_ORIGIN/api/v1/markets/US/session" | jq
   ```
   Expected: `phase` is what the current time says (`REGULAR` inside
   `opensAt`…`closesAt`, `PRE_OPEN`/`POST_CLOSE` outside it), `isTradingDay` is
   true on a business day, and `opensAt`/`closesAt` are non-null whenever the
   day trades. A `HOLIDAY` on a business day is the calendar, not the feed —
   see `market-data-degraded.md`.
6. **Leader handoff drill** — proves `CANCEL_ONLY → old leader disconnect → new leader recovery → NORMAL` with two real `dist/main.js` processes against the loopback fake provider (never live Toss):
   ```bash
   pnpm --filter @moi/paper-api build
   pnpm --filter @moi/paper-api test:drill
   ```
   Evidence lands in `apps/paper-api/test-results/leader-handoff/<utc>-drill.json` (`summary.peakConcurrentConnections === 2`, `summary.evictions === 0`). Docker is required; the drill fails (never skips) without it.

## Rollback criteria

- Lag that started within 15 minutes of a deploy: roll back `paper-api`. Migrations are additive and remain compatible with the previous image.
- Never roll back a migration on a database with traffic; restore-from-backup is the only supported way to move the schema backwards, and it requires a full stop (see deployment guide, Backup and restore).

## Evidence to retain

- Alert payload (name, market, incident id, recovery epoch) and the time it fired and resolved.
- Output of every diagnosis query above, taken before and after the fix.
- `GET /health/market-data` and `GET /metrics` snapshots at incident start, at CANCEL_ONLY entry, and after NORMAL.
- Admin API responses (incident id, `Idempotency-Key`, request ids) for any incident or cancel-all call.
- Structured application logs for the window (14-day retention; export the window before it ages out).
- The commit SHA and image digests of `paper-api` and `web` that were running.
