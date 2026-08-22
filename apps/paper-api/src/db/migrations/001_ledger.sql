-- Skipjack paper-trading ledger.
--
-- Every decimal amount is `numeric` so money and quantities never touch binary
-- floating point, and every optimistically-locked row carries `version bigint`.
-- Session-owned ledger rows cascade on session expiry; audit history does not,
-- because it references the session pseudonymously instead of by foreign key.

create table markets (
  code text primary key check (code in ('KR', 'US')),
  base_currency text not null check (base_currency in ('KRW', 'USD')),
  time_zone text not null
);

insert into markets (code, base_currency, time_zone)
values
  ('KR', 'KRW', 'Asia/Seoul'),
  ('US', 'USD', 'America/New_York');

create table anonymous_sessions (
  id uuid primary key,
  token_hash text not null unique,
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'EXPIRED', 'REVOKED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  version bigint not null default 0
);

create table wallets (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  currency text not null check (currency in ('KRW', 'USD')),
  -- `total >= 0` is implied by the composition check below plus the two
  -- component floors, and is kept deliberately: it states the invariant at the
  -- column, and it survives on its own if a later migration ever adds a third
  -- component bucket and relaxes the composition check. Being redundant, it
  -- cannot be violated in isolation, so it has no isolating negative test.
  total numeric not null check (total >= 0),
  available numeric not null check (available >= 0),
  reserved numeric not null check (reserved >= 0),
  version bigint not null default 0,
  unique (session_id, currency),
  check (total = available + reserved)
);

create table positions (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  market_code text not null references markets(code),
  symbol text not null check (length(symbol) > 0),
  -- Redundant floor, kept for the same reason as wallets.total.
  total_quantity numeric not null check (total_quantity >= 0),
  available_quantity numeric not null check (available_quantity >= 0),
  reserved_quantity numeric not null check (reserved_quantity >= 0),
  average_cost numeric not null check (average_cost >= 0),
  version bigint not null default 0,
  unique (session_id, market_code, symbol),
  check (total_quantity = available_quantity + reserved_quantity)
);

create table oco_groups (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'RESOLVED')),
  resolved_at timestamptz,
  version bigint not null default 0,
  check ((status = 'RESOLVED') = (resolved_at is not null))
);

