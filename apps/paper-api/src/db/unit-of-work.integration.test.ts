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
import { createDatabase, type Database, snapshotInput } from './database.js';
import * as lockOrderModule from './lock-order.js';
import {
  compositeLockKey,
  createLockOrderGuard,
  LEDGER_LOCK_ORDER,
  LEDGER_REFERENCE_TABLES,
  LEDGER_UNIQUE_INDEXES,
  type LockStrength,
  type LockTable,
  type LockTarget,
  ocoWinnerClaimKey,
  sequenceLockKey,
  type UniqueKeyClaim,
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
  type TradingMutationResult,
  type TradingTransaction,
  UnitOfWork,
  UnknownCommitOutcomeError,
} from './unit-of-work.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 60_000;
const GATE_TIMEOUT_MS = 30_000;
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
  readonly claims: readonly UniqueKeyClaim[];
  readonly onLock: (target: LockTarget) => void;
  readonly onClaim: (claim: UniqueKeyClaim) => void;
} {
  const locks: LockTarget[] = [];
  const claims: UniqueKeyClaim[] = [];
  return {
    locks,
    claims,
    onLock: (target: LockTarget) => {
      locks.push(target);
    },
    onClaim: (claim: UniqueKeyClaim) => {
      claims.push(claim);
    },
  };
}

interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

/**
 * A one-shot gate that fails rather than hangs.
 *
 * A gate that never opens used to present as a hung run with no red test, which
 * is the worst possible failure mode for a suite of gated concurrency tests: it
 * hides a real defect behind a timeout nobody attributes. The rejection is
 * pre-handled so a gate that is never awaited cannot raise an unhandled
 * rejection either.
 */
