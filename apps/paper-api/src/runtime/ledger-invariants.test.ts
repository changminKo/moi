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
    'delete from reservations; delete from orders; delete from positions; delete from wallets; delete from anonymous_sessions;',
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

describe('verifyLedgerInvariants (§6.1 RESTORING)', () => {
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
