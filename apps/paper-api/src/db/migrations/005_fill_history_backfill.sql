-- Fill history, part 2 of 4: the backfill.
--
-- Split from 004 so the slow work issues no AccessExclusiveLock of its own:
-- these statements only write rows, taking RowExclusiveLock, which readers
-- ignore. Indexes and constraints are 006 and 007.
--
-- This does not mean readers run free during the first deploy — 004's lock is
-- still held across this file, because the whole set shares one transaction
-- (see 004's header, spec §16.37, issue #47). What the split does buy: the
-- weakest possible lock per statement, so the policy fix in #47
-- (`disableTransactions`) makes these files individually cheap without
-- rewriting them.
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
