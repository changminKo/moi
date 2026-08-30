import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.js';
import { ensureAuditPartitions, migrateToLatest } from './migrate.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const IDLE_ERROR_WAIT_MS = 250;

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const RAISE_EXCEPTION = 'P0001';

const LEDGER_TABLES = [
  'account_sequences',
  'anonymous_sessions',
  'audit_events',
  'audit_events_default',
  'capacity_counters',
  'fee_model_versions',
  'fills',
  'idempotency_requests',
  'leader_epochs',
  'market_sessions',
  'market_states',
  'markets',
  'oco_groups',
  'orders',
  'outbox_events',
  'positions',
  'reservations',
  'safety_incidents',
  'wallets',
  'whitelist_entries',
  'whitelist_versions',
];

// Every table whose rows are updated in place carries `version` for optimistic
// locking. The append-only tables (fills, outbox_events, account_sequences,
// idempotency_requests, whitelist_entries, audit_events, markets) do not.
const VERSION_TABLES = [
  'anonymous_sessions',
  'capacity_counters',
  'fee_model_versions',
  'leader_epochs',
  'market_sessions',
  'market_states',
  'oco_groups',
  'orders',
  'positions',
  'reservations',
  'safety_incidents',
  'wallets',
  'whitelist_versions',
];

const DECIMAL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['wallets', 'total'],
  ['wallets', 'available'],
  ['wallets', 'reserved'],
  ['positions', 'total_quantity'],
  ['positions', 'available_quantity'],
  ['positions', 'reserved_quantity'],
  ['positions', 'average_cost'],
  ['orders', 'quantity'],
  ['orders', 'filled_quantity'],
  ['orders', 'limit_price'],
  ['orders', 'stop_price'],
  ['fills', 'price'],
  ['fills', 'quantity'],
  ['fills', 'fee'],
  ['fills', 'slippage'],
  ['reservations', 'amount'],
];

let container: StartedPostgreSqlContainer;
let containerStartupMs = 0;
let db: Database;

interface PostgresError {
  readonly code: string;
  readonly message: string;
}

async function expectPostgresError(
  operation: Promise<unknown>,
  code: string,
): Promise<PostgresError> {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught as PostgresError,
  );
  if (error === undefined) {
    throw new Error(`expected the statement to fail with SQLSTATE ${code}`);
  }
  expect(error.code).toBe(code);
  return error;
}

async function insertSession(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into anonymous_sessions (id, token_hash, status, expires_at)
    values (${id}, ${`token-hash-${id}`}, 'ACTIVE', now() + interval '1 hour')
  `.execute(db);
  return id;
}

async function insertWallet(
  sessionId: string,
  currency: 'KRW' | 'USD',
  total: string,
  available: string,
  reserved: string,
): Promise<void> {
  await sql`
    insert into wallets (id, session_id, currency, total, available, reserved)
    values (${randomUUID()}, ${sessionId}, ${currency}, ${total}, ${available}, ${reserved})
  `.execute(db);
}

async function insertPosition(
  sessionId: string,
  symbol: string,
): Promise<void> {
  await sql`
    insert into positions (
      id, session_id, market_code, symbol,
      total_quantity, available_quantity, reserved_quantity, average_cost
    ) values (
      ${randomUUID()}, ${sessionId}, 'US', ${symbol}, '5', '5', '0', '190'
    )
  `.execute(db);
}

async function insertOcoGroup(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into oco_groups (id, session_id) values (${id}, ${sessionId})
  `.execute(db);
  return id;
}

interface OrderOverrides {
  readonly marketCode?: string;
  readonly ocoGroupId?: string | null;
  readonly isOcoWinner?: boolean;
  readonly quantity?: string;
  readonly filledQuantity?: string;
}

async function insertOrder(
  sessionId: string,
  overrides: OrderOverrides = {},
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into orders (
      id, session_id, market_code, symbol, oco_group_id, is_oco_winner,
      order_type, side, limit_price, quantity, filled_quantity, status
    ) values (
      ${id}, ${sessionId}, ${overrides.marketCode ?? 'US'}, 'AAPL',
      ${overrides.ocoGroupId ?? null}, ${overrides.isOcoWinner ?? false},
      'LIMIT', 'BUY', '190.25', ${overrides.quantity ?? '10'},
      ${overrides.filledQuantity ?? '0'}, 'OPEN'
    )
  `.execute(db);
  return id;
}

async function insertWhitelistVersion(
  versionNumber: number,
  published: boolean,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into whitelist_versions (id, version_number, status, published_at)
    values (
      ${id}, ${versionNumber},
      ${published ? 'PUBLISHED' : 'DRAFT'},
      ${published ? sql`now()` : sql`null`}
    )
  `.execute(db);
  return id;
}

async function insertWhitelistEntry(
  versionId: string,
  symbol: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into whitelist_entries (
      id, whitelist_version_id, market_code, symbol
    ) values (${id}, ${versionId}, 'US', ${symbol})
  `.execute(db);
  return id;
}

async function publishWhitelistVersion(versionId: string): Promise<void> {
  await sql`
    update whitelist_versions set status = 'PUBLISHED', published_at = now()
    where id = ${versionId}
  `.execute(db);
}

async function entryCount(versionId: string): Promise<string> {
  const result = await sql<{ count: string }>`
    select count(*) as count from whitelist_entries
    where whitelist_version_id = ${versionId}
  `.execute(db);
  return result.rows[0]?.count ?? '0';
}

async function insertFeeModelVersion(
  versionNumber: number,
  published: boolean,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into fee_model_versions (
      id, market_code, version_number, status, schedule, rounding_mode, published_at
    ) values (
      ${id}, 'US', ${versionNumber},
      ${published ? 'PUBLISHED' : 'DRAFT'},
      ${JSON.stringify({ commissionRate: '0.0007' })}::jsonb,
      'HALF_UP',
      ${published ? sql`now()` : sql`null`}
    )
  `.execute(db);
  return id;
}

async function tableNames(target: Database): Promise<readonly string[]> {
  const result = await sql<{ table_name: string }>`
    select table_name from information_schema.tables where table_schema = 'public'
  `.execute(target);
  return result.rows.map((row) => row.table_name);
}

