import { randomUUID } from 'node:crypto';
import {
  applyFillToPosition,
  type Currency,
  type DecimalString,
  DomainError,
  decimal,
  type Market,
  type Side,
} from '@skipjack/trading-core';
import { sql } from 'kysely';

/** Anything `sql\`...\`.execute()` accepts: a Kysely instance or a transaction. */
export type LedgerExecutor = Parameters<ReturnType<typeof sql>['execute']>[0];

export interface Balances {
  readonly total: DecimalString;
  readonly available: DecimalString;
  readonly reserved: DecimalString;
}

export interface SettlementPlanInput {
  readonly balances: Balances;
  /** Unreleased amount still held by this order's (or group's) reservation. */
  readonly reservationRemaining: DecimalString;
  /** Cash cost (BUY) or quantity leaving the position (SELL). */
  readonly consumed: DecimalString;
  /** Terminal fills release whatever the reservation still holds. */
  readonly terminal: boolean;
}

export interface SettlementPlan {
  readonly balances: Balances;
  readonly reservationRemaining: DecimalString;
  readonly released: boolean;
}

/**
 * Pure settlement arithmetic shared by cash (BUY) and position (SELL) legs:
 * the consumed amount leaves `total`, first out of the reservation and then
 * out of `available` for any shortfall (price protection keeps that small);
 * a terminal fill hands the unused reservation back to `available`.
 */
export function planSettlement(
  input: SettlementPlanInput,
  shortfallCode:
    | 'INSUFFICIENT_AVAILABLE_CASH'
    | 'INSUFFICIENT_AVAILABLE_POSITION',
): SettlementPlan {
  const consumed = decimal(input.consumed);
  if (consumed.isNegative())
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'settlement amount is negative',
    );
  const remaining = decimal(input.reservationRemaining);
  const fromReservation = consumed.lessThan(remaining) ? consumed : remaining;
  const shortfall = consumed.minus(fromReservation);
  const total = decimal(input.balances.total).minus(consumed);
  let reserved = decimal(input.balances.reserved).minus(fromReservation);
  let available = decimal(input.balances.available).minus(shortfall);
  if (available.isNegative())
    throw new DomainError(
      shortfallCode,
      'fill exceeds the reserved and available balance',
    );
  let left = remaining.minus(fromReservation);
  let released = false;
  if (input.terminal) {
    available = available.plus(left);
    reserved = reserved.minus(left);
    left = decimal('0');
    released = true;
  }
  if (reserved.isNegative() || total.isNegative())
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'settlement would drive a balance negative',
    );
  return {
    balances: {
      total: total.toString(),
      available: available.toString(),
      reserved: reserved.toString(),
    },
    reservationRemaining: left.toString(),
    released,
  };
}

export interface SettlementFill {
  readonly price: DecimalString;
  readonly quantity: DecimalString;
  readonly fee: DecimalString;
}

export interface FillSettlementInput {
  readonly order: {
    readonly id: string;
    readonly sessionId: string;
    readonly market: Market;
    readonly symbol: string;
    readonly side: Side;
    readonly ocoGroupId?: string | null;
  };
  readonly fills: readonly SettlementFill[];
  readonly terminal: boolean;
}

export const currencyFor = (market: Market): Currency =>
  market === 'KR' ? 'KRW' : 'USD';

interface ReservationRow {
  id: string;
  amount: string;
}

async function lockReservation(
  executor: LedgerExecutor,
  input: FillSettlementInput['order'],
): Promise<ReservationRow | undefined> {
  const rows =
    input.ocoGroupId === undefined || input.ocoGroupId === null
      ? await sql<ReservationRow>`
          select id::text, amount::text from reservations
          where order_id = ${input.id}::uuid and released = false for update
        `.execute(executor)
      : await sql<ReservationRow>`
          select id::text, amount::text from reservations
          where oco_group_id = ${input.ocoGroupId}::uuid and released = false for update
        `.execute(executor);
  return rows.rows[0];
}

async function writeReservation(
  executor: LedgerExecutor,
  reservation: ReservationRow | undefined,
  plan: SettlementPlan,
): Promise<void> {
  if (reservation === undefined) return;
  await sql`
    update reservations set amount = ${plan.reservationRemaining}, released = ${plan.released}, version = version + 1
    where id = ${reservation.id}::uuid
  `.execute(executor);
}

/**
 * Settles engine fills against the ledger inside the caller's transaction:
 * BUY debits the wallet (consuming the cash reservation) and grows the
 * position at weighted average cost; SELL shrinks the position (consuming
 * the position reservation) and credits the proceeds. Legacy orders without
 * a reservation row settle out of `available` alone.
 */
