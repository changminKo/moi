import { randomUUID } from 'node:crypto';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../db/database.js';
import { migrateToLatest } from '../../db/migrate.js';
import { createPortfolioRepository } from '../../db/repositories/portfolio-repository.js';

const CONTAINER_TIMEOUT_MS = 180_000;

let container: StartedPostgreSqlContainer;
let db: Database;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

async function seedSession(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into anonymous_sessions (id, token_hash, status, expires_at)
    values (${id}::uuid, ${randomUUID()}, 'ACTIVE', now() + interval '1 day')
  `.execute(db);
  return id;
}

async function seedOrder(
  sessionId: string,
  overrides: {
    readonly market?: string;
    readonly symbol?: string;
    readonly side?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into orders (
      id, session_id, market_code, symbol, order_type, side, quantity,
      filled_quantity, status, limit_price
    ) values (
      ${id}::uuid, ${sessionId}::uuid, ${overrides.market ?? 'KR'},
      ${overrides.symbol ?? '005930'}, 'LIMIT', ${overrides.side ?? 'BUY'},
      10, 0, 'OPEN', 100
    )
  `.execute(db);
  return id;
}

async function seedFill(
  sessionId: string,
  orderId: string,
  fill: {
    readonly price: string;
    readonly quantity: string;
    readonly fee: string;
    readonly accountSequence?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into fills (
      id, order_id, session_id, account_sequence, price, quantity, fee, slippage
    ) values (
      ${id}::uuid, ${orderId}::uuid, ${sessionId}::uuid,
      ${fill.accountSequence ?? null}, ${fill.price}, ${fill.quantity}, ${fill.fee}, 0
    )
  `.execute(db);
  return id;
}

/**
 * Inserts a fill the way the *previous* release does — no `session_id`, no
 * `account_sequence` — against the migrated schema. `deploy.sh` runs migrations
 * while that release is still serving, so this is the shape production writes
 * during every deploy window.
 */
async function insertLikeOldRelease(
  orderId: string,
  fill: {
    readonly price: string;
    readonly quantity: string;
    readonly fee: string;
  },
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into fills (id, order_id, price, quantity, fee, slippage)
    values (${id}::uuid, ${orderId}::uuid, ${fill.price}, ${fill.quantity}, ${fill.fee}, 0)
  `.execute(db);
  return id;
}

describe('fill history', () => {
  it('lets the release that is still serving during the migration keep writing owned fills', async () => {
    const session = await seedSession();
    const order = await seedOrder(session);

    // The old release's statement must still succeed: a failure here is every
    // fill and trigger order on the running process failing from the migration
    // commit until the new image has restarted, and a broken rollback.
    const id = await insertLikeOldRelease(order, {
      price: '71000',
      quantity: '1',
      fee: '10',
    });

    const row = (
      await sql<{
        session_id: string | null;
        fill_sequence: string | null;
        account_sequence: string | null;
      }>`select session_id::text as session_id, fill_sequence::text as fill_sequence, account_sequence::text as account_sequence from fills where id = ${id}::uuid`.execute(
        db,
      )
    ).rows[0];
    // Owned, not merely tolerated: the trigger derives the session from the
    // order, so the row is visible to the endpoint and satisfies the composite
    // foreign key rather than sitting there as an orphan with a null owner.
    expect(row?.session_id).toBe(session);
    expect(row?.fill_sequence).toMatch(/^\d+$/);
    expect(row?.account_sequence).toBeNull();

    const repository = createPortfolioRepository({
      executor: db,
    } as unknown as Parameters<typeof createPortfolioRepository>[0]);
    const page = await repository.listFills(session, { limit: 50 });
    expect(page.items.map((item) => item.id)).toContain(id);
  });

  it('rejects a fill whose session does not own its order', async () => {
    const mine = await seedSession();
    const theirs = await seedSession();
    const order = await seedOrder(mine);
    // The composite foreign key is what stops `listFills` from filtering on one
    // session while returning another session's symbol and side.
    await expect(
      sql`
        insert into fills (id, order_id, session_id, price, quantity, fee, slippage)
        values (${randomUUID()}::uuid, ${order}::uuid, ${theirs}::uuid, '1', '1', '0', 0)
      `.execute(db),
    ).rejects.toThrow(/fills_order_session_fkey/);
  });

  it('pages one session own fills on a monotonic cursor and hides every other session', async () => {
    const mine = await seedSession();
    const theirs = await seedSession();
    const myOrder = await seedOrder(mine);
    const theirOrder = await seedOrder(theirs, {
      market: 'US',
      symbol: 'AAPL',
      side: 'SELL',
    });

    const first = await seedFill(mine, myOrder, {
      price: '71200',
      quantity: '3',
      fee: '10.6800',
      accountSequence: 7,
    });
    const second = await seedFill(mine, myOrder, {
      price: '71300',
      quantity: '2',
      fee: '7.1300',
      accountSequence: 9,
    });
    await seedFill(theirs, theirOrder, {
      price: '229.87',
      quantity: '1',
      fee: '0.23',
    });

    const repository = createPortfolioRepository({
      executor: db,
    } as unknown as Parameters<typeof createPortfolioRepository>[0]);

    const page = await repository.listFills(mine, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual({
      id: first,
      fillSequence: expect.stringMatching(/^\d+$/),
      accountSequence: '7',
      orderId: myOrder,
      market: 'KR',
      symbol: '005930',
      side: 'BUY',
      quantity: '3',
      price: '71200',
      // Normalised the same way every other money field in this payload is
      // (`numeric` → decimal.toString()): the value is exact, the trailing
      // zeros are not part of it.
      fee: '10.68',
      currency: 'KRW',
      isRecoveryFill: false,
      occurredAt: expect.stringMatching(/^\d{4}-/),
    });
    expect(page.nextCursor).toBe(page.items[0]?.fillSequence);

    const next = await repository.listFills(mine, {
      limit: 50,
      after: page.nextCursor as string,
    });
    expect(next.items.map((item) => item.id)).toEqual([second]);
    // A page that ends the history carries no cursor, so a caller can stop.
    expect(next.nextCursor).toBeUndefined();

    // The cursor is exclusive and monotonic: paging never repeats or skips.
    const all = await repository.listFills(mine, { limit: 50 });
    expect(all.items.map((item) => item.id)).toEqual([first, second]);
    expect(
      Number(all.items[1]?.fillSequence) > Number(all.items[0]?.fillSequence),
    ).toBe(true);

    // Another session's fill is invisible, whatever the cursor.
    const other = await repository.listFills(theirs, { limit: 50 });
    expect(other.items.map((item) => item.orderId)).toEqual([theirOrder]);
    expect(other.items[0]?.currency).toBe('USD');
    expect(other.items[0]?.side).toBe('SELL');
    expect(
      (await repository.listFills(mine, { limit: 50, after: '0' })).items.map(
        (item) => item.id,
      ),
    ).toEqual([first, second]);
  });

  it('keeps money exact and reports an unpublished fill as having no account sequence', async () => {
    const session = await seedSession();
    const order = await seedOrder(session, { market: 'US', symbol: 'AAPL' });
    const at = '2026-08-30T04:05:06.789Z';
    await sql`
      insert into fills (
        id, order_id, session_id, price, quantity, fee, slippage,
        is_recovery_fill, occurred_at
      ) values (
        ${randomUUID()}::uuid, ${order}::uuid, ${session}::uuid,
        '229.8700', '1.0000', '0.2299', 0, true, ${at}::timestamptz
      )
    `.execute(db);
    const repository = createPortfolioRepository({
      executor: db,
    } as unknown as Parameters<typeof createPortfolioRepository>[0]);

    const page = await repository.listFills(session, { limit: 50 });
    const fill = page.items[0];
    expect(fill?.price).toBe('229.87');
    expect(fill?.fee).toBe('0.2299');
    expect(fill?.quantity).toBe('1');
    // Pre-migration fills were never published in an event; the record says so
    // rather than inventing a sequence.
    expect(fill?.accountSequence).toBeNull();
    // A recovery fill is reported as one — a client reconciling against the
    // provider needs to know which of its fills were replayed.
    expect(fill?.isRecoveryFill).toBe(true);
    // Milliseconds survive. `String(date)` on the pg `Date` would print a
    // locale string with none, collapsing two fills a millisecond apart.
    expect(fill?.occurredAt).toBe(at);
  });
});
