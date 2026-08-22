import {
  type Currency,
  type DecimalString,
  DomainError,
  type Market,
  type OrderStatus,
  type OrderType,
  type Quantity,
  type Side,
} from '@skipjack/trading-core';
import type { IsolationLevel } from 'kysely';
import {
  type Database,
  type LedgerTransaction,
  snapshotInput,
} from './database.js';
import {
  type AccountRepository,
  createAccountRepository,
} from './repositories/account-repository.js';
import {
  type AuditRepository,
  createAuditRepository,
} from './repositories/audit-repository.js';
import {
  createIdempotencyRepository,
  type IdempotencyRepository,
} from './repositories/idempotency-repository.js';
import {
  createOrderRepository,
  type OrderRepository,
} from './repositories/order-repository.js';
import {
  createOutboxRepository,
  type OutboxRepository,
} from './repositories/outbox-repository.js';
import {
  createSessionRepository,
  type SessionRepository,
} from './repositories/session-repository.js';

/**
 * The single global lock order of the ledger.
 *
 * Deadlock freedom here is structural, not statistical: a set of transactions
 * that always requests row locks in one total order can never form a wait
 * cycle. The total order is (rank of table in this array, then row key
 * ascending as a string), and `LedgerConnection.acquireLock` refuses any
 * acquisition that would go backwards in it — so an inconsistent order is a
 * test failure in this repository rather than a deadlock in production.
 *
 * The ranks are ordered from the most coarse-grained row to the most
 * fine-grained: a mutation starts by pinning the session that owns the ledger,
 * then its balances, then the grouping row, then individual orders. Every
 * mutation therefore enters the order at the top and moves down it.
 *
 * Append-only tables (`audit_events`, `outbox_events`, `reservations`,
 * `account_sequences`) and `idempotency_requests` are absent on purpose: they
 * are never locked with `for update`. Duplicate idempotency keys are serialised
 * by a unique index, and that index is only ever reached after the session row
 * is already held, so it adds no second ordering to reason about.
 */
export const LEDGER_LOCK_ORDER = Object.freeze([
  'anonymous_sessions',
  'wallets',
  'positions',
  'oco_groups',
  'orders',
] as const);

export type LockTable = (typeof LEDGER_LOCK_ORDER)[number];

export interface LockTarget {
  readonly table: LockTable;
  /**
   * The row's natural key rendered as a string. It has to be the natural key
   * rather than the surrogate id, because a lock must be ordered before the row
   * has been read.
   */
  readonly key: string;
}

/**
 * The persistence-layer handle for one open transaction: the Kysely executor
 * plus the lock-order guard. Repositories receive it; application services
 * never do. `TradingTransaction` is what an application service receives, and
 * it reaches this object only through closures — no reflection over a
 * `TradingTransaction` can find the Kysely instance.
 */
export interface LedgerConnection {
  readonly executor: LedgerTransaction;
  /**
   * Declares the row lock that the next statement will take. Throws
   * INVARIANT_VIOLATION when it would violate `LEDGER_LOCK_ORDER`.
   */
  acquireLock(target: LockTarget): void;
}

/** Everything an application service may do inside one transaction. */
export interface TradingTransaction {
  readonly sessions: SessionRepository;
  readonly accounts: AccountRepository;
  readonly orders: OrderRepository;
  readonly audit: AuditRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
}

/**
 * Waits before a retry attempt, given the attempt that just failed and the
 * PostgreSQL SQLSTATE that failed it.
 *
 * It is injected so that no production wall-clock sleep can leak into a test and
 * no test has to tolerate one: the suite passes a recorder that returns
 * immediately, and the SQLSTATE argument lets it assert that the retry was
 * driven by a real 40001 or 40P01 rather than by anything a test could fake.
 */
export type BackoffSchedule = (
  attempt: number,
  sqlState: string,
) => Promise<void>;

export interface UnitOfWorkOptions {
  readonly backoff: BackoffSchedule;
  /**
   * Retries after the first attempt. Three by default, so a serialization
   * failure or deadlock is executed at most four times in total.
   */
  readonly maxRetries?: number;
  /**
   * Left unset, PostgreSQL's `read committed` applies, which is the level the
   * lock order is designed for: explicit `for update` locks serialise the
   * conflicting mutations, so serialization failures do not arise from ordinary
   * traffic. `serializable` is available for work that needs snapshot-wide
   * consistency and accepts 40001 as its cost.
   */
  readonly isolationLevel?: IsolationLevel;
  /** Observes each lock as it is taken. Diagnostics and tests only. */
  readonly onLock?: (target: LockTarget) => void;
}