async function partitionNames(target: Database): Promise<readonly string[]> {
  const result = await sql<{ relname: string }>`
    select child.relname
    from pg_inherits
    join pg_class as parent on parent.oid = pg_inherits.inhparent
    join pg_class as child on child.oid = pg_inherits.inhrelid
    where parent.relname = 'audit_events'
    order by child.relname
  `.execute(target);
  return result.rows.map((row) => row.relname);
}

async function createEmptyDatabase(timeZone?: string): Promise<{
  readonly db: Database;
  readonly destroy: () => Promise<void>;
}> {
  const name = `ledger_${randomUUID().replaceAll('-', '')}`;
  await sql`create database ${sql.id(name)}`.execute(db);
  if (timeZone !== undefined) {
    await sql
      .raw(`alter database "${name}" set "TimeZone" = '${timeZone}'`)
      .execute(db);
  }
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${name}`;
  const fresh = createDatabase(uri.toString());
  return { db: fresh, destroy: () => fresh.destroy() };
}

async function partitionBounds(
  target: Database,
): Promise<ReadonlyArray<readonly [string, string]>> {
  return await target.transaction().execute(async (trx) => {
    await sql`set local time zone 'UTC'`.execute(trx);
    const result = await sql<{ relname: string; bound: string }>`
      select child.relname, pg_get_expr(child.relpartbound, child.oid) as bound
      from pg_inherits
      join pg_class as parent on parent.oid = pg_inherits.inhparent
      join pg_class as child on child.oid = pg_inherits.inhrelid
      where parent.relname = 'audit_events'
      order by child.relname
    `.execute(trx);
    return result.rows.map((row) => [row.relname, row.bound] as const);
  });
}

async function ensurePartitionUnderTimeZone(
  target: Database,
  timeZone: string,
  month: string,
): Promise<string> {
  return await target.transaction().execute(async (trx) => {
    await sql.raw(`set local time zone '${timeZone}'`).execute(trx);
    const result = await sql<{ name: string }>`
      select ensure_audit_partition(${month}::date) as name
    `.execute(trx);
    return result.rows[0]?.name ?? '';
  });
}

async function insertAuditEvent(
  target: Database,
  id: string,
  occurredAt: string,
): Promise<void> {
  await sql`
    insert into audit_events (
      id, session_reference, event_type, payload, occurred_at
    ) values (
      ${id}, ${`pseudonym-${id}`}, 'ORDER_ACCEPTED',
      ${JSON.stringify({ id })}::jsonb, ${occurredAt}
    )
  `.execute(target);
}

async function partitionIndexSuffixes(
  target: Database,
  table: string,
): Promise<readonly string[]> {
  const result = await sql<{ indexname: string }>`
    select indexname from pg_indexes
    where tablename = ${table} order by indexname
  `.execute(target);
  return result.rows.map((row) => row.indexname.replace(`${table}_`, ''));
}

async function auditPartitionOf(
  target: Database,
  id: string,
): Promise<string | undefined> {
  const result = await sql<{ partition: string }>`
    select tableoid::regclass::text as partition
    from audit_events where id = ${id}
  `.execute(target);
  return result.rows[0]?.partition;
}

function monthPartitionName(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  return `audit_events_${year}_${month}`;
}

beforeAll(async () => {
  const startedAt = Date.now();
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  containerStartupMs = Date.now() - startedAt;
  db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
  if (containerStartupMs > 0) {
    console.log(`postgres:17-alpine startup: ${containerStartupMs}ms`);
  }
});

describe('createDatabase', () => {
  it(
    'reports a terminated idle backend instead of crashing the process',
    async () => {
      const reported: Error[] = [];
      const fresh = createDatabase(container.getConnectionUri(), (error) => {
        reported.push(error);
      });
      try {
        const backend = await sql<{ pid: number }>`
          select pg_backend_pid() as pid
        `.execute(fresh);
        const pid = backend.rows[0]?.pid;
        expect(typeof pid).toBe('number');

        await sql`select pg_terminate_backend(${pid})`.execute(db);
        await new Promise((resolve) => setTimeout(resolve, IDLE_ERROR_WAIT_MS));

        expect(reported.map((error) => error.message)).toEqual([
          'terminating connection due to administrator command',
        ]);

        const after = await sql<{ ok: number }>`select 1 as ok`.execute(fresh);
        expect(after.rows[0]?.ok).toBe(1);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('ledger migration', () => {
  it(
    'runs against PostgreSQL 17',
    async () => {
      const version = await sql<{ server_version: string }>`
        show server_version
      `.execute(db);
      expect(version.rows[0]?.server_version).toMatch(/^17\./);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates every ledger table on an empty PostgreSQL 17 database',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        expect(await tableNames(fresh.db)).toEqual([]);

        const results = await migrateToLatest(fresh.db);
        expect(results.map((result) => result.migrationName)).toEqual([
          '001_ledger',
          '002_audit_partitions',
          '003_leader_release',
          '004_fill_history',
          '005_fill_history_backfill',
          '006_fill_history_indexes',
          '007_fill_history_validate',
        ]);
        expect(results.map((result) => result.status)).toEqual(
          results.map(() => 'Success'),
        );

        expect(await tableNames(fresh.db)).toEqual(
          expect.arrayContaining([...LEDGER_TABLES]),
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is idempotent when the migrations are already applied',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);

        const results = await migrateToLatest(fresh.db);
        expect(results).toEqual([]);

        const applied = await sql<{ name: string }>`
          select name from kysely_migration order by name
        `.execute(fresh.db);
        expect(applied.rows.map((row) => row.name)).toEqual([
          '001_ledger',
          '002_audit_partitions',
          '003_leader_release',
          '004_fill_history',
          '005_fill_history_backfill',
          '006_fill_history_indexes',
          '007_fill_history_validate',
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'stores every decimal field as numeric and every version as bigint',
    async () => {
      const columns = await sql<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>`
        select table_name, column_name, data_type
        from information_schema.columns
        where table_schema = 'public'
      `.execute(db);

      for (const [table, column] of DECIMAL_COLUMNS) {
        const found = columns.rows.find(
          (row) => row.table_name === table && row.column_name === column,
        );
        expect(found, `${table}.${column}`).toBeDefined();
        expect(found?.data_type, `${table}.${column}`).toBe('numeric');
      }

      const inexact = columns.rows.filter(
        (row) =>
          row.data_type === 'double precision' || row.data_type === 'real',
      );
      expect(inexact).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives every optimistically locked table a non-null bigint version',
    async () => {
      const result = await sql<{
        table_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>`
        select table_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and column_name = 'version'
        order by table_name
      `.execute(db);
      expect(result.rows).toEqual(
        VERSION_TABLES.map((table) => ({
          table_name: table,
          data_type: 'bigint',
          is_nullable: 'NO',
          column_default: '0',
        })),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a second position for the same session, market and symbol',
    async () => {
      const sessionId = await insertSession();
      await insertPosition(sessionId, 'AAPL');
      await expectPostgresError(
        insertPosition(sessionId, 'AAPL'),
        UNIQUE_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps full decimal precision for money amounts',
    async () => {
      const sessionId = await insertSession();
      await insertWallet(
        sessionId,
        'KRW',
        '12345678901234.123456789',
        '12345678901234.123456789',
        '0',
      );
      const stored = await sql<{ total: string }>`
        select total from wallets where session_id = ${sessionId}
      `.execute(db);
      expect(stored.rows[0]?.total).toBe('12345678901234.123456789');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('migrateToLatest failure', () => {
  it(
    'surfaces a migration failure and leaves no ledger table behind',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await sql`create table markets (code text primary key)`.execute(
          fresh.db,
        );

        await expect(migrateToLatest(fresh.db)).rejects.toThrow(/markets/);

        const remaining = (await tableNames(fresh.db)).filter(
          (name) => name !== 'markets' && !name.startsWith('kysely_migration'),
        );
        expect(remaining).toEqual([]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('ledger constraints', () => {
  it(
    'rejects a second wallet for the same session and currency',
    async () => {
      const sessionId = await insertSession();
      await insertWallet(sessionId, 'KRW', '100', '100', '0');
      await expectPostgresError(
        insertWallet(sessionId, 'KRW', '50', '50', '0'),
        UNIQUE_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a wallet whose total is not available plus reserved',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        insertWallet(sessionId, 'USD', '100', '60', '30'),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects negative wallet balances',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        insertWallet(sessionId, 'USD', '-10', '-10', '0'),
        CHECK_VIOLATION,
      );
      await expectPostgresError(
        insertWallet(sessionId, 'USD', '0', '10', '-10'),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a position whose total is not available plus reserved',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        sql`
          insert into positions (
            id, session_id, market_code, symbol,
            total_quantity, available_quantity, reserved_quantity, average_cost
          ) values (
            ${randomUUID()}, ${sessionId}, 'US', 'AAPL', '10', '4', '4', '190'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects negative position quantities',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        sql`
          insert into positions (
            id, session_id, market_code, symbol,
            total_quantity, available_quantity, reserved_quantity, average_cost
          ) values (
            ${randomUUID()}, ${sessionId}, 'US', 'AAPL', '0', '-5', '5', '190'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an order that refers to an unknown market',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        insertOrder(sessionId, { marketCode: 'XX' }),
        FOREIGN_KEY_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a whitelist entry that refers to an unknown market',
    async () => {
      const versionId = await insertWhitelistVersion(101, false);
      await expectPostgresError(
        sql`
          insert into whitelist_entries (
            id, whitelist_version_id, market_code, symbol
          ) values (${randomUUID()}, ${versionId}, 'XX', 'AAPL')
        `.execute(db),
        FOREIGN_KEY_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a second winner in the same OCO group',
    async () => {
      const sessionId = await insertSession();
      const groupId = await insertOcoGroup(sessionId);
      await insertOrder(sessionId, { ocoGroupId: groupId, isOcoWinner: true });
      await expectPostgresError(
        insertOrder(sessionId, { ocoGroupId: groupId, isOcoWinner: true }),
        UNIQUE_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'allows at most one winner but many losing legs in a group',
    async () => {
      const sessionId = await insertSession();
      const groupId = await insertOcoGroup(sessionId);
      await insertOrder(sessionId, { ocoGroupId: groupId, isOcoWinner: false });
      await insertOrder(sessionId, { ocoGroupId: groupId, isOcoWinner: false });
      await insertOrder(sessionId, { ocoGroupId: groupId, isOcoWinner: true });
      const winners = await sql<{ count: string }>`
        select count(*) as count from orders
        where oco_group_id = ${groupId} and is_oco_winner
      `.execute(db);
      expect(winners.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an OCO winner flag on an order without a group',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        insertOrder(sessionId, { isOcoWinner: true }),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects an order filled beyond its quantity',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        insertOrder(sessionId, { quantity: '10', filledQuantity: '11' }),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a market order that carries a limit price',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        sql`
          insert into orders (
            id, session_id, market_code, symbol, order_type, side,
            limit_price, quantity, status
          ) values (
            ${randomUUID()}, ${sessionId}, 'US', 'AAPL', 'MARKET', 'BUY',
            '190.25', '10', 'OPEN'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a limit order without a limit price',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        sql`
          insert into orders (
            id, session_id, market_code, symbol, order_type, side,
            quantity, status
          ) values (
            ${randomUUID()}, ${sessionId}, 'US', 'AAPL', 'LIMIT', 'BUY',
            '10', 'OPEN'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a duplicate idempotency key for one session',
    async () => {
      const sessionId = await insertSession();
      const insert = (hash: string) =>
        sql`
        insert into idempotency_requests (
          id, session_id, idempotency_key, request_hash, status
        ) values (
          ${randomUUID()}, ${sessionId}, 'key-1', ${hash}, 'IN_PROGRESS'
        )
      `.execute(db);
      await insert('hash-a');
      await expectPostgresError(insert('hash-b'), UNIQUE_VIOLATION);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a completed idempotency record without a status code',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        sql`
          insert into idempotency_requests (
            id, session_id, idempotency_key, request_hash, status
          ) values (
            ${randomUUID()}, ${sessionId}, 'key-2', 'hash', 'COMPLETED'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a duplicate outbox event id',
    async () => {
      const first = await insertSession();
      const second = await insertSession();
      const eventId = randomUUID();
      const insert = (sessionId: string, streamSequence: number) =>
        sql`
        insert into outbox_events (
          id, event_id, session_id, stream_sequence, event_type, payload
        ) values (
          ${randomUUID()}, ${eventId}, ${sessionId}, ${streamSequence},
          'ORDER_ACCEPTED', '{}'::jsonb
        )
      `.execute(db);
      await insert(first, 1);
      await expectPostgresError(insert(second, 1), UNIQUE_VIOLATION);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a duplicate session stream sequence',
    async () => {
      const sessionId = await insertSession();
      const insert = () =>
        sql`
        insert into outbox_events (
          id, event_id, session_id, stream_sequence, event_type, payload
        ) values (
          ${randomUUID()}, ${randomUUID()}, ${sessionId}, 7,
          'ORDER_ACCEPTED', '{}'::jsonb
        )
      `.execute(db);
      await insert();
      await expectPostgresError(insert(), UNIQUE_VIOLATION);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a duplicate account sequence for one session',
    async () => {
      const sessionId = await insertSession();
      const insert = () =>
        sql`
        insert into account_sequences (
          id, session_id, account_sequence, mutation_kind
        ) values (${randomUUID()}, ${sessionId}, 3, 'ORDER_ACCEPTED')
      `.execute(db);
      await insert();
      await expectPostgresError(insert(), UNIQUE_VIOLATION);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a reservation with a negative amount',
    async () => {
      const sessionId = await insertSession();
      const orderId = await insertOrder(sessionId);
      await expectPostgresError(
        sql`
          insert into reservations (
            id, session_id, order_id, kind, currency, amount
          ) values (
            ${randomUUID()}, ${sessionId}, ${orderId}, 'CASH', 'USD', '-1'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a reservation that belongs to neither an order nor an OCO group',
    async () => {
      const sessionId = await insertSession();
      await expectPostgresError(
        sql`
          insert into reservations (id, session_id, kind, currency, amount)
          values (${randomUUID()}, ${sessionId}, 'CASH', 'USD', '10')
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects capacity counters above their configured ceiling',
    async () => {
      await expectPostgresError(
        sql`
          insert into capacity_counters (
            id, scope_type, scope_id, active_leg_count, max_active_legs
          ) values (${randomUUID()}, 'GLOBAL', 'global', 10001, 10000)
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a resolved safety incident without a resolution timestamp',
    async () => {
      await expectPostgresError(
        sql`
          insert into safety_incidents (
            id, scope_type, scope_id, source, cause_code, reason, status
          ) values (
            ${randomUUID()}, 'MARKET', 'US', 'AUTOMATIC', 'FEED_DOWN',
            'websocket closed', 'RESOLVED'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a market session whose close precedes its open',
    async () => {
      await expectPostgresError(
        sql`
          insert into market_sessions (
            id, market_code, session_date, phase, opens_at, closes_at
          ) values (
            ${randomUUID()}, 'US', '2026-08-24', 'REGULAR',
            '2026-08-24T20:00:00Z', '2026-08-24T13:30:00Z'
          )
        `.execute(db),
        CHECK_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects a leader epoch for an unknown market',
    async () => {
      await expectPostgresError(
        sql`
          insert into leader_epochs (
            id, market_code, epoch, fencing_token, leader_id
          ) values (${randomUUID()}, 'XX', 1, 1, 'leader-a')
        `.execute(db),
        FOREIGN_KEY_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rejects market state for an unknown market',
    async () => {
      await expectPostgresError(
        sql`
          insert into market_states (
            id, market_code, symbol, health_state
          ) values (${randomUUID()}, 'XX', 'AAPL', 'NORMAL')
        `.execute(db),
        FOREIGN_KEY_VIOLATION,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe('published version immutability', () => {
  it(
    'refuses to update a published whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(201, true);
      const error = await expectPostgresError(
        sql`
          update whitelist_versions set status = 'DRAFT' where id = ${versionId}
        `.execute(db),
        RAISE_EXCEPTION,
      );
      expect(error.message).toMatch(/immutable/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to delete a published whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(202, true);
      await expectPostgresError(
        sql`delete from whitelist_versions where id = ${versionId}`.execute(db),
        RAISE_EXCEPTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to add an entry to a published whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(203, true);
      await expectPostgresError(
        sql`
          insert into whitelist_entries (
            id, whitelist_version_id, market_code, symbol
          ) values (${randomUUID()}, ${versionId}, 'US', 'AAPL')
        `.execute(db),
        RAISE_EXCEPTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to change an entry of a published whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(204, false);
      const entryId = randomUUID();
      await sql`
        insert into whitelist_entries (
          id, whitelist_version_id, market_code, symbol
        ) values (${entryId}, ${versionId}, 'US', 'AAPL')
      `.execute(db);
      await sql`
        update whitelist_versions set status = 'PUBLISHED', published_at = now()
        where id = ${versionId}
      `.execute(db);
      await expectPostgresError(
        sql`
          update whitelist_entries set tradability = 'CANCEL_ONLY'
          where id = ${entryId}
        `.execute(db),
        RAISE_EXCEPTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still allows publishing a draft whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(205, false);
      await sql`
        update whitelist_versions set status = 'PUBLISHED', published_at = now()
        where id = ${versionId}
      `.execute(db);
      const stored = await sql<{ status: string }>`
        select status from whitelist_versions where id = ${versionId}
      `.execute(db);
      expect(stored.rows[0]?.status).toBe('PUBLISHED');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to update or delete a published fee model version',
    async () => {
      const versionId = await insertFeeModelVersion(301, true);
      await expectPostgresError(
        sql`
          update fee_model_versions set rounding_mode = 'DOWN'
          where id = ${versionId}
        `.execute(db),
        RAISE_EXCEPTION,
      );
      await expectPostgresError(
        sql`delete from fee_model_versions where id = ${versionId}`.execute(db),
        RAISE_EXCEPTION,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to move an entry out of a published whitelist version',
    async () => {
      const publishedId = await insertWhitelistVersion(210, false);
      const draftId = await insertWhitelistVersion(211, false);
      const entryId = await insertWhitelistEntry(publishedId, 'AAPL');
      await insertWhitelistEntry(publishedId, 'MSFT');
      await publishWhitelistVersion(publishedId);
      expect(await entryCount(publishedId)).toBe('2');

      await expectPostgresError(
        sql`
          update whitelist_entries set whitelist_version_id = ${draftId}
          where id = ${entryId}
        `.execute(db),
        RAISE_EXCEPTION,
      );
      expect(await entryCount(publishedId)).toBe('2');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to move an entry into a published whitelist version',
    async () => {
      const draftId = await insertWhitelistVersion(212, false);
      const publishedId = await insertWhitelistVersion(213, true);
      const entryId = await insertWhitelistEntry(draftId, 'AAPL');

      await expectPostgresError(
        sql`
          update whitelist_entries set whitelist_version_id = ${publishedId}
          where id = ${entryId}
        `.execute(db),
        RAISE_EXCEPTION,
      );
      expect(await entryCount(publishedId)).toBe('0');
      expect(await entryCount(draftId)).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to delete an entry of a published whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(214, false);
      const entryId = await insertWhitelistEntry(versionId, 'AAPL');
      await publishWhitelistVersion(versionId);

      await expectPostgresError(
        sql`delete from whitelist_entries where id = ${entryId}`.execute(db),
        RAISE_EXCEPTION,
      );
      expect(await entryCount(versionId)).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still allows moving an entry between two draft whitelist versions',
    async () => {
      const sourceId = await insertWhitelistVersion(215, false);
      const targetId = await insertWhitelistVersion(216, false);
      const entryId = await insertWhitelistEntry(sourceId, 'AAPL');

      await sql`
        update whitelist_entries set whitelist_version_id = ${targetId}
        where id = ${entryId}
      `.execute(db);

      expect(await entryCount(sourceId)).toBe('0');
      expect(await entryCount(targetId)).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to truncate whitelist versions while one is published',
    async () => {
      const versionId = await insertWhitelistVersion(217, true);
      // The cascade reaches whitelist_entries, whose own TRUNCATE guard would
      // raise for published entries left by earlier tests and satisfy a
      // message-agnostic assertion even with this trigger removed. Naming the
      // table in the assertion keeps the test tied to this trigger.
      const error = await expectPostgresError(
        sql`truncate whitelist_versions cascade`.execute(db),
        RAISE_EXCEPTION,
      );
      expect(error.message).toBe(
        'published whitelist_versions rows are immutable',
      );
      const survivor = await sql<{ count: string }>`
        select count(*) as count from whitelist_versions where id = ${versionId}
      `.execute(db);
      expect(survivor.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to truncate the entries of a published whitelist version',
    async () => {
      const versionId = await insertWhitelistVersion(218, false);
      await insertWhitelistEntry(versionId, 'AAPL');
      await publishWhitelistVersion(versionId);

      await expectPostgresError(
        sql`truncate whitelist_entries`.execute(db),
        RAISE_EXCEPTION,
      );
      expect(await entryCount(versionId)).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to truncate fee model versions while one is published',
    async () => {
      const versionId = await insertFeeModelVersion(310, true);
      await expectPostgresError(
        sql`truncate fee_model_versions cascade`.execute(db),
        RAISE_EXCEPTION,
      );
      const survivor = await sql<{ count: string }>`
        select count(*) as count from fee_model_versions where id = ${versionId}
      `.execute(db);
      expect(survivor.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still allows publishing a draft fee model version',
    async () => {
      const versionId = await insertFeeModelVersion(302, false);
      await sql`
        update fee_model_versions set status = 'PUBLISHED', published_at = now()
        where id = ${versionId}
      `.execute(db);
      const stored = await sql<{ status: string }>`
        select status from fee_model_versions where id = ${versionId}
      `.execute(db);
      expect(stored.rows[0]?.status).toBe('PUBLISHED');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('audit event retention', () => {
  it(
    'keeps no foreign key from audit events to sessions or orders',
    async () => {
      const constraints = await sql<{ constraint_name: string }>`
        select constraint_name
        from information_schema.table_constraints
        where table_schema = 'public'
          and table_name like 'audit_events%'
          and constraint_type = 'FOREIGN KEY'
      `.execute(db);
      expect(constraints.rows).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cascades session deletion to the ledger and keeps audit history',
    async () => {
      const sessionId = await insertSession();
      const orderId = await insertOrder(sessionId);
      await insertWallet(sessionId, 'USD', '1000', '1000', '0');
      await sql`
        insert into positions (
          id, session_id, market_code, symbol,
          total_quantity, available_quantity, reserved_quantity, average_cost
        ) values (
          ${randomUUID()}, ${sessionId}, 'US', 'AAPL', '5', '5', '0', '190'
        )
      `.execute(db);
      await sql`
        insert into reservations (
          id, session_id, order_id, kind, currency, amount
        ) values (
          ${randomUUID()}, ${sessionId}, ${orderId}, 'CASH', 'USD', '1902.50'
        )
      `.execute(db);
      await sql`
        insert into outbox_events (
          id, event_id, session_id, stream_sequence, event_type, payload
        ) values (
          ${randomUUID()}, ${randomUUID()}, ${sessionId}, 1,
          'ORDER_ACCEPTED', '{}'::jsonb
        )
      `.execute(db);
      await ensureAuditPartitions(db, new Date());
      await sql`
        insert into audit_events (
          id, session_reference, order_id, event_type, payload, occurred_at
        ) values (
          ${randomUUID()}, ${`pseudonym-${sessionId}`}, ${orderId},
          'ORDER_ACCEPTED', '{}'::jsonb, now()
        )
      `.execute(db);

      await sql`
        delete from anonymous_sessions where id = ${sessionId}
      `.execute(db);

      const remaining = await sql<{
        orders: string;
        wallets: string;
        positions: string;
        reservations: string;
        outbox: string;
        audit: string;
      }>`
        select
          (select count(*) from orders where session_id = ${sessionId}) as orders,
          (select count(*) from wallets where session_id = ${sessionId}) as wallets,
          (select count(*) from positions where session_id = ${sessionId}) as positions,
          (select count(*) from reservations where session_id = ${sessionId}) as reservations,
          (select count(*) from outbox_events where session_id = ${sessionId}) as outbox,
          (select count(*) from audit_events where session_reference = ${`pseudonym-${sessionId}`}) as audit
      `.execute(db);
      expect(remaining.rows[0]).toEqual({
        orders: '0',
        wallets: '0',
        positions: '0',
        reservations: '0',
        outbox: '0',
        audit: '1',
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'accepts an audit event whose session reference is unknown',
    async () => {
      await ensureAuditPartitions(db, new Date());
      const reference = `pseudonym-${randomUUID()}`;
      await sql`
        insert into audit_events (
          id, session_reference, event_type, payload, occurred_at
        ) values (
          ${randomUUID()}, ${reference}, 'INCIDENT_ACTIVATED', '{}'::jsonb, now()
        )
      `.execute(db);
      const stored = await sql<{ count: string }>`
        select count(*) as count from audit_events
        where session_reference = ${reference}
      `.execute(db);
      expect(stored.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('ensureAuditPartitions', () => {
  it(
    'creates the current and next monthly partitions and is idempotent',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_default',
        ]);

        const now = new Date('2026-08-22T04:00:00Z');
        await ensureAuditPartitions(fresh.db, now);
        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_2026_08',
          'audit_events_2026_09',
          'audit_events_default',
        ]);

        await ensureAuditPartitions(fresh.db, now);
        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_2026_08',
          'audit_events_2026_09',
          'audit_events_default',
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'rolls the whole call back when one partition cannot be created',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        await sql`
          create table audit_events_overlap partition of audit_events
          for values from ('2026-10-01') to ('2026-11-01')
        `.execute(fresh.db);

        await expect(
          ensureAuditPartitions(fresh.db, new Date('2026-09-15T00:00:00Z')),
        ).rejects.toThrow();

        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_default',
          'audit_events_overlap',
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates the monthly partition when the default partition already holds it',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        const now = new Date('2026-08-22T04:00:00Z');

        const early = randomUUID();
        await insertAuditEvent(fresh.db, early, now.toISOString());
        expect(await auditPartitionOf(fresh.db, early)).toBe(
          'audit_events_default',
        );

        expect(await ensureAuditPartitions(fresh.db, now)).toEqual([
          'audit_events_2026_08',
          'audit_events_2026_09',
        ]);
        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_2026_08',
          'audit_events_2026_09',
          'audit_events_default',
        ]);
        expect(await auditPartitionOf(fresh.db, early)).toBe(
          'audit_events_2026_08',
        );

        const stored = await sql<{
          session_reference: string;
          payload: { id: string };
          occurred_at: Date;
        }>`
          select session_reference, payload, occurred_at
          from audit_events where id = ${early}
        `.execute(fresh.db);
        expect(stored.rows[0]?.session_reference).toBe(`pseudonym-${early}`);
        expect(stored.rows[0]?.payload).toEqual({ id: early });
        expect(stored.rows[0]?.occurred_at.toISOString()).toBe(
          now.toISOString(),
        );

        // A partition built by the recovery path has to be as complete as one
        // built by `create table ... partition of`: same indexes, same primary
        // key, inherited from the parent.
        const recovered = await partitionIndexSuffixes(
          fresh.db,
          'audit_events_2026_08',
        );
        expect(recovered).toEqual([
          'occurred_at_idx',
          'order_id_occurred_at_idx',
          'pkey',
          'session_reference_occurred_at_idx',
        ]);
        expect(recovered).toEqual(
          await partitionIndexSuffixes(fresh.db, 'audit_events_default'),
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves default rows that belong to no monthly partition where they are',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        const now = new Date('2026-08-22T04:00:00Z');
        const inMonth = randomUUID();
        const outOfRange = randomUUID();
        await insertAuditEvent(fresh.db, inMonth, now.toISOString());
        await insertAuditEvent(fresh.db, outOfRange, '2019-01-05T00:00:00Z');

        await ensureAuditPartitions(fresh.db, now);

        expect(await auditPartitionOf(fresh.db, inMonth)).toBe(
          'audit_events_2026_08',
        );
        expect(await auditPartitionOf(fresh.db, outOfRange)).toBe(
          'audit_events_default',
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pins partition bounds to UTC under a non-UTC session time zone',
    async () => {
      const fresh = await createEmptyDatabase('Asia/Seoul');
      try {
        await migrateToLatest(fresh.db);
        await ensureAuditPartitions(fresh.db, new Date('2029-05-15T00:00:00Z'));

        expect(await partitionBounds(fresh.db)).toEqual([
          [
            'audit_events_2029_05',
            "FOR VALUES FROM ('2029-05-01 00:00:00+00') TO ('2029-06-01 00:00:00+00')",
          ],
          [
            'audit_events_2029_06',
            "FOR VALUES FROM ('2029-06-01 00:00:00+00') TO ('2029-07-01 00:00:00+00')",
          ],
          ['audit_events_default', 'DEFAULT'],
        ]);

        const firstInstant = randomUUID();
        const justBefore = randomUUID();
        await insertAuditEvent(fresh.db, firstInstant, '2029-05-01T00:00:00Z');
        await insertAuditEvent(fresh.db, justBefore, '2029-04-30T23:59:59Z');
        expect(await auditPartitionOf(fresh.db, firstInstant)).toBe(
          'audit_events_2029_05',
        );
        expect(await auditPartitionOf(fresh.db, justBefore)).toBe(
          'audit_events_default',
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates contiguous UTC bounds across a year boundary',
    async () => {
      const fresh = await createEmptyDatabase('Asia/Seoul');
      try {
        await migrateToLatest(fresh.db);
        await ensureAuditPartitions(fresh.db, new Date('2026-12-31T23:59:59Z'));

        expect(await partitionBounds(fresh.db)).toEqual([
          [
            'audit_events_2026_12',
            "FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00')",
          ],
          [
            'audit_events_2027_01',
            "FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00')",
          ],
          ['audit_events_default', 'DEFAULT'],
        ]);

        const rollover = randomUUID();
        await insertAuditEvent(fresh.db, rollover, '2027-01-01T00:00:00Z');
        expect(await auditPartitionOf(fresh.db, rollover)).toBe(
          'audit_events_2027_01',
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates contiguous UTC bounds for a leap-day month',
    async () => {
      const fresh = await createEmptyDatabase('Asia/Seoul');
      try {
        await migrateToLatest(fresh.db);
        await ensureAuditPartitions(fresh.db, new Date('2028-02-29T12:00:00Z'));

        expect(await partitionBounds(fresh.db)).toEqual([
          [
            'audit_events_2028_02',
            "FOR VALUES FROM ('2028-02-01 00:00:00+00') TO ('2028-03-01 00:00:00+00')",
          ],
          [
            'audit_events_2028_03',
            "FOR VALUES FROM ('2028-03-01 00:00:00+00') TO ('2028-04-01 00:00:00+00')",
          ],
          ['audit_events_default', 'DEFAULT'],
        ]);

        const leapDay = randomUUID();
        await insertAuditEvent(fresh.db, leapDay, '2028-02-29T23:59:59Z');
        expect(await auditPartitionOf(fresh.db, leapDay)).toBe(
          'audit_events_2028_02',
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps months contiguous when the session time zone changes between calls',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        expect(
          await ensurePartitionUnderTimeZone(
            fresh.db,
            'Asia/Seoul',
            '2030-01-01',
          ),
        ).toBe('audit_events_2030_01');
        expect(
          await ensurePartitionUnderTimeZone(fresh.db, 'UTC', '2030-02-01'),
        ).toBe('audit_events_2030_02');
        expect(
          await ensurePartitionUnderTimeZone(
            fresh.db,
            'America/New_York',
            '2030-03-01',
          ),
        ).toBe('audit_events_2030_03');

        expect(await partitionBounds(fresh.db)).toEqual([
          [
            'audit_events_2030_01',
            "FOR VALUES FROM ('2030-01-01 00:00:00+00') TO ('2030-02-01 00:00:00+00')",
          ],
          [
            'audit_events_2030_02',
            "FOR VALUES FROM ('2030-02-01 00:00:00+00') TO ('2030-03-01 00:00:00+00')",
          ],
          [
            'audit_events_2030_03',
            "FOR VALUES FROM ('2030-03-01 00:00:00+00') TO ('2030-04-01 00:00:00+00')",
          ],
          ['audit_events_default', 'DEFAULT'],
        ]);

        const februaryFirst = randomUUID();
        const marchFirst = randomUUID();
        await insertAuditEvent(fresh.db, februaryFirst, '2030-02-01T00:00:00Z');
        await insertAuditEvent(fresh.db, marchFirst, '2030-03-01T00:00:00Z');
        expect(await auditPartitionOf(fresh.db, februaryFirst)).toBe(
          'audit_events_2030_02',
        );
        expect(await auditPartitionOf(fresh.db, marchFirst)).toBe(
          'audit_events_2030_03',
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'serialises two concurrent maintenance calls on separate connections',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        const now = new Date('2026-08-22T04:00:00Z');
        const expected = ['audit_events_2026_08', 'audit_events_2026_09'];

        // Both calls take ACCESS EXCLUSIVE on audit_events in the same order,
        // so the loser waits and then observes the partitions the winner
        // created instead of deadlocking or failing.
        const [first, second] = await Promise.all([
          ensureAuditPartitions(fresh.db, now),
          ensureAuditPartitions(fresh.db, now),
        ]);
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(await partitionNames(fresh.db)).toEqual([
          ...expected,
          'audit_events_default',
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses to treat a squatted table name as an existing partition',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        await sql`create table audit_events_2029_03 (x int)`.execute(fresh.db);

        await expect(
          ensureAuditPartitions(fresh.db, new Date('2029-03-15T00:00:00Z')),
        ).rejects.toThrow(/audit_events_2029_03/);

        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_default',
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'routes rows outside every monthly partition to the default partition',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        const now = new Date('2026-08-22T04:00:00Z');
        await ensureAuditPartitions(fresh.db, now);

        const inMonth = randomUUID();
        const outOfRange = randomUUID();
        await sql`
          insert into audit_events (
            id, session_reference, event_type, payload, occurred_at
          ) values
            (${inMonth}, 'pseudonym-a', 'ORDER_ACCEPTED', '{}'::jsonb, ${now.toISOString()}),
            (${outOfRange}, 'pseudonym-b', 'ORDER_ACCEPTED', '{}'::jsonb, '2019-01-05T00:00:00Z')
        `.execute(fresh.db);

        const located = await sql<{ id: string; partition: string }>`
          select id, tableoid::regclass::text as partition
          from audit_events
          order by occurred_at
        `.execute(fresh.db);
        expect(located.rows).toEqual([
          { id: outOfRange, partition: 'audit_events_default' },
          { id: inMonth, partition: monthPartitionName(now) },
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// PostgreSQL searches the session's temporary schema for relation names before
// pg_catalog and before every schema listed in search_path, and TEMPORARY on a
// database is granted to PUBLIC. A guard that names its tables unqualified from
// an unpinned function therefore evaluates against whatever the writer put in
// pg_temp, which is a two-statement bypass available to any role that can run
// DML — including one that cannot drop the trigger it is defeating.
describe('pg_temp shadowing', () => {
  it(
    'blocks an entry change on a published version whose parent table is shadowed',
    async () => {
      const versionId = await insertWhitelistVersion(230, false);
      const entryId = await insertWhitelistEntry(versionId, 'SHDW');
      await publishWhitelistVersion(versionId);

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table whitelist_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        await expectPostgresError(
          sql`
            update public.whitelist_entries set symbol = 'TAMPERED'
            where id = ${entryId}
          `.execute(trx),
          RAISE_EXCEPTION,
        );
      });

      const stored = await sql<{ symbol: string }>`
        select symbol from whitelist_entries where id = ${entryId}
      `.execute(db);
      expect(stored.rows[0]?.symbol).toBe('SHDW');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks deleting an entry of a published version whose parent table is shadowed',
    async () => {
      const versionId = await insertWhitelistVersion(231, false);
      const entryId = await insertWhitelistEntry(versionId, 'SHDX');
      await publishWhitelistVersion(versionId);

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table whitelist_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        await expectPostgresError(
          sql`delete from public.whitelist_entries where id = ${entryId}`.execute(
            trx,
          ),
          RAISE_EXCEPTION,
        );
      });

      expect(await entryCount(versionId)).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks truncating whitelist versions while its own table is shadowed',
    async () => {
      const versionId = await insertWhitelistVersion(232, true);

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table whitelist_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        const error = await expectPostgresError(
          sql`truncate public.whitelist_versions cascade`.execute(trx),
          RAISE_EXCEPTION,
        );
        expect(error.message).toBe(
          'published whitelist_versions rows are immutable',
        );
      });

      const survivor = await sql<{ count: string }>`
        select count(*) as count from whitelist_versions where id = ${versionId}
      `.execute(db);
      expect(survivor.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks truncating fee model versions while its own table is shadowed',
    async () => {
      const versionId = await insertFeeModelVersion(320, true);

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table fee_model_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        const error = await expectPostgresError(
          sql`truncate public.fee_model_versions cascade`.execute(trx),
          RAISE_EXCEPTION,
        );
        expect(error.message).toBe(
          'published fee_model_versions rows are immutable',
        );
      });

      const survivor = await sql<{ count: string }>`
        select count(*) as count from fee_model_versions where id = ${versionId}
      `.execute(db);
      expect(survivor.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks truncating whitelist entries while both queried tables are shadowed',
    async () => {
      const versionId = await insertWhitelistVersion(233, false);
      await insertWhitelistEntry(versionId, 'SHDY');
      await publishWhitelistVersion(versionId);

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table whitelist_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        await sql`
          create temp table whitelist_entries (
            id uuid, whitelist_version_id uuid
          ) on commit drop
        `.execute(trx);
        await expectPostgresError(
          sql`truncate public.whitelist_entries`.execute(trx),
          RAISE_EXCEPTION,
        );
      });

      expect(await entryCount(versionId)).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'blocks updating and deleting a published version while its table is shadowed',
    async () => {
      const whitelistId = await insertWhitelistVersion(234, true);
      const feeModelId = await insertFeeModelVersion(321, true);

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table whitelist_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        await sql`
          create temp table fee_model_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        await expectPostgresError(
          sql`
            update public.whitelist_versions set status = 'DRAFT'
            where id = ${whitelistId}
          `.execute(trx),
          RAISE_EXCEPTION,
        );
      });

      await db.transaction().execute(async (trx) => {
        await sql`
          create temp table fee_model_versions (id uuid, status text)
          on commit drop
        `.execute(trx);
        await expectPostgresError(
          sql`
            delete from public.fee_model_versions where id = ${feeModelId}
          `.execute(trx),
          RAISE_EXCEPTION,
        );
      });

      const stored = await sql<{ status: string }>`
        select status from whitelist_versions where id = ${whitelistId}
      `.execute(db);
      expect(stored.rows[0]?.status).toBe('PUBLISHED');
      const feeModel = await sql<{ count: string }>`
        select count(*) as count from fee_model_versions
        where id = ${feeModelId}
      `.execute(db);
      expect(feeModel.rows[0]?.count).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps the partition fast path correct while pg_catalog is shadowed',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        const now = new Date('2032-05-10T00:00:00Z');
        expect(await ensureAuditPartitions(fresh.db, now)).toEqual([
          'audit_events_2032_05',
          'audit_events_2032_06',
        ]);

        await fresh.db.transaction().execute(async (trx) => {
          await sql`
            create temp table pg_inherits (
              inhrelid oid, inhparent oid, inhseqno int,
              inhdetachpending boolean
            ) on commit drop
          `.execute(trx);
          await sql`
            create temp table pg_class (
              oid oid, relname name, relnamespace oid, relkind "char"
            ) on commit drop
          `.execute(trx);
          const repeated = await sql<{ name: string }>`
            select ensure_audit_partition('2032-05-01'::date) as name
          `.execute(trx);
          expect(repeated.rows[0]?.name).toBe('audit_events_2032_05');
        });

        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_2032_05',
          'audit_events_2032_06',
          'audit_events_default',
        ]);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'creates the real partition while a temp table shadows its name',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        const eventId = randomUUID();
        await insertAuditEvent(fresh.db, eventId, '2032-09-15T00:00:00Z');

        await fresh.db.transaction().execute(async (trx) => {
          await sql`
            create temp table audit_events_2032_09 (
              like public.audit_events including defaults
            ) on commit drop
          `.execute(trx);
          const created = await sql<{ name: string }>`
            select ensure_audit_partition('2032-09-01'::date) as name
          `.execute(trx);
          expect(created.rows[0]?.name).toBe('audit_events_2032_09');
        });

        expect(await partitionNames(fresh.db)).toEqual([
          'audit_events_2032_09',
          'audit_events_default',
        ]);
        expect(await auditPartitionOf(fresh.db, eventId)).toBe(
          'audit_events_2032_09',
        );
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses a partition that carries the right name and the wrong bounds',
    async () => {
      const fresh = await createEmptyDatabase();
      try {
        await migrateToLatest(fresh.db);
        // The shape an upgrade from the pre-fix, TimeZone-dependent bounds
        // would leave behind: right name, bounds nine hours off, and a gap
        // routed to the default partition that nothing would ever report.
        await sql`
          create table audit_events_2038_04 partition of audit_events
          for values from ('2038-03-31 15:00:00+00') to ('2038-04-30 15:00:00+00')
        `.execute(fresh.db);

        await expect(
          ensureAuditPartitions(fresh.db, new Date('2038-04-15T00:00:00Z')),
        ).rejects.toThrow(/audit_events_2038_04/);
      } finally {
        await fresh.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('003_leader_release', () => {
  it('adds a nullable released_at column to leader_epochs', async () => {
    const column = await sql<{ is_nullable: string; data_type: string }>`
      select is_nullable, data_type from information_schema.columns
      where table_name = 'leader_epochs' and column_name = 'released_at'
    `.execute(db);
    expect(column.rows).toEqual([
      { is_nullable: 'YES', data_type: 'timestamp with time zone' },
    ]);
  });
});
