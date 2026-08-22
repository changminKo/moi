import { randomUUID } from 'node:crypto';
import {
  assertAccountInvariants,
  DomainError,
  type Market,
} from '@skipjack/trading-core';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from './database.js';
import { ensureAuditPartitions, migrateToLatest } from './migrate.js';
import type { ReserveCashInput } from './repositories/account-repository.js';
import * as unitOfWorkModule from './unit-of-work.js';
import {
  commitTradingMutation,
  LEDGER_LOCK_ORDER,
  type LockTarget,
  type TradingMutationInput,
  type TradingTransaction,
  UnitOfWork,
  UnknownCommitOutcomeError,
} from './unit-of-work.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 25;
const POLL_ATTEMPTS = 400;

// The competitor transaction in the deadlock test must never be the deadlock
// victim: PostgreSQL aborts whichever backend's deadlock_timeout expires first
// after the wait cycle closes, so raising the competitor's timeout far above the
// 1s server default makes the unit of work the victim deterministically.
const COMPETITOR_DEADLOCK_TIMEOUT = '30s';

let container: StartedPostgreSqlContainer;
let db: Database;

interface BackoffConsultation {
  readonly attempt: number;
  readonly sqlState: string;
}

/** Records every backoff consultation without ever consulting a clock. */
function recordBackoff(): {
  readonly attempts: readonly BackoffConsultation[];
  readonly backoff: (attempt: number, sqlState: string) => Promise<void>;
} {
  const attempts: BackoffConsultation[] = [];
  return {
    attempts,
    backoff: async (attempt: number, sqlState: string) => {
      attempts.push({ attempt, sqlState });
    },
  };
}

function recordLocks(): {
  readonly locks: readonly LockTarget[];
  readonly onLock: (target: LockTarget) => void;
} {
  const locks: LockTarget[] = [];
  return {
    locks,
    onLock: (target: LockTarget) => {
      locks.push(target);
    },
  };
}

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open = (): void => {
    throw new Error('gate was not initialised');
  };
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

async function waitUntil<T>(probe: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('the awaited database condition never became true');
}

async function insertSession(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into anonymous_sessions (id, token_hash, expires_at)
    values (${id}, ${`token-hash-${id}`}, now() + interval '1 hour')
  `.execute(db);
  return id;
}

async function insertWallet(
  sessionId: string,
  currency: 'KRW' | 'USD',
  total: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into wallets (id, session_id, currency, total, available, reserved)
    values (${id}, ${sessionId}, ${currency}, ${total}, ${total}, '0')
  `.execute(db);
  return id;
}

async function insertPosition(
  sessionId: string,
  symbol: string,
  quantity: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into positions (
      id, session_id, market_code, symbol,
      total_quantity, available_quantity, reserved_quantity, average_cost
    ) values (
      ${id}, ${sessionId}, 'US', ${symbol}, ${quantity}, ${quantity}, '0', '100'
    )
  `.execute(db);
  return id;
}

async function insertOcoGroup(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into oco_groups (id, session_id) values (${id}, ${sessionId})
  `.execute(db);
  return id;
}

async function insertOrderRow(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into orders (
      id, session_id, market_code, symbol, order_type, side,
      limit_price, quantity, status
    ) values (
      ${id}, ${sessionId}, 'US', 'AAPL', 'LIMIT', 'BUY', '100', '10', 'OPEN'
    )
  `.execute(db);
  return id;
}

interface WalletRow {
  readonly total: string;
  readonly available: string;
  readonly reserved: string;
  readonly version: string;
}

async function readWallet(walletId: string): Promise<WalletRow> {
  const result = await sql<WalletRow>`
    select total, available, reserved, version from wallets where id = ${walletId}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`wallet ${walletId} does not exist`);
  }
  return row;
}

interface OrderRow {
  readonly status: string;
  readonly filled_quantity: string;
  readonly version: string;
}

