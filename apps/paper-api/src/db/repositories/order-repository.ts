import {
  type DecimalString,
  DomainError,
  type Market,
  type OrderSnapshot,
  type OrderStatus,
  type OrderType,
  type Quantity,
  type Side,
} from '@skipjack/trading-core';
import { sql } from 'kysely';
import { assertVersionedUpdate, snapshotInput } from '../database.js';
import { ocoWinnerClaimKey } from '../lock-order.js';
import type { LedgerConnection } from '../unit-of-work.js';

export interface InsertOrderInput {
  readonly id: string;
  readonly sessionId: string;
  readonly marketCode: Market;
  readonly symbol: string;
  readonly orderType: OrderType;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly status: OrderStatus;
  readonly limitPrice?: DecimalString;
  readonly stopPrice?: DecimalString;
  readonly ocoGroupId?: string;
}

export interface InsertOcoGroupInput {
  readonly id: string;
  readonly sessionId: string;
}

export interface UpdateOrderInput {
  readonly id: string;
  readonly expectedVersion: bigint;
  readonly status: OrderStatus;
  readonly filledQuantity?: Quantity;
  readonly terminalReason?: string;
  readonly isOcoWinner?: boolean;
  /**
   * The OCO group the order belongs to, which a grouped order must name.
   *
   * It is not decoration: every `update` of a grouped order rewrites the row's
   * entry in the partial unique index `orders_one_oco_winner_per_group`, so it
   * can wait on another transaction's uncommitted winner. That wait has to be
   * declared, and it can only be declared by a caller that says which group.
   * The statement enforces it — an order whose `oco_group_id` differs from this
   * value matches no row and is refused as a state conflict — so a grouped
   * order cannot be updated without its claim being ordered.
   */
  readonly ocoGroupId?: string;
}

export interface ResolveOcoGroupInput {
  readonly id: string;
  readonly expectedVersion: bigint;
  readonly resolvedAt: Date;
}

/** An order row held under `for update`. */
export interface LockedOrder extends OrderSnapshot {
  readonly sessionId: string;
}

export interface LockedOcoGroup {
  readonly id: string;
  readonly sessionId: string;
  readonly status: 'ACTIVE' | 'RESOLVED';
  readonly version: bigint;
}

export interface OrderRepository {
  insertOcoGroup(input: InsertOcoGroupInput): Promise<void>;
  insert(input: InsertOrderInput): Promise<void>;
  lock(orderId: string): Promise<LockedOrder | undefined>;
  lockOcoGroup(ocoGroupId: string): Promise<LockedOcoGroup | undefined>;
  update(input: UpdateOrderInput): Promise<bigint>;
  resolveOcoGroup(input: ResolveOcoGroupInput): Promise<bigint>;
  /**
   * Lock-free read of the OCO group an order belongs to and every leg in it
   * (ascending id), so a cancellation can lock the group and both legs in
   * LEDGER_LOCK_ORDER before it mutates anything. Undefined for a single.
   */
  findOcoLegs(orderId: string): Promise<OcoLegs | undefined>;
}

export interface OcoLegs {
  readonly groupId: string;
  readonly legIds: readonly string[];
}

export async function findOcoLegs(
  connection: LedgerConnection,
  orderId: string,
): Promise<OcoLegs | undefined> {
  const request = snapshotInput({ orderId });
  const rows = await sql<{ group_id: string; leg_id: string }>`
    select o.oco_group_id::text as group_id, legs.id::text as leg_id
    from orders o
    join orders legs on legs.oco_group_id = o.oco_group_id
    where o.id = ${request.orderId} and o.oco_group_id is not null
    order by legs.id
  `.execute(connection.executor);
  const first = rows.rows[0];
  if (first === undefined) return undefined;
  return { groupId: first.group_id, legIds: rows.rows.map((r) => r.leg_id) };
}

export async function insertOcoGroup(
  connection: LedgerConnection,
  input: InsertOcoGroupInput,
): Promise<void> {
  const group = snapshotInput({ id: input.id, sessionId: input.sessionId });
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: group.sessionId,
    strength: 'KEY_SHARE',
  });
  await sql`
    insert into oco_groups (id, session_id)
    values (${group.id}, ${group.sessionId})
  `.execute(connection.executor);
}

