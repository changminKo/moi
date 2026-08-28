import {
  type Currency,
  type DecimalString,
  DomainError,
  type Market,
  type PositionSnapshot,
  type Quantity,
  releaseReservation,
  reserveCash,
  reservePosition,
  type WalletSnapshot,
} from '@skipjack/trading-core';
import { sql } from 'kysely';
import { assertVersionedUpdate, snapshotInput } from '../database.js';
import { compositeLockKey } from '../lock-order.js';
import type { LedgerConnection } from '../unit-of-work.js';

/** A wallet row held under `for update`, carrying its persistence identity. */
export interface LockedWallet extends WalletSnapshot {
  readonly id: string;
  readonly sessionId: string;
}

/** A position row held under `for update`, carrying its persistence identity. */
export interface LockedPosition extends PositionSnapshot {
  readonly id: string;
  readonly sessionId: string;
  readonly marketCode: Market;
  readonly averageCost: DecimalString;
}

export interface WalletKey {
  readonly sessionId: string;
  readonly currency: Currency;
}

export interface PositionKey {
  readonly sessionId: string;
  readonly marketCode: Market;
  readonly symbol: string;
}

export interface ReserveCashInput {
  readonly wallet: LockedWallet;
  readonly amount: DecimalString;
}

export interface ReservePositionInput {
  readonly position: LockedPosition;
  readonly quantity: Quantity;
}

export interface ReservationInput {
  readonly id: string;
  readonly sessionId: string;
  readonly orderId?: string;
  readonly ocoGroupId?: string;
  readonly kind: 'CASH' | 'POSITION';
  readonly amount: DecimalString;
  readonly currency?: Currency;
  readonly marketCode?: Market;
  readonly symbol?: string;
}

export interface OrderReservationsKey {
  readonly sessionId: string;
  readonly orderId: string;
}

/** An unreleased reservation the order (or its whole OCO group) still holds. */
export interface OpenReservation {
  readonly id: string;
  readonly kind: 'CASH' | 'POSITION';
  readonly amount: DecimalString;
  readonly currency: Currency | null;
  readonly marketCode: Market | null;
  readonly symbol: string | null;
}

export interface ReleaseCashInput {
  readonly wallet: LockedWallet;
  readonly amount: DecimalString;
  readonly reservationId: string;
}

export interface ReleasePositionInput {
  readonly position: LockedPosition;
  readonly quantity: Quantity;
  readonly reservationId: string;
}

const TERMINAL_STATUSES = ['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'];

export interface AccountRepository {
  lockWallet(key: WalletKey): Promise<LockedWallet | undefined>;
  lockPosition(key: PositionKey): Promise<LockedPosition | undefined>;
  reserveCash(input: ReserveCashInput): Promise<WalletSnapshot>;
  reservePosition(input: ReservePositionInput): Promise<PositionSnapshot>;
  recordReservation(input: ReservationInput): Promise<void>;
  /**
   * Lock-free read of what a cancellation must release: the order's own
   * reservation, or its OCO group's shared one once every other leg is terminal.
   */
  findOrderReservations(
    key: OrderReservationsKey,
  ): Promise<readonly OpenReservation[]>;
  /** Hands reserved cash back to `available` and retires the reservation row. */
  releaseCash(input: ReleaseCashInput): Promise<WalletSnapshot>;
  /** Hands reserved quantity back to `available` and retires the reservation row. */
  releasePosition(input: ReleasePositionInput): Promise<PositionSnapshot>;
}

interface WalletRow {
  readonly id: string;
  readonly session_id: string;
  readonly currency: string;
  readonly total: string;
  readonly available: string;
  readonly reserved: string;
  readonly version: string;
}

interface PositionRow {
  readonly id: string;
  readonly session_id: string;
  readonly market_code: string;
  readonly symbol: string;
  readonly total_quantity: string;
  readonly available_quantity: string;
  readonly reserved_quantity: string;
  readonly average_cost: string;
  readonly version: string;
}

const CURRENCIES = new Set<string>(['KRW', 'USD']);
const MARKETS = new Set<string>(['KR', 'US']);