async function readOrder(orderId: string): Promise<OrderRow> {
  const result = await sql<OrderRow>`
    select status, filled_quantity, version from orders where id = ${orderId}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`order ${orderId} does not exist`);
  }
  return row;
}

interface LedgerCounts {
  readonly orders: number;
  readonly audit: number;
  readonly outbox: number;
  readonly idempotency: number;
}

async function countLedgerRows(target: Database): Promise<LedgerCounts> {
  const result = await sql<{
    orders: string;
    audit: string;
    outbox: string;
    idempotency: string;
  }>`
    select
      (select count(*) from orders) as orders,
      (select count(*) from audit_events) as audit,
      (select count(*) from outbox_events) as outbox,
      (select count(*) from idempotency_requests) as idempotency
  `.execute(target);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('the ledger count query returned no row');
  }
  return {
    orders: Number(row.orders),
    audit: Number(row.audit),
    outbox: Number(row.outbox),
    idempotency: Number(row.idempotency),
  };
}

/** Commits a wallet mutation from outside the transaction under test. */
async function bumpWalletFromOutside(walletId: string): Promise<void> {
  await sql`
    update wallets set version = version + 1 where id = ${walletId}
  `.execute(db);
}

async function orderFixture(
  tx: TradingTransaction,
  sessionId: string,
): Promise<string> {
  const id = randomUUID();
  await tx.orders.insert({
    id,
    sessionId,
    marketCode: 'US',
    symbol: 'AAPL',
    orderType: 'LIMIT',
    side: 'BUY',
    limitPrice: '100',
    quantity: '10',
    status: 'OPEN',
  });
  return id;
}

async function auditFixture(
  tx: TradingTransaction,
  sessionId: string,
): Promise<void> {
  await tx.audit.append({
    id: randomUUID(),
    sessionReference: `pseudonym-${sessionId}`,
    eventType: 'ORDER_PLACED',
    payload: { source: 'unit-of-work-test' },
    occurredAt: new Date('2026-08-22T00:00:00.000Z'),
  });
}

async function outboxFixture(
  tx: TradingTransaction,
  sessionId: string,
): Promise<void> {
  await tx.outbox.append({
    id: randomUUID(),
    eventId: randomUUID(),
    sessionId,
    streamSequence: 1n,
    eventType: 'ORDER_PLACED',
    payload: { source: 'unit-of-work-test' },
  });
}

function mutationInput(
  sessionId: string,
  overrides: Partial<TradingMutationInput> = {},
): TradingMutationInput {
  return {
    sessionId,
    idempotencyKey: 'key-1',
    requestHash: 'hash-1',
    order: {
      id: randomUUID(),
      marketCode: 'US' satisfies Market,
      symbol: 'AAPL',
      orderType: 'LIMIT',
      side: 'BUY',
      limitPrice: '100',
      quantity: '2',
      status: 'OPEN',
    },
    cash: { currency: 'KRW', amount: '200' },
    audit: {
      id: randomUUID(),
      eventType: 'ORDER_PLACED',
      payload: { via: 'commitTradingMutation' },
      occurredAt: new Date('2026-08-22T00:00:00.000Z'),
    },
    outbox: {
      id: randomUUID(),
      eventId: randomUUID(),
      streamSequence: 1n,
      eventType: 'ORDER_PLACED',
      payload: { via: 'commitTradingMutation' },
    },
    response: { statusCode: 201, body: { accepted: true } },
    ...overrides,
  };
}

/**
 * Re-presents an input with a counting accessor on every own field, so a test
 * can assert how many times the code under test read each one.
 */
function countingReads<T extends object>(
  base: T,
): { readonly input: T; readonly reads: Map<string, number> } {
  const reads = new Map<string, number>();
  const input: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(base)) {
    reads.set(field, 0);
    Object.defineProperty(input, field, {
      enumerable: true,
      get: () => {
        reads.set(field, (reads.get(field) ?? 0) + 1);
        return value;
      },
    });
  }

  return { input: input as T, reads };
}

/**
 * Every object and function reachable from `root` by reflection: own data
 * properties plus the prototype chain. Values behind getters are deliberately
 * not invoked, so nothing here can be faked by a side effect.
 */
function reachableValues(root: unknown): readonly unknown[] {
  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  const found: unknown[] = [];

  while (queue.length > 0) {
    const value = queue.pop();
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    found.push(value);

    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if ('value' in descriptor) {
        queue.push(descriptor.value);
      }
    }
    queue.push(Object.getPrototypeOf(value));
  }

  return found;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  db = createDatabase(container.getConnectionUri());
  await migrateToLatest(db);
  await ensureAuditPartitions(db, new Date('2026-08-22T00:00:00.000Z'));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.destroy();
  await container?.stop();
});

afterEach(async () => {
  await sql`truncate table anonymous_sessions cascade`.execute(db);
  await sql`truncate table audit_events`.execute(db);
});

describe('UnitOfWork.run transaction boundary', () => {
  it('rolls back ledger, audit, outbox, and idempotency together', async () => {
    const sessionId = await insertSession();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      unitOfWork.run(async (tx) => {
        await orderFixture(tx, sessionId);
        await auditFixture(tx, sessionId);
        await outboxFixture(tx, sessionId);
        await tx.idempotency.begin({
          sessionId,
          key: 'key-1',
          requestHash: 'hash-1',
        });
        await tx.idempotency.complete({
          sessionId,
          key: 'key-1',
          statusCode: 201,
          body: { accepted: true },
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    expect(await countLedgerRows(db)).toEqual({
      orders: 0,
      audit: 0,
      outbox: 0,
      idempotency: 0,
    });
  });

  it('writes audit and outbox rows in the same transaction as the order', async () => {
    const sessionId = await insertSession();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });
    const mutated = gate();
    const committed = gate();

    const run = unitOfWork.run(async (tx) => {
      await orderFixture(tx, sessionId);
      await auditFixture(tx, sessionId);
      await outboxFixture(tx, sessionId);
      mutated.open();
      await committed.opened;
      return 'done';
    });

    await mutated.opened;
    // A different connection, so a different backend: nothing may be visible
    // while the transaction that wrote all three rows is still open.
    expect(await countLedgerRows(db)).toEqual({
      orders: 0,
      audit: 0,
      outbox: 0,
      idempotency: 0,
    });

    committed.open();
    await expect(run).resolves.toBe('done');
    expect(await countLedgerRows(db)).toEqual({
      orders: 1,
      audit: 1,
      outbox: 1,
      idempotency: 0,
    });
  });
});

describe('optimistic versioning', () => {
  it('rejects a stale expected version with ORDER_STATE_CONFLICT and mutates nothing', async () => {
    const sessionId = await insertSession();
    const orderId = await insertOrderRow(sessionId);
    const before = await readOrder(orderId);
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

    const error = await unitOfWork
      .run(async (tx) => {
        await tx.orders.update({
          id: orderId,
          expectedVersion: 7n,
          status: 'CANCELLED',
        });
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('ORDER_STATE_CONFLICT');
    expect(backoff.attempts).toEqual([]);
    expect(await readOrder(orderId)).toEqual(before);
  });

  it('advances the version by one on a matching expected version', async () => {
    const sessionId = await insertSession();
    const orderId = await insertOrderRow(sessionId);
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await unitOfWork.run(async (tx) => {
      const locked = await tx.orders.lock(orderId);
      expect(locked?.version).toBe(0n);
      await tx.orders.update({
        id: orderId,
        expectedVersion: 0n,
        status: 'CANCELLED',
      });
    });

    expect(await readOrder(orderId)).toEqual({
      status: 'CANCELLED',
      filled_quantity: '0',
      version: '1',
    });
  });
});

describe('row locking', () => {
  it('lets exactly one of two concurrent reservations against one wallet succeed', async () => {
    const sessionId = await insertSession();
    const walletId = await insertWallet(sessionId, 'KRW', '100');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    const reserve = async (): Promise<void> => {
      await unitOfWork.run(async (tx) => {
        const wallet = await tx.accounts.lockWallet({
          sessionId,
          currency: 'KRW',
        });
        if (wallet === undefined) {
          throw new Error('the wallet disappeared');
        }
        await tx.accounts.reserveCash({ wallet, amount: '100' });
      });
    };

    const outcomes = await Promise.allSettled([reserve(), reserve()]);
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as DomainError;
    expect(reason).toBeInstanceOf(DomainError);
    expect(['INSUFFICIENT_AVAILABLE_CASH', 'ORDER_STATE_CONFLICT']).toContain(
      reason.code,
    );

    const wallet = await readWallet(walletId);
    expect(wallet).toEqual({
      total: '100',
      available: '0',
      reserved: '100',
      version: '1',
    });
    assertAccountInvariants({
      wallets: [
        {
          currency: 'KRW',
          total: wallet.total,
          available: wallet.available,
          reserved: wallet.reserved,
          version: BigInt(wallet.version),
        },
      ],
      positions: [],
    });
  });

  it('documents one global lock order and rejects any inversion of it', async () => {
    expect(LEDGER_LOCK_ORDER).toEqual([
      'anonymous_sessions',
      'wallets',
      'positions',
      'oco_groups',
      'orders',
    ]);

    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '100');
    const orderId = await insertOrderRow(sessionId);
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

    const error = await unitOfWork
      .run(async (tx) => {
        await tx.orders.lock(orderId);
        await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('INVARIANT_VIOLATION');
    expect((error as DomainError).message).toContain('lock order');
    // A lock-order defect is a bug, never a transient condition.
    expect(backoff.attempts).toEqual([]);
  });

  it('takes every lock of a full mutation in the documented global order', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '1000');
    await insertPosition(sessionId, 'AAPL', '10');
    const ocoGroupId = await insertOcoGroup(sessionId);
    const siblingOrderIds = [
      await insertOrderRow(sessionId),
      await insertOrderRow(sessionId),
    ].sort();
    const locks = recordLocks();
    const unitOfWork = new UnitOfWork(db, {
      backoff: recordBackoff().backoff,
      onLock: locks.onLock,
    });

    await commitTradingMutation(
      unitOfWork,
      mutationInput(sessionId, {
        cash: { currency: 'KRW', amount: '200' },
        position: { marketCode: 'US', symbol: 'AAPL', quantity: '1' },
        ocoGroupId,
        siblingOrderIds: [...siblingOrderIds].reverse(),
      }),
    );

    expect(locks.locks.map((target) => target.table)).toEqual([
      'anonymous_sessions',
      'wallets',
      'positions',
      'oco_groups',
      'orders',
      'orders',
    ]);
    // Sibling order rows are locked by ascending id even though the caller
    // supplied them in the opposite order.
    expect(locks.locks.slice(4).map((target) => target.key)).toEqual(
      siblingOrderIds,
    );
  });
});

describe('serialization and deadlock retries', () => {
  it(
    'retries a real 40001 serialization failure and applies the work once',
    async () => {
      const sessionId = await insertSession();
      const walletId = await insertWallet(sessionId, 'KRW', '1000');
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, {
        backoff: backoff.backoff,
        isolationLevel: 'serializable',
      });
      let executions = 0;

      await unitOfWork.run(async (tx) => {
        executions += 1;
        // Fixes this transaction's snapshot before the competing commit lands.
        await tx.sessions.find(sessionId);
        if (executions === 1) {
          await bumpWalletFromOutside(walletId);
        }
        const wallet = await tx.accounts.lockWallet({
          sessionId,
          currency: 'KRW',
        });
        if (wallet === undefined) {
          throw new Error('the wallet disappeared');
        }
        await tx.accounts.reserveCash({ wallet, amount: '100' });
      });

      expect(executions).toBe(2);
      expect(backoff.attempts).toEqual([{ attempt: 1, sqlState: '40001' }]);
      const wallet = await readWallet(walletId);
      expect(wallet.total).toBe('1000');
      expect(wallet.available).toBe('900');
      expect(wallet.reserved).toBe('100');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'retries a real 40P01 deadlock and applies the work once',
    async () => {
      const sessionId = await insertSession();
      const krwWalletId = await insertWallet(sessionId, 'KRW', '1000');
      const usdWalletId = await insertWallet(sessionId, 'USD', '1000');
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });
      const competitorHoldsUsd = gate();
      const unitOfWorkHoldsKrw = gate();
      const competitorMayFinish = gate();
      let executions = 0;

      // The competitor deliberately violates the global lock order — USD before
      // KRW — because a deadlock needs a cycle, and only an inverted acquisition
      // can create one.
      const competitor = db.transaction().execute(async (trx) => {
        await sql
          .raw(`set local deadlock_timeout = '${COMPETITOR_DEADLOCK_TIMEOUT}'`)
          .execute(trx);
        await sql`select 1 from wallets where id = ${usdWalletId} for update`.execute(
          trx,
        );
        competitorHoldsUsd.open();
        await unitOfWorkHoldsKrw.opened;
        await sql`select 1 from wallets where id = ${krwWalletId} for update`.execute(
          trx,
        );
        await competitorMayFinish.opened;
        await sql`update wallets set version = version + 1 where id = ${krwWalletId}`.execute(
          trx,
        );
      });

      await competitorHoldsUsd.opened;

      const run = unitOfWork.run(async (tx) => {
        executions += 1;
        const krw = await tx.accounts.lockWallet({
          sessionId,
          currency: 'KRW',
        });
        if (executions === 1) {
          unitOfWorkHoldsKrw.open();
          // Wait until the competitor is actually blocked on the KRW row, so the
          // wait cycle closes on the next statement instead of by chance.
          await waitUntil(async () => {
            const result = await sql<{ blocked: string }>`
            select count(*) as blocked from pg_locks where not granted
          `.execute(db);
            return Number(result.rows[0]?.blocked ?? 0) > 0 ? true : undefined;
          });
        }
        await tx.accounts.lockWallet({ sessionId, currency: 'USD' });
        if (krw === undefined) {
          throw new Error('the wallet disappeared');
        }
        await tx.accounts.reserveCash({ wallet: krw, amount: '100' });
      });

      competitorMayFinish.open();
      await run;
      await competitor;

      expect(executions).toBe(2);
      expect(backoff.attempts).toEqual([{ attempt: 1, sqlState: '40P01' }]);
      const wallet = await readWallet(krwWalletId);
      expect(wallet.total).toBe('1000');
      expect(wallet.available).toBe('900');
      expect(wallet.reserved).toBe('100');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'gives the caller a stable transient domain error after the default three retries',
    async () => {
      const sessionId = await insertSession();
      const walletId = await insertWallet(sessionId, 'KRW', '1000');
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, {
        backoff: backoff.backoff,
        isolationLevel: 'serializable',
      });
      let executions = 0;

      const error = await unitOfWork
        .run(async (tx) => {
          executions += 1;
          await tx.sessions.find(sessionId);
          await orderFixture(tx, sessionId);
          await bumpWalletFromOutside(walletId);
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('SERVICE_UNAVAILABLE');
      expect((error as DomainError).retryable).toBe(true);
      // The default ceiling is three retries: four executions of the work, three
      // backoff consultations, in order.
      expect(executions).toBe(4);
      expect(backoff.attempts).toEqual([
        { attempt: 1, sqlState: '40001' },
        { attempt: 2, sqlState: '40001' },
        { attempt: 3, sqlState: '40001' },
      ]);
      expect(await countLedgerRows(db)).toEqual({
        orders: 0,
        audit: 0,
        outbox: 0,
        idempotency: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'honours an injected retry ceiling',
    async () => {
      const sessionId = await insertSession();
      const walletId = await insertWallet(sessionId, 'KRW', '1000');
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, {
        backoff: backoff.backoff,
        isolationLevel: 'serializable',
        maxRetries: 1,
      });
      let executions = 0;

      await expect(
        unitOfWork.run(async (tx) => {
          executions += 1;
          await tx.sessions.find(sessionId);
          await bumpWalletFromOutside(walletId);
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
        }),
      ).rejects.toBeInstanceOf(DomainError);

      expect(executions).toBe(2);
      expect(backoff.attempts).toEqual([{ attempt: 1, sqlState: '40001' }]);
    },
    TEST_TIMEOUT_MS,
  );

  it('never retries a domain error', async () => {
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });
    let executions = 0;

    await expect(
      unitOfWork.run(async () => {
        executions += 1;
        throw new DomainError('INSUFFICIENT_AVAILABLE_CASH', 'no cash');
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_CASH' });

    expect(executions).toBe(1);
    expect(backoff.attempts).toEqual([]);
  });

  it('never retries a hand-made object that only claims a retryable SQLSTATE', async () => {
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });
    let executions = 0;

    await expect(
      unitOfWork.run(async () => {
        executions += 1;
        throw { code: '40001', message: 'not a driver error' };
      }),
    ).rejects.toMatchObject({ code: '40001' });

    expect(executions).toBe(1);
    expect(backoff.attempts).toEqual([]);
  });

  it(
    'never replays an unknown commit outcome',
    async () => {
      const poolErrors: Error[] = [];
      const isolated = createDatabase(container.getConnectionUri(), (error) => {
        poolErrors.push(error);
      });
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(isolated, { backoff: backoff.backoff });
      const sessionId = await insertSession();
      const mutated = gate();
      const terminated = gate();
      let executions = 0;

      try {
        const run = unitOfWork.run(async (tx) => {
          executions += 1;
          await orderFixture(tx, sessionId);
          mutated.open();
          await terminated.opened;
        });

        await mutated.opened;
        const pid = await waitUntil(async () => {
          const result = await sql<{ pid: number }>`
          select activity.pid
          from pg_locks as lock
          join pg_class as class on class.oid = lock.relation
          join pg_stat_activity as activity on activity.pid = lock.pid
          where class.relname = 'orders'
            and lock.mode = 'RowExclusiveLock'
            and activity.datname = current_database()
            and activity.pid <> pg_backend_pid()
        `.execute(db);
          return result.rows[0]?.pid;
        });
        await sql`select pg_terminate_backend(${pid})`.execute(db);
        terminated.open();

        const error = await run.then(
          () => undefined,
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(UnknownCommitOutcomeError);
        expect((error as UnknownCommitOutcomeError).cause).toBeDefined();
        // One execution: an outcome nobody can observe must never be replayed.
        expect(executions).toBe(1);
        expect(backoff.attempts).toEqual([]);

        // The dead client's socket closes after the pool has discarded it, and
        // `pg` reports that on the client. Reaching the reporter is what proves
        // the failure was contained instead of becoming an uncaught exception.
        const reported = await waitUntil(async () =>
          poolErrors.length > 0 ? poolErrors[0] : undefined,
        );
        expect(reported).toBeInstanceOf(Error);
      } finally {
        await isolated.destroy();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('commitTradingMutation', () => {
  it('commits ledger, audit, outbox, and idempotency atomically', async () => {
    const sessionId = await insertSession();
    const walletId = await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    const result = await commitTradingMutation(
      unitOfWork,
      mutationInput(sessionId),
    );

    expect(result).toEqual({
      replayed: false,
      statusCode: 201,
      body: { accepted: true },
    });
    expect(await countLedgerRows(db)).toEqual({
      orders: 1,
      audit: 1,
      outbox: 1,
      idempotency: 1,
    });
    const wallet = await readWallet(walletId);
    expect(wallet.available).toBe('800');
    expect(wallet.reserved).toBe('200');
  });

  it('replays one idempotency key exactly once and returns the recorded result', async () => {
    const sessionId = await insertSession();
    const walletId = await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });
    const input = mutationInput(sessionId);

    const first = await commitTradingMutation(unitOfWork, input);
    const second = await commitTradingMutation(unitOfWork, input);

    expect(first.replayed).toBe(false);
    expect(second).toEqual({
      replayed: true,
      statusCode: 201,
      body: { accepted: true },
    });
    expect(await countLedgerRows(db)).toEqual({
      orders: 1,
      audit: 1,
      outbox: 1,
      idempotency: 1,
    });
    const wallet = await readWallet(walletId);
    expect(wallet.available).toBe('800');
    expect(wallet.reserved).toBe('200');
  });

  it('rejects the same idempotency key with a different request hash', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await commitTradingMutation(unitOfWork, mutationInput(sessionId));
    await expect(
      commitTradingMutation(
        unitOfWork,
        mutationInput(sessionId, { requestHash: 'hash-2' }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rolls the whole mutation back when the reservation is refused', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '100');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      commitTradingMutation(
        unitOfWork,
        mutationInput(sessionId, {
          cash: { currency: 'KRW', amount: '10000' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_CASH' });

    expect(await countLedgerRows(db)).toEqual({
      orders: 0,
      audit: 0,
      outbox: 0,
      idempotency: 0,
    });
  });
});

describe('read-once discipline', () => {
  it('reads every supplied field of a trading mutation exactly once', async () => {
    const sessionId = await insertSession();
    const walletId = await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });
    const hostile = countingReads(mutationInput(sessionId));

    await commitTradingMutation(unitOfWork, hostile.input);

    // A field read twice is a field whose second value could differ from the
    // one that was validated — the defect family this codebase keeps hitting.
    expect(
      [...hostile.reads.entries()].filter(([, count]) => count !== 1),
    ).toEqual([]);
    const wallet = await readWallet(walletId);
    expect(wallet.available).toBe('800');
    expect(wallet.reserved).toBe('200');
  });

  it('reads the wallet and amount of a cash reservation exactly once', async () => {
    const sessionId = await insertSession();
    const walletId = await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await unitOfWork.run(async (tx) => {
      const wallet = await tx.accounts.lockWallet({
        sessionId,
        currency: 'KRW',
      });
      if (wallet === undefined) {
        throw new Error('the wallet disappeared');
      }
      // Every read after the first hands back an amount nobody validated.
      const hostile = countingReads<ReserveCashInput>({
        wallet,
        amount: '100',
      });
      await tx.accounts.reserveCash(hostile.input);
      expect([...hostile.reads.entries()]).toEqual([
        ['wallet', 1],
        ['amount', 1],
      ]);
    });

    const wallet = await readWallet(walletId);
    expect(wallet.available).toBe('900');
    expect(wallet.reserved).toBe('100');
  });
});

describe('persistence encapsulation', () => {
  it('never exposes the Kysely instance through the unit of work or its transaction', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    expect(
      reachableValues(unitOfWork).filter((value) => value instanceof Kysely),
    ).toEqual([]);

    const exposed = await unitOfWork.run(async (tx) => {
      expect(
        reachableValues(tx).filter((value) => value instanceof Kysely),
      ).toEqual([]);
      expect(Object.isFrozen(tx)).toBe(true);
      return reachableValues(tx).filter((value) => value instanceof Kysely);
    });
    expect(exposed).toEqual([]);

    const result = await commitTradingMutation(
      unitOfWork,
      mutationInput(sessionId),
    );
    expect(
      reachableValues(result).filter((value) => value instanceof Kysely),
    ).toEqual([]);
  });

  it('exports no database handle and no unexpected name', () => {
    expect(
      Object.values(unitOfWorkModule).filter(
        (value) => value instanceof Kysely,
      ),
    ).toEqual([]);
    expect(Object.keys(unitOfWorkModule).sort()).toEqual([
      'LEDGER_LOCK_ORDER',
      'UnitOfWork',
      'UnknownCommitOutcomeError',
      'commitTradingMutation',
    ]);
  });
});
