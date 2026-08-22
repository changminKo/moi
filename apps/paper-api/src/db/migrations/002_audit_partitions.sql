-- Monthly range partitions for audit_events.
--
-- The default partition guarantees that a row whose occurred_at falls outside
-- every monthly partition is still stored instead of rejected. Monthly
-- partitions are created on demand by ensureAuditPartitions(db, now), which
-- calls ensure_audit_partition() once per month inside a single transaction.

create table audit_events_default partition of audit_events default;

create index audit_events_order_idx on audit_events (order_id, occurred_at);

create index audit_events_session_idx
  on audit_events (session_reference, occurred_at desc);

create index audit_events_occurred_at_idx on audit_events (occurred_at);

create function audit_partition_exists(partition_name text)
  returns boolean language sql stable as $$
  select exists (
    select 1
    from pg_inherits
    join pg_class as parent on parent.oid = pg_inherits.inhparent
    join pg_class as child on child.oid = pg_inherits.inhrelid
    where parent.relname = 'audit_events'
      and parent.relnamespace = 'public'::regnamespace
      and child.relname = partition_name
  );
$$;

-- Creates one monthly partition and returns its name, doing nothing when it is
-- already attached. Two properties make this safe to call from any reachable
-- state:
--
--   * Bounds are pinned to UTC instants. A bare `date` literal would be cast to
--     timestamptz in whatever TimeZone the DDL session carries, which does not
--     have to be the UTC month arithmetic that migrate.ts computes. Under
--     Asia/Seoul that shifts every boundary nine hours, leaving a window that
--     routes rows to the default partition; under a TimeZone change between two
--     calls the second month overlaps the first and the call fails outright.
--   * Rows for the month that are already sitting in the default partition are
--     moved into the new partition before it is attached. PostgreSQL refuses to
--     attach a range that the default partition still holds rows for, so
--     without the move the first audit write of a month would wedge partition
--     maintenance permanently — and, because both months share one
--     transaction, take the following month down with it.
create function ensure_audit_partition(month_start date) returns text
language plpgsql as $$
declare
  month_first date := date_trunc('month', month_start)::date;
  range_start timestamptz := month_first::timestamp at time zone 'UTC';
  range_end timestamptz :=
    (month_first::timestamp + interval '1 month') at time zone 'UTC';
  partition_name text := 'audit_events_' || to_char(month_first, 'YYYY_MM');
  squatter_relkind "char";
begin
  -- Fast path: nothing to do, and no reason to lock out readers or writers.
  if audit_partition_exists(partition_name) then
    return partition_name;
  end if;

  -- The probe, the row move and the attach have to see one state: a row
  -- inserted into the default partition between the move and the attach would
  -- fail the attach. Attaching takes this lock anyway, so taking it up front
  -- costs nothing beyond the move itself.
  lock table audit_events in access exclusive mode;
  if audit_partition_exists(partition_name) then
    return partition_name;
  end if;

  select relkind into squatter_relkind
  from pg_class
  where relname = partition_name
    and relnamespace = 'public'::regnamespace;
  if squatter_relkind is not null then
    raise exception
      'relation % exists but is not a partition of audit_events',
      partition_name;
  end if;

  execute format(
    'create table %I (like audit_events including defaults)',
    partition_name
  );

  -- Only the default partition can hold rows for a range no partition covers,
  -- so this moves exactly those rows. If the range does overlap an existing
  -- partition the attach below fails and the whole statement rolls back, which
  -- undoes the move with it.
  execute format(
    'with moved as (
       delete from audit_events
       where occurred_at >= %L::timestamptz and occurred_at < %L::timestamptz
       returning *
     )
     insert into %I select * from moved',
    range_start,
    range_end,
    partition_name
  );

  execute format(
    'alter table audit_events attach partition %I
       for values from (%L::timestamptz) to (%L::timestamptz)',
    partition_name,
    range_start,
    range_end
  );

  return partition_name;
end;
$$;
