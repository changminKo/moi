# Runbook: Redis loss or leader-lease loss

Alerts: `RecoveryDurationExceeded`, plus `MarketDataRecoveringSustained` when the leader cannot re-acquire.

## Symptoms

- `recovery_duration_seconds` above 60; markets remain RECOVERING.
- Redis healthcheck failing in the orchestrator; `REDIS_URL` connection errors in logs.
- `leader_epochs` shows an epoch with `released_at is null` for a process that is no longer running.
- Quotes stop; user streams stall (fan-out uses Redis).

## Safe first action

Do **not** start a second `paper-api` replica to "take over". Two leaders means two Toss connection pairs and split fills. First determine whether the *process* or *Redis* is down: `GET /health/live` on the API answers even without Redis; `GET /health/ready` does not.

## How to enter or preserve CANCEL_ONLY

If the API is alive, open a global incident so no new orders are accepted while leadership is unclear:

```bash
curl -sS -X POST "$API_ORIGIN/admin/incidents" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"scopeType":"GLOBAL","scope":"*","causeGroup":"INFRA","reason":"redis or leader lease unavailable"}'
```

If the API is dead, the process is trivially not accepting orders; preserve that by *not* starting a replacement until Redis is healthy.

## Read-only diagnosis

```bash
redis-cli -u "$REDIS_URL" PING
curl -sS "$API_ORIGIN/health/live"; curl -sS "$API_ORIGIN/health/ready"
curl -sS "$API_ORIGIN/health/market-data" | jq
```

The leader lease is a **PostgreSQL session advisory lock** (`pg_try_advisory_lock(hashtext(market))`) plus a `leader_epochs` row; Redis holds no lease state.

```sql
select market_code, epoch, leader_id, acquired_at, released_at from leader_epochs order by market_code;
select pid, application_name, state from pg_stat_activity where application_name like 'skipjack-lease-%';
select l.pid, a.application_name from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory';
```

## The previous process did not exit (`LeaderLeaseWaitLong`)

A new process logs `lease.waiting {market}` every 10 s while it polls `pg_try_advisory_lock` at 250 ms. If the wait exceeds 60 s and the old process has already been asked to stop, confirm it is gone (`docker ps` / platform UI), then look for a leftover backend in `pg_locks` above and terminate it with `select pg_terminate_backend(<pid>)`. The waiter acquires on its next poll; no restart is needed. Never start a third process to "help" — it would open a third provider connection.

## One market lease lost means a global re-election (`LeaderReelection`)

Losing either market's lease connection takes **both** markets to `CANCEL_ONLY`: the process enters `RE_ELECTING`, closes both provider sockets, releases the surviving lease, then re-acquires the KR→US bundle and recovers. This is the designed behaviour, not two incidents. If `runtime_state{state="RE_ELECTING"}` stays 1 for more than 60 s, another process probably holds one of the locks — check `pg_locks` as above.

## Recovery preconditions

- Redis `PING` returns `PONG` and AOF replay finished (`redis-cli INFO persistence` shows `loading:0`).
- No stale process holds a live epoch: if a row is live but its process is gone, stop the old container before the new one starts. The new leader acquires a strictly higher epoch, fencing any late writes from the old one.
- PostgreSQL is reachable (`/health/ready` shows `db: true`).

## Verification: reservations, leader fence, outbox lag, user-stream recovery

Run all four before declaring the incident over. Every query is read-only.

1. **Reservations** — no reservation may outlive its order:
   ```sql
   select r.id, r.order_id, o.status
   from reservations r
   join orders o on o.id = r.order_id
   where o.status in ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED')
     and r.released_at is null;
   ```
   Expected: zero rows.
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
   pnpm --filter @skipjack/paper-api build
   pnpm --filter @skipjack/paper-api exec vitest run src/runtime/leader-handoff.drill
   ```
   Evidence lands in `apps/paper-api/test-results/leader-handoff/<utc>-drill.json` (`summary.peakConcurrentConnections === 2`, `summary.evictions === 0`). Docker is required; the drill fails (never skips) without it.

## Rollback criteria

- Redis data loss is acceptable: lease and fan-out state are rebuilt from PostgreSQL on recovery. Never restore an old Redis snapshot over a running system; it can resurrect an expired lease.
- If the new leader fails to reach NORMAL within 60 seconds twice in a row, roll back the `paper-api` image and keep the global incident open.

## Evidence to retain

- Alert payload (name, market, incident id, recovery epoch) and the time it fired and resolved.
- Output of every diagnosis query above, taken before and after the fix.
- `GET /health/market-data` and `GET /metrics` snapshots at incident start, at CANCEL_ONLY entry, and after NORMAL.
- Admin API responses (incident id, `Idempotency-Key`, request ids) for any incident or cancel-all call.
- Structured application logs for the window (14-day retention; export the window before it ages out).
- The commit SHA and image digests of `paper-api` and `web` that were running.