interface OrderRow {
  readonly id: string;
  readonly session_id: string;
  readonly status: string;
  readonly filled_quantity: string;
  readonly terminal_reason: string | null;
  readonly version: string;
}

interface OcoGroupRow {
  readonly id: string;
  readonly session_id: string;
  readonly status: string;
  readonly version: string;
}

const ORDER_STATUSES = new Set<string>([
  'RECEIVED',
  'PENDING_TRIGGER',
  'TRIGGERED',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
]);

/**
 * `OrderSnapshot.terminalReason` is a closed union, so an unrecognised stored
 * reason is schema drift and must not be forwarded as if it were understood.
 */
function toTerminalReason(
  value: string | null,
): { readonly terminalReason: 'IOC_REMAINDER' } | Record<string, never> {
  if (value === null) {
    return {};
  }
  if (value !== 'IOC_REMAINDER') {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `order terminal reason ${value} is not a known reason`,
    );
  }
  return { terminalReason: value };
}

function toLockedOrder(row: OrderRow): LockedOrder {
  const status = row.status;
  if (!ORDER_STATUSES.has(status)) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `order status ${status} is not a known status`,
    );
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    status: status as OrderStatus,
    filledQuantity: row.filled_quantity,
    version: BigInt(row.version),
    ...toTerminalReason(row.terminal_reason),
  };
}

function toLockedOcoGroup(row: OcoGroupRow): LockedOcoGroup {
  const status = row.status;
  if (status !== 'ACTIVE' && status !== 'RESOLVED') {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `OCO group status ${status} is not a known status`,
    );
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    status,
    version: BigInt(row.version),
  };
}

/**
 * Inserts one order row.
 *
 * `orders` references `anonymous_sessions` and, when the order belongs to an
 * OCO pair, `oco_groups`; both foreign-key checks take a `for key share` lock on
 * the parent row. Declaring them is what makes an insert-after-order-lock
 * sequence a refusal here instead of a deadlock in production. The `markets`
 * parent is a reference row and stays outside the order (see
 * LEDGER_REFERENCE_TABLES).
 */
export async function insertOrder(
  connection: LedgerConnection,
  input: InsertOrderInput,
): Promise<void> {
  const order = snapshotInput({
    id: input.id,
    sessionId: input.sessionId,
    marketCode: input.marketCode,
    symbol: input.symbol,
    orderType: input.orderType,
    side: input.side,
    quantity: input.quantity,
    status: input.status,
    limitPrice: input.limitPrice ?? null,
    stopPrice: input.stopPrice ?? null,
    ocoGroupId: input.ocoGroupId ?? null,
  });
  connection.acquireLock({
    table: 'anonymous_sessions',
    key: order.sessionId,
    strength: 'KEY_SHARE',
  });
  if (order.ocoGroupId !== null) {
    connection.acquireLock({
      table: 'oco_groups',
      key: order.ocoGroupId,
      strength: 'KEY_SHARE',
    });
  }

  await sql`
    insert into orders (
      id, session_id, market_code, symbol, oco_group_id, order_type, side,
      limit_price, stop_price, quantity, status
    ) values (
      ${order.id}, ${order.sessionId}, ${order.marketCode}, ${order.symbol},
      ${order.ocoGroupId}, ${order.orderType}, ${order.side},
      ${order.limitPrice}, ${order.stopPrice}, ${order.quantity}, ${order.status}
    )
  `.execute(connection.executor);
}

