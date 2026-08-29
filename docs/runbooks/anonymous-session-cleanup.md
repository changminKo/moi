# Runbook: Anonymous session cleanup

Not alert-driven. Scheduled maintenance for `anonymous_sessions` and their ledgers.

## Symptoms

- `anonymous_sessions` grows without bound; `wallets`, `orders`, `fills`, `reservations`, and `audit_events` partitions grow with it.
- Session lookups and portfolio snapshots slow down; `db_lock_wait_seconds{lock_type="session"}` creeps up during cleanup runs.
- Disk usage on the PostgreSQL volume trends toward the 85% threshold.

## Safe first action

Measure before deleting. Cleanup is `expireInactiveSessions` (`apps/paper-api/src/modules/session/session-cleanup.ts`): it first *expires* sessions past their inactivity window, then *deletes* already-expired ones in bounded batches. Run it with a small batch and confirm `{ expired, deleted }` counts match the dry-run estimate below.

## How to enter or preserve CANCEL_ONLY

Cleanup does not require CANCEL_ONLY. It must, however, never delete a session with open orders or live reservations; if the estimate below shows any, resolve those orders first (cancel them through the normal path) rather than forcing deletion. If cleanup is run during an active incident, keep the incident open; cleanup does not resolve it.

## Read-only diagnosis

```sql
select count(*) filter (where expires_at < now()) as expired,
       count(*) filter (where last_seen_at < now() - interval '30 days') as inactive_30d,
       count(*) as total
from anonymous_sessions;
select s.id from anonymous_sessions s
where s.expires_at < now()
  and exists (select 1 from orders o where o.session_id = s.id and o.status in ('OPEN', 'PARTIALLY_FILLED'));
select s.id from anonymous_sessions s
where s.expires_at < now()
  and exists (select 1 from reservations r join wallets w on w.session_id = r.session_id
              where w.session_id = s.id and r.released = false);
```

Both existence queries must return zero rows before deletion proceeds.

## Recovery preconditions

- Database healthy (`/health/ready` ok) and outbox lag below 30s; cleanup adds write load.
- A backup completed within the last 24 hours.
- The audit partition for the affected month is retained (audit rows are never deleted by cleanup; partitions age out by the retention job).

## Verification: reservations, leader fence, outbox lag, user-stream recovery

Run all four before declaring the incident over. Every query is read-only.

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
5. **Leader handoff drill** — proves `CANCEL_ONLY → old leader disconnect → new leader recovery → NORMAL` with two real `dist/main.js` processes against the loopback fake provider (never live Toss):
   ```bash
   pnpm --filter @moi/paper-api build
   pnpm --filter @moi/paper-api test:drill
   ```
   Evidence lands in `apps/paper-api/test-results/leader-handoff/<utc>-drill.json` (`summary.peakConcurrentConnections === 2`, `summary.evictions === 0`). Docker is required; the drill fails (never skips) without it.

## Rollback criteria

- Cleanup is not reversible except via backup restore. Stop immediately if `deleted` exceeds the dry-run estimate by more than 5%, or if any post-run Verification check fails, and open an incident.
- If lock waits exceed 5s during a batch, halve the batch size rather than retrying at the same size.

## Evidence to retain

- Alert payload (name, market, incident id, recovery epoch) and the time it fired and resolved.
- Output of every diagnosis query above, taken before and after the fix.
- `GET /health/market-data` and `GET /metrics` snapshots at incident start, at CANCEL_ONLY entry, and after NORMAL.
- Admin API responses (incident id, `Idempotency-Key`, request ids) for any incident or cancel-all call.
- Structured application logs for the window (14-day retention; export the window before it ages out).
- The commit SHA and image digests of `paper-api` and `web` that were running.
