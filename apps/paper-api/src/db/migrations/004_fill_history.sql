-- Fill history: make a session's own fills reachable without the outbox.
--
-- `fills` was reachable only by joining from `orders`, and the ORDER_FILLED
-- outbox payload carried no price or fee, so a client could not reconstruct
-- realized P&L once the retention-bounded replay window had passed.
--
-- `fill_sequence` is the cursor. It is a global bigserial, but every write for
-- one session happens inside `runSessionTransaction`, which takes the session
-- row `for update` first; same-session inserts are therefore serialized, and
-- assignment order equals commit order *within a session*. A client filtering
-- by its own session can page on it without the gap-visibility hazard a global
-- sequence would otherwise have.
--
-- `account_sequence` records the ORDER_FILLED event this fill was published in,
-- so a client can align a REST page with the account stream it was reading. It
-- is nullable: fills written before this migration were never published with a
-- sequence, and inventing one would be a lie.
alter table fills add column session_id uuid references anonymous_sessions(id) on delete cascade;

update fills f set session_id = o.session_id from orders o where o.id = f.order_id;

alter table fills alter column session_id set not null;

alter table fills add column account_sequence bigint check (account_sequence is null or account_sequence > 0);

alter table fills add column fill_sequence bigserial;

create unique index fills_sequence_idx on fills (fill_sequence);
create index fills_session_sequence_idx on fills (session_id, fill_sequence);
