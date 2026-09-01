# Runbook: Market data DEGRADED or RECOVERING

Alerts: `MarketDataDegradedSustained`, `MarketDataRecoveringSustained`, `FeedReconnectFlapping`.

## Symptoms

- `market_data_health{market, state="DEGRADED"}` or `state="RECOVERING"` stays at 1 beyond the alert `for` window.
- `feed_reconnect_total` climbs; `feed_ping_latency_seconds` rises before each reconnect.
- The web app shows the market badge as DEGRADED/RECOVERING; quotes stop updating; order placement for that market is disabled by server capabilities.
- `GET /health/market-data` reports the state, the current leader epoch, and the last Toss frame time.

## Safe first action

Do nothing that touches the ledger. Confirm the state is *reported*, not stuck: compare `lastFrameAt` in `/health/market-data` with wall-clock time. DEGRADED with stale frames is the feed; DEGRADED with fresh frames is the state machine. Only the state machine case justifies intervention.

## How to enter or preserve CANCEL_ONLY

The market is already CANCEL_ONLY for placement while DEGRADED/RECOVERING; server capabilities enforce it. If the market bounces between NORMAL and DEGRADED (flapping), pin it:

```bash
curl -sS -X POST "$API_ORIGIN/admin/incidents" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"scopeType":"MARKET","scope":"KRX","causeGroup":"MARKET_DATA","reason":"feed flapping, pinning CANCEL_ONLY"}'
```

Keep the incident open until the feed has been stable for at least 10 minutes.

## `PROVIDER_IP_NOT_ALLOWED` / `ProviderAuthFailed`

A `403 access_denied` from the provider means the process's egress IP is not on the provider allow list, and a `401` means the client credentials were rejected. Neither is fixed by a restart: correct the allow list (the `paper-api` egress IP must be static, registered in the Toss console, and recorded in `infra/provider-allowlist.yaml`; compare the process's current egress address with `pnpm preflight:deploy --skip-compose`) or rotate `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET` through the secret manager (`infra/secrets.env.tpl`), then let the market-local reconnect supervisor retry (or resolve `RECOVERY_RETRY_EXHAUSTED` if it tripped).

## After a restart

A restart does not clear the incident rows. The health state machine lives in
memory and comes back `NORMAL`, but placement is derived from the `ACTIVE` rows
in `safety_incidents`, which the process re-reads on boot. A recovered feed now
resolves the automatic rows the market owns (and `RECOVERY_RETRY_EXHAUSTED`
with them) and `/health/market-data` reports `DEGRADED` for any market that
still has one, so `NORMAL` next to `placement:false` is no longer possible. Do
not trust that alone — check, and resolve anything left:

```bash
curl -sS "$API_ORIGIN/api/v1/health/trading" | jq '{placement, reasons}'
curl -sS "$API_ORIGIN/health/market-data" | jq
```

```sql
select id, scope_type, scope_id, source, cause_code, activated_at
from safety_incidents where status = 'ACTIVE' order by activated_at;
```

Anything still `ACTIVE` after both markets report `NORMAL` is operator-owned
(`STARTUP_INVARIANT_OR_AUDIT_FAILURE`, or an incident someone pinned by hand)
and blocks placement until it is resolved. Resolve one with its current
`version` as `expectedVersion`:

```bash
curl -sS -X POST "$API_ORIGIN/admin/incidents/$INCIDENT_ID/resolve" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"expectedVersion":1}'
```

A `409 VERSION_CONFLICT` means the row changed under you; re-read `version` and
retry. Do not resolve `STARTUP_INVARIANT_OR_AUDIT_FAILURE` until the ledger
invariants pass — see `emergency-cancel-only.md`.

Reading a closed row afterwards: `source` says who raised it, `resolved_by` who
cleared it — `RECOVERY` for a market that came back on its own, `ADMIN_API` for
the call above. `source = 'MANUAL'` with `resolved_by = 'RECOVERY'` is a hold
that closed without an operator, which is expected for
`RECOVERY_RETRY_EXHAUSTED` and worth a second look for anything else:

```sql
select scope_id, cause_code, source, resolved_by, activated_at, resolved_at
from safety_incidents
where status = 'RESOLVED' and resolved_at > now() - interval '24 hours'
order by resolved_at;
```

## Read-only diagnosis

```bash
curl -sS "$API_ORIGIN/health/market-data" | jq
curl -sS "$API_ORIGIN/metrics" | grep -E 'market_data_health|feed_reconnect_total|feed_ping_latency_seconds|recovery_duration_seconds'
```

```sql
select market, state, epoch, updated_at from market_states order by market;
select market, epoch, acquired_at, released_at from leader_epochs order by acquired_at desc limit 10;
```

Check Toss status pages and the hosting provider's egress health before suspecting the process.

## Recovery preconditions

- Toss REST snapshot endpoint answers (`rest_snapshot_request_total{result="ok"}` increasing).
- Exactly one leader epoch is live for the market (see Verification).
- Redis answers `PING` and the lease TTL is renewing.
- No `InvariantViolation` or `EmergencyLatchActive` alert is active; if one is, follow `emergency-cancel-only.md` first.

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

- If the DEGRADED state began within 15 minutes of a deploy, roll back the `paper-api` image (see `docs/operations/deployment.md`, Rollback). The database schema is forward-compatible one release back, so no migration rollback is needed.
- If a restart does not return the market to NORMAL within two recovery cycles (about 2 minutes), stop restarting; leave CANCEL_ONLY pinned and escalate. Repeated restarts create repeated Toss handshakes and can trip upstream rate limits.

## Evidence to retain

- Alert payload (name, market, incident id, recovery epoch) and the time it fired and resolved.
- Output of every diagnosis query above, taken before and after the fix.
- `GET /health/market-data` and `GET /metrics` snapshots at incident start, at CANCEL_ONLY entry, and after NORMAL.
- Admin API responses (incident id, `Idempotency-Key`, request ids) for any incident or cancel-all call.
- Structured application logs for the window (14-day retention; export the window before it ages out).
- The commit SHA and image digests of `paper-api` and `web` that were running.
