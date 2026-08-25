# Runbook: Emergency CANCEL_ONLY and the safety latch

Alerts: `InvariantViolation`, `TransactionalAuditFailure`, `EmergencyLatchActive`, `SafetyIncidentActive`.

## Symptoms

- `invariant_violation_total{invariant_type, market}` increments: a reservation, balance, or position check failed inside a transaction. The transaction was rolled back.
- `transactional_audit_failure_total` increments: the audit row could not be written, so the business write was refused.
- `emergency_latch_active == 1`: the process latched itself into CANCEL_ONLY everywhere and will stay there across restarts until an operator resolves the incident.
- Web app shows the global CANCEL_ONLY banner; place-order controls are disabled; cancel controls remain.

## Safe first action

Leave the latch engaged. Its purpose is to stop the bleeding while a human looks. Capture `/metrics`, `/health/market-data`, and the offending log lines (`invariant_type`, request id) before anything else.

## How to enter or preserve CANCEL_ONLY

Entering manually (when the latch did *not* trip but you want the same posture):

```bash
curl -sS -X POST "$API_ORIGIN/admin/incidents" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"scopeType":"GLOBAL","scope":"*","causeGroup":"OPERATOR","reason":"manual emergency posture"}'
```

If open orders must be flattened (for example an invariant that could re-fire on the next fill):

```bash
curl -sS -X POST "$API_ORIGIN/admin/cancel-all" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

Preserving: do not call `/admin/incidents/:id/resolve` until every check in Verification passes.

## Read-only diagnosis

```sql
select id, scope_type, scope, cause_group, reason, opened_at, resolved_at
from safety_incidents where resolved_at is null;
select event_type, count(*) from audit_events
where occurred_at > now() - interval '1 hour' group by event_type order by 2 desc;
select w.session_id, w.currency, w.available, w.reserved,
       coalesce(sum(r.amount), 0) as open_reservations
from wallets w left join reservations r on r.wallet_id = w.id and r.released_at is null
group by w.session_id, w.currency, w.available, w.reserved
having w.reserved <> coalesce(sum(r.amount), 0);
```

The last query must return zero rows; any row is the invariant the latch protected.

## Recovery preconditions

- Root cause identified and either fixed in a deployed image or shown to be a one-off external input.
- The wallet/reservation reconciliation query returns zero rows.
- Audit writes succeed (`transactional_audit_failure_total` flat for 10 minutes).
- Exactly one leader epoch per market is live.

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

## Rollback criteria

- Any invariant violation within 30 minutes of a deploy is treated as a regression: roll back the image first, diagnose second. The latch remains engaged through the rollback.
- Resolve the incident (`POST /admin/incidents/:id/resolve`) only after rollback *and* the reconciliation query is clean.

## Evidence to retain

- Alert payload (name, market, incident id, recovery epoch) and the time it fired and resolved.
- Output of every diagnosis query above, taken before and after the fix.
- `GET /health/market-data` and `GET /metrics` snapshots at incident start, at CANCEL_ONLY entry, and after NORMAL.
- Admin API responses (incident id, `Idempotency-Key`, request ids) for any incident or cancel-all call.
- Structured application logs for the window (14-day retention; export the window before it ages out).
- The commit SHA and image digests of `paper-api` and `web` that were running.