function gate(): Gate {
  let open = (): void => {
    throw new Error('gate was not initialised');
  };
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('a test gate never opened'));
    }, GATE_TIMEOUT_MS);
    open = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  opened.catch(() => undefined);
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
        // A claiming statement pins the session after it writes its entry, so
        // the session has to be held before it runs.
        await tx.sessions.lock(sessionId);
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
        await orderFixture(tx, sessionId);
        await auditFixture(tx, sessionId);
        await outboxFixture(tx, sessionId);
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

  it(
    'keeps total = available + reserved across twenty concurrent rounds',
    async () => {
      const sessionId = await insertSession();
      const walletId = await insertWallet(sessionId, 'KRW', '1000');
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });
      let succeeded = 0;

      for (let round = 0; round < 20; round += 1) {
        const settled = await Promise.allSettled(
          Array.from({ length: 4 }, () =>
            unitOfWork.run(async (tx) => {
              const wallet = await tx.accounts.lockWallet({
                sessionId,
                currency: 'KRW',
              });
              if (wallet === undefined) {
                throw new Error('the wallet disappeared');
              }
              await tx.accounts.reserveCash({ wallet, amount: '10' });
            }),
          ),
        );
        succeeded += settled.filter(
          (outcome) => outcome.status === 'fulfilled',
        ).length;

        // Checked after every round, not only at the end: a round that broke
        // the identity and a later one that restored it would both be hidden by
        // a single final assertion.
        const wallet = await readWallet(walletId);
        expect(BigInt(wallet.total)).toBe(
          BigInt(wallet.available) + BigInt(wallet.reserved),
        );
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
      }

      // Every one of the eighty reservations is serialised by the row lock, so
      // every one of them commits.
      expect(succeeded).toBe(80);
      const wallet = await readWallet(walletId);
      expect([wallet.total, wallet.available, wallet.reserved]).toEqual([
        '1000',
        '200',
        '800',
      ]);
      expect(backoff.attempts).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it('documents one global lock order and rejects any inversion of it', async () => {
    expect(LEDGER_LOCK_ORDER).toEqual([
      'anonymous_sessions',
      'idempotency_requests',
      'wallets',
      'positions',
      'oco_groups',
      'orders',
      'outbox_events',
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
      onClaim: locks.onClaim,
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
      'idempotency_requests',
      'wallets',
      'positions',
      'oco_groups',
      'orders',
      'orders',
    ]);
    // Sibling order rows are locked by ascending id even though the caller
    // supplied them in the opposite order.
    expect(locks.locks.slice(5, 7).map((target) => target.key)).toEqual(
      siblingOrderIds,
    );
    // Every lock of the mutation is an exclusive `for update` acquisition
    // except the idempotency record, which only its own UPDATE pins.
    expect(locks.locks.map((target) => target.strength)).toEqual([
      'UPDATE',
      'NO_KEY_UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
      'UPDATE',
    ]);
    // The two unique-index entries the mutation writes are claimed in the same
    // order, and the claim of the idempotency key comes before the rank-2
    // wallet rather than after it.
    expect(locks.claims).toEqual([
      {
        table: 'idempotency_requests',
        key: `${sessionId}:key-1`,
        index: 'idempotency_requests_session_id_idempotency_key_key',
      },
      {
        table: 'outbox_events',
        key: `${sessionId}:00000000000000000001`,
        index: 'outbox_events_session_id_stream_sequence_key',
      },
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

  it(
    'replays one key under eight-way concurrency with exactly one effect',
    async () => {
      const sessionId = await insertSession();
      const walletId = await insertWallet(sessionId, 'KRW', '1000');
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });
      // One request, eight times at once. Every one of them locks the session
      // first, so they serialise on the rank-0 row: one does the work and the
      // rest find the recorded result rather than an in-progress claim.
      const input = mutationInput(sessionId);

      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          commitTradingMutation(unitOfWork, input),
        ),
      );

      const results = settled.map((outcome) =>
        outcome.status === 'fulfilled'
          ? `replayed=${(outcome.value as TradingMutationResult).replayed}`
          : settledCode(outcome),
      );
      expect(results.filter((result) => result === 'replayed=false')).toEqual([
        'replayed=false',
      ]);
      expect(
        results.filter((result) => result === 'replayed=true'),
      ).toHaveLength(7);
      expect(await countLedgerRows(db)).toEqual({
        orders: 1,
        audit: 1,
        outbox: 1,
        idempotency: 1,
        reservations: 0,
      });
      // The cash was reserved once, not eight times.
      const wallet = await readWallet(walletId);
      expect([wallet.total, wallet.available, wallet.reserved]).toEqual([
        '1000',
        '800',
        '200',
      ]);
      expect(backoff.attempts).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

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

  it('refuses a mutation whose key another writer holds in progress', async () => {
    const sessionId = await insertSession();
    await insertWallet(sessionId, 'KRW', '1000');
    // An abandoned IN_PROGRESS claim committed by another writer. Taking it over
    // would stamp that writer's record with this request's response and commit
    // an order under it, so the mutation refuses instead.
    await insertIdempotencyRow(sessionId, 'in-flight-key');
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

    const error = await commitTradingMutation(
      unitOfWork,
      mutationInput(sessionId, {
        idempotencyKey: 'in-flight-key',
        requestHash: 'hash-existing',
      }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('IDEMPOTENCY_CONFLICT');
    expect((error as DomainError).message).toContain('already in progress');
    expect(backoff.attempts).toEqual([]);
    expect(await readIdempotencyStatus(sessionId, 'in-flight-key')).toBe(
      'IN_PROGRESS',
    );
    expect((await countLedgerRows(db)).orders).toBe(0);
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
      'LEDGER_UNIQUE_INDEXES',
      'compositeLockKey',
      'createLockOrderGuard',
      'ocoWinnerClaimKey',
      'sequenceLockKey',
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

/**
 * Every table a repository statement touches — inserts into, updates, locks, or
 * reaches as a foreign-key parent.
 *
 * The unique-index accounting is scoped to these. `markets` and `fills` are in
 * the list even though nothing writes them, because an insert does pin a market
 * row and a fill's parent order: scoping the accounting to the written tables
 * alone would have made the completeness claim narrower than it reads. The
 * partitions of `audit_events` are excluded by name, and the test below measures
 * that their unique indexes enforce the parent's key rather than a key of their
 * own.
 */
const LEDGER_TOUCHED_TABLES = Object.freeze([
  'anonymous_sessions',
  'idempotency_requests',
  'wallets',
  'positions',
  'oco_groups',
  'orders',
  'outbox_events',
  'reservations',
  'audit_events',
  'account_sequences',
  'fills',
  'markets',
] as const);

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

async function insertAccountSequenceRow(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into account_sequences (
      id, session_id, account_sequence, mutation_kind
    ) values (${id}, ${sessionId}, 1, 'FIXTURE')
  `.execute(db);
  return id;
}

async function insertFillRow(orderId: string): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into fills (id, order_id, quantity, price, fee, slippage)
    values (${id}, ${orderId}, '1', '100', '0', '0')
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
  readonly usdWalletId: string;
  readonly positionId: string;
  readonly ocoGroupId: string;
  readonly lowerOrderId: string;
  readonly higherOrderId: string;
  /** An order that belongs to `ocoGroupId`, so its winner slot is claimable. */
  readonly groupedOrderId: string;
  readonly accountSequenceId: string;
  readonly fillId: string;
  readonly reservationId: string;
  readonly outboxId: string;
  readonly auditId: string;
  readonly idempotencyId: string;
  readonly idempotencyKey: string;
}

async function ledgerFixture(): Promise<LedgerFixture> {
  const sessionId = await insertSession();
  const walletId = await insertWallet(sessionId, 'KRW', '1000');
  const usdWalletId = await insertWallet(sessionId, 'USD', '1000');
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
    usdWalletId,
    positionId,
    ocoGroupId,
    lowerOrderId,
    higherOrderId,
    groupedOrderId: await insertGroupedOrderRow(sessionId, ocoGroupId),
    accountSequenceId: await insertAccountSequenceRow(sessionId),
    fillId: await insertFillRow(lowerOrderId),
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

/**
 * One measurable row, labelled the way the guard's declaration labels it.
 *
 * `reference` is derived from `LEDGER_REFERENCE_TABLES` rather than written by
 * hand, so removing a table from that constant changes what the measurement
 * excludes instead of only failing an assertion about the constant.
 */
function observableRow(
  table: string,
  key: string,
  column: 'id' | 'code',
  value: string,
): ObservableRow {
  return {
    label: `${table}:${key}`,
    table,
    column,
    value,
    reference: (LEDGER_REFERENCE_TABLES as readonly string[]).includes(table),
  };
}

/**
 * Every row the accounting measures.
 *
 * A lock on a row that is not in this list is measured as nothing, so the list
 * has to cover every table any repository statement can reach — including the
 * ones the lock order deliberately omits, which is where an undeclared lock
 * would otherwise hide. `covers every table the ledger names` asserts that.
 */
function observableRows(fixture: LedgerFixture): readonly ObservableRow[] {
  return [
    observableRow(
      'anonymous_sessions',
      fixture.sessionId,
      'id',
      fixture.sessionId,
    ),
    observableRow(
      'idempotency_requests',
      compositeLockKey(fixture.sessionId, fixture.idempotencyKey),
      'id',
      fixture.idempotencyId,
    ),
    observableRow(
      'wallets',
      compositeLockKey(fixture.sessionId, 'KRW'),
      'id',
      fixture.walletId,
    ),
    observableRow(
      'wallets',
      compositeLockKey(fixture.sessionId, 'USD'),
      'id',
      fixture.usdWalletId,
    ),
    observableRow(
      'positions',
      compositeLockKey(fixture.sessionId, 'US', 'AAPL'),
      'id',
      fixture.positionId,
    ),
    observableRow('oco_groups', fixture.ocoGroupId, 'id', fixture.ocoGroupId),
    observableRow('orders', fixture.lowerOrderId, 'id', fixture.lowerOrderId),
    observableRow('orders', fixture.higherOrderId, 'id', fixture.higherOrderId),
    observableRow(
      'orders',
      fixture.groupedOrderId,
      'id',
      fixture.groupedOrderId,
    ),
    // Tables the lock order omits. Nothing may ever lock a row in one of them:
    // a lock here could not be declared, because acquireLock refuses a table
    // with no rank — and for `outbox_events`, which is ranked only so that its
    // unique-key claim has a place, nothing locks a row either.
    observableRow('outbox_events', fixture.outboxId, 'id', fixture.outboxId),
    observableRow(
      'reservations',
      fixture.reservationId,
      'id',
      fixture.reservationId,
    ),
    observableRow('audit_events', fixture.auditId, 'id', fixture.auditId),
    observableRow(
      'account_sequences',
      fixture.accountSequenceId,
      'id',
      fixture.accountSequenceId,
    ),
    observableRow('fills', fixture.fillId, 'id', fixture.fillId),
    observableRow('markets', 'US', 'code', 'US'),
    observableRow('markets', 'KR', 'code', 'KR'),
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
const LOCK_PROBES: Readonly<Record<string, readonly LockProbe[]>> = {
  'sessions.find': [(tx, fixture) => tx.sessions.find(fixture.sessionId)],
  'sessions.findByTokenHash': [(tx) => tx.sessions.findByTokenHash('missing-token-hash')],
  'sessions.bootstrap': [(tx) => tx.sessions.bootstrap({ id: randomUUID(), tokenHash: 'probe-token-hash', now: FIXED_NOW, expiresAt: new Date(FIXED_NOW.getTime() + 1000) })],
  'sessions.lock': [(tx, fixture) => tx.sessions.lock(fixture.sessionId)],
  'sessions.expire': [(tx, fixture) => tx.sessions.expire(fixture.sessionId, FIXED_NOW)],
  'sessions.touch': [
    (tx, fixture) =>
      tx.sessions.touch({
        sessionId: fixture.sessionId,
        expectedVersion: 0n,
        lastSeenAt: FIXED_NOW,
      }),
  ],
  'accounts.lockWallet': [
    (tx, fixture) =>
      tx.accounts.lockWallet({ sessionId: fixture.sessionId, currency: 'KRW' }),
  ],
  'accounts.lockPosition': [
    (tx, fixture) =>
      tx.accounts.lockPosition({
        sessionId: fixture.sessionId,
        marketCode: 'US',
        symbol: 'AAPL',
      }),
  ],
  'accounts.reserveCash': [
    async (tx, fixture) => {
      const wallet = await tx.accounts.lockWallet({
        sessionId: fixture.sessionId,
        currency: 'KRW',
      });
      if (wallet === undefined) {
        throw new Error('the wallet disappeared');
      }
      return await tx.accounts.reserveCash({ wallet, amount: '10' });
    },
    // The probe above pre-locks the row `for update`, which exempts the
    // declaration and leaves its strength unmeasured. This one reserves against
    // a row nobody locked, so the declared strength is the one PostgreSQL takes.
    (tx, fixture) =>
      tx.accounts.reserveCash({
        wallet: unlockedWallet(fixture.walletId, fixture.sessionId, 0n),
        amount: '10',
      }),
  ],
  'accounts.reservePosition': [
    async (tx, fixture) => {
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
    (tx, fixture) =>
      tx.accounts.reservePosition({
        position: unlockedPosition(fixture.positionId, fixture.sessionId, 0n),
        quantity: '1',
      }),
  ],
  'accounts.recordReservation': [
    (tx, fixture) =>
      tx.accounts.recordReservation({
        id: randomUUID(),
        sessionId: fixture.sessionId,
        orderId: fixture.lowerOrderId,
        kind: 'POSITION',
        amount: '1',
        marketCode: 'US',
        symbol: 'AAPL',
      }),
  ],
  'orders.insert': [
    (tx, fixture) =>
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
  ],
  'orders.lock': [(tx, fixture) => tx.orders.lock(fixture.lowerOrderId)],
  'orders.lockOcoGroup': [
    (tx, fixture) => tx.orders.lockOcoGroup(fixture.ocoGroupId),
  ],
  'orders.update': [
    (tx, fixture) =>
      tx.orders.update({
        id: fixture.lowerOrderId,
        expectedVersion: 0n,
        status: 'CANCELLED',
      }),
    // The three columns the first probe never writes. `is_oco_winner` is a
    // column of a partial unique index, so it is the one argument that could
    // change the row lock PostgreSQL takes — and the one that claims the
    // winner slot.
    (tx, fixture) =>
      tx.orders.update({
        id: fixture.groupedOrderId,
        expectedVersion: 0n,
        status: 'FILLED',
        filledQuantity: '10',
        terminalReason: 'IOC_REMAINDER',
        isOcoWinner: true,
        ocoGroupId: fixture.ocoGroupId,
      }),
  ],
  'orders.resolveOcoGroup': [
    (tx, fixture) =>
      tx.orders.resolveOcoGroup({
        id: fixture.ocoGroupId,
        expectedVersion: 0n,
        resolvedAt: FIXED_NOW,
      }),
  ],
  'audit.append': [
    (tx, fixture) =>
      tx.audit.append({
        id: randomUUID(),
        eventType: 'ORDER_PLACED',
        payload: { probe: 'audit' },
        occurredAt: FIXED_NOW,
        orderId: fixture.lowerOrderId,
      }),
  ],
  'outbox.append': [
    // The session pin of a claiming insert is taken after the claim, so it can
    // only ever be a re-declaration of a row the caller already holds — which is
    // why every probe of a claiming method locks the session first, exactly as
    // `commitTradingMutation` does. That leaves the pin's own strength
    // unmeasured here; `orders.insert#0` and `accounts.recordReservation#0`
    // measure that an insert's foreign-key pin is `for key share`.
    async (tx, fixture) => {
      await tx.sessions.lock(fixture.sessionId);
      return await tx.outbox.append({
        id: randomUUID(),
        eventId: randomUUID(),
        sessionId: fixture.sessionId,
        streamSequence: 2n,
        eventType: 'ORDER_PLACED',
        payload: { probe: 'outbox' },
      });
    },
  ],
  'idempotency.begin': [
    async (tx, fixture) => {
      await tx.sessions.lock(fixture.sessionId);
      return await tx.idempotency.begin({
        sessionId: fixture.sessionId,
        key: 'fresh-key',
        requestHash: 'hash-fresh',
      });
    },
  ],
  'idempotency.find': [
    (tx, fixture) =>
      tx.idempotency.find({
        sessionId: fixture.sessionId,
        key: fixture.idempotencyKey,
      }),
  ],
  'idempotency.complete': [
    (tx, fixture) =>
      tx.idempotency.complete({
        sessionId: fixture.sessionId,
        key: fixture.idempotencyKey,
        statusCode: 201,
        body: { accepted: true },
      }),
  ],
};

/**
 * The unique-index entries each probe writes, and therefore the claims it must
 * declare. Every other probe declares none: the empty lists are as load-bearing
 * as the populated ones, because a claim nobody needs is a false ordering
 * constraint.
 */
const EXPECTED_CLAIMS: Readonly<Record<string, readonly string[]>> = {
  'sessions.find#0': [],
  'sessions.findByTokenHash#0': [],
  'sessions.bootstrap#0': [],
  'sessions.lock#0': [],
  'sessions.expire#0': [],
  'sessions.touch#0': [],
  'accounts.lockWallet#0': [],
  'accounts.lockPosition#0': [],
  'accounts.reserveCash#0': [],
  'accounts.reserveCash#1': [],
  'accounts.reservePosition#0': [],
  'accounts.reservePosition#1': [],
  'accounts.recordReservation#0': [],
  'orders.insert#0': [],
  'orders.lock#0': [],
  'orders.lockOcoGroup#0': [],
  'orders.update#0': [],
  'orders.update#1': ['orders_one_oco_winner_per_group'],
  'orders.resolveOcoGroup#0': [],
  'audit.append#0': [],
  'outbox.append#0': ['outbox_events_session_id_stream_sequence_key'],
  'idempotency.begin#0': [
    'idempotency_requests_session_id_idempotency_key_key',
  ],
  'idempotency.find#0': [],
  'idempotency.complete#0': [],
};

interface LockAccounting {
  readonly declared: Record<string, LockStrength>;
  readonly observed: Record<string, ObservedLockMode>;
  readonly claimedIndexes: readonly string[];
  readonly referenceModes: readonly ObservedLockMode[];
}

/**
 * Compares what the guard was told against what PostgreSQL holds, in both
 * directions.
 *
 * The direction is the point. A lock taken but not declared is an undeclared
 * acquisition; a lock declared but not taken is a fiction that would let a
 * declaration drift away from the statement it describes. Equality catches
 * both, and the unit test below pins that it catches both — a subset check
 * looks identical while the code is correct.
 */
function lockAccountingMismatch(
  declared: Record<string, LockStrength>,
  observed: Record<string, ObservedLockMode>,
): string | undefined {
  // Rendered key-sorted, because the two maps are built in different orders —
  // declaration order against `observableRows` order — and a difference in
  // insertion order is not a difference in what was locked. Comparing the raw
  // serialisations would have turned an innocuous reordering inside a
  // repository method into a false mismatch.
  const render = (
    accounting: Record<string, LockStrength | ObservedLockMode>,
  ): string =>
    JSON.stringify(
      Object.entries(accounting).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  const declaredText = render(declared);
  const observedText = render(observed);
  return declaredText === observedText
    ? undefined
    : `declared ${declaredText} observed ${observedText}`;
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
    onClaim: locks.onClaim,
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
  return {
    declared,
    observed,
    claimedIndexes: locks.claims.map((claim) => claim.index),
    referenceModes,
  };
}

describe('lock accounting', () => {
  it('has a probe for every repository method', async () => {
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    // Reflected off `tx` itself rather than off a hand-written list, so a
    // seventh repository added to TradingTransaction needs a probe too.
    const methods = await unitOfWork.run(async (tx) =>
      Object.entries(tx).flatMap(([repository, api]) =>
        Object.keys(api as object).map((method) => `${repository}.${method}`),
      ),
    );

    // A new repository method with no probe is a method whose locks nobody
    // measured, which is exactly how an undeclared lock ships.
    expect([...methods].sort()).toEqual(Object.keys(LOCK_PROBES).sort());
    expect(methods.length).toBeGreaterThan(0);
  });

  it('measures every table the ledger names', async () => {
    const fixture = await ledgerFixture();
    const measured = new Set(observableRows(fixture).map((row) => row.table));

    // A lock on an unmeasured row reads as no lock at all, so the row set has
    // to cover the whole reachable surface, not only the ranked tables.
    const named = new Set<string>([
      ...LEDGER_LOCK_ORDER,
      ...LEDGER_REFERENCE_TABLES,
      ...Object.values(LEDGER_UNIQUE_INDEXES).map((entry) => entry.table),
      'reservations',
      'fills',
    ]);
    expect([...named].filter((table) => !measured.has(table))).toEqual([]);
  });

  it(
    'declares exactly the row locks PostgreSQL actually holds, for every method',
    async () => {
      const mismatches: Record<string, string> = {};
      const strongerThanShared: Record<string, readonly ObservedLockMode[]> =
        {};
      const claims: Record<string, readonly string[]> = {};

      for (const [method, probes] of Object.entries(LOCK_PROBES)) {
        for (const [index, probe] of probes.entries()) {
          const label = `${method}#${index}`;
          const accounting = await accountForLocks(probe);
          const mismatch = lockAccountingMismatch(
            accounting.declared,
            accounting.observed,
          );
          if (mismatch !== undefined) {
            mismatches[label] = mismatch;
          }
          claims[label] = accounting.claimedIndexes;
          const stronger = accounting.referenceModes.filter(
            (mode) => mode === 'NO_KEY_UPDATE' || mode === 'UPDATE',
          );
          if (stronger.length > 0) {
            strongerThanShared[label] = stronger;
          }
        }
      }

      expect(mismatches).toEqual({});
      // Reference rows stay outside the lock order only because every lock on
      // them is shared, and shared locks never wait on one another.
      expect(strongerThanShared).toEqual({});
      expect(LEDGER_REFERENCE_TABLES).toEqual(['markets']);
      // And every unique-index entry a statement writes is claimed.
      expect(claims).toEqual(EXPECTED_CLAIMS);
    },
    CONTAINER_TIMEOUT_MS,
  );

  it('rejects a mismatch in either direction', () => {
    const declared: Record<string, LockStrength> = {
      'wallets:s:KRW': 'UPDATE',
    };

    expect(
      lockAccountingMismatch(declared, { 'wallets:s:KRW': 'UPDATE' }),
    ).toBe(undefined);
    // Declared but never taken.
    expect(lockAccountingMismatch(declared, {})).toBeDefined();
    // Taken but never declared.
    expect(
      lockAccountingMismatch({}, { 'wallets:s:KRW': 'UPDATE' } as Record<
        string,
        ObservedLockMode
      >),
    ).toBeDefined();
    // Same rows, wrong strength.
    expect(
      lockAccountingMismatch(declared, { 'wallets:s:KRW': 'KEY_SHARE' }),
    ).toBeDefined();
    // Two rows in the other insertion order are the same accounting.
    expect(
      lockAccountingMismatch(
        { 'anonymous_sessions:s': 'UPDATE', 'wallets:s:KRW': 'UPDATE' },
        { 'wallets:s:KRW': 'UPDATE', 'anonymous_sessions:s': 'UPDATE' },
      ),
    ).toBe(undefined);
  });

  it(
    'accounts for every unique index the schema defines',
    async () => {
      const result = await sql<{ table_name: string; index_name: string }>`
        select source.relname as table_name, index_class.relname as index_name
        from pg_class as source
        join pg_index as index_meta on index_meta.indrelid = source.oid
        join pg_class as index_class on index_class.oid = index_meta.indexrelid
        join pg_namespace as space on space.oid = source.relnamespace
        where index_meta.indisunique
          and space.nspname = 'public'
          and source.relname = any(${[...LEDGER_TOUCHED_TABLES]}::text[])
      `.execute(db);

      // Read out of PostgreSQL's own catalog: a unique index nobody classified
      // is a wait on a transaction id nobody reasoned about.
      const catalog = Object.fromEntries(
        result.rows.map((row) => [row.index_name, row.table_name]),
      );
      const classified = Object.fromEntries(
        Object.entries(LEDGER_UNIQUE_INDEXES).map(([index, entry]) => [
          index,
          entry.table,
        ]),
      );
      expect(catalog).toEqual(classified);

      // The partitions of audit_events are the one set of unique indexes the
      // query above excludes by name. They need no classification of their own
      // only because each enforces the parent's key, which is measured here
      // rather than assumed.
      const partitions = await sql<{
        index_name: string;
        columns: readonly string[];
      }>`
        select
          index_class.relname as index_name,
          (
            select array_agg(attribute.attname::text order by attribute.attnum)
            from pg_attribute as attribute
            where attribute.attrelid = source.oid
              and attribute.attnum = any(index_meta.indkey)
          ) as columns
        from pg_class as source
        join pg_index as index_meta on index_meta.indrelid = source.oid
        join pg_class as index_class on index_class.oid = index_meta.indexrelid
        join pg_namespace as space on space.oid = source.relnamespace
        where index_meta.indisunique
          and space.nspname = 'public'
          and source.relname like 'audit_events\\_%'
      `.execute(db);
      expect(partitions.rows.length).toBeGreaterThan(0);
      expect(
        partitions.rows.filter(
          (row) => row.columns.join(',') !== 'id,occurred_at',
        ),
      ).toEqual([]);
      expect(LEDGER_UNIQUE_INDEXES.audit_events_pkey?.table).toBe(
        'audit_events',
      );
    },
    TEST_TIMEOUT_MS,
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

  it('refuses every strengthening of a held lock, in order or not', () => {
    const backwards = createLockOrderGuard();
    // A foreign-key check pins the session row shared; the order row is then
    // locked exclusively. Upgrading the session row afterwards is a real
    // acquisition that can block.
    backwards.acquireLock({
      table: 'anonymous_sessions',
      key: 's',
      strength: 'KEY_SHARE',
    });
    backwards.acquireLock({ table: 'orders', key: 'o', strength: 'UPDATE' });

    expect(() =>
      backwards.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'UPDATE',
      }),
    ).toThrow('may not be strengthened');

    // An upgrade that keeps the table order is refused just the same: two
    // transactions running this identical sequence wait for one another, so no
    // ordering can make it safe.
    const forwards = createLockOrderGuard();
    forwards.acquireLock({
      table: 'anonymous_sessions',
      key: 's',
      strength: 'KEY_SHARE',
    });

    expect(() =>
      forwards.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'UPDATE',
      }),
    ).toThrow('may not be strengthened');
    expect(() =>
      forwards.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'NO_KEY_UPDATE',
      }),
    ).toThrow('may not be strengthened');
  });

  it('reports the strengthening as a lock-order violation, never as transient', () => {
    const guard = createLockOrderGuard();
    guard.acquireLock({ table: 'orders', key: 'o', strength: 'KEY_SHARE' });

    const error = (() => {
      try {
        guard.acquireLock({ table: 'orders', key: 'o', strength: 'UPDATE' });
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('INVARIANT_VIOLATION');
    expect((error as DomainError).retryable).toBe(false);
    expect((error as DomainError).message).toContain('lock order violation');
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
    name: 'idempotency.complete after an order lock',
    invert: async (tx, fixture) => {
      await tx.orders.lock(fixture.lowerOrderId);
      return await tx.idempotency.complete({
        sessionId: fixture.sessionId,
        key: fixture.idempotencyKey,
        statusCode: 201,
        body: { accepted: true },
      });
    },
  },
  {
    name: 'an order lock after the OCO winner claim of its own group',
    invert: async (tx, fixture) => {
      await tx.orders.update({
        id: fixture.groupedOrderId,
        expectedVersion: 0n,
        status: 'FILLED',
        isOcoWinner: true,
        ocoGroupId: fixture.ocoGroupId,
      });
      return await tx.orders.lock(fixture.lowerOrderId);
    },
  },
  {
    name: 'an outbox append with a lower stream sequence than the last',
    invert: async (tx, fixture) => {
      // Pinned first, so the refusal below is the sequence inversion rather
      // than the held-parent rule.
      await tx.sessions.lock(fixture.sessionId);
      await tx.outbox.append({
        id: randomUUID(),
        eventId: randomUUID(),
        sessionId: fixture.sessionId,
        streamSequence: 10n,
        eventType: 'ORDER_PLACED',
        payload: { probe: 'outbox' },
      });
      return await tx.outbox.append({
        id: randomUUID(),
        eventId: randomUUID(),
        sessionId: fixture.sessionId,
        streamSequence: 9n,
        eventType: 'ORDER_PLACED',
        payload: { probe: 'outbox' },
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
      // Three fixture orders survive; the inverted insert rolled back.
      expect((await countLedgerRows(db)).orders).toBe(3);
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

// ─────────────────────────────────────────────────────────────────────────────
// The two ways PostgreSQL makes a transaction wait
//
// A total order on row locks is not enough on its own. A transaction can also
// strengthen a lock it already holds — which no ordering can make safe, because
// two transactions running the identical sequence wait for one another — and it
// can wait on another transaction's uncommitted unique-index entry, which is a
// wait on a transaction id that no row-lock order can see. Everything below
// reproduces one of those, through the public repository API, with both sides
// obeying the documented table order.
// ─────────────────────────────────────────────────────────────────────────────

function barrier(parties: number): { arrive(): Promise<void> } {
  let waiting = 0;
  const released = gate();
  return {
    arrive: async () => {
      waiting += 1;
      if (waiting >= parties) {
        released.open();
      }
      await released.opened;
    },
  };
}

async function insertGroupedOrderRow(
  sessionId: string,
  ocoGroupId: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into orders (
      id, session_id, market_code, symbol, oco_group_id, order_type, side,
      limit_price, quantity, status
    ) values (
      ${id}, ${sessionId}, 'US', 'AAPL', ${ocoGroupId}, 'LIMIT', 'BUY',
      '100', '10', 'OPEN'
    )
  `.execute(db);
  return id;
}

/** The outcome of one settled transaction, as a single comparable string. */
function settledCode(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status === 'fulfilled') {
    return `FULFILLED|${String(outcome.value)}`;
  }
  const reason: unknown = outcome.reason;
  if (reason instanceof DomainError) {
    return `${reason.code}|${reason.message.includes('lock order') ? 'lock order' : reason.message}`;
  }
  return String(reason);
}

interface UpgradeOutcome {
  readonly codes: readonly string[];
  readonly lockOrderRefusals: number;
  readonly backoffs: readonly BackoffConsultation[];
}

/**
 * Runs `work` in `fleet` concurrent transactions that are all released from a
 * barrier at the same point, and reports what each one was told.
 */
async function raceTransactions(
  fleet: number,
  work: (tx: TradingTransaction, arrive: () => Promise<void>) => Promise<void>,
): Promise<UpgradeOutcome> {
  const backoffs: BackoffConsultation[] = [];
  const meeting = barrier(fleet);
  const runs = Array.from({ length: fleet }, async () => {
    const unitOfWork = new UnitOfWork(db, {
      backoff: async (attempt: number, sqlState: string) => {
        backoffs.push({ attempt, sqlState });
      },
    });
    return await unitOfWork.run(async (tx) => {
      await work(tx, meeting.arrive);
    });
  });

  const settled = await Promise.allSettled(runs);
  const codes = settled.map((outcome) =>
    outcome.status === 'fulfilled'
      ? 'FULFILLED'
      : outcome.reason instanceof DomainError
        ? outcome.reason.code
        : String(outcome.reason),
  );
  const lockOrderRefusals = settled.filter(
    (outcome) =>
      outcome.status === 'rejected' &&
      outcome.reason instanceof DomainError &&
      outcome.reason.message.includes('lock order'),
  ).length;
  return { codes, lockOrderRefusals, backoffs };
}

describe('a lock upgrade is an ordering event, not an exemption', () => {
  it('refuses the guard-level strengthening of a row already pinned shared', () => {
    const guard = createLockOrderGuard();

    guard.acquireLock({
      table: 'anonymous_sessions',
      key: 's',
      strength: 'KEY_SHARE',
    });

    expect(() =>
      guard.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'UPDATE',
      }),
    ).toThrow(DomainError);
  });

  it(
    'refuses outbox.append then sessions.lock instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      let sequence = 0n;

      const outcome = await raceTransactions(2, async (tx, arrive) => {
        sequence += 1n;
        // Read before the first await: `sequence` is shared by the fleet, so a
        // value read after one would be the last member's, not this one's.
        const streamSequence = sequence;
        // The claiming append below needs the session pinned already; an insert
        // pins it `for key share`, which is the shape that then asks to
        // strengthen it to `for update`.
        await tx.orders.insert({
          id: randomUUID(),
          sessionId,
          marketCode: 'US',
          symbol: 'AAPL',
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: '100',
          quantity: '1',
          status: 'OPEN',
        });
        await tx.outbox.append({
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId,
          streamSequence,
          eventType: 'ORDER_PLACED',
          payload: { probe: 'upgrade' },
        });
        await arrive();
        await tx.sessions.lock(sessionId);
      });

      expect(outcome.codes).toEqual([
        'INVARIANT_VIOLATION',
        'INVARIANT_VIOLATION',
      ]);
      expect(outcome.lockOrderRefusals).toBe(2);
      expect(outcome.backoffs).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses orders.insert then lockOcoGroup instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      const ocoGroupId = await insertOcoGroup(sessionId);

      const outcome = await raceTransactions(2, async (tx, arrive) => {
        await tx.orders.insert({
          id: randomUUID(),
          sessionId,
          marketCode: 'US',
          symbol: 'AAPL',
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: '100',
          quantity: '1',
          status: 'OPEN',
          ocoGroupId,
        });
        await arrive();
        await tx.orders.lockOcoGroup(ocoGroupId);
      });

      expect(outcome.codes).toEqual([
        'INVARIANT_VIOLATION',
        'INVARIANT_VIOLATION',
      ]);
      expect(outcome.lockOrderRefusals).toBe(2);
      expect(outcome.backoffs).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses idempotency.begin then sessions.lock instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      let key = 0;

      const outcome = await raceTransactions(2, async (tx, arrive) => {
        key += 1;
        // Read before the first await: `key` is shared by the fleet, so a value
        // read after one would be the last member's, not this one's.
        const requestKey = `upgrade-${key}`;
        // The claim below needs the session pinned already; an insert
        // pins it `for key share`, which is the shape that then asks to
        // strengthen it to `for update`.
        await tx.orders.insert({
          id: randomUUID(),
          sessionId,
          marketCode: 'US',
          symbol: 'AAPL',
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: '100',
          quantity: '1',
          status: 'OPEN',
        });
        await tx.idempotency.begin({
          sessionId,
          key: requestKey,
          requestHash: 'hash-upgrade',
        });
        await arrive();
        await tx.sessions.lock(sessionId);
      });

      expect(outcome.codes).toEqual([
        'INVARIANT_VIOLATION',
        'INVARIANT_VIOLATION',
      ]);
      expect(outcome.lockOrderRefusals).toBe(2);
      expect(outcome.backoffs).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses recordReservation then orders.lock instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      const orderId = await insertOrderRow(sessionId);

      const outcome = await raceTransactions(2, async (tx, arrive) => {
        await tx.accounts.recordReservation({
          id: randomUUID(),
          sessionId,
          orderId,
          kind: 'CASH',
          amount: '1',
          currency: 'KRW',
        });
        await arrive();
        await tx.orders.lock(orderId);
      });

      expect(outcome.codes).toEqual([
        'INVARIANT_VIOLATION',
        'INVARIANT_VIOLATION',
      ]);
      expect(outcome.lockOrderRefusals).toBe(2);
      expect(outcome.backoffs).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses every member of a six-way upgrade fleet instead of exhausting the retries',
    async () => {
      const sessionId = await insertSession();
      let sequence = 0n;

      const outcome = await raceTransactions(6, async (tx, arrive) => {
        sequence += 1n;
        // Read before the first await: `sequence` is shared by the fleet, so a
        // value read after one would be the last member's, not this one's.
        const streamSequence = sequence;
        // The claiming append below needs the session pinned already; an insert
        // pins it `for key share`, which is the shape that then asks to
        // strengthen it to `for update`.
        await tx.orders.insert({
          id: randomUUID(),
          sessionId,
          marketCode: 'US',
          symbol: 'AAPL',
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: '100',
          quantity: '1',
          status: 'OPEN',
        });
        await tx.outbox.append({
          id: randomUUID(),
          eventId: randomUUID(),
          sessionId,
          streamSequence,
          eventType: 'ORDER_PLACED',
          payload: { probe: 'fleet' },
        });
        await arrive();
        await tx.sessions.lock(sessionId);
      });

      expect(new Set(outcome.codes)).toEqual(new Set(['INVARIANT_VIOLATION']));
      expect(outcome.lockOrderRefusals).toBe(6);
      expect(outcome.backoffs).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a unique-index claim is an ordering event too', () => {
  it(
    'refuses the idempotency claim taken after the wallet instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      await insertWallet(sessionId, 'KRW', '1000');
      const claimant = recordBackoff();
      const racer = recordBackoff();
      // No retries on either side, so a deadlock cannot be hidden by a replay:
      // the SQLSTATE reaches the caller.
      const claimantUnitOfWork = new UnitOfWork(db, {
        backoff: claimant.backoff,
        maxRetries: 0,
      });
      const racerUnitOfWork = new UnitOfWork(db, {
        backoff: racer.backoff,
        maxRetries: 0,
      });
      const keyClaimed = gate();
      const walletHeld = gate();

      // Lane B's B3: the claimant owns the uncommitted idempotency key and then
      // wants the wallet; the racer owns the wallet and then wants the key. Both
      // ascend the table order, so only ordering the claim itself can refuse it.
      const claimantRun = claimantUnitOfWork
        .run(async (tx) => {
          // Both sides pin the session `for key share` through an insert, which
          // is what a claiming statement requires and what keeps them
          // concurrent: two shared holders do not serialise on the row.
          await tx.orders.insert({
            id: randomUUID(),
            sessionId,
            marketCode: 'US',
            symbol: 'AAPL',
            orderType: 'LIMIT',
            side: 'BUY',
            limitPrice: '100',
            quantity: '1',
            status: 'OPEN',
          });
          await tx.idempotency.begin({
            sessionId,
            key: 'shared-key',
            requestHash: 'hash-shared',
          });
          keyClaimed.open();
          await walletHeld.opened;
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
          return 'claimant committed';
        })
        .finally(() => keyClaimed.open());

      const racerRun = racerUnitOfWork
        .run(async (tx) => {
          await keyClaimed.opened;
          await tx.orders.insert({
            id: randomUUID(),
            sessionId,
            marketCode: 'US',
            symbol: 'AAPL',
            orderType: 'LIMIT',
            side: 'BUY',
            limitPrice: '100',
            quantity: '1',
            status: 'OPEN',
          });
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
          walletHeld.open();
          await tx.idempotency.begin({
            sessionId,
            key: 'shared-key',
            requestHash: 'hash-shared',
          });
          return 'racer committed';
        })
        .finally(() => walletHeld.open());

      const [claimantOutcome, racerOutcome] = await Promise.allSettled([
        claimantRun,
        racerRun,
      ]);

      expect({
        claimant: settledCode(claimantOutcome),
        racer: settledCode(racerOutcome),
      }).toEqual({
        claimant: 'FULFILLED|claimant committed',
        racer: 'INVARIANT_VIOLATION|lock order',
      });
      expect(claimant.attempts).toEqual([]);
      expect(racer.attempts).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an order lock taken after the OCO winner claim instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      const ocoGroupId = await insertOcoGroup(sessionId);
      const first = await insertGroupedOrderRow(sessionId, ocoGroupId);
      const second = await insertGroupedOrderRow(sessionId, ocoGroupId);
      const lower = first < second ? first : second;
      const higher = first < second ? second : first;
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

      // Both order rows are taken in ascending id order, so the row-lock half of
      // the order is satisfied throughout: only the winner claim is out of
      // order, and only the claim can refuse this.
      const error = await unitOfWork
        .run(async (tx) => {
          await tx.orders.lock(lower);
          await tx.orders.update({
            id: lower,
            expectedVersion: 0n,
            status: 'FILLED',
            isOcoWinner: true,
            ocoGroupId,
          });
          await tx.orders.lock(higher);
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INVARIANT_VIOLATION');
      expect((error as DomainError).message).toContain('lock order');
      expect(backoff.attempts).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets the ordered winner commit while the inverted one is refused',
    async () => {
      const sessionId = await insertSession();
      const ocoGroupId = await insertOcoGroup(sessionId);
      const first = await insertGroupedOrderRow(sessionId, ocoGroupId);
      const second = await insertGroupedOrderRow(sessionId, ocoGroupId);
      const lower = first < second ? first : second;
      const higher = first < second ? second : first;
      const inverting = recordBackoff();
      const documented = recordBackoff();
      const invertingUnitOfWork = new UnitOfWork(db, {
        backoff: inverting.backoff,
      });
      const documentedUnitOfWork = new UnitOfWork(db, {
        backoff: documented.backoff,
      });
      const winnerClaimed = gate();
      const higherLocked = gate();

      // Lane A's xid-wait reproduction: one transaction claims the winner slot
      // and then wants an order row the other holds, while the other wants the
      // winner slot. Before the claim was ordered this closed a real cycle.
      const inverted = invertingUnitOfWork
        .run(async (tx) => {
          await tx.orders.lock(lower);
          await tx.orders.update({
            id: lower,
            expectedVersion: 0n,
            status: 'FILLED',
            isOcoWinner: true,
            ocoGroupId,
          });
          winnerClaimed.open();
          await higherLocked.opened;
          await tx.orders.lock(higher);
        })
        .finally(() => winnerClaimed.open());

      const documentedRun = documentedUnitOfWork.run(async (tx) => {
        await winnerClaimed.opened;
        await tx.orders.lock(higher);
        higherLocked.open();
        await tx.orders.update({
          id: higher,
          expectedVersion: 0n,
          status: 'FILLED',
          isOcoWinner: true,
          ocoGroupId,
        });
        return 'committed';
      });

      const [invertedOutcome, documentedOutcome] = await Promise.allSettled([
        inverted,
        documentedRun,
      ]);

      expect({
        inverted: settledCode(invertedOutcome),
        documented: settledCode(documentedOutcome),
      }).toEqual({
        inverted: 'INVARIANT_VIOLATION|lock order',
        documented: 'FULFILLED|committed',
      });
      expect(inverting.attempts).toEqual([]);
      expect(documented.attempts).toEqual([]);
      const winners = await sql<{ id: string }>`
        select id from orders where is_oco_winner
      `.execute(db);
      expect(winners.rows.map((row) => row.id)).toEqual([higher]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the unique-key claim guard', () => {
  it('refuses a table that has no rank in the lock order', () => {
    const guard = createLockOrderGuard();

    expect(() =>
      guard.claimUniqueKey({
        table: 'fills' as LockTable,
        key: 'row',
        index: 'orders_one_oco_winner_per_group',
      }),
    ).toThrow('no rank');
  });

  it('refuses an index this order does not claim', () => {
    const guard = createLockOrderGuard();

    // A primary key whose value the application generates per row is classified
    // FRESH_IDENTITY, not claimed: declaring it would order a wait that cannot
    // happen between two well-behaved callers.
    expect(() =>
      guard.claimUniqueKey({
        table: 'orders',
        key: 'k',
        index: 'orders_pkey' as 'orders_one_oco_winner_per_group',
      }),
    ).toThrow('is not a claimed unique index');
    // An index that belongs to another table cannot borrow this table's rank.
    expect(() =>
      guard.claimUniqueKey({
        table: 'orders',
        key: 'k',
        index: 'outbox_events_session_id_stream_sequence_key',
      }),
    ).toThrow('is not a claimed unique index');
  });

  it('orders a claim against the row locks of the same table', () => {
    const claims: UniqueKeyClaim[] = [];
    const guard = createLockOrderGuard(undefined, (claim) =>
      claims.push(claim),
    );

    guard.acquireLock({
      table: 'orders',
      key: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      strength: 'NO_KEY_UPDATE',
    });
    guard.claimUniqueKey({
      table: 'orders',
      key: ocoWinnerClaimKey('g'),
      index: 'orders_one_oco_winner_per_group',
    });
    // Claiming the same slot again acquires nothing.
    guard.claimUniqueKey({
      table: 'orders',
      key: ocoWinnerClaimKey('g'),
      index: 'orders_one_oco_winner_per_group',
    });

    expect(claims).toEqual([
      {
        table: 'orders',
        key: 'oco-winner:g',
        index: 'orders_one_oco_winner_per_group',
      },
    ]);
    // PostgreSQL locks the row first and writes the index entry second, so an
    // order row may not be locked after the winner slot has been claimed.
    expect(() =>
      guard.acquireLock({
        table: 'orders',
        key: '00000000-0000-0000-0000-000000000000',
        strength: 'UPDATE',
      }),
    ).toThrow('lock order violation');
  });

  it('lets the row lock of a claimed key follow its claim', () => {
    const guard = createLockOrderGuard();

    // `begin` claims the idempotency key and the completion updates that same
    // row: one resource, one position in the order.
    guard.claimUniqueKey({
      table: 'idempotency_requests',
      key: compositeLockKey('s', 'k'),
      index: 'idempotency_requests_session_id_idempotency_key_key',
    });
    guard.acquireLock({
      table: 'idempotency_requests',
      key: compositeLockKey('s', 'k'),
      strength: 'NO_KEY_UPDATE',
    });

    expect(() =>
      guard.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'UPDATE',
      }),
    ).toThrow('lock order violation');
  });
});

describe('the held-parent rule of a claiming statement', () => {
  it('names the rule when a foreign-key parent would follow a claim', () => {
    const guard = createLockOrderGuard();

    guard.claimUniqueKey({
      table: 'outbox_events',
      key: compositeLockKey('s', sequenceLockKey(1n)),
      index: 'outbox_events_session_id_stream_sequence_key',
    });

    // The generic message would say the parent must not be locked after the
    // entry, which is true and useless: there is no order that would let it.
    expect(() =>
      guard.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'KEY_SHARE',
      }),
    ).toThrow('has to be held before the statement runs');
  });

  it('says nothing about held parents when two rows are simply inverted', () => {
    const guard = createLockOrderGuard();

    guard.acquireLock({ table: 'wallets', key: 's:KRW', strength: 'UPDATE' });

    expect(() =>
      guard.acquireLock({
        table: 'anonymous_sessions',
        key: 's',
        strength: 'UPDATE',
      }),
    ).not.toThrow('has to be held before the statement runs');
  });
});

describe('lock keys', () => {
  it('keeps two different rows apart when a key part contains the delimiter', () => {
    // Without the escape, ('a:b', 'c') and ('a', 'b:c') would render to one key
    // and the guard would treat two rows as one, skipping an ordering check.
    expect(compositeLockKey('a:b', 'c')).not.toBe(compositeLockKey('a', 'b:c'));
    expect(compositeLockKey('a\\b', 'c')).not.toBe(
      compositeLockKey('a', '\\b:c'),
    );
    expect(compositeLockKey('s', 'KRW')).toBe('s:KRW');
  });

  it('renders a sequence so string order is numeric order', () => {
    expect(sequenceLockKey(2n) < sequenceLockKey(10n)).toBe(true);
    expect(sequenceLockKey(1n)).toBe('00000000000000000001');
    expect(sequenceLockKey(9_223_372_036_854_775_807n)).toHaveLength(20);
    expect(() => sequenceLockKey(-1n)).toThrow(DomainError);
  });

  it('sorts the OCO winner claim above every order id', () => {
    // Order ids are uuids, so their keys only contain 0-9, a-f and '-'.
    expect(
      'ffffffff-ffff-ffff-ffff-ffffffffffff' < ocoWinnerClaimKey('g'),
    ).toBe(true);
    expect(
      '00000000-0000-0000-0000-000000000000' < ocoWinnerClaimKey('g'),
    ).toBe(true);
  });
});

describe('every versioned update advances its own version', () => {
  it('advances the session version by one', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    const version = await unitOfWork.run(async (tx) =>
      tx.sessions.touch({
        sessionId: fixture.sessionId,
        expectedVersion: 0n,
        lastSeenAt: FIXED_NOW,
      }),
    );

    expect(version).toBe(1n);
    expect(await readVersion('anonymous_sessions', fixture.sessionId)).toBe(
      '1',
    );
  });

  it('advances the wallet version by one', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await unitOfWork.run(async (tx) =>
      tx.accounts.reserveCash({
        wallet: unlockedWallet(fixture.walletId, fixture.sessionId, 0n),
        amount: '10',
      }),
    );

    // The version column is the optimistic-concurrency token: without the
    // increment, two callers that each read version N both succeed in sequence.
    expect(await readWallet(fixture.walletId)).toEqual({
      total: '1000',
      available: '990',
      reserved: '10',
      version: '1',
    });
  });

  it('advances the position version by one', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await unitOfWork.run(async (tx) =>
      tx.accounts.reservePosition({
        position: unlockedPosition(fixture.positionId, fixture.sessionId, 0n),
        quantity: '1',
      }),
    );

    expect(await readVersion('positions', fixture.positionId)).toBe('1');
  });

  it('advances the OCO group version by one', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    const version = await unitOfWork.run(async (tx) =>
      tx.orders.resolveOcoGroup({
        id: fixture.ocoGroupId,
        expectedVersion: 0n,
        resolvedAt: FIXED_NOW,
      }),
    );

    expect(version).toBe(1n);
    expect(await readVersion('oco_groups', fixture.ocoGroupId)).toBe('1');
  });

  it('refuses to resolve an OCO group that is already resolved', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await unitOfWork.run(async (tx) =>
      tx.orders.resolveOcoGroup({
        id: fixture.ocoGroupId,
        expectedVersion: 0n,
        resolvedAt: FIXED_NOW,
      }),
    );

    // `status = 'ACTIVE'` is a guarantee of its own, not a duplicate of the
    // version predicate: at the right version a resolved group would otherwise
    // be resolved a second time and its resolved_at overwritten.
    await expect(
      unitOfWork.run(async (tx) =>
        tx.orders.resolveOcoGroup({
          id: fixture.ocoGroupId,
          expectedVersion: 1n,
          resolvedAt: new Date('2026-08-23T00:00:00.000Z'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    const resolved = await sql<{ resolved_at: Date; version: string }>`
      select resolved_at, version from oco_groups where id = ${fixture.ocoGroupId}
    `.execute(db);
    expect(resolved.rows[0]?.resolved_at).toEqual(FIXED_NOW);
    expect(resolved.rows[0]?.version).toBe('1');
  });
});

describe('an OCO order names its group or it is not updated', () => {
  it('refuses to update a grouped order that does not name its group', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    // Every update of a grouped order rewrites its winner-index entry, so an
    // update that cannot declare the claim must not be allowed to run.
    await expect(
      unitOfWork.run(async (tx) =>
        tx.orders.update({
          id: fixture.groupedOrderId,
          expectedVersion: 0n,
          status: 'CANCELLED',
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });

    expect(await readVersion('orders', fixture.groupedOrderId)).toBe('0');
  });

  it('refuses to update an ungrouped order under someone else’s group', async () => {
    const fixture = await ledgerFixture();
    const unitOfWork = new UnitOfWork(db, { backoff: recordBackoff().backoff });

    await expect(
      unitOfWork.run(async (tx) =>
        tx.orders.update({
          id: fixture.lowerOrderId,
          expectedVersion: 0n,
          status: 'CANCELLED',
          ocoGroupId: fixture.ocoGroupId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_STATE_CONFLICT' });
  });

  it(
    'claims the winner slot on every update of a grouped order',
    async () => {
      const fixture = await ledgerFixture();
      const locks = recordLocks();
      const unitOfWork = new UnitOfWork(db, {
        backoff: recordBackoff().backoff,
        onLock: locks.onLock,
        onClaim: locks.onClaim,
      });

      await unitOfWork.run(async (tx) =>
        tx.orders.update({
          id: fixture.groupedOrderId,
          expectedVersion: 0n,
          status: 'FILLED',
          isOcoWinner: true,
          ocoGroupId: fixture.ocoGroupId,
        }),
      );

      // A plain status update of a row that is *already* the winner rewrites
      // its entry in the partial unique index just the same, so the claim is
      // still the resource being taken — the winner flag is not what decides it.
      const error = await unitOfWork
        .run(async (tx) => {
          await tx.orders.update({
            id: fixture.groupedOrderId,
            expectedVersion: 1n,
            status: 'CANCELLED',
            ocoGroupId: fixture.ocoGroupId,
          });
          await tx.orders.lock(fixture.lowerOrderId);
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).message).toContain('lock order');
      expect(
        locks.claims.filter(
          (claim) => claim.index === 'orders_one_oco_winner_per_group',
        ),
      ).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  it('refuses to name a winner without naming its group', async () => {
    const fixture = await ledgerFixture();
    const backoff = recordBackoff();
    const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

    await expect(
      unitOfWork.run(async (tx) =>
        tx.orders.update({
          id: fixture.groupedOrderId,
          expectedVersion: 0n,
          status: 'FILLED',
          isOcoWinner: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });

    expect(backoff.attempts).toEqual([]);
  });
});

describe('snapshotInput', () => {
  it('reads every field once into a frozen null-prototype copy', () => {
    const reads: string[] = [];
    const hostile = {
      get sessionId(): string {
        reads.push('sessionId');
        return 'session';
      },
    };

    const snapshot = snapshotInput({ sessionId: hostile.sessionId });

    expect(reads).toEqual(['sessionId']);
    expect(snapshot.sessionId).toBe('session');
    expect(snapshot.sessionId).toBe('session');
    expect(reads).toEqual(['sessionId']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBe(null);
  });

  it('cannot inherit an absent field from a polluted prototype', () => {
    const polluted = Object.prototype as unknown as Record<string, unknown>;
    polluted.currency = 'USD';
    try {
      const snapshot = snapshotInput<{ currency?: string }>({});

      expect(snapshot.currency).toBe(undefined);
      expect(({} as { currency?: string }).currency).toBe('USD');
    } finally {
      delete polluted.currency;
    }
  });

  it('is a copy, so mutating the caller’s object cannot change it', () => {
    const fields = { amount: '100' };
    const snapshot = snapshotInput(fields);

    fields.amount = '999';

    expect(snapshot.amount).toBe('100');
  });
});

describe('the deadlock class this order does not claim', () => {
  it(
    'absorbs a reused order id with the retry and leaves exactly one effect',
    async () => {
      const sessionId = await insertSession();
      await insertWallet(sessionId, 'KRW', '1000');
      // The same order id from two concurrent requests: a caller that reused an
      // identity. orders_pkey is classified FRESH_IDENTITY precisely because
      // this cannot be ordered — both transactions believe they are writing the
      // same row — so the guarantee is that the retry absorbs it, in bounded
      // time, with one effect.
      const reusedOrderId = randomUUID();
      const first = recordBackoff();
      const second = recordBackoff();
      const firstUnitOfWork = new UnitOfWork(db, { backoff: first.backoff });
      const secondUnitOfWork = new UnitOfWork(db, { backoff: second.backoff });
      const idClaimed = gate();
      const walletHeld = gate();
      let executions = 0;

      const insertReused = (tx: TradingTransaction): Promise<void> =>
        tx.orders.insert({
          id: reusedOrderId,
          sessionId,
          marketCode: 'US',
          symbol: 'AAPL',
          orderType: 'LIMIT',
          side: 'BUY',
          limitPrice: '100',
          quantity: '1',
          status: 'OPEN',
        });

      const firstRun = firstUnitOfWork
        .run(async (tx) => {
          executions += 1;
          await insertReused(tx);
          idClaimed.open();
          await walletHeld.opened;
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
          return 'first committed';
        })
        .finally(() => idClaimed.open());

      const secondRun = secondUnitOfWork
        .run(async (tx) => {
          executions += 1;
          await idClaimed.opened;
          await tx.orders.insert({
            id: randomUUID(),
            sessionId,
            marketCode: 'US',
            symbol: 'AAPL',
            orderType: 'LIMIT',
            side: 'BUY',
            limitPrice: '100',
            quantity: '1',
            status: 'OPEN',
          });
          await tx.accounts.lockWallet({ sessionId, currency: 'KRW' });
          walletHeld.open();
          await insertReused(tx);
          return 'second committed';
        })
        .finally(() => walletHeld.open());

      const settled = await Promise.allSettled([firstRun, secondRun]);

      // Bounded: both transactions settle, and the deadlock is what drove the
      // one retry rather than a silent stall.
      expect(
        settled.filter((outcome) => outcome.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        [...first.attempts, ...second.attempts].map(
          (attempt) => attempt.sqlState,
        ),
      ).toContain('40P01');
      expect(executions).toBeLessThanOrEqual(4);
      const rejected = settled.find(
        (outcome) => outcome.status === 'rejected',
      ) as PromiseRejectedResult;
      expect((rejected.reason as { code?: string }).code).toBe('23505');
      // Exactly one effect: the reused id exists once.
      const rows = await sql<{ total: string }>`
        select count(*) as total from orders where id = ${reusedOrderId}
      `.execute(db);
      expect(rows.rows[0]?.total).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The two kinds of wait one `insert` produces, in the order PostgreSQL really
 * takes them.
 *
 * An `insert` writes its index entries while the statement runs and checks its
 * foreign keys in AFTER ROW triggers that fire when the statement ends. So a
 * statement that both claims a unique index and pins a foreign-key parent takes
 * the claim *first* — the opposite of the order those two declarations read in
 * when the parent's rank is lower. No ranking can fix that: the claim cannot be
 * ranked below a parent the same statement pins afterwards. What fixes it is
 * requiring the parent to be held before the statement runs, so the pin
 * acquires nothing and cannot wait, and declaring the claim in the position
 * PostgreSQL takes it.
 */
describe('a claimed index entry is written before the parent it pins', () => {
  const appendEventDirectly = async (
    executor: Database,
    sessionId: string,
  ): Promise<void> => {
    await sql`
      insert into outbox_events (
        id, event_id, session_id, stream_sequence, event_type, payload
      ) values (
        ${randomUUID()}, ${randomUUID()}, ${sessionId}, 1, 'RAW', '{}'::jsonb
      )
    `.execute(executor);
  };

  const anInsertIsWaiting = async (
    table: string,
  ): Promise<true | undefined> => {
    const result = await sql<{ waiting: string }>`
      select count(*) as waiting
      from pg_stat_activity
      where datname = current_database()
        and pid <> pg_backend_pid()
        and wait_event_type = 'Lock'
        and query ilike ${`%insert into ${table}%`}
    `.execute(db);
    return Number(result.rows[0]?.waiting ?? 0) > 0 ? true : undefined;
  };

  it(
    'measures the order PostgreSQL really takes the two waits in',
    async () => {
      const sessionId = await insertSession();
      const sessionHeld = gate();

      // Raw SQL on purpose: this measures PostgreSQL, not the repositories, and
      // the repositories refuse the shape. The claimer writes the (session, 1)
      // index entry and then blocks on the holder's `for update` of the session
      // row; the holder then writes the same entry and waits for the claimer's
      // transaction id. That cycle can only close if the entry really was
      // written before the pin — had the pin come first, the claimer would have
      // been waiting before it wrote anything, the holder's insert would have
      // found no conflicting entry and committed, and the claimer would have
      // ended on a plain 23505 instead of either of them deadlocking.
      const claimer = db.transaction().execute(async (trx) => {
        await sql
          .raw(`set local deadlock_timeout = '${COMPETITOR_DEADLOCK_TIMEOUT}'`)
          .execute(trx);
        await sessionHeld.opened;
        await appendEventDirectly(trx, sessionId);
        return 'claimer committed';
      });
      claimer.catch(() => undefined);

      const holder = db.transaction().execute(async (trx) => {
        await sql.raw(`set local deadlock_timeout = '100ms'`).execute(trx);
        await sql`
          select 1 from anonymous_sessions where id = ${sessionId} for update
        `.execute(trx);
        sessionHeld.open();
        await waitUntil(async () => anInsertIsWaiting('outbox_events'));
        await appendEventDirectly(trx, sessionId);
        return 'holder committed';
      });
      holder.catch(() => undefined);

      const [claimerOutcome, holderOutcome] = await Promise.allSettled([
        claimer,
        holder,
      ]);

      expect(claimerOutcome.status).toBe('fulfilled');
      expect(holderOutcome.status).toBe('rejected');
      expect((holderOutcome as PromiseRejectedResult).reason).toMatchObject({
        code: '40P01',
      });
      const rows = await sql<{ total: string }>`
        select count(*) as total
        from outbox_events where session_id = ${sessionId}
      `.execute(db);
      expect(rows.rows[0]?.total).toBe('1');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an outbox append that does not already hold the session row',
    async () => {
      const sessionId = await insertSession();
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

      const error = await unitOfWork
        .run((tx) => outboxFixture(tx, sessionId))
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INVARIANT_VIOLATION');
      expect((error as DomainError).message).toContain('lock order');
      expect((error as DomainError).message).toContain(
        'has to be held before the statement runs',
      );
      expect(backoff.attempts).toEqual([]);
      expect((await countLedgerRows(db)).outbox).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an idempotency claim that does not already hold the session row',
    async () => {
      const sessionId = await insertSession();
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

      const error = await unitOfWork
        .run((tx) =>
          tx.idempotency.begin({
            sessionId,
            key: 'unpinned-key',
            requestHash: 'hash-unpinned',
          }),
        )
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INVARIANT_VIOLATION');
      expect((error as DomainError).message).toContain(
        'has to be held before the statement runs',
      );
      expect(backoff.attempts).toEqual([]);
      expect((await countLedgerRows(db)).idempotency).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'lets a claim through once an insert has pinned the session shared',
    async () => {
      const sessionId = await insertSession();
      const backoff = recordBackoff();
      const unitOfWork = new UnitOfWork(db, { backoff: backoff.backoff });

      // `for key share` is all the pin needs to be: the rule is that the parent
      // is already held, not that it is held strongly.
      await unitOfWork.run(async (tx) => {
        await orderFixture(tx, sessionId);
        await tx.idempotency.begin({
          sessionId,
          key: 'pinned-key',
          requestHash: 'hash-pinned',
        });
        await outboxFixture(tx, sessionId);
      });

      expect(await countLedgerRows(db)).toEqual({
        orders: 1,
        audit: 0,
        outbox: 1,
        idempotency: 1,
        reservations: 0,
      });
      expect(backoff.attempts).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses the outbox claim race instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      const holder = recordBackoff();
      const claimer = recordBackoff();
      const holderUnitOfWork = new UnitOfWork(db, { backoff: holder.backoff });
      const claimerUnitOfWork = new UnitOfWork(db, {
        backoff: claimer.backoff,
      });
      const sessionHeld = gate();
      let claimerSettled = false;

      // Lane B's D1, through two ordinary transactions: the holder pins the
      // session and appends, the claimer appends without pinning anything. Both
      // ascended the declared order, and the pair deadlocked on the claimed
      // index — a 40P01 the guard never saw.
      const holderRun = holderUnitOfWork.run(async (tx) => {
        await tx.sessions.lock(sessionId);
        sessionHeld.open();
        await waitUntil(async () =>
          claimerSettled || (await anInsertIsWaiting('outbox_events'))
            ? true
            : undefined,
        );
        await outboxFixture(tx, sessionId);
        return 'holder committed';
      });
      holderRun.catch(() => undefined);

      const claimerRun = claimerUnitOfWork
        .run(async (tx) => {
          await sessionHeld.opened;
          await outboxFixture(tx, sessionId);
          return 'claimer committed';
        })
        .finally(() => {
          claimerSettled = true;
        });
      claimerRun.catch(() => undefined);

      const [holderOutcome, claimerOutcome] = await Promise.allSettled([
        holderRun,
        claimerRun,
      ]);

      expect({
        holder: settledCode(holderOutcome),
        claimer: settledCode(claimerOutcome),
      }).toEqual({
        holder: 'FULFILLED|holder committed',
        claimer: 'INVARIANT_VIOLATION|lock order',
      });
      expect(holder.attempts).toEqual([]);
      expect(claimer.attempts).toEqual([]);
      expect((await countLedgerRows(db)).outbox).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses the idempotency claim race instead of deadlocking on it',
    async () => {
      const sessionId = await insertSession();
      const holder = recordBackoff();
      const claimer = recordBackoff();
      const holderUnitOfWork = new UnitOfWork(db, { backoff: holder.backoff });
      const claimerUnitOfWork = new UnitOfWork(db, {
        backoff: claimer.backoff,
      });
      const sessionHeld = gate();
      let claimerSettled = false;

      // Lane B's D2. The holder's prefix is exactly commitTradingMutation's:
      // `sessions.lock` then `idempotency.begin`.
      const holderRun = holderUnitOfWork.run(async (tx) => {
        await tx.sessions.lock(sessionId);
        sessionHeld.open();
        await waitUntil(async () =>
          claimerSettled || (await anInsertIsWaiting('idempotency_requests'))
            ? true
            : undefined,
        );
        await tx.idempotency.begin({
          sessionId,
          key: 'raced-key',
          requestHash: 'hash-raced',
        });
        return 'holder committed';
      });
      holderRun.catch(() => undefined);

      const claimerRun = claimerUnitOfWork
        .run(async (tx) => {
          await sessionHeld.opened;
          await tx.idempotency.begin({
            sessionId,
            key: 'raced-key',
            requestHash: 'hash-raced',
          });
          return 'claimer committed';
        })
        .finally(() => {
          claimerSettled = true;
        });
      claimerRun.catch(() => undefined);

      const [holderOutcome, claimerOutcome] = await Promise.allSettled([
        holderRun,
        claimerRun,
      ]);

      expect({
        holder: settledCode(holderOutcome),
        claimer: settledCode(claimerOutcome),
      }).toEqual({
        holder: 'FULFILLED|holder committed',
        claimer: 'INVARIANT_VIOLATION|lock order',
      });
      expect(holder.attempts).toEqual([]);
      expect(claimer.attempts).toEqual([]);
      expect((await countLedgerRows(db)).idempotency).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps a whole mutation clean while an unpinned append is refused',
    async () => {
      const sessionId = await insertSession();
      await insertWallet(sessionId, 'KRW', '1000');
      const competitor = recordBackoff();
      const mutation = recordBackoff();
      const competitorUnitOfWork = new UnitOfWork(db, {
        backoff: competitor.backoff,
      });
      const mutationUnitOfWork = new UnitOfWork(db, {
        backoff: mutation.backoff,
      });

      // Lane B's D3: the same claimed key from a bare append and from
      // commitTradingMutation. The mutation cannot be dragged into the cycle
      // because the bare append can no longer reach the statement that would
      // close it.
      const [competitorOutcome, mutationOutcome] = await Promise.allSettled([
        competitorUnitOfWork.run(async (tx) => {
          await outboxFixture(tx, sessionId);
          return 'competitor committed';
        }),
        commitTradingMutation(mutationUnitOfWork, mutationInput(sessionId)),
      ]);

      expect(settledCode(competitorOutcome)).toBe(
        'INVARIANT_VIOLATION|lock order',
      );
      expect(mutationOutcome).toMatchObject({
        status: 'fulfilled',
        value: { replayed: false, statusCode: 201 },
      });
      expect(competitor.attempts).toEqual([]);
      expect(mutation.attempts).toEqual([]);
      expect(await countLedgerRows(db)).toEqual({
        orders: 1,
        audit: 1,
        outbox: 1,
        idempotency: 1,
        reservations: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );
});
