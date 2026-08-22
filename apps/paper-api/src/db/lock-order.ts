import { DomainError } from '@skipjack/trading-core';

/**
 * The single global lock order of the ledger.
 *
 * Deadlock freedom here is structural, not statistical: a set of transactions
 * that always requests row locks in one total order can never form a wait
 * cycle. The total order is (rank of table in this array, then row key
 * ascending as a string), and `createLockOrderGuard` refuses any acquisition
 * that would go backwards in it — so an inconsistent order is a test failure in
 * this repository rather than a deadlock in production.
 *
 * The ranks are ordered from the most coarse-grained row to the most
 * fine-grained: a mutation starts by pinning the session that owns the ledger,
 * then its balances, then the grouping row, then individual orders, and last the
 * idempotency record that retires the request. Every mutation therefore enters
 * the order at the top and moves down it.
 *
 * Every lock counts, not only an explicit `select … for update`. Three kinds of
 * row lock reach this order:
 *
 *   * `for update` on a read, the strongest and the only one that is visible in
 *     the SQL text;
 *   * `for no key update`, which PostgreSQL takes implicitly on every row an
 *     `update` touches without changing a key column;
 *   * `for key share`, which every foreign-key check takes on the parent row an
 *     `insert` (or a key-changing `update`) references.
 *
 * The third kind is the one that is easy to miss and the one that produced real
 * deadlocks before it was declared: `insert into orders` pins the session row
 * and the OCO group row, `insert into outbox_events` and the idempotency writes
 * pin the session row, and `insert into reservations` pins the session and the
 * order. A transaction that took an order lock first and only then inserted was
 * acquiring a rank-0 lock after a rank-4 lock without saying so.
 *
 * `audit_events` is absent because it references nothing: it is append-only and
 * carries no foreign key, so it locks nothing. `reservations`, `outbox_events`
 * and `account_sequences` are absent because nothing ever locks a row in them —
 * they are only ever inserted into, and an insert locks its parents, not its own
 * invisible new row. A future `update` against one of them cannot be declared,
 * because `acquireLock` refuses a table with no rank, so the omission fails
 * loudly rather than silently.
 */
export const LEDGER_LOCK_ORDER = Object.freeze([
  'anonymous_sessions',
  'wallets',
  'positions',
  'oco_groups',
  'orders',
  'idempotency_requests',
] as const);

export type LockTable = (typeof LEDGER_LOCK_ORDER)[number];

/**
 * Tables of immutable reference data, deliberately outside the lock order.
 *
 * `markets` is read by foreign keys on `orders`, `positions` and
 * `reservations`, so an insert does take a `for key share` lock on a market
 * row. It needs no rank because no statement in this application ever locks a
 * market row in a mode that conflicts with `for key share`: the rows are
 * written once by the migration and never updated. Shared locks never wait on
 * one another, so no wait edge can exist here, and a lock that cannot wait
 * cannot be part of a cycle. The suite measures this rather than assuming it —
 * every repository method is checked for a stronger-than-shared lock on a
 * reference row.
 */
export const LEDGER_REFERENCE_TABLES = Object.freeze(['markets'] as const);

/**
 * How strongly a row is held, in PostgreSQL's own row-lock order.
 *
 * Strength matters to the ordering discipline because a *strengthening* of a
 * lock already held is a fresh acquisition that can block: a transaction
 * holding `for key share` on a session row (from a foreign-key check) and then
 * asking for `for update` on it waits for every other holder of the shared
 * lock. Treating that as "already held" is what would let a foreign-key pin
 * hide an inverted acquisition.
 */
export type LockStrength = 'KEY_SHARE' | 'NO_KEY_UPDATE' | 'UPDATE';

const STRENGTH_RANK: Readonly<Record<LockStrength, number>> = Object.freeze({
  KEY_SHARE: 0,
  NO_KEY_UPDATE: 1,
  UPDATE: 2,
});

export interface LockTarget {
  readonly table: LockTable;
  /**
   * The row's natural key rendered as a string. It has to be the natural key
   * rather than the surrogate id, because a lock must be ordered before the row
   * has been read — and because two statements that touch one row have to
   * produce the same key whichever identity they address it by.
   */
  readonly key: string;
  readonly strength: LockStrength;
}

/** The lock-order discipline of one open transaction. */
export interface LockOrderGuard {
  /**
   * Declares the row lock the next statement will take. Throws
   * INVARIANT_VIOLATION when it would violate `LEDGER_LOCK_ORDER`.
   */
  acquireLock(target: LockTarget): void;
}

function lockRank(table: string): number {
  return (LEDGER_LOCK_ORDER as readonly string[]).indexOf(table);
}

function compareLockTargets(left: LockTarget, right: LockTarget): number {
  const byTable = lockRank(left.table) - lockRank(right.table);
  if (byTable !== 0) {
    return byTable;
  }
  if (left.key === right.key) {
    return 0;
  }
  return left.key < right.key ? -1 : 1;
}

/**
 * Creates the guard for one transaction.
 *
 * `onLock` observes each acquisition that really happens — a re-declaration of
 * something already held at the same or greater strength acquires nothing and is
 * not reported.
 */
export function createLockOrderGuard(
  onLock?: (target: LockTarget) => void,
): LockOrderGuard {
  const held = new Map<string, LockStrength>();
  let last: LockTarget | undefined;

  return {
    acquireLock(target: LockTarget): void {
      const rank = lockRank(target.table);
      if (rank < 0) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          `${target.table} has no rank in the ledger lock order`,
        );
      }

      // Re-locking a row this transaction already holds at least this strongly
      // acquires nothing, so it cannot extend a wait cycle and needs no
      // ordering. A strengthening does acquire something, so it does.
      const identity = `${rank}:${target.key}`;
      const alreadyHeld = held.get(identity);
      if (
        alreadyHeld !== undefined &&
        STRENGTH_RANK[alreadyHeld] >= STRENGTH_RANK[target.strength]
      ) {
        return;
      }
      if (last !== undefined && compareLockTargets(target, last) < 0) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          `lock order violation: ${target.table} (${target.key}) must not be locked after ${last.table} (${last.key})`,
        );
      }

      held.set(identity, target.strength);
      last = target;
      onLock?.(target);
    },
  };
}