const DEFAULT_MAX_RETRIES = 3;
const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

/**
 * A transaction whose commit was sent but whose result nobody can observe — the
 * connection died mid-commit. It may have committed and it may not have, so it
 * must never be replayed: a replay of an already-committed trading mutation is
 * a double effect. Recovery belongs to the caller's idempotency key, not to a
 * retry loop.
 */
export class UnknownCommitOutcomeError extends Error {
  constructor(cause: unknown) {
    super(
      'the transaction commit outcome is unknown and must not be replayed',
      { cause },
    );
    this.name = 'UnknownCommitOutcomeError';
  }
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
 * Reads the SQLSTATE of a thrown value exactly once.
 *
 * Only an `Error` is trusted to carry one: the `pg` driver throws
 * `DatabaseError`, so requiring an Error instance costs nothing and stops a
 * plain object from claiming a retryable SQLSTATE and being replayed.
 */
function sqlStateOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The SQLSTATE this failure may be retried under, or undefined for none. */
function retryableSqlState(error: unknown): string | undefined {
  // A domain error is a decision, never a transient condition. Checking it
  // first also means a domain error can never be replayed by claiming a
  // retryable SQLSTATE.
  if (error instanceof DomainError) {
    return undefined;
  }
  const sqlState = sqlStateOf(error);
  if (sqlState === SERIALIZATION_FAILURE || sqlState === DEADLOCK_DETECTED) {
    return sqlState;
  }
  return undefined;
}

function createLedgerConnection(
  executor: LedgerTransaction,
  onLock: ((target: LockTarget) => void) | undefined,
): LedgerConnection {
  const held = new Set<string>();
  let last: LockTarget | undefined;

  return {
    executor,
    acquireLock(target: LockTarget): void {
      const rank = lockRank(target.table);
      if (rank < 0) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          `${target.table} has no rank in the ledger lock order`,
        );
      }

      // Re-locking a row this transaction already holds acquires nothing, so it
      // cannot extend a wait cycle and needs no ordering.
      const identity = `${rank}:${target.key}`;
      if (held.has(identity)) {
        return;
      }
      if (last !== undefined && compareLockTargets(target, last) < 0) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          `lock order violation: ${target.table} (${target.key}) must not be locked after ${last.table} (${last.key})`,
        );
      }

      held.add(identity);
      last = target;
      onLock?.(target);
    },
  };
}

function createTradingTransaction(
  connection: LedgerConnection,
): TradingTransaction {
  return Object.freeze({
    sessions: createSessionRepository(connection),
    accounts: createAccountRepository(connection),
    orders: createOrderRepository(connection),
    audit: createAuditRepository(connection),
    outbox: createOutboxRepository(connection),
    idempotency: createIdempotencyRepository(connection),
  });
}

/**
 * The one transaction boundary of the ledger.
 *
 * The Kysely instance is held in a private field, so not even reflection over a
 * `UnitOfWork` can reach it, and `run` hands the work a `TradingTransaction`
 * rather than a transaction handle. Everything a mutation writes — ledger rows,
 * audit history, outbox events, the idempotency record — commits together or
 * rolls back together.
 */
export class UnitOfWork {
  readonly #db: Database;
  readonly #backoff: BackoffSchedule;
  readonly #maxRetries: number;
  readonly #isolationLevel: IsolationLevel | undefined;
  readonly #onLock: ((target: LockTarget) => void) | undefined;

  constructor(db: Database, options: UnitOfWorkOptions) {
    const settings = snapshotInput({
      backoff: options.backoff,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      isolationLevel: options.isolationLevel,
      onLock: options.onLock,
    });
    if (!Number.isInteger(settings.maxRetries) || settings.maxRetries < 0) {
      throw new RangeError('maxRetries must be a non-negative integer');
    }

    this.#db = db;
    this.#backoff = settings.backoff;
    this.#maxRetries = settings.maxRetries;
    this.#isolationLevel = settings.isolationLevel;
    this.#onLock = settings.onLock;
  }

