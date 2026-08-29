import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { verifyLedgerInvariants } from './ledger-invariants.js';

let container: StartedPostgreSqlContainer;
let db: Database;
let client: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
}, 300_000);

afterEach(async () => {
  await client.query(
    'delete from reservations; delete from orders; delete from oco_groups; delete from positions; delete from wallets; delete from anonymous_sessions;',
  );
});
afterAll(async () => {
  await client?.end();
  await db?.destroy();
  await container?.stop();
});

async function seedSession(reserved = 30): Promise<string> {
  const id = (
    await client.query(
      "insert into anonymous_sessions (id, token_hash, status, expires_at, last_seen_at) values (gen_random_uuid(), md5(gen_random_uuid()::text), 'ACTIVE', now() + interval '1 day', now()) returning id::text",
    )
  ).rows[0].id as string;
  await client.query(
    "insert into wallets (id, session_id, currency, total, available, reserved) values (gen_random_uuid(), $1, 'USD', 100, $2, $3)",
    [id, 100 - reserved, reserved],
  );
  return id;
}
async function seedOrderWithCash(
  session: string,
  amount: number,
): Promise<void> {
  const order = (
    await client.query(
      "insert into orders (id, session_id, market_code, symbol, order_type, side, quantity, limit_price, status) values (gen_random_uuid(), $1, 'US', 'AAPL', 'LIMIT', 'BUY', 1, 100, 'OPEN') returning id::text",
      [session],
    )
  ).rows[0].id as string;
  await client.query(
    "insert into reservations (id, session_id, order_id, kind, currency, amount, released) values (gen_random_uuid(), $1, $2, 'CASH', 'USD', $3, false)",
    [session, order, amount],
  );
}

async function seedOcoGroupWithCash(
  session: string,
  amount: number,
  released = false,
): Promise<string> {
  const group = (
    await client.query(
      'insert into oco_groups (id, session_id, status) values (gen_random_uuid(), $1, $2) returning id::text',
      [session, released ? 'RESOLVED' : 'ACTIVE'],
    )
  ).rows[0].id as string;
  for (const [type, price] of [
    ['LIMIT', 180],
    ['STOP', 200],
  ] as const) {
    await client.query(
      "insert into orders (id, session_id, market_code, symbol, order_type, side, quantity, limit_price, stop_price, status, oco_group_id) values (gen_random_uuid(), $1, 'US', 'AAPL', $2, 'BUY', 1, $3, $3, $4, $5)",
      [session, type, price, released ? 'CANCELLED' : 'PENDING_TRIGGER', group],
    );
  }
  await client.query(
    "insert into reservations (id, session_id, oco_group_id, kind, currency, amount, released) values (gen_random_uuid(), $1, $2, 'CASH', 'USD', $3, $4)",
    [session, group, amount, released],
  );
  return group;
}
async function seedPosition(
  session: string,
  reserved: number,
  reservationAmount?: number,
): Promise<void> {
  await client.query(
    "insert into positions (id, session_id, market_code, symbol, total_quantity, available_quantity, reserved_quantity, average_cost) values (gen_random_uuid(), $1, 'US', 'AAPL', 10, $2, $3, 150)",
    [session, 10 - reserved, reserved],
  );
  if (reservationAmount === undefined) return;
  const order = (
    await client.query(
      "insert into orders (id, session_id, market_code, symbol, order_type, side, quantity, limit_price, status) values (gen_random_uuid(), $1, 'US', 'AAPL', 'LIMIT', 'SELL', $2, 160, 'OPEN') returning id::text",
      [session, reservationAmount],
    )
  ).rows[0].id as string;
  await client.query(
    "insert into reservations (id, session_id, order_id, kind, market_code, symbol, amount, released) values (gen_random_uuid(), $1, $2, 'POSITION', 'US', 'AAPL', $3, false)",
    [session, order, reservationAmount],
  );
}

describe('verifyLedgerInvariants (§6.1 RESTORING)', () => {
  it('reconciles an OCO shared CASH reservation that has no order_id', async () => {
    const session = await seedSession(30);
    await seedOcoGroupWithCash(session, 30);
    await expect(verifyLedgerInvariants(db)).resolves.toMatchObject({
      reservations: 0,
    });
  });
  it('fails closed when a resolved OCO group left its reservation unreleased', async () => {
    const session = await seedSession(0);
    await seedOcoGroupWithCash(session, 30);
    await expect(verifyLedgerInvariants(db)).rejects.toThrow(/reservations=1/);
  });
  it('accepts a partially filled order whose residual reservation shrank with the wallet', async () => {
    const session = await seedSession(12);
    await seedOrderWithCash(session, 12);
    await client.query(
      'update orders set quantity = 5, filled_quantity = 2, status = $1',
      ['PARTIALLY_FILLED'],
    );
    await expect(verifyLedgerInvariants(db)).resolves.toMatchObject({
      orders: 0,
      reservations: 0,
    });
  });
  it('reconciles POSITION reservations against reserved_quantity', async () => {
    const session = await seedSession(0);
    await seedPosition(session, 4, 4);
    await expect(verifyLedgerInvariants(db)).resolves.toMatchObject({
      positions: 0,
      reservations: 0,
    });
  });
  it('fails closed when a position reserves quantity no reservation explains', async () => {
    const session = await seedSession(0);
    await seedPosition(session, 4);
    await expect(verifyLedgerInvariants(db)).rejects.toThrow(/reservations=1/);
  });

  it('passes when wallet reservations reconcile with unreleased CASH reservations', async () => {
    const session = await seedSession(30);
    await seedOrderWithCash(session, 30);
    await expect(verifyLedgerInvariants(db)).resolves.toEqual({
      wallets: 0,
      positions: 0,
      orders: 0,
      reservations: 0,
    });
  });

  it('fails closed when a wallet reserves more than its open reservations', async () => {
    await seedSession(30);
    await expect(verifyLedgerInvariants(db)).rejects.toMatchObject({
      code: 'INVARIANT_VIOLATION',
      message: /reservations=1/,
    });
  });

  it('fails closed when a wallet reserves less than its open reservations', async () => {
    const session = await seedSession(10);
    await seedOrderWithCash(session, 30);
    await expect(verifyLedgerInvariants(db)).rejects.toThrow(/reservations=1/);
  });

  it('ignores released reservations', async () => {
    const session = await seedSession(0);
    await seedOrderWithCash(session, 30);
    await client.query('update reservations set released = true');
    await expect(verifyLedgerInvariants(db)).resolves.toMatchObject({
      reservations: 0,
    });
  });

  it('never swallows a query error', async () => {
    const broken = createDatabase(
      'postgres://invalid:invalid@127.0.0.1:1/none',
    );
    await expect(verifyLedgerInvariants(broken)).rejects.toThrow();
    await broken.destroy();
  });
});