export async function lockOrder(
  connection: LedgerConnection,
  orderId: string,
): Promise<LockedOrder | undefined> {
  connection.acquireLock({ table: 'orders', key: orderId, strength: 'UPDATE' });
  const result = await sql<OrderRow>`
    select id, session_id, status, filled_quantity, terminal_reason, version
    from orders
    where id = ${orderId}
    for update
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toLockedOrder(row);
}

export async function lockOcoGroup(
  connection: LedgerConnection,
  ocoGroupId: string,
): Promise<LockedOcoGroup | undefined> {
  connection.acquireLock({
    table: 'oco_groups',
    key: ocoGroupId,
    strength: 'UPDATE',
  });
  const result = await sql<OcoGroupRow>`
    select id, session_id, status, version
    from oco_groups
    where id = ${ocoGroupId}
    for update
  `.execute(connection.executor);
  const row = result.rows[0];
  return row === undefined ? undefined : toLockedOcoGroup(row);
}

/**
 * Applies a versioned order update.
 *
 * `filled_quantity`, `terminal_reason`, and `is_oco_winner` are left untouched
 * when the caller omits them; `coalesce` expresses that unambiguously because
 * no caller ever needs to write them back to null — a terminal reason is set
 * once and an OCO winner is never un-won.
 *
 * The row lock is declared first and the winner-slot claim second, in the order
 * PostgreSQL takes them: an `update` locks the row, then writes its index
 * entries. So a transaction that has claimed the slot may no longer take an
 * order row lock, which is exactly the sequence that used to deadlock — every
 * order row a transaction writes has to be locked before the first winner claim.
 */
export async function updateOrder(
  connection: LedgerConnection,
  input: UpdateOrderInput,
): Promise<bigint> {
  const update = snapshotInput({
    id: input.id,
    expectedVersion: input.expectedVersion,
    status: input.status,
    filledQuantity: input.filledQuantity ?? null,
    terminalReason: input.terminalReason ?? null,
    isOcoWinner: input.isOcoWinner ?? null,
    ocoGroupId: input.ocoGroupId ?? null,
  });
  if (update.isOcoWinner === true && update.ocoGroupId === null) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `order ${update.id} cannot be made the OCO winner without naming its group`,
    );
  }
  // None of these columns is a key column, so PostgreSQL takes `for no key
  // update` on the row — a real lock, declared like any other.
  connection.acquireLock({
    table: 'orders',
    key: update.id,
    strength: 'NO_KEY_UPDATE',
  });
  if (update.ocoGroupId !== null) {
    connection.claimUniqueKey({
      table: 'orders',
      key: ocoWinnerClaimKey(update.ocoGroupId),
      index: 'orders_one_oco_winner_per_group',
    });
  }

  const result = await sql<{ version: string }>`
    update orders
    set status = ${update.status},
        filled_quantity = coalesce(${update.filledQuantity}, filled_quantity),
        terminal_reason = coalesce(${update.terminalReason}, terminal_reason),
        is_oco_winner = coalesce(${update.isOcoWinner}, is_oco_winner),
        updated_at = now(),
        version = version + 1
    where id = ${update.id}
      and version = ${update.expectedVersion}
      and oco_group_id is not distinct from ${update.ocoGroupId}
    returning version
  `.execute(connection.executor);
  return BigInt(
    assertVersionedUpdate(result.rows, `order ${update.id}`).version,
  );
}

export async function resolveOcoGroup(
  connection: LedgerConnection,
  input: ResolveOcoGroupInput,
): Promise<bigint> {
  const resolve = snapshotInput({
    id: input.id,
    expectedVersion: input.expectedVersion,
    resolvedAt: input.resolvedAt,
  });
  connection.acquireLock({
    table: 'oco_groups',
    key: resolve.id,
    strength: 'NO_KEY_UPDATE',
  });

  const result = await sql<{ version: string }>`
    update oco_groups
    set status = 'RESOLVED', resolved_at = ${resolve.resolvedAt},
        version = version + 1
    where id = ${resolve.id}
      and version = ${resolve.expectedVersion}
      and status = 'ACTIVE'
    returning version
  `.execute(connection.executor);
  return BigInt(
    assertVersionedUpdate(result.rows, `OCO group ${resolve.id}`).version,
  );
}

export function createOrderRepository(
  connection: LedgerConnection,
): OrderRepository {
  return Object.freeze({
    insertOcoGroup: (input: InsertOcoGroupInput) =>
      insertOcoGroup(connection, input),
    insert: (input: InsertOrderInput) => insertOrder(connection, input),
    lock: (orderId: string) => lockOrder(connection, orderId),
    findOcoLegs: (orderId: string) => findOcoLegs(connection, orderId),
    lockOcoGroup: (ocoGroupId: string) => lockOcoGroup(connection, ocoGroupId),
    update: (input: UpdateOrderInput) => updateOrder(connection, input),
    resolveOcoGroup: (input: ResolveOcoGroupInput) =>
      resolveOcoGroup(connection, input),
  });
}