  /**
   * Runs `work` in one transaction, retrying only PostgreSQL serialization
   * failures (40001) and deadlocks (40P01).
   *
   * Three outcomes are deliberately never retried: a domain error, because it
   * is a decision and not a transient condition; any other driver error,
   * because nothing says a second attempt would fare differently; and a failure
   * once the commit has been sent, because the transaction's fate is then
   * unobservable and a replay could double the effect. The one exception to
   * that last rule is a commit that fails with 40001 or 40P01, which PostgreSQL
   * only reports after aborting the transaction — a known outcome, and safe to
   * retry.
   */
  async run<T>(work: (tx: TradingTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      let commitSent = false;
      try {
        const builder =
          this.#isolationLevel === undefined
            ? this.#db.transaction()
            : this.#db.transaction().setIsolationLevel(this.#isolationLevel);
        return await builder.execute(async (trx) => {
          const result = await work(
            createTradingTransaction(createLedgerConnection(trx, this.#onLock)),
          );
          commitSent = true;
          return result;
        });
      } catch (error) {
        const sqlState = retryableSqlState(error);
        if (sqlState === undefined) {
          throw commitSent ? new UnknownCommitOutcomeError(error) : error;
        }
        if (attempt > this.#maxRetries) {
          throw new DomainError(
            'SERVICE_UNAVAILABLE',
            `the transaction still failed with SQLSTATE ${sqlState} after ${attempt} attempts`,
          );
        }
        await this.#backoff(attempt, sqlState);
      }
    }
  }
}

export interface TradingMutationOrder {
  readonly id: string;
  readonly marketCode: Market;
  readonly symbol: string;
  readonly orderType: OrderType;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly status: OrderStatus;
  readonly limitPrice?: DecimalString;
  readonly stopPrice?: DecimalString;
}

export interface TradingMutationCash {
  readonly currency: Currency;
  readonly amount: DecimalString;
}

export interface TradingMutationPosition {
  readonly marketCode: Market;
  readonly symbol: string;
  readonly quantity: Quantity;
}

export interface TradingMutationAudit {
  readonly id: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
  readonly sessionReference?: string;
}

export interface TradingMutationOutbox {
  readonly id: string;
  readonly eventId: string;
  readonly streamSequence: bigint;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface TradingMutationResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

export interface TradingMutationInput {
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly order: TradingMutationOrder;
  readonly audit: TradingMutationAudit;
  readonly outbox: TradingMutationOutbox;
  readonly response: TradingMutationResponse;
  readonly cash?: TradingMutationCash;
  readonly position?: TradingMutationPosition;
  readonly ocoGroupId?: string;
  /**
   * Orders that already exist and must be pinned by this mutation — the other
   * leg of an OCO pair, for instance. They are locked in ascending id order
   * regardless of the order they arrive in.
   */
  readonly siblingOrderIds?: readonly string[];
}

export interface TradingMutationResult {
  /** True when the idempotency key already had a recorded result. */
  readonly replayed: boolean;
  readonly statusCode: number;
  readonly body: unknown;
}

/**
 * Commits one trading mutation atomically.
 *
 * The whole point of this function is that there is exactly one transaction:
 * the reservation, the order row, the audit event, the outbox event, and the
 * idempotency record either all exist afterwards or none of them do. Locks are
 * taken strictly down `LEDGER_LOCK_ORDER`, and every caller-supplied value is
 * snapshotted once before any of it is used.
 */
export async function commitTradingMutation(
  unitOfWork: UnitOfWork,
  input: TradingMutationInput,
): Promise<TradingMutationResult> {
  // One read of every field, nested containers included. Reading a container
  // twice — `input.order.id` and then `input.order.symbol` — would let an
  // accessor hand back two different orders, so each container is captured
  // once first and only the capture is read afterwards. Nothing below this
  // block reads `input` again.
  const order = input.order;
  const audit = input.audit;
  const outbox = input.outbox;
  const response = input.response;
  const cash = input.cash;
  const position = input.position;
  const request = snapshotInput({
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    orderId: order.id,
    orderMarketCode: order.marketCode,
    orderSymbol: order.symbol,
    orderType: order.orderType,
    orderSide: order.side,
    orderQuantity: order.quantity,
    orderStatus: order.status,
    orderLimitPrice: order.limitPrice,
    orderStopPrice: order.stopPrice,
    auditId: audit.id,
    auditEventType: audit.eventType,
    auditPayload: audit.payload,
    auditOccurredAt: audit.occurredAt,
    auditSessionReference: audit.sessionReference,
    outboxId: outbox.id,
    outboxEventId: outbox.eventId,
    outboxStreamSequence: outbox.streamSequence,
    outboxEventType: outbox.eventType,
    outboxPayload: outbox.payload,
    responseStatusCode: response.statusCode,
    responseBody: JSON.stringify(response.body),
    cashCurrency: cash?.currency,
    cashAmount: cash?.amount,
    positionMarketCode: position?.marketCode,
    positionSymbol: position?.symbol,
    positionQuantity: position?.quantity,
    ocoGroupId: input.ocoGroupId,
    siblingOrderIds: [...new Set(input.siblingOrderIds ?? [])].sort(),
  });
  const responseBody: unknown = JSON.parse(request.responseBody);

  return await unitOfWork.run(async (tx) => {
    const session = await tx.sessions.lock(request.sessionId);
    if (session === undefined || session.status !== 'ACTIVE') {
      throw new DomainError(
        'ACCOUNT_READ_ONLY',
        `session ${request.sessionId} cannot accept mutations`,
      );
    }

    const claim = await tx.idempotency.begin({
      sessionId: request.sessionId,
      key: request.idempotencyKey,
      requestHash: request.requestHash,
    });
    if (claim.state === 'COMPLETED') {
      return {
        replayed: true,
        statusCode: claim.statusCode,
        body: claim.body,
      };
    }
    if (claim.state === 'IN_PROGRESS') {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key ${request.idempotencyKey} is already in progress`,
      );
    }

    if (
      request.cashCurrency !== undefined &&
      request.cashAmount !== undefined
    ) {
      const wallet = await tx.accounts.lockWallet({
        sessionId: request.sessionId,
        currency: request.cashCurrency,
      });
      if (wallet === undefined) {
        throw new DomainError(
          'INSUFFICIENT_AVAILABLE_CASH',
          `session ${request.sessionId} holds no ${request.cashCurrency} wallet`,
        );
      }
      await tx.accounts.reserveCash({ wallet, amount: request.cashAmount });
    }

    if (
      request.positionMarketCode !== undefined &&
      request.positionSymbol !== undefined &&
      request.positionQuantity !== undefined
    ) {
      const position = await tx.accounts.lockPosition({
        sessionId: request.sessionId,
        marketCode: request.positionMarketCode,
        symbol: request.positionSymbol,
      });
      if (position === undefined) {
        throw new DomainError(
          'INSUFFICIENT_AVAILABLE_POSITION',
          `session ${request.sessionId} holds no ${request.positionSymbol} position`,
        );
      }
      await tx.accounts.reservePosition({
        position,
        quantity: request.positionQuantity,
      });
    }

    if (request.ocoGroupId !== undefined) {
      const group = await tx.orders.lockOcoGroup(request.ocoGroupId);
      if (group === undefined || group.status !== 'ACTIVE') {
        throw new DomainError(
          'ORDER_STATE_CONFLICT',
          `OCO group ${request.ocoGroupId} is not active`,
        );
      }
    }

    for (const siblingOrderId of request.siblingOrderIds) {
      const sibling = await tx.orders.lock(siblingOrderId);
      if (sibling === undefined) {
        throw new DomainError(
          'ORDER_STATE_CONFLICT',
          `order ${siblingOrderId} does not exist`,
        );
      }
    }

    await tx.orders.insert({
      id: request.orderId,
      sessionId: request.sessionId,
      marketCode: request.orderMarketCode,
      symbol: request.orderSymbol,
      orderType: request.orderType,
      side: request.orderSide,
      quantity: request.orderQuantity,
      status: request.orderStatus,
      ...(request.orderLimitPrice === undefined
        ? {}
        : { limitPrice: request.orderLimitPrice }),
      ...(request.orderStopPrice === undefined
        ? {}
        : { stopPrice: request.orderStopPrice }),
      ...(request.ocoGroupId === undefined
        ? {}
        : { ocoGroupId: request.ocoGroupId }),
    });

    await tx.audit.append({
      id: request.auditId,
      eventType: request.auditEventType,
      payload: request.auditPayload,
      occurredAt: request.auditOccurredAt,
      orderId: request.orderId,
      ...(request.auditSessionReference === undefined
        ? {}
        : { sessionReference: request.auditSessionReference }),
    });

    await tx.outbox.append({
      id: request.outboxId,
      eventId: request.outboxEventId,
      sessionId: request.sessionId,
      streamSequence: request.outboxStreamSequence,
      eventType: request.outboxEventType,
      payload: request.outboxPayload,
    });

    await tx.idempotency.complete({
      sessionId: request.sessionId,
      key: request.idempotencyKey,
      statusCode: request.responseStatusCode,
      body: responseBody,
    });

    return {
      replayed: false,
      statusCode: request.responseStatusCode,
      body: responseBody,
    };
  });
}
