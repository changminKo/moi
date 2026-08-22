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
import * as lockOrderModule from './lock-order.js';
import {
  createLockOrderGuard,
  LEDGER_LOCK_ORDER,
  LEDGER_REFERENCE_TABLES,
  type LockStrength,
  type LockTable,
  type LockTarget,
} from './lock-order.js';
import { ensureAuditPartitions, migrateToLatest } from './migrate.js';
import type {
  LockedPosition,
  LockedWallet,
  ReserveCashInput,
} from './repositories/account-repository.js';
import * as unitOfWorkModule from './unit-of-work.js';
import {
  commitTradingMutation,
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
  readonly reservations: number;
}

async function countLedgerRows(target: Database): Promise<LedgerCounts> {
  const result = await sql<{
    orders: string;
    audit: string;
    outbox: string;
    idempotency: string;
    reservations: string;
  }>`
    select
      (select count(*) from orders) as orders,
      (select count(*) from audit_events) as audit,
      (select count(*) from outbox_events) as outbox,
      (select count(*) from idempotency_requests) as idempotency,
      (select count(*) from reservations) as reservations
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
    reservations: Number(row.reservations),
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

/** True for a container this probe may descend into without changing its kind. */
function isPlainContainer(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return (
    prototype === Object.prototype ||
    prototype === null ||
    prototype === Array.prototype
  );
}

/**
 * Re-presents an input with a counting accessor on every own field, nested
 * containers included, so a test can assert how many times the code under test
 * read each one. Paths are dotted, so `order.symbol` is distinguishable from
 * `order` itself: a re-read of a nested field is exactly the defect a top-level
 * probe cannot see.
 */
function countingReads<T extends object>(
  base: T,
): { readonly input: T; readonly reads: Map<string, number> } {
  const reads = new Map<string, number>();

  const wrap = (container: object, path: string): object => {
    const wrapped: object = Array.isArray(container) ? [] : {};

    for (const [field, value] of Object.entries(container)) {
      const fieldPath = path === '' ? field : `${path}.${field}`;
      const exposed: unknown = isPlainContainer(value)
        ? wrap(value, fieldPath)
        : value;
      reads.set(fieldPath, 0);
      Object.defineProperty(wrapped, field, {
        enumerable: true,
        get: () => {
          reads.set(fieldPath, (reads.get(fieldPath) ?? 0) + 1);
          return exposed;
        },
      });
    }

    return wrapped;
  };

  return { input: wrap(base, '') as T, reads };
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
      reservations: 0,
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
      reservations: 0,
    });

    committed.open();
    await expect(run).resolves.toBe('done');
    expect(await countLedgerRows(db)).toEqual({
      orders: 1,
      audit: 1,
      outbox: 1,
      idempotency: 0,
      reservations: 0,
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
      'idempotency_requests',
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
      'idempotency_requests',
    ]);
    // Sibling order rows are locked by ascending id even though the caller
    // supplied them in the opposite order.
    expect(locks.locks.slice(4, 6).map((target) => target.key)).toEqual(
      siblingOrderIds,
    );
    // Every lock of the mutation is an exclusive `for update` acquisition
    // except the idempotency record, which only its own UPDATE pins.
    expect(locks.locks.map((target) => target.strength)).toEqual([
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'NO_KEY_UPDATE',
    ]);
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
        reservations: 0,
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
      reservations: 0,
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
      reservations: 0,
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
      reservations: 0,
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
      expect(
        [...hostile.reads.entries()].filter(([, count]) => count !== 1),
      ).toEqual([]);
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
      'UnitOfWork',
      'UnknownCommitOutcomeError',
      'commitTradingMutation',
    ]);
    expect(Object.keys(lockOrderModule).sort()).toEqual([
      'LEDGER_LOCK_ORDER',
      'LEDGER_REFERENCE_TABLES',
      'createLockOrderGuard',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock accounting
//
// The guarantee under test is not "the five `for update` readers are ordered"
// but "every row lock a repository method takes is accounted for by the
// ordering discipline". An `update` takes a lock without saying so, and an
// `insert` takes one on every foreign-key parent it pins, so the tests below
// measure the locks PostgreSQL actually holds and compare them against the
// locks the guard was told about.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-08-22T00:00:00.000Z');

async function insertIdempotencyRow(
  sessionId: string,
  key: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into idempotency_requests (
      id, session_id, idempotency_key, request_hash, status
    ) values (${id}, ${sessionId}, ${key}, 'hash-existing', 'IN_PROGRESS')
  `.execute(db);
  return id;
}

