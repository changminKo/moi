-- Fill history, part 1 of 4: catalog-only DDL.
--
-- Everything here is a catalog change — no table rewrite, no full-table scan,
-- no data. That is what keeps this file's AccessExclusiveLock brief: the slow
-- work (backfill, index builds, constraint validation) lives in 005-007, each
-- chosen to take the weakest lock that statement can take.
--
-- Read the split as per-statement lock strength, NOT as lock duration within
-- one deploy. Kysely's Migrator runs every pending migration in a SINGLE
-- transaction (`migrator.js:442-445`; `disableTransactions` is not set), so on
-- the deploy that first applies 004-007 the AccessExclusiveLock taken here is
-- held until 007 commits, and splitting the files cannot shorten it. Measured
-- reader stall = total migration time, linear in rows: 100 rows 10 ms, 30k
-- 0.67 s, 300k 7.6 s. Production `fills` is ~100 rows, so ~10 ms today. See
-- spec §16.37 and issue #47 — moving to `disableTransactions` or to
-- one-heavy-migration-per-release is a policy call for every future migration,
-- deliberately not made here.
--
-- `lock_timeout` bounds the wait for the locks below: a migration that cannot
-- get them promptly fails the deploy instead of queueing ahead of live traffic
-- and stalling every reader behind it.
set lock_timeout = '3s';

-- Nullable on purpose. `deploy.sh` migrates while the previous release is still
-- serving, and that release inserts fills without this column; a NOT NULL here
-- would break every fill and trigger order on the old process from this commit
-- until the new image finishes restarting, and would leave a rollback broken.
-- The trigger below makes the old release's insert *correct* rather than merely
-- tolerated, so its fills are owned and visible. NOT NULL is a later release's
-- job, once no running code can insert without the column.
alter table fills add column session_id uuid references anonymous_sessions(id) on delete cascade;

alter table fills add column account_sequence bigint check (account_sequence is null or account_sequence > 0);

-- Plain bigint plus a separate sequence: `add column ... bigserial` would make
-- the default volatile and rewrite the whole table under AccessExclusiveLock.
-- Adding the column nullable and setting the default afterwards is catalog-only,
-- and existing rows keep NULL until 005 assigns them a value.
alter table fills add column fill_sequence bigint;
create sequence fills_fill_sequence_seq owned by fills.fill_sequence;
alter table fills alter column fill_sequence set default nextval('fills_fill_sequence_seq');

-- The previous release inserts a fill with no session_id. Deriving it from the
-- order keeps those rows owned, so they are visible to `GET /api/v1/fills` and
-- satisfy the composite foreign key 005 adds. The current release sets the
-- column explicitly and the trigger then leaves the value alone.
create function fills_session_from_order() returns trigger as $$
begin
  if new.session_id is null then
    select o.session_id into new.session_id from orders o where o.id = new.order_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger fills_session_from_order_trigger
  before insert on fills
  for each row execute function fills_session_from_order();
