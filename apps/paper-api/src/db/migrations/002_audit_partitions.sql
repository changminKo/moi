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

create function ensure_audit_partition(month_start date) returns text
language plpgsql as $$
declare
  range_start date := date_trunc('month', month_start)::date;
  range_end date := (date_trunc('month', month_start) + interval '1 month')::date;
  partition_name text := 'audit_events_' || to_char(range_start, 'YYYY_MM');
begin
  if exists (
    select 1
    from pg_class
    where relname = partition_name
      and relnamespace = 'public'::regnamespace
  ) then
    return partition_name;
  end if;

  begin
    execute format(
      'create table %I partition of audit_events for values from (%L) to (%L)',
      partition_name,
      range_start,
      range_end
    );
  exception
    when duplicate_table then
      null;
  end;

  return partition_name;
end;
$$;
