-- Fill history, part 2 of 2: data and indexes.
--
-- Split from 004 so the slow work runs without an AccessExclusiveLock on
-- `fills`: this migration only writes rows, taking RowExclusiveLock, which
-- readers ignore. The old release keeps serving `GET /api/v1/portfolio` — which
-- reads `fills` twice — throughout. Indexes and constraints are 006 and 007.
set lock_timeout = '3s';

update fills f set session_id = o.session_id
from orders o where o.id = f.order_id and f.session_id is null;

-- Deterministic, and in the order a client will replay it. Assigning by heap
-- order would invert history: the UPDATE above rewrites tuples to the end of
-- the heap, so an older fill can land after a newer one. Realized P&L replayed
-- on an inverted cursor books a sell before the buy it closes.
with ordered as (
  select id, row_number() over (order by occurred_at, id) as sequence
  from fills where fill_sequence is null
)
update fills f set fill_sequence = ordered.sequence
from ordered where ordered.id = f.id;

select setval(
  'fills_fill_sequence_seq',
  coalesce((select max(fill_sequence) from fills), 0) + 1,
  false
);