async function insertReservationRow(
  sessionId: string,
  orderId: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into reservations (
      id, session_id, order_id, kind, currency, amount
    ) values (${id}, ${sessionId}, ${orderId}, 'CASH', 'KRW', '1')
  `.execute(db);
  return id;
}

async function insertOutboxRow(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into outbox_events (
      id, event_id, session_id, stream_sequence, event_type, payload
    ) values (
      ${id}, ${randomUUID()}, ${sessionId}, 1, 'FIXTURE', '{}'::jsonb
    )
  `.execute(db);
  return id;
}

async function insertAuditRow(): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into audit_events (id, event_type, payload, occurred_at)
    values (${id}, 'FIXTURE', '{}'::jsonb, ${FIXED_NOW})
  `.execute(db);
  return id;
}

interface VersionedRow {
  readonly version: string;
}

async function readVersion(table: string, id: string): Promise<string> {
  const result = await sql<VersionedRow>`
    select version from ${sql.table(table)} where id = ${id}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`${table} row ${id} does not exist`);
  }
  return row.version;
}

async function readIdempotencyStatus(
  sessionId: string,
  key: string,
): Promise<string> {
  const result = await sql<{ status: string }>`
    select status from idempotency_requests
    where session_id = ${sessionId} and idempotency_key = ${key}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`idempotency key ${key} does not exist`);
  }
  return row.status;
}

/** A wallet snapshot the caller assembled itself, without locking the row. */
function unlockedWallet(
  walletId: string,
  sessionId: string,
  version: bigint,
): LockedWallet {
  return {
    id: walletId,
    sessionId,
    currency: 'KRW',
    total: '1000',
    available: '1000',
    reserved: '0',
    version,
  };
}

function unlockedPosition(
  positionId: string,
  sessionId: string,
  version: bigint,
): LockedPosition {
  return {
    id: positionId,
    sessionId,
    marketCode: 'US',
    symbol: 'AAPL',
    total: '10',
    available: '10',
    reserved: '0',
    averageCost: '100',
    version,
  };
}

interface LedgerFixture {
  readonly sessionId: string;
  readonly walletId: string;
  readonly positionId: string;
  readonly ocoGroupId: string;
  readonly lowerOrderId: string;
  readonly higherOrderId: string;
  readonly reservationId: string;
  readonly outboxId: string;
  readonly auditId: string;
  readonly idempotencyId: string;
  readonly idempotencyKey: string;
}

async function ledgerFixture(): Promise<LedgerFixture> {
  const sessionId = await insertSession();
  const walletId = await insertWallet(sessionId, 'KRW', '1000');
  const positionId = await insertPosition(sessionId, 'AAPL', '10');
  const ocoGroupId = await insertOcoGroup(sessionId);
  const first = await insertOrderRow(sessionId);
  const second = await insertOrderRow(sessionId);
  const lowerOrderId = first < second ? first : second;
  const higherOrderId = first < second ? second : first;
  const idempotencyKey = 'existing-key';

  return {
    sessionId,
    walletId,
    positionId,
    ocoGroupId,
    lowerOrderId,
    higherOrderId,
    reservationId: await insertReservationRow(sessionId, lowerOrderId),
    outboxId: await insertOutboxRow(sessionId),
    auditId: await insertAuditRow(),
    idempotencyId: await insertIdempotencyRow(sessionId, idempotencyKey),
    idempotencyKey,
  };
}

type ObservedLockMode = LockStrength | 'NONE';

interface ObservableRow {
  /** `${table}:${lock key}`, the label the guard's declaration produces. */
  readonly label: string;
  readonly table: string;
  readonly column: 'id' | 'code';
  readonly value: string;
  /**
   * Immutable reference rows are deliberately outside the lock order: see
   * LEDGER_REFERENCE_TABLES.
   */
  readonly reference: boolean;
}

function observableRows(fixture: LedgerFixture): readonly ObservableRow[] {
  const ranked = (
    table: LockTable,
    key: string,
    value: string,
  ): ObservableRow => ({
    label: `${table}:${key}`,
    table,
    column: 'id',
    value,
    reference: false,
  });

  return [
    ranked('anonymous_sessions', fixture.sessionId, fixture.sessionId),
    ranked('wallets', `${fixture.sessionId}:KRW`, fixture.walletId),
    ranked('positions', `${fixture.sessionId}:US:AAPL`, fixture.positionId),
    ranked('oco_groups', fixture.ocoGroupId, fixture.ocoGroupId),
    ranked('orders', fixture.lowerOrderId, fixture.lowerOrderId),
    ranked('orders', fixture.higherOrderId, fixture.higherOrderId),
    ranked(
      'idempotency_requests',
      `${fixture.sessionId}:${fixture.idempotencyKey}`,
      fixture.idempotencyId,
    ),
    // Unranked tables the repositories write. Nothing may ever lock a row in
    // one of them: a lock here could not be declared, because acquireLock
    // refuses a table with no rank.
    {
      label: `reservations:${fixture.reservationId}`,
      table: 'reservations',
      column: 'id',
      value: fixture.reservationId,
      reference: false,
    },
    {
      label: `outbox_events:${fixture.outboxId}`,
      table: 'outbox_events',
      column: 'id',
      value: fixture.outboxId,
      reference: false,
    },
    {
      label: `audit_events:${fixture.auditId}`,
      table: 'audit_events',
      column: 'id',
      value: fixture.auditId,
      reference: false,
    },
    {
      label: 'markets:US',
      table: 'markets',
      column: 'code',
      value: 'US',
      reference: true,
    },
  ];
}

const LOCK_NOT_AVAILABLE = '55P03';

/**
 * True when a second backend can take `mode` on the row right now. Each probe
 * is its own statement, so the lock it takes on a free row is released before
 * the next probe runs.
 */
async function lockIsAvailable(
  row: ObservableRow,
  mode: string,
): Promise<boolean> {
  try {
    await sql`
      select 1 from ${sql.table(row.table)}
      where ${sql.ref(row.column)} = ${row.value}
      ${sql.raw(mode)} nowait
    `.execute(db);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      return false;
    }
    throw error;
  }
}

/**
 * The strongest lock another transaction holds on `row`, read off PostgreSQL's
 * own conflict matrix from a second backend: `for update` conflicts with every
 * row lock, `for no key update` with all but `for key share`, and `for key
 * share` only with `for update`.
 */
async function observeLock(row: ObservableRow): Promise<ObservedLockMode> {
  if (await lockIsAvailable(row, 'for update')) {
    return 'NONE';
  }
  if (await lockIsAvailable(row, 'for no key update')) {
    return 'KEY_SHARE';
  }
  if (await lockIsAvailable(row, 'for key share')) {
    return 'NO_KEY_UPDATE';
  }
  return 'UPDATE';
}

type LockProbe = (
  tx: TradingTransaction,
  fixture: LedgerFixture,
) => Promise<unknown>;

/**
 * One probe per repository method. The suite asserts that this table covers
 * every method of every repository, so a new method cannot be added — and
 * cannot take an undeclared lock — without a probe that measures it.
 */
const LOCK_PROBES: Readonly<Record<string, LockProbe>> = {
  'sessions.find': (tx, fixture) => tx.sessions.find(fixture.sessionId),
  'sessions.lock': (tx, fixture) => tx.sessions.lock(fixture.sessionId),
  'sessions.touch': (tx, fixture) =>
    tx.sessions.touch({
      sessionId: fixture.sessionId,
      expectedVersion: 0n,
      lastSeenAt: FIXED_NOW,
    }),
  'accounts.lockWallet': (tx, fixture) =>
    tx.accounts.lockWallet({ sessionId: fixture.sessionId, currency: 'KRW' }),
  'accounts.lockPosition': (tx, fixture) =>
    tx.accounts.lockPosition({
      sessionId: fixture.sessionId,
      marketCode: 'US',
      symbol: 'AAPL',
    }),
  'accounts.reserveCash': async (tx, fixture) => {
    const wallet = await tx.accounts.lockWallet({
      sessionId: fixture.sessionId,
      currency: 'KRW',
    });
    if (wallet === undefined) {
      throw new Error('the wallet disappeared');
    }
    return await tx.accounts.reserveCash({ wallet, amount: '10' });
  },
  'accounts.reservePosition': async (tx, fixture) => {
    const position = await tx.accounts.lockPosition({
      sessionId: fixture.sessionId,
      marketCode: 'US',
      symbol: 'AAPL',
    });
    if (position === undefined) {
      throw new Error('the position disappeared');
    }
    return await tx.accounts.reservePosition({ position, quantity: '1' });
  },
  'accounts.recordReservation': (tx, fixture) =>
    tx.accounts.recordReservation({
      id: randomUUID(),
      sessionId: fixture.sessionId,
      orderId: fixture.lowerOrderId,
      kind: 'POSITION',
      amount: '1',
      marketCode: 'US',
      symbol: 'AAPL',
    }),
  'orders.insert': (tx, fixture) =>
    tx.orders.insert({
      id: randomUUID(),
      sessionId: fixture.sessionId,
      marketCode: 'US',
      symbol: 'AAPL',
      orderType: 'LIMIT',
      side: 'BUY',
      limitPrice: '100',
      quantity: '1',
      status: 'OPEN',
      ocoGroupId: fixture.ocoGroupId,
    }),
  'orders.lock': (tx, fixture) => tx.orders.lock(fixture.lowerOrderId),
  'orders.lockOcoGroup': (tx, fixture) =>
    tx.orders.lockOcoGroup(fixture.ocoGroupId),
  'orders.update': (tx, fixture) =>
    tx.orders.update({
      id: fixture.lowerOrderId,
      expectedVersion: 0n,
      status: 'CANCELLED',
    }),
  'orders.resolveOcoGroup': (tx, fixture) =>
    tx.orders.resolveOcoGroup({
      id: fixture.ocoGroupId,
      expectedVersion: 0n,
      resolvedAt: FIXED_NOW,
    }),
  'audit.append': (tx, fixture) =>
    tx.audit.append({
      id: randomUUID(),
      eventType: 'ORDER_PLACED',
      payload: { probe: 'audit' },
      occurredAt: FIXED_NOW,
      orderId: fixture.lowerOrderId,
    }),
  'outbox.append': (tx, fixture) =>
    tx.outbox.append({
      id: randomUUID(),
      eventId: randomUUID(),
      sessionId: fixture.sessionId,
      streamSequence: 2n,
      eventType: 'ORDER_PLACED',
      payload: { probe: 'outbox' },
    }),
  'idempotency.begin': (tx, fixture) =>
    tx.idempotency.begin({
      sessionId: fixture.sessionId,
      key: 'fresh-key',
      requestHash: 'hash-fresh',
    }),
  'idempotency.find': (tx, fixture) =>
    tx.idempotency.find({
      sessionId: fixture.sessionId,
      key: fixture.idempotencyKey,
    }),
  'idempotency.complete': (tx, fixture) =>
    tx.idempotency.complete({
      sessionId: fixture.sessionId,
      key: fixture.idempotencyKey,
      statusCode: 201,
      body: { accepted: true },
    }),
};

interface LockAccounting {
  readonly declared: Record<string, LockStrength>;
  readonly observed: Record<string, ObservedLockMode>;
  readonly referenceModes: readonly ObservedLockMode[];
}

/**
 * Runs one probe, parks its transaction while it still holds everything it
 * took, and measures the ledger's rows from a second backend.
 */
async function accountForLocks(probe: LockProbe): Promise<LockAccounting> {
  const fixture = await ledgerFixture();
  const locks = recordLocks();
  const unitOfWork = new UnitOfWork(db, {
    backoff: recordBackoff().backoff,
    onLock: locks.onLock,
  });
  const acquired = gate();
  const mayCommit = gate();

  const run = unitOfWork.run(async (tx) => {
    try {
      await probe(tx, fixture);
    } finally {
      acquired.open();
    }
    await mayCommit.opened;
  });
  run.catch(() => undefined);
  await acquired.opened;

  const declared: Record<string, LockStrength> = {};
  for (const target of locks.locks) {
    declared[`${target.table}:${target.key}`] = target.strength;
  }

  const observed: Record<string, ObservedLockMode> = {};
  const referenceModes: ObservedLockMode[] = [];
  for (const row of observableRows(fixture)) {
    const mode = await observeLock(row);
    if (row.reference) {
      referenceModes.push(mode);
      continue;
    }
    if (mode !== 'NONE') {
      observed[row.label] = mode;
    }
  }

  mayCommit.open();
  await run;
  return { declared, observed, referenceModes };
}

describe('lock accounting', () => {
  it('has a probe for every repository method', async () => {
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    const methods = await unitOfWork.run(async (tx) =>
      Object.entries({
        sessions: tx.sessions,
        accounts: tx.accounts,
        orders: tx.orders,
        audit: tx.audit,
        outbox: tx.outbox,
        idempotency: tx.idempotency,
      }).flatMap(([repository, api]) =>
        Object.keys(api).map((method) => `${repository}.${method}`),
      ),
    );

    // A new repository method with no probe is a method whose locks nobody
    // measured, which is exactly how an undeclared lock ships.
    expect([...methods].sort()).toEqual(Object.keys(LOCK_PROBES).sort());
  });

  it(
    'declares exactly the row locks PostgreSQL actually holds, for every method',
    async () => {
      const mismatches: Record<
        string,
        {
          declared: Record<string, LockStrength>;
          observed: Record<string, ObservedLockMode>;
        }
      > = {};
      const strongerThanShared: Record<string, readonly ObservedLockMode[]> =
        {};

      for (const [method, probe] of Object.entries(LOCK_PROBES)) {
        const accounting = await accountForLocks(probe);
        if (
          JSON.stringify(accounting.observed) !==
          JSON.stringify(accounting.declared)
        ) {
          mismatches[method] = {
            declared: accounting.declared,
            observed: accounting.observed,
          };
        }
        const stronger = accounting.referenceModes.filter(
          (mode) => mode === 'NO_KEY_UPDATE' || mode === 'UPDATE',
        );
        if (stronger.length > 0) {
          strongerThanShared[method] = stronger;
        }
      }

      expect(mismatches).toEqual({});
      // Reference rows stay outside the lock order only because every lock on
      // them is shared, and shared locks never wait on one another.
      expect(strongerThanShared).toEqual({});
      expect(LEDGER_REFERENCE_TABLES).toEqual(['markets']);
    },
    CONTAINER_TIMEOUT_MS,
  );
});

describe('the lock-order guard', () => {
  it('refuses a table that has no rank in the lock order', () => {
    const guard = createLockOrderGuard();

    expect(() =>
      guard.acquireLock({
        table: 'fills' as LockTable,
        key: 'row',
        strength: 'UPDATE',
      }),
    ).toThrow(DomainError);
    expect(() =>
      guard.acquireLock({
        table: 'fills' as LockTable,
        key: 'row',
        strength: 'UPDATE',
      }),
    ).toThrow('no rank');
  });

  it('orders two rows of one table by their keys', () => {
    const guard = createLockOrderGuard();

    guard.acquireLock({ table: 'orders', key: 'b', strength: 'UPDATE' });

    expect(() =>
      guard.acquireLock({ table: 'orders', key: 'a', strength: 'UPDATE' }),
    ).toThrow('lock order violation');
  });

  it('exempts a row it already holds at an equal or weaker strength', () => {
    const observed: LockTarget[] = [];
    const guard = createLockOrderGuard((target) => observed.push(target));

    guard.acquireLock({ table: 'wallets', key: 'w', strength: 'UPDATE' });
    guard.acquireLock({ table: 'orders', key: 'o', strength: 'UPDATE' });
    // Re-locking a held row acquires nothing, so it cannot extend a wait cycle
    // and needs no ordering.
    guard.acquireLock({ table: 'wallets', key: 'w', strength: 'UPDATE' });
    guard.acquireLock({
      table: 'wallets',
      key: 'w',
      strength: 'NO_KEY_UPDATE',
    });
    guard.acquireLock({ table: 'wallets', key: 'w', strength: 'KEY_SHARE' });

    expect(observed).toEqual([
      { table: 'wallets', key: 'w', strength: 'UPDATE' },
      { table: 'orders', key: 'o', strength: 'UPDATE' },
    ]);
  });

  it('refuses a strengthening of a held lock that goes backwards', () => {
    const guard = createLockOrderGuard();

    // A foreign-key check pins the session row shared; the order row is then
    // locked exclusively. Upgrading the session row afterwards is a real
    // acquisition that can block, so it must obey the order.
    guard.acquireLock({
      table: 'anonymous_sessions',
      key: 's',
      strength: 'KEY_SHARE',
    });
    guard.acquireLock({ table: 'orders', key: 'o', strength: 'UPDATE' });

    expect(() =>
      guard.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'UPDATE',
      }),
    ).toThrow('lock order violation');
  });

  it('allows a strengthening of a held lock that keeps the order', () => {
    const observed: LockTarget[] = [];
    const guard = createLockOrderGuard((target) => observed.push(target));

    guard.acquireLock({
      table: 'anonymous_sessions',
      key: 's',
      strength: 'KEY_SHARE',
    });
    guard.acquireLock({
      table: 'anonymous_sessions',
      key: 's',
      strength: 'UPDATE',
    });
    guard.acquireLock({ table: 'orders', key: 'o', strength: 'KEY_SHARE' });

    expect(observed).toEqual([
      { table: 'anonymous_sessions', key: 's', strength: 'KEY_SHARE' },
      { table: 'anonymous_sessions', key: 's', strength: 'UPDATE' },
      { table: 'orders', key: 'o', strength: 'KEY_SHARE' },
    ]);
  });

  it('ranks every table of the lock order exactly once', () => {
    expect(new Set(LEDGER_LOCK_ORDER).size).toBe(LEDGER_LOCK_ORDER.length);
    expect(
      LEDGER_LOCK_ORDER.filter((table) =>
        (LEDGER_REFERENCE_TABLES as readonly string[]).includes(table),
      ),
    ).toEqual([]);
  });
});

interface InversionCase {
  readonly name: string;
  readonly invert: (
    tx: TradingTransaction,
    fixture: LedgerFixture,
  ) => Promise<unknown>;
}

const INVERSION_CASES: readonly InversionCase[] = [
  {
    name: 'sessions.touch after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.sessions.touch({
        sessionId: fixture.sessionId,
        expectedVersion: 0n,
        lastSeenAt: FIXED_NOW,
      });
    },
  },
  {
    name: 'accounts.reserveCash after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.accounts.reserveCash({
        wallet: unlockedWallet(fixture.walletId, fixture.sessionId, 0n),
        amount: '10',
      });
    },
  },
  {
    name: 'accounts.reservePosition after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.accounts.reservePosition({
        position: unlockedPosition(fixture.positionId, fixture.sessionId, 0n),
        quantity: '1',
      });
    },
  },
  {
    name: 'accounts.recordReservation after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.higherOrderId);
      return await tx.accounts.recordReservation({
        id: randomUUID(),
        sessionId: fixture.sessionId,
        orderId: fixture.higherOrderId,
        kind: 'CASH',
        amount: '1',
        currency: 'KRW',
      });
    },
  },
  {
    name: 'orders.insert after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.orders.insert({
        id: randomUUID(),
        sessionId: fixture.sessionId,
        marketCode: 'US',
        symbol: 'AAPL',
        orderType: 'LIMIT',
        side: 'BUY',
        limitPrice: '100',
        quantity: '1',
        status: 'OPEN',
      });
    },
  },
  {
    name: 'orders.resolveOcoGroup after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.orders.resolveOcoGroup({
        id: fixture.ocoGroupId,
        expectedVersion: 0n,
        resolvedAt: FIXED_NOW,
      });
    },
  },
  {
    name: 'orders.update after the idempotency record is written',
    invert: async (tx, fixture) => {
      await tx.idempotency.complete({
        sessionId: fixture.sessionId,
        key: fixture.idempotencyKey,
        statusCode: 201,
        body: { accepted: true },
      });
      return await tx.orders.update({
        id: fixture.lowerOrderId,
        expectedVersion: 0n,
        status: 'CANCELLED',
      });
    },
  },
  {
    name: 'outbox.append after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.outbox.append({
        id: randomUUID(),
        eventId: randomUUID(),
        sessionId: fixture.sessionId,
        streamSequence: 2n,
        eventType: 'ORDER_PLACED',
        payload: { probe: 'outbox' },
      });
    },
  },
  {
    name: 'idempotency.begin after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.idempotency.begin({
        sessionId: fixture.sessionId,
        key: 'fresh-key',
        requestHash: 'hash-fresh',
      });
    },
  },
  {
    name: 'a second order locked by a lower id',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.higherOrderId);
      return await tx.orders.lock(fixture.lowerOrderId);
    },
  },
];

describe('write paths obey the global lock order', () => {
  it(
    'refuses every write that would take a lock out of order',
    async () => {
      const outcomes: Record<string, string> = {};
      const expected: Record<string, string> = {};

      for (const inversion of INVERSION_CASES) {
        const fixture = await ledgerFixture();
        const backoff = recordBackoff();
        const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

        const error = await unitOfWork
          .run(async (tx) => inversion.invert(tx, fixture))
          .then(
            () => undefined,
            (caught: unknown) => caught,
          );

        outcomes[inversion.name] =
          error instanceof DomainError
            ? `${error.code}|${error.message.includes('lock order') ? 'lock order' : error.message}`
            : `${String(error)}`;
        expected[inversion.name] = 'INVARIANT_VIOLATION|lock order';
        // A lock-order defect is a bug, never a transient condition.
        expect(backoff.attempts).toEqual([]);
      }

      expect(outcomes).toEqual(expected);
    },
    TEST_TIMEOUT_MS,
  );

  it('lets an append-only write with no foreign key run at any point', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    // audit_events references nothing, so it locks nothing and orders nothing.
    await unitOfWork.run(async (tx) => {
      await tx.orders.lock(fixture.lowerOrderId);
      await tx.audit.append({
        id: randomUUID(),
        eventType: 'ORDER_PLACED',
        payload: { probe: 'audit' },
        occurredAt: FIXED_NOW,
      });
    });

    expect((await countLedgerRows(db)).audit).toBe(2);
  });

  it(
    'turns the update-then-lock deadlock into a refusal instead of a 40P01',
    async () => {
      const fixture = await ledgerFixture();
      const inverting = recordBackoff();
      const documented = recordBackoff();
      const invertingUnitOfWork = new UnitOfWork(db, {
        backoff: inverting.backoff,
      });
      const documentedUnitOfWork = new UnitOfWork(db, {
        backoff: documented.backoff,
      });
      const orderLocked = gate();
      const sessionLocked = gate();

      // The reproduction lane B used: one transaction takes the order row and
      // then touches the session, the other follows the documented session ->
      // order direction. Before the write paths declared their locks this was a
      // real PostgreSQL deadlock with the guard silent.
      const inverted = invertingUnitOfWork.run(async (tx) => {
        await tx.orders.lock(fixture.lowerOrderId);
        orderLocked.open();
        await sessionLocked.opened;
        await tx.sessions.touch({
          sessionId: fixture.sessionId,
          expectedVersion: 0n,
          lastSeenAt: FIXED_NOW,
        });
      });
      inverted.catch(() => undefined);

      const ordered = documentedUnitOfWork.run(async (tx) => {
        await orderLocked.opened;
        await tx.sessions.lock(fixture.sessionId);
        sessionLocked.open();
        await tx.orders.lock(fixture.lowerOrderId);
        return 'committed';
      });

      await expect(inverted).rejects.toMatchObject({
        code: 'INVARIANT_VIOLATION',
      });
      await expect(ordered).resolves.toBe('committed');
      expect(inverting.attempts).toEqual([]);
      expect(documented.attempts).toEqual([]);
      expect(await readVersion('anonymous_sessions', fixture.sessionId)).toBe(
        '0',
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'turns the insert-then-lock deadlock through an OCO parent into a refusal',
    async () => {
      const fixture = await ledgerFixture();
      const inverting = recordBackoff();
      const documented = recordBackoff();
      const invertingUnitOfWork = new UnitOfWork(db, {
        backoff: inverting.backoff,
      });
      const documentedUnitOfWork = new UnitOfWork(db, {
        backoff: documented.backoff,
      });
      const orderLocked = gate();
      const groupLocked = gate();

      const inverted = invertingUnitOfWork.run(async (tx) => {
        await tx.orders.lock(fixture.lowerOrderId);
        orderLocked.open();
        await groupLocked.opened;
        // The foreign key on oco_group_id pins the rank-3 group row.
        await tx.orders.insert({
          id: randomUUID(),
          sessionId: fixture.sessionId,
          marketCode: 'US',
          symbol: 'AAPL',
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: '100',
          quantity: '1',
          status: 'OPEN',
          ocoGroupId: fixture.ocoGroupId,
        });
      });
      inverted.catch(() => undefined);

      const ordered = documentedUnitOfWork.run(async (tx) => {
        await orderLocked.opened;
        await tx.orders.lockOcoGroup(fixture.ocoGroupId);
        groupLocked.open();
        await tx.orders.lock(fixture.lowerOrderId);
        return 'committed';
      });

      await expect(inverted).rejects.toMatchObject({
        code: 'INVARIANT_VIOLATION',
      });
      await expect(ordered).resolves.toBe('committed');
      expect(inverting.attempts).toEqual([]);
      expect(documented.attempts).toEqual([]);
      expect((await countLedgerRows(db)).orders).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('optimistic versioning on every versioned table', () => {
  it('refuses a stale session version and mutates nothing', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      unitOfWork.run(async (tx) =>
        tx.sessions.touch({
          sessionId: fixture.sessionId,
          expectedVersion: 7n,
          lastSeenAt: FIXED_NOW,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    expect(await readVersion('anonymous_sessions', fixture.sessionId)).toBe(
      '0',
    );
  });

  it('refuses a stale wallet version and mutates nothing', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    // The balances are sufficient, so only the version predicate can refuse
    // this: the reservation itself is a legal one.
    await expect(
      unitOfWork.run(async (tx) =>
        tx.accounts.reserveCash({
          wallet: unlockedWallet(fixture.walletId, fixture.sessionId, 7n),
          amount: '10',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    expect(await readWallet(fixture.walletId)).toEqual({
      total: '1000',
      available: '1000',
      reserved: '0',
      version: '0',
    });
  });

  it('refuses a stale position version and mutates nothing', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      unitOfWork.run(async (tx) =>
        tx.accounts.reservePosition({
          position: unlockedPosition(fixture.positionId, fixture.sessionId, 7n),
          quantity: '1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    expect(await readVersion('positions', fixture.positionId)).toBe('0');
  });

  it('refuses a stale OCO group version and mutates nothing', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      unitOfWork.run(async (tx) =>
        tx.orders.resolveOcoGroup({
          id: fixture.ocoGroupId,
          expectedVersion: 7n,
          resolvedAt: FIXED_NOW,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    expect(await readVersion('oco_groups', fixture.ocoGroupId)).toBe('0');
  });

  it('refuses to complete an idempotency record twice', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });
    const complete = {
      sessionId: fixture.sessionId,
      key: fixture.idempotencyKey,
      statusCode: 201,
      body: { accepted: true },
    };

    await unitOfWork.run(async (tx) => tx.idempotency.complete(complete));

    // `status = 'IN_PROGRESS'` is this table's expected version: a recorded
    // result must never be overwritten by a second completion.
    await expect(
      unitOfWork.run(async (tx) =>
        tx.idempotency.complete({ ...complete, statusCode: 500 }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    expect(
      await readIdempotencyStatus(fixture.sessionId, fixture.idempotencyKey),
    ).toBe('COMPLETED');
    const result = await sql<{ response_status_code: number }>`
      select response_status_code from idempotency_requests
      where id = ${fixture.idempotencyId}
    `.execute(db);
    expect(result.rows[0]?.response_status_code).toBe(201);
  });
});

describe('boundary values that are not representable', () => {
  it('refuses a response body that is not JSON', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      commitTradingMutation(
        unitOfWork,
        mutationInput(sessionId, {
          response: { statusCode: 201, body: undefined },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });

    expect(await countLedgerRows(db)).toEqual({
      orders: 0,
      audit: 0,
      outbox: 0,
      idempotency: 0,
      reservations: 0,
    });
  });

  it('refuses an audit payload that is not JSON', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '1000');
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      commitTradingMutation(
        unitOfWork,
        mutationInput(sessionId, {
          audit: {
            id: randomUUID(),
            eventType: 'ORDER_PLACED',
            payload: undefined,
            occurredAt: FIXED_NOW,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });

    expect(await countLedgerRows(db)).toEqual({
      orders: 0,
      audit: 0,
      outbox: 0,
      idempotency: 0,
      reservations: 0,
    });
  });
});

describe('retry classification of hostile errors', () => {
  it('never retries a domain error that claims a retryable SQLSTATE', async () => {
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });
    let executions = 0;

    await expect(
      unitOfWork.run(async () => {
        executions += 1;
        const tampered = new DomainError('ORDER_STATE_CONFLICT', 'tampered');
        // A domain error is a decision. Reading a SQLSTATE off one — however it
        // got there — must never turn it into a replay.
        Object.defineProperty(tampered, 'code', { value: '40001' });
        throw tampered;
      }),
    ).rejects.toBeInstanceOf(DomainError);

    expect(executions).toBe(1);
    expect(backoff.attempts).toEqual([]);
  });

  it(
    'keeps the driver error that exhausted the retries as the cause',
    async () => {
      const sessionId = await insertSession();
      const walletId = await insertWallet(sessionId, 'KRW', '1000');
      const unitOfWork = new UnitOfWork(db, {
        backoff: recordBackoff().backoff,
        isolationLevel: 'serializable',
        maxRetries: 1,
      });

      const error = await unitOfWork
        .run(async (tx) => {
          await tx.sessions.find(sessionId);
          await bumpWalletFromOutside(walletId);
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(DomainError);
      // A post-mortem needs the driver's own detail, not just the SQLSTATE in
      // a message string.
      expect((error as { cause?: unknown }).cause).toMatchObject({
        code: '40001',
      });
    },
    TEST_TIMEOUT_MS,
  );
});