/**
 * The lock key of a wallet is its natural key, not its surrogate id: the id is
 * unknown until the row has been read, and a lock has to be ordered before it
 * is taken.
 */
function walletLockKey(key: WalletKey): string {
  return compositeLockKey(key.sessionId, key.currency);
}

function positionLockKey(key: PositionKey): string {
  return compositeLockKey(key.sessionId, key.marketCode, key.symbol);
}

function toLockedWallet(row: WalletRow): LockedWallet {
  const currency = row.currency;
  if (!CURRENCIES.has(currency)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `wallet currency ${currency} is not a known currency`,
    );
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    currency: currency as Currency,
    total: row.total,
    available: row.available,
    reserved: row.reserved,
    version: BigInt(row.version),
  };
}

function toLockedPosition(row: PositionRow): LockedPosition {
  const marketCode = row.market_code;
  if (!MARKETS.has(marketCode)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `position market ${marketCode} is not a known market`,
    );
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    marketCode: marketCode as Market,
    symbol: row.symbol,
    total: row.total_quantity,
    available: row.available_quantity,
    reserved: row.reserved_quantity,
    averageCost: row.average_cost,
    version: BigInt(row.version),
  };
}

export async function lockWallet(
  connection: LedgerConnection,
  key: WalletKey,
): Promise<LockedWallet | undefined> {
  const wanted = snapshotInput({
    sessionId: key.sessionId,
    currency: key.currency,
  });
  connection.acquireLock({
    table: 'wallets',
    key: walletLockKey(wanted),
    strength: 'UPDATE',
  });
  const result = await sql<WalletRow>`
    select id, session_id, currency, total, available, reserved, version
    from wallets
    where session_id = ${wanted.sessionId} and currency = ${wanted.currency}
    for update
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toLockedWallet(row);
}

export async function lockPosition(
  connection: LedgerConnection,
  key: PositionKey,
): Promise<LockedPosition | undefined> {
  const wanted = snapshotInput({
    sessionId: key.sessionId,
    marketCode: key.marketCode,
    symbol: key.symbol,
  });
  connection.acquireLock({
    table: 'positions',
    key: positionLockKey(wanted),
    strength: 'UPDATE',
  });
  const result = await sql<PositionRow>`
    select
      id, session_id, market_code, symbol, total_quantity,
      available_quantity, reserved_quantity, average_cost, version
    from positions
    where session_id = ${wanted.sessionId}
      and market_code = ${wanted.marketCode}
      and symbol = ${wanted.symbol}
    for update
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toLockedPosition(row);
}

/**
 * Applies the core `reserveCash` decision to a locked wallet row. The balance
 * arithmetic belongs to trading-core; this only persists its result under the
 * version the row carried when it was locked.
 */
export async function reserveCashOnWallet(
  connection: LedgerConnection,
  input: ReserveCashInput,
): Promise<WalletSnapshot> {
  // One read of `wallet` and one of each of its fields: reading the container
  // again could hand back a different object than the one whose balances were
  // checked.
  const wallet = input.wallet;
  const request = snapshotInput({
    walletId: wallet.id,
    sessionId: wallet.sessionId,
    currency: wallet.currency,
    total: wallet.total,
    available: wallet.available,
    reserved: wallet.reserved,
    version: wallet.version,
    amount: input.amount,
  });

  const reserved = reserveCash(
    {
      currency: request.currency,
      total: request.total,
      available: request.available,
      reserved: request.reserved,
      version: request.version,
    },
    request.amount,
  );

  // The `update` takes a `for no key update` lock on the same row `lockWallet`
  // takes `for update`, so it is declared under the same natural key: the
  // guard has to see one row, not two.
  connection.acquireLock({
    table: 'wallets',
    key: walletLockKey(request),
    strength: 'NO_KEY_UPDATE',
  });

  const result = await sql<{ version: string }>`
    update wallets
    set available = ${reserved.available},
        reserved = ${reserved.reserved},
        version = version + 1
    where id = ${request.walletId} and version = ${request.version}
    returning version
  `.execute(connection.executor);
  assertVersionedUpdate(result.rows, `wallet ${request.walletId}`);
  return reserved;
}