create table fee_model_versions (
  id uuid primary key,
  market_code text not null references markets(code),
  version_number bigint not null check (version_number > 0),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED')),
  schedule jsonb not null,
  rounding_mode text not null check (rounding_mode in ('UP', 'DOWN', 'HALF_UP')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  version bigint not null default 0,
  unique (market_code, version_number),
  check ((status = 'PUBLISHED') = (published_at is not null))
);

create table orders (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  market_code text not null references markets(code),
  symbol text not null check (length(symbol) > 0),
  oco_group_id uuid references oco_groups(id) on delete cascade,
  is_oco_winner boolean not null default false,
  order_type text not null check (
    order_type in ('MARKET', 'LIMIT', 'STOP', 'TAKE_PROFIT', 'OCO')
  ),
  side text not null check (side in ('BUY', 'SELL')),
  limit_price numeric check (limit_price > 0),
  stop_price numeric check (stop_price > 0),
  quantity numeric not null check (quantity > 0),
  filled_quantity numeric not null default 0 check (filled_quantity >= 0),
  status text not null check (
    status in (
      'RECEIVED', 'PENDING_TRIGGER', 'TRIGGERED', 'OPEN', 'PARTIALLY_FILLED',
      'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'
    )
  ),
  terminal_reason text,
  market_data_epoch bigint not null default 0 check (market_data_epoch >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version bigint not null default 0,
  check (filled_quantity <= quantity),
  check (not is_oco_winner or oco_group_id is not null),
  check (order_type <> 'MARKET' or (limit_price is null and stop_price is null)),
  check (order_type <> 'LIMIT' or limit_price is not null),
  check (order_type not in ('STOP', 'TAKE_PROFIT') or stop_price is not null)
);

-- One winner per OCO group, enforced by the schema rather than by application code.
create unique index orders_one_oco_winner_per_group
  on orders (oco_group_id)
  where is_oco_winner;

create index orders_session_status_idx on orders (session_id, status);

create table fills (
  id uuid primary key,
  order_id uuid not null references orders(id) on delete cascade,
  price numeric not null check (price > 0),
  quantity numeric not null check (quantity > 0),
  fee numeric not null check (fee >= 0),
  slippage numeric not null,
  reference_trade_price numeric check (reference_trade_price > 0),
  reference_trade_at timestamptz,
  book_level_price numeric check (book_level_price > 0),
  book_level_volume numeric check (book_level_volume >= 0),
  recovery_epoch bigint not null default 0 check (recovery_epoch >= 0),
  market_data_version bigint not null default 0 check (market_data_version >= 0),
  leader_fencing_token bigint not null default 0 check (leader_fencing_token >= 0),
  fee_model_version_id uuid references fee_model_versions(id),
  is_recovery_fill boolean not null default false,
  occurred_at timestamptz not null default now()
);

create index fills_order_idx on fills (order_id, occurred_at);

create table reservations (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  order_id uuid references orders(id) on delete cascade,
  oco_group_id uuid references oco_groups(id) on delete cascade,
  kind text not null check (kind in ('CASH', 'POSITION')),
  currency text check (currency in ('KRW', 'USD')),
  market_code text references markets(code),
  symbol text,
  amount numeric not null check (amount >= 0),
  released boolean not null default false,
  version bigint not null default 0,
  check ((order_id is null) <> (oco_group_id is null)),
  check ((kind = 'CASH') = (currency is not null)),
  check ((kind = 'POSITION') = (symbol is not null and market_code is not null))
);

create table idempotency_requests (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  idempotency_key text not null check (length(idempotency_key) > 0),
  request_hash text not null,
  status text not null check (status in ('IN_PROGRESS', 'COMPLETED')),
  response_status_code integer check (response_status_code between 100 and 599),
  response_body jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (session_id, idempotency_key),
  check ((status = 'COMPLETED') = (response_status_code is not null))
);

create table safety_incidents (
  id uuid primary key,
  scope_type text not null check (
    scope_type in ('GLOBAL', 'MARKET', 'SYMBOL', 'ACCOUNT', 'LOCAL')
  ),
  scope_id text,
  source text not null check (source in ('AUTOMATIC', 'MANUAL')),
  cause_code text not null,
  reason text not null,
  blocked_capabilities text[] not null default '{}',
  recovery_epoch bigint not null default 0 check (recovery_epoch >= 0),
  owner_fencing_token bigint not null default 0 check (owner_fencing_token >= 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'RESOLVED')),
  activated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  version bigint not null default 0,
  check ((scope_type in ('GLOBAL', 'LOCAL')) = (scope_id is null)),
  check ((status = 'RESOLVED') = (resolved_at is not null))
);

create table outbox_events (
  id uuid primary key,
  event_id uuid not null unique,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  stream_sequence bigint not null check (stream_sequence > 0),
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (session_id, stream_sequence)
);

create table account_sequences (
  id uuid primary key,
  session_id uuid not null references anonymous_sessions(id) on delete cascade,
  account_sequence bigint not null check (account_sequence > 0),
  mutation_kind text not null,
  assigned_at timestamptz not null default now(),
  unique (session_id, account_sequence)
);

create table market_states (
  id uuid primary key,
  market_code text not null references markets(code),
  symbol text,
  health_state text not null check (
    health_state in ('NORMAL', 'LOSSY', 'RECOVERING', 'UNAVAILABLE')
  ),
  recovery_epoch bigint not null default 0 check (recovery_epoch >= 0),
  market_data_version bigint not null default 0 check (market_data_version >= 0),
  observed_at timestamptz not null default now(),
  version bigint not null default 0
);

create unique index market_states_scope_idx
  on market_states (market_code, coalesce(symbol, ''));

create table leader_epochs (
  id uuid primary key,
  market_code text not null unique references markets(code),
  epoch bigint not null check (epoch >= 0),
  fencing_token bigint not null check (fencing_token >= 0),
  leader_id text not null,
  acquired_at timestamptz not null default now(),
  version bigint not null default 0
);

create table capacity_counters (
  id uuid primary key,
  scope_type text not null check (scope_type in ('GLOBAL', 'SESSION')),
  scope_id text not null,
  active_leg_count integer not null default 0 check (active_leg_count >= 0),
  max_active_legs integer not null check (max_active_legs > 0),
  version bigint not null default 0,
  unique (scope_type, scope_id),
  check (active_leg_count <= max_active_legs)
);

create table market_sessions (
  id uuid primary key,
  market_code text not null references markets(code),
  session_date date not null,
  phase text not null check (
    phase in ('CLOSED', 'PRE_OPEN', 'REGULAR', 'POST_CLOSE', 'HOLIDAY')
  ),
  opens_at timestamptz,
  closes_at timestamptz,
  version bigint not null default 0,
  unique (market_code, session_date),
  check (opens_at is null or closes_at is null or opens_at < closes_at)
);

create table whitelist_versions (
  id uuid primary key,
  version_number bigint not null unique check (version_number > 0),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'PUBLISHED')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  version bigint not null default 0,
  check ((status = 'PUBLISHED') = (published_at is not null))
);

create table whitelist_entries (
  id uuid primary key,
  whitelist_version_id uuid not null
    references whitelist_versions(id) on delete cascade,
  market_code text not null references markets(code),
  symbol text not null check (length(symbol) > 0),
  tradability text not null default 'NORMAL'
    check (tradability in ('NORMAL', 'CANCEL_ONLY')),
  unique (whitelist_version_id, market_code, symbol)
);

