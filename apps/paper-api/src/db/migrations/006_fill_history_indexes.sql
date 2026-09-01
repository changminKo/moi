-- Fill history, part 3 of 4: indexes and constraints.
--
-- Separate from the backfill so that file issues no AccessExclusiveLock:
-- `create index` blocks writers but not readers, and the constraint statements
-- here are catalog-only. The foreign key is added NOT VALID on purpose — the
-- validating scan runs in 007, where it takes ShareUpdateExclusiveLock and
-- blocks nobody, instead of scanning under the AccessExclusiveLock that adding
-- the constraint takes.
--
-- Note this file does take AccessExclusiveLock on `orders`, not just `fills`,
-- to attach the unique constraint. It is catalog-only and brief, but on the
-- first deploy it is held to the end of 007 with the rest (spec §16.37).
set lock_timeout = '3s';

create unique index fills_sequence_idx on fills (fill_sequence);
create index fills_session_sequence_idx on fills (session_id, fill_sequence);

-- `fills.session_id` is denormalised: `listFills` filters on it but returns the
-- instrument and side from the joined order. Nothing but this constraint stops
-- the two from diverging, and a divergence would show one session another
-- session's symbol and side. PostgreSQL enforces the pairing instead.
create unique index orders_id_session_idx on orders (id, session_id);
alter table orders add constraint orders_id_session_key unique using index orders_id_session_idx;
alter table fills add constraint fills_order_session_fkey
  foreign key (order_id, session_id) references orders (id, session_id) not valid;
