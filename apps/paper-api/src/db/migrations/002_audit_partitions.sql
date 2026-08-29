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

-- Returns the partition bound expression of the audit_events partition with
-- this name, or NULL when audit_events has no such partition. Both callers
-- below need the bound and not only the existence, so this returns the bound
-- and existence is `is not null`.
--
-- `set search_path = public, pg_temp` is load-bearing, not cosmetic. When
-- pg_temp is not named in the path PostgreSQL searches the session's temporary
-- schema for relation names *first* — ahead of pg_catalog — and TEMPORARY on a
-- database is granted to PUBLIC, so an unpinned body lets any caller answer
-- this question with `create temp table pg_inherits (...)`. Naming pg_temp last
-- demotes it; pg_catalog stays implicitly first because it is not named.
-- Qualifying every catalog relation as well means neither half depends on the
-- other. The same reasoning applies to every function in this schema.
--
-- SECURITY INVOKER (the default) is deliberate: this reads only catalogs the
-- caller may already read, and a definer-rights function would run its dynamic
-- SQL as the owner for the benefit of any role holding EXECUTE.
create function audit_partition_bound(partition_name text) returns text
  language sql stable set search_path = public, pg_temp as $$
  select pg_catalog.pg_get_expr(child.relpartbound, child.oid)
  from pg_catalog.pg_inherits as inherits
  join pg_catalog.pg_class as parent on parent.oid = inherits.inhparent
  join pg_catalog.pg_class as child on child.oid = inherits.inhrelid
  where parent.relname = 'audit_events'
    and parent.relnamespace = 'public'::pg_catalog.regnamespace
    and child.relname = partition_name;
$$;

-- Creates one monthly partition and returns its name, doing nothing when it is
-- already attached. Three properties make this safe to call from any reachable
-- state:
--
--   * Bounds are pinned to UTC instants. A bare `date` literal would be cast to
--     timestamptz in whatever TimeZone the DDL session carries, which does not
--     have to be the UTC month arithmetic that migrate.ts computes. Under
--     Asia/Seoul that shifts every boundary nine hours, leaving a window that
--     routes rows to the default partition; under a TimeZone change between two
--     calls the second month overlaps the first and the call fails outright.
--   * The fast path checks the bounds it found, not only the name. A partition
--     carrying the right name and the wrong bounds — the shape an upgrade from
--     the pre-fix TimeZone-dependent code would leave behind — would otherwise
--     be reported as already done, leaving a permanent gap routed to the
--     default partition that nothing ever reports.
--   * Rows for the month that are already sitting in the default partition are
--     moved into the new partition before it is attached. PostgreSQL refuses to
--     attach a range that the default partition still holds rows for, so
--     without the move the first audit write of a month would wedge partition
--     maintenance permanently — and, because both months share one
--     transaction, take the following month down with it.
--
-- Every relation is schema-qualified and the path is pinned for the reason
-- given on audit_partition_bound(): unqualified names in the dynamic SQL below
-- would otherwise resolve into the caller's pg_temp, which moves audit rows
-- into a temporary table the attach then refuses. This function is likewise
-- SECURITY INVOKER — it takes ACCESS EXCLUSIVE on audit_events and creates
-- tables, so running it with the owner's rights would hand both to any role
-- holding EXECUTE. Whoever schedules maintenance runs it as the table owner.
create function ensure_audit_partition(month_start date) returns text
language plpgsql set search_path = public, pg_temp as $$
declare
  month_first date := date_trunc('month', month_start)::date;
  range_start timestamptz := month_first::timestamp at time zone 'UTC';
  range_end timestamptz :=
    (month_first::timestamp + interval '1 month') at time zone 'UTC';
  partition_name text := 'audit_events_' || to_char(month_first, 'YYYY_MM');
  expected_bound text;
  attached_bound text;
  squatter_relkind "char";
begin
  -- pg_get_expr renders its literals in the session TimeZone, and so does %L,
  -- so comparing the two rendered forms compares the instants.
  expected_bound := format(
    'FOR VALUES FROM (%L) TO (%L)', range_start, range_end
  );

  -- Fast path: an already-attached month needs no lock, so a repeat call locks
  -- out neither readers nor writers. Only when the month is missing does the
  -- probe, the row move and the attach have to see one state — a row inserted
  -- into the default partition between the move and the attach would fail the
  -- attach — so the lock is taken and the probe repeated under it. Attaching
  -- takes this lock anyway, so taking it up front costs nothing beyond the
  -- move itself.
  attached_bound := audit_partition_bound(partition_name);
  if attached_bound is null then
    lock table public.audit_events in access exclusive mode;
    attached_bound := audit_partition_bound(partition_name);
  end if;

  if attached_bound is not null then
    if attached_bound <> expected_bound then
      raise exception
        'partition % is attached as %, not %',
        partition_name, attached_bound, expected_bound;
    end if;
    return partition_name;
  end if;

  select relkind into squatter_relkind
  from pg_catalog.pg_class
  where relname = partition_name
    and relnamespace = 'public'::pg_catalog.regnamespace;
  if squatter_relkind is not null then
    raise exception
      'relation % exists but is not a partition of audit_events',
      partition_name;
  end if;

  execute format(
    'create table public.%I (like public.audit_events including defaults)',
    partition_name
  );

  -- Only the default partition can hold rows for a range no partition covers,
  -- so this moves exactly those rows. If the range does overlap an existing
  -- partition the attach below fails and the whole statement rolls back, which
  -- undoes the move with it.
  execute format(
    'with moved as (
       delete from public.audit_events
       where occurred_at >= %L::timestamptz and occurred_at < %L::timestamptz
       returning *
     )
     insert into public.%I select * from moved',
    range_start,
    range_end,
    partition_name
  );

  execute format(
    'alter table public.audit_events attach partition public.%I
       for values from (%L::timestamptz) to (%L::timestamptz)',
    partition_name,
    range_start,
    range_end
  );

  return partition_name;
end;
$$;