export async function reservePositionQuantity(
  connection: LedgerConnection,
  input: ReservePositionInput,
): Promise<PositionSnapshot> {
  const position = input.position;
  const request = snapshotInput({
    positionId: position.id,
    sessionId: position.sessionId,
    marketCode: position.marketCode,
    symbol: position.symbol,
    total: position.total,
    available: position.available,
    reserved: position.reserved,
    version: position.version,
    quantity: input.quantity,
  });

  const reserved = reservePosition(
    {
      symbol: request.symbol,
      total: request.total,
      available: request.available,
      reserved: request.reserved,
      version: request.version,
    },
    request.quantity,
  );

  connection.acquireLock({
    table: 'positions',
    key: positionLockKey(request),
    strength: 'NO_KEY_UPDATE',
  });

  const result = await sql<{ version: string }>`
    update positions
    set available_quantity = ${reserved.available},
        reserved_quantity = ${reserved.reserved},
        version = version + 1
    where id = ${request.positionId} and version = ${request.version}
    returning version
  `.execute(connection.executor);
  assertVersionedUpdate(result.rows, `position ${request.positionId}`);
  return reserved;
}

/**
 * Records one reservation row.
 *
 * `reservations` references `anonymous_sessions` and `orders`, so the insert's
 * foreign-key checks take a `for key share` lock on both parents. They are
 * declared in rank order; the `markets` parent is a reference row and stays
 * outside the order (see LEDGER_REFERENCE_TABLES).
 */
export async function recordReservation(
  connection: LedgerConnection,
  input: ReservationInput,
): Promise<void> {
  const reservation = snapshotInput({
    id: input.id,
    sessionId: input.sessionId,
    orderId: input.orderId ?? null,
    ocoGroupId: input.ocoGroupId ?? null,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency ?? null,
    marketCode: input.marketCode ?? null,
    symbol: input.symbol ?? null,
  });
  if ((reservation.orderId === null) === (reservation.ocoGroupId === null)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'reservation must name exactly one order or OCO group',
    );
  }
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: reservation.sessionId,
    strength: 'KEY_SHARE',
  });
  if (reservation.orderId !== null) {
    connection.acquireLock({
      table: 'orders',
      key: reservation.orderId,
      strength: 'KEY_SHARE',
    });
  } else {
    connection.acquireLock({
      table: 'oco_groups',
      key: reservation.ocoGroupId as string,
      strength: 'KEY_SHARE',
    });
  }

  await sql`
    insert into reservations (
      id, session_id, order_id, oco_group_id, kind, currency, market_code,
      symbol, amount
    ) values (
      ${reservation.id}, ${reservation.sessionId}, ${reservation.orderId},
      ${reservation.ocoGroupId}, ${reservation.kind}, ${reservation.currency},
      ${reservation.marketCode}, ${reservation.symbol}, ${reservation.amount}
    )
  `.execute(connection.executor);
}

export async function findOrderReservations(
  connection: LedgerConnection,
  key: OrderReservationsKey,
): Promise<readonly OpenReservation[]> {
  const request = snapshotInput({
    sessionId: key.sessionId,
    orderId: key.orderId,
  });
  const rows = await sql<{
    id: string;
    kind: 'CASH' | 'POSITION';
    amount: string;
    currency: Currency | null;
    market_code: Market | null;
    symbol: string | null;
  }>`
    select r.id::text, r.kind, r.amount::text, r.currency, r.market_code, r.symbol
    from reservations r
    where r.released = false and r.session_id = ${request.sessionId}::uuid and (
      r.order_id = ${request.orderId}::uuid
      or (r.oco_group_id is not null
          and r.oco_group_id = (select oco_group_id from orders where id = ${request.orderId}::uuid)
          and not exists (
            select 1 from orders o where o.oco_group_id = r.oco_group_id
              and o.id <> ${request.orderId}::uuid and o.status <> all(${TERMINAL_STATUSES})))
    )
    order by r.id
  `.execute(connection.executor);
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    marketCode: row.market_code,
    symbol: row.symbol,
  }));
}

