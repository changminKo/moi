import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.js';
import { migrateToLatest } from './migrate.js';

const CONTAINER_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

let container: StartedPostgreSqlContainer;
let admin: Database;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  admin = createDatabase(container.getConnectionUri());
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await admin?.destroy();
  await container?.stop();
});

/** A database of its own, so each case migrates from a genuinely empty schema. */
async function freshDatabase(): Promise<Database> {
  const name = `fills_${randomUUID().replaceAll('-', '')}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  const uri = new URL(container.getConnectionUri());
  uri.pathname = `/${name}`;
  return createDatabase(uri.toString());
}

/** Applies only the migrations that precede the fill-history pair. */
async function migrateToPreFillHistory(db: Database): Promise<void> {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const directory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  for (const name of [
    '001_ledger',
    '002_audit_partitions',
    '003_leader_release',
  ]) {
    const statements = await readFile(join(directory, `${name}.sql`), 'utf8');
    await sql.raw(statements).execute(db);
  }
  // Kysely records what it applied; seed the same names so `migrateToLatest`
  // runs exactly the two fill-history migrations, the way a deploy does.
  await sql`
    create table if not exists kysely_migration (
      name varchar(255) primary key, timestamp varchar(255) not null
    )
  `.execute(db);
  await sql`
    create table if not exists kysely_migration_lock (
      id varchar(255) primary key, is_locked integer not null default 0
    )
  `.execute(db);
  await sql`insert into kysely_migration_lock (id, is_locked) values ('migration_lock', 0) on conflict do nothing`.execute(
    db,
  );
  for (const name of [
    '001_ledger',
    '002_audit_partitions',
    '003_leader_release',
  ]) {
    await sql`insert into kysely_migration (name, timestamp) values (${name}, ${new Date().toISOString()})`.execute(
      db,
    );
  }
}

async function seedPreMigrationRows(db: Database): Promise<{
  readonly sessionId: string;
  readonly ordered: readonly string[];
}> {
  const sessionId = randomUUID();
  await sql`
    insert into anonymous_sessions (id, token_hash, status, expires_at)
    values (${sessionId}::uuid, ${randomUUID()}, 'ACTIVE', now() + interval '1 day')
  `.execute(db);
  const orderId = randomUUID();
  await sql`
    insert into orders (
      id, session_id, market_code, symbol, order_type, side, quantity,
      filled_quantity, status, limit_price
    ) values (
      ${orderId}::uuid, ${sessionId}::uuid, 'KR', '005930', 'LIMIT', 'BUY',
      10, 0, 'OPEN', 100
    )
  `.execute(db);

  // Inserted newest-first so heap order contradicts time order: the property
  // the backfill has to get right is that the cursor follows `occurred_at`,
  // not the order rows happen to sit in.
  const times = [
    '2026-08-30T03:00:00.500Z',
    '2026-08-30T01:00:00.250Z',
    '2026-08-30T02:00:00.750Z',
  ];
  const ids = times.map(() => randomUUID());
  for (const [index, at] of times.entries()) {
    await sql`
      insert into fills (id, order_id, price, quantity, fee, slippage, occurred_at)
      values (${ids[index]}::uuid, ${orderId}::uuid, '100', '1', '0', 0, ${at}::timestamptz)
    `.execute(db);
  }
  // Expected cursor order: oldest occurred_at first.
  return {
    sessionId,
    ordered: [ids[1] as string, ids[2] as string, ids[0] as string],
  };
}

describe('fill history migration', () => {
  it(
    'backfills pre-migration fills and numbers them in occurred_at order',
    async () => {
      const db = await freshDatabase();
      try {
        await migrateToPreFillHistory(db);
        const seeded = await seedPreMigrationRows(db);

        const applied = await migrateToLatest(db);
        expect(applied.map((result) => result.migrationName)).toEqual([
          '004_fill_history',
          '005_fill_history_backfill',
          '006_fill_history_indexes',
          '007_fill_history_validate',
        ]);

        const rows = (
          await sql<{
            id: string;
            session_id: string | null;
            fill_sequence: string;
            occurred_at: Date;
          }>`select id::text as id, session_id::text as session_id, fill_sequence::text as fill_sequence, occurred_at from fills order by fill_sequence`.execute(
            db,
          )
        ).rows;

        // Every pre-migration row is owned, so none of them is invisible to
        // `GET /api/v1/fills`.
        expect(rows.map((row) => row.session_id)).toEqual([
          seeded.sessionId,
          seeded.sessionId,
          seeded.sessionId,
        ]);
        // The cursor follows time, not heap position. Replaying realized P&L on
        // an inverted cursor would book a sell before the buy it closes.
        expect(rows.map((row) => row.id)).toEqual(seeded.ordered);
        const times = rows.map((row) => row.occurred_at.getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));

        // The sequence continues past the backfilled values rather than
        // colliding with them.
        const next = (
          await sql<{
            value: string;
          }>`select nextval('fills_fill_sequence_seq')::text as value`.execute(
            db,
          )
        ).rows[0];
        expect(Number(next?.value)).toBeGreaterThan(
          Number(rows[2]?.fill_sequence),
        );
      } finally {
        await db.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'adds the columns without rewriting the table and without holding an exclusive lock while it works',
    async () => {
      const db = await freshDatabase();
      try {
        await migrateToPreFillHistory(db);
        await seedPreMigrationRows(db);
        const before = (
          await sql<{
            node: string;
          }>`select relfilenode::text as node from pg_class where relname = 'fills'`.execute(
            db,
          )
        ).rows[0]?.node;

        await migrateToLatest(db);

        const after = (
          await sql<{
            node: string;
          }>`select relfilenode::text as node from pg_class where relname = 'fills'`.execute(
            db,
          )
        ).rows[0]?.node;
        // A rewrite is what `add column ... bigserial` would have caused: the
        // whole table copied under AccessExclusiveLock, blocking every reader —
        // including the old release's portfolio snapshot — for its duration.
        expect(after).toBe(before);

        const defaults = (
          await sql<{ definition: string | null }>`
            select column_default as definition from information_schema.columns
            where table_name = 'fills' and column_name = 'fill_sequence'
          `.execute(db)
        ).rows[0];
        expect(defaults?.definition).toContain('fills_fill_sequence_seq');
      } finally {
        await db.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