-- A published version is an immutable operational record: only the
-- DRAFT -> PUBLISHED transition may still touch the row.
--
-- Every guard below pins `search_path = public, pg_temp` and schema-qualifies
-- the tables it reads. That is load-bearing, not cosmetic: when pg_temp is not
-- named in the path PostgreSQL searches the session's temporary schema for
-- relation names *first*, ahead of pg_catalog and ahead of every named schema,
-- and TEMPORARY on a database is granted to PUBLIC. An unpinned guard that
-- names `whitelist_versions` therefore reads whatever the writer just put in
-- pg_temp, so `create temp table whitelist_versions (...)` disarms it in one
-- statement — from a NOSUPERUSER role that cannot drop the trigger. Naming
-- pg_temp last demotes it to the end of the path; pg_catalog stays implicitly
-- first because it is not named. Note that `search_path = pg_catalog, public`
-- would NOT close this: leaving pg_temp unnamed still puts it first.
--
-- All of these are SECURITY INVOKER (the default) on purpose. They guard rows
-- the caller is already writing and read no more than the caller may read, so
-- definer rights would buy nothing and would instead expose the owner's rights
-- — including the dynamic SQL in reject_truncate_of_published_versions() — to
-- every role holding EXECUTE. Definer rights are also not what closes the hole
-- above; the pinned path is.
create function reject_published_version_change() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'PUBLISHED' then
    raise exception 'published % rows are immutable', tg_table_name;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger whitelist_versions_published_is_immutable
  before update or delete on whitelist_versions
  for each row execute function reject_published_version_change();

create trigger fee_model_versions_published_is_immutable
  before update or delete on fee_model_versions
  for each row execute function reject_published_version_change();

-- An entry's membership belongs to its version, so BOTH parents of a row
-- change matter: reparenting an entry away from a published version removes it
-- from that version's operational record just as surely as reparenting one into
-- a published version adds to it. Checking only NEW would leave the move-out
-- direction open.
--
-- fee_model_versions needs no counterpart: it owns no child table, so nothing
-- can be reparented out of a published fee model. Its only inbound reference is
-- fills.fee_model_version_id, and which fee model a fill was priced with is a
-- property of the fill, not part of the version's definition.
create function reject_published_whitelist_entry_change() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  old_version uuid;
  new_version uuid;
  published_parents bigint;
begin
  if tg_op <> 'INSERT' then
    old_version := old.whitelist_version_id;
  end if;
  if tg_op <> 'DELETE' then
    new_version := new.whitelist_version_id;
  end if;

  select count(*) into published_parents
  from public.whitelist_versions
  where status = 'PUBLISHED'
    and (id = old_version or id = new_version);

  if published_parents > 0 then
    raise exception 'entries of a published whitelist version are immutable';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger whitelist_entries_published_is_immutable
  before insert or update or delete on whitelist_entries
  for each row execute function reject_published_whitelist_entry_change();

-- Row triggers are DML-only, so TRUNCATE would otherwise erase a published
-- version and its entries without ever consulting the rules above. Statement
-- triggers close that path; TRUNCATE stays available while nothing is
-- published, which is what a draft-only environment needs.
create function reject_truncate_of_published_versions() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  has_published boolean;
begin
  -- tg_relid::regclass names the table the trigger actually fired on, so the
  -- probe cannot be retargeted even by a name that resolves elsewhere.
  execute format(
    'select exists (select 1 from %s where status = %L)',
    tg_relid::regclass,
    'PUBLISHED'
  ) into has_published;
  if has_published then
    raise exception 'published % rows are immutable', tg_table_name;
  end if;
  return null;
end;
$$;

create function reject_truncate_of_published_whitelist_entries()
  returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (
    select 1
    from public.whitelist_entries as entry
    join public.whitelist_versions as version
      on version.id = entry.whitelist_version_id
    where version.status = 'PUBLISHED'
  ) then
    raise exception 'entries of a published whitelist version are immutable';
  end if;
  return null;
end;
$$;

create trigger whitelist_versions_published_survives_truncate
  before truncate on whitelist_versions
  for each statement execute function reject_truncate_of_published_versions();

create trigger fee_model_versions_published_survives_truncate
  before truncate on fee_model_versions
  for each statement execute function reject_truncate_of_published_versions();

create trigger whitelist_entries_published_survives_truncate
  before truncate on whitelist_entries
  for each statement
  execute function reject_truncate_of_published_whitelist_entries();

-- Audit history outlives the session it describes, so it stores a pseudonymous
-- session reference and deliberately carries no foreign key to
-- anonymous_sessions or orders: session expiry must not delete audit rows.
create table audit_events (
  id uuid not null,
  session_reference text,
  order_id uuid,
  event_type text not null,
  payload jsonb not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (id, occurred_at)
) partition by range (occurred_at);