export async function settleFill(
  executor: LedgerExecutor,
  input: FillSettlementInput,
): Promise<void> {
  const { order } = input;
  const currency = currencyFor(order.market);
  const reservation = await lockReservation(executor, order);
  const remaining = reservation?.amount ?? '0';
  if (order.side === 'BUY') {
    const wallet = (
      await sql<Balances & { id: string }>`
        select id::text, total::text, available::text, reserved::text from wallets
        where session_id = ${order.sessionId}::uuid and currency = ${currency} for update
      `.execute(executor)
    ).rows[0];
    if (wallet === undefined)
      throw new DomainError(
        'INSUFFICIENT_AVAILABLE_CASH',
        `session holds no ${currency} wallet`,
      );
    const cost = input.fills
      .reduce(
        (sum, f) => sum.plus(decimal(f.price).mul(f.quantity)).plus(f.fee),
        decimal('0'),
      )
      .toString();
    const plan = planSettlement(
      {
        balances: wallet,
        reservationRemaining: remaining,
        consumed: cost,
        terminal: input.terminal,
      },
      'INSUFFICIENT_AVAILABLE_CASH',
    );
    await sql`
      update wallets set total = ${plan.balances.total}, available = ${plan.balances.available},
        reserved = ${plan.balances.reserved}, version = version + 1 where id = ${wallet.id}::uuid
    `.execute(executor);
    await writeReservation(executor, reservation, plan);
    await growPosition(executor, order, input.fills);
    return;
  }
  const position = (
    await sql<{
      id: string;
      total_quantity: string;
      available_quantity: string;
      reserved_quantity: string;
    }>`
      select id::text, total_quantity::text, available_quantity::text, reserved_quantity::text from positions
      where session_id = ${order.sessionId}::uuid and market_code = ${order.market} and symbol = ${order.symbol} for update
    `.execute(executor)
  ).rows[0];
  if (position === undefined)
    throw new DomainError(
      'INSUFFICIENT_AVAILABLE_POSITION',
      `session holds no ${order.symbol} position`,
    );
  const quantity = input.fills
    .reduce((sum, f) => sum.plus(f.quantity), decimal('0'))
    .toString();
  const plan = planSettlement(
    {
      balances: {
        total: position.total_quantity,
        available: position.available_quantity,
        reserved: position.reserved_quantity,
      },
      reservationRemaining: remaining,
      consumed: quantity,
      terminal: input.terminal,
    },
    'INSUFFICIENT_AVAILABLE_POSITION',
  );
  await sql`
    update positions set total_quantity = ${plan.balances.total}, available_quantity = ${plan.balances.available},
      reserved_quantity = ${plan.balances.reserved}, version = version + 1 where id = ${position.id}::uuid
  `.execute(executor);
  await writeReservation(executor, reservation, plan);
  const proceeds = input.fills
    .reduce(
      (sum, f) => sum.plus(decimal(f.price).mul(f.quantity)).minus(f.fee),
      decimal('0'),
    )
    .toString();
  await sql`
    insert into wallets (id, session_id, currency, total, available, reserved)
    values (${randomUUID()}::uuid, ${order.sessionId}::uuid, ${currency}, ${proceeds}, ${proceeds}, 0)
    on conflict (session_id, currency) do update
      set total = wallets.total + excluded.total, available = wallets.available + excluded.available,
          version = wallets.version + 1
  `.execute(executor);
}

async function growPosition(
  executor: LedgerExecutor,
  order: FillSettlementInput['order'],
  fills: readonly SettlementFill[],
): Promise<void> {
  const current = (
    await sql<{ id: string; total_quantity: string; average_cost: string }>`
      select id::text, total_quantity::text, average_cost::text from positions
      where session_id = ${order.sessionId}::uuid and market_code = ${order.market} and symbol = ${order.symbol} for update
    `.execute(executor)
  ).rows[0];
  const start = {
    symbol: order.symbol,
    quantity: current?.total_quantity ?? '0',
    totalCost: current
      ? decimal(current.average_cost).mul(current.total_quantity).toString()
      : '0',
    realizedPnl: '0',
  };
  const next = fills.reduce(
    (position, fill) =>
      applyFillToPosition(position, {
        symbol: order.symbol,
        side: 'BUY',
        price: fill.price,
        quantity: fill.quantity,
        fee: fill.fee,
      }),
    start,
  );
  const added = decimal(next.quantity).minus(start.quantity).toString();
  const averageCost = decimal(next.quantity).isZero()
    ? '0'
    : decimal(next.totalCost).div(next.quantity).toDecimalPlaces(8).toString();
  if (current === undefined) {
    await sql`
      insert into positions (id, session_id, market_code, symbol, total_quantity, available_quantity, reserved_quantity, average_cost)
      values (${randomUUID()}::uuid, ${order.sessionId}::uuid, ${order.market}, ${order.symbol}, ${added}, ${added}, 0, ${averageCost})
    `.execute(executor);
    return;
  }
  await sql`
    update positions set total_quantity = total_quantity + ${added}::numeric,
      available_quantity = available_quantity + ${added}::numeric,
      average_cost = ${averageCost}, version = version + 1
    where id = ${current.id}::uuid
  `.execute(executor);
}