/**
 * Retires one reservation row. Measured, not assumed: the update also pins the
 * owning session row `for key share`, so the caller has to hold the session
 * already — every cancellation does, as its first lock.
 */
async function retireReservation(
  connection: LedgerConnection,
  sessionId: string,
  reservationId: string,
): Promise<void> {
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: sessionId,
    strength: 'KEY_SHARE',
  });
  connection.acquireLock({
    table: 'reservations',
    key: reservationId,
    strength: 'NO_KEY_UPDATE',
  });
  const result = await sql<{ version: string }>`
    update reservations set released = true, version = version + 1
    where id = ${reservationId}::uuid and released = false
    returning version
  `.execute(connection.executor);
  assertVersionedUpdate(result.rows, `reservation ${reservationId}`);
}

export async function releaseCash(
  connection: LedgerConnection,
  input: ReleaseCashInput,
): Promise<WalletSnapshot> {
  const wallet = input.wallet;
  const request = snapshotInput({
    walletId: wallet.id,
    sessionId: wallet.sessionId,
    currency: wallet.currency,
    total: wallet.total,
    available: wallet.available,
    reserved: wallet.reserved,
    version: wallet.version,
    amount: input.amount,
    reservationId: input.reservationId,
  });
  const released = releaseReservation(
    {
      currency: request.currency,
      total: request.total,
      available: request.available,
      reserved: request.reserved,
      version: request.version,
    },
    request.amount,
  );
  connection.acquireLock({
    table: 'wallets',
    key: walletLockKey(request),
    strength: 'NO_KEY_UPDATE',
  });
  const result = await sql<{ version: string }>`
    update wallets
    set available = ${released.available},
        reserved = ${released.reserved},
        version = version + 1
    where id = ${request.walletId} and version = ${request.version}
    returning version
  `.execute(connection.executor);
  assertVersionedUpdate(result.rows, `wallet ${request.walletId}`);
  await retireReservation(connection, request.sessionId, request.reservationId);
  return released;
}

export async function releasePosition(
  connection: LedgerConnection,
  input: ReleasePositionInput,
): Promise<PositionSnapshot> {
  const position = input.position;
  const request = snapshotInput({
    positionId: position.id,
    sessionId: position.sessionId,
    marketCode: position.marketCode,
    symbol: position.symbol,
    total: position.total,
    available: position.available,
    reserved: position.reserved,
    version: position.version,
    quantity: input.quantity,
    reservationId: input.reservationId,
  });
  const released = releaseReservation(
    {
      symbol: request.symbol,
      total: request.total,
      available: request.available,
      reserved: request.reserved,
      version: request.version,
    },
    request.quantity,
  );
  connection.acquireLock({
    table: 'positions',
    key: positionLockKey(request),
    strength: 'NO_KEY_UPDATE',
  });
  const result = await sql<{ version: string }>`
    update positions
    set available_quantity = ${released.available},
        reserved_quantity = ${released.reserved},
        version = version + 1
    where id = ${request.positionId} and version = ${request.version}
    returning version
  `.execute(connection.executor);
  assertVersionedUpdate(result.rows, `position ${request.positionId}`);
  await retireReservation(connection, request.sessionId, request.reservationId);
  return released;
}

export function createAccountRepository(
  connection: LedgerConnection,
): AccountRepository {
  return Object.freeze({
    lockWallet: (key: WalletKey) => lockWallet(connection, key),
    lockPosition: (key: PositionKey) => lockPosition(connection, key),
    reserveCash: (input: ReserveCashInput) =>
      reserveCashOnWallet(connection, input),
    reservePosition: (input: ReservePositionInput) =>
      reservePositionQuantity(connection, input),
    recordReservation: (input: ReservationInput) =>
      recordReservation(connection, input),
    findOrderReservations: (key: OrderReservationsKey) =>
      findOrderReservations(connection, key),
    releaseCash: (input: ReleaseCashInput) => releaseCash(connection, input),
    releasePosition: (input: ReleasePositionInput) =>
      releasePosition(connection, input),
  });
}
