import { randomUUID } from 'node:crypto';
import {
  assertExactMoney,
  calculateAverageCost,
  currencyFor,
  type DecimalString,
  DomainError,
  type Market,
  moneyDecimal,
  type Side,
} from '@moi/trading-core';
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
  /**
   * For a non-terminal fill: the exposure the order still needs reserved
   * (remaining quantity × price + estimated fee). Anything the reservation
   * holds above this is handed back to `available` (price improvement).
   */
  readonly desiredRemaining?: DecimalString;
}

export interface SettlementPlan {
  readonly balances: Balances;
  readonly reservationRemaining: DecimalString;
  readonly released: boolean;
}

const money = (value: DecimalString, what: string) =>
  assertExactMoney(moneyDecimal(value), what);

/**
 * Pure settlement arithmetic shared by cash (BUY) and position (SELL) legs,
 * in the ledger's exact-money domain: the consumed amount leaves `total`,
 * first out of the reservation and then out of `available` for any shortfall
 * (price protection keeps that small); a terminal fill hands the unused
 * reservation back to `available`, a partial fill hands back anything above
 * the remaining exposure.
 */
export function planSettlement(
  input: SettlementPlanInput,
  shortfallCode:
    | 'INSUFFICIENT_AVAILABLE_CASH'
    | 'INSUFFICIENT_AVAILABLE_POSITION',
): SettlementPlan {
  const consumed = money(input.consumed, 'Settlement amount');
  if (consumed.isNegative())
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'settlement amount is negative',
    );
  const remaining = money(input.reservationRemaining, 'Reservation remaining');
  const fromReservation = consumed.lessThan(remaining) ? consumed : remaining;
  const shortfall = consumed.minus(fromReservation);
  const total = assertExactMoney(
    money(input.balances.total, 'Balance total').minus(consumed),
    'Settled total',
  );
  let reserved = assertExactMoney(
    money(input.balances.reserved, 'Balance reserved').minus(fromReservation),
    'Settled reserved',
  );
  let available = assertExactMoney(
    money(input.balances.available, 'Balance available').minus(shortfall),
    'Settled available',
  );
  if (available.isNegative())
    throw new DomainError(
      shortfallCode,
      'fill exceeds the reserved and available balance',
    );
  let left = assertExactMoney(
    remaining.minus(fromReservation),
    'Reservation left',
  );
  let released = false;
  const giveBack = (amount: ReturnType<typeof moneyDecimal>) => {
    available = assertExactMoney(available.plus(amount), 'Released available');
    reserved = assertExactMoney(reserved.minus(amount), 'Released reserved');
    left = assertExactMoney(left.minus(amount), 'Reservation after release');
  };
  if (input.terminal) {
    giveBack(left);
    released = true;
  } else if (input.desiredRemaining !== undefined) {
    const desired = money(input.desiredRemaining, 'Desired reservation');
    if (left.greaterThan(desired)) giveBack(left.minus(desired));
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

export interface SettlementOrder {
  readonly id: string;
  readonly sessionId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly ocoGroupId?: string | null;
  /** Needed to recompute the remaining exposure after a partial fill. */
  readonly type?: 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT' | 'OCO';
  readonly limitPrice?: DecimalString | null;
  readonly quantity?: DecimalString;
  readonly filledQuantityAfter?: DecimalString;
}

export interface FillSettlementInput {
  readonly order: SettlementOrder;
  readonly fills: readonly SettlementFill[];
  readonly terminal: boolean;
  /** Fee the remaining quantity would cost at `price`; sizes the kept reservation. */
  readonly estimateFee?: (
    price: DecimalString,
    quantity: DecimalString,
  ) => DecimalString;
}

interface ReservationRow {
  id: string;
  amount: string;
}

/**
 * Locks the balance row a fill will settle into (wallet for BUY, position for
 * SELL). Fill persistence calls this FIRST — before it locks the order row —
 * so fills and cancellations take ledger locks in the same order
 * (session → balance → order → reservation) and cannot deadlock each other.
 */
export async function lockBalances(
  executor: LedgerExecutor,
  order: Pick<SettlementOrder, 'sessionId' | 'market' | 'symbol' | 'side'>,
): Promise<void> {
  // Both sides touch both balances (a BUY grows the position, a SELL credits
  // the wallet), so both rows are locked up front in rank order — wallets
  // before positions — whatever the side; opposing fills cannot cycle.
  await sql`
    select id from wallets where session_id = ${order.sessionId}::uuid
      and currency = ${currencyFor(order.market)} for update
  `.execute(executor);
  await sql`
    select id from positions where session_id = ${order.sessionId}::uuid
      and market_code = ${order.market} and symbol = ${order.symbol} for update
  `.execute(executor);
}

async function lockReservation(
  executor: LedgerExecutor,
  input: SettlementOrder,
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

function remainingExposure(
  input: FillSettlementInput,
): DecimalString | undefined {
  const { order } = input;
  if (
    input.terminal ||
    order.type !== 'LIMIT' ||
    order.limitPrice === undefined ||
    order.limitPrice === null ||
    order.quantity === undefined ||
    order.filledQuantityAfter === undefined
  )
    return undefined;
  const remaining = assertExactMoney(
    moneyDecimal(order.quantity).minus(order.filledQuantityAfter),
    'Remaining quantity',
  );
  if (remaining.isNegative() || remaining.isZero()) return '0';
  // A SELL reservation is denominated in shares: no notional is involved.
  if (order.side === 'SELL') return remaining.toString();
  const notional = assertExactMoney(
    remaining.mul(order.limitPrice),
    'Remaining notional',
  );
  const fee =
    input.estimateFee?.(order.limitPrice, remaining.toString()) ?? '0';
  return assertExactMoney(notional.plus(fee), 'Remaining exposure').toString();
}

/**
 * Settles engine fills against the ledger inside the caller's transaction,
 * which must already hold the session and the balance row (`lockBalances`)
 * and the order row: BUY debits the wallet (consuming the cash reservation)
 * and grows the position at weighted average cost; SELL shrinks the position
 * (consuming the position reservation) and credits the proceeds. Legacy
 * orders without a reservation row settle out of `available` alone.
 */
export async function settleFill(
  executor: LedgerExecutor,
  input: FillSettlementInput,
): Promise<void> {
  const { order } = input;
  const currency = currencyFor(order.market);
  const reservation = await lockReservation(executor, order);
  const remaining = reservation?.amount ?? '0';
  const desiredRemaining = remainingExposure(input);
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
        (sum, f) =>
          assertExactMoney(
            sum
              .plus(
                assertExactMoney(
                  moneyDecimal(f.price).mul(f.quantity),
                  'Fill notional',
                ),
              )
              .plus(f.fee),
            'Fill cost',
          ),
        moneyDecimal(0),
      )
      .toString();
    const plan = planSettlement(
      {
        balances: wallet,
        reservationRemaining: remaining,
        consumed: cost,
        terminal: input.terminal,
        ...(desiredRemaining === undefined ? {} : { desiredRemaining }),
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
    .reduce((sum, f) => sum.plus(f.quantity), moneyDecimal(0))
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
      ...(desiredRemaining === undefined ? {} : { desiredRemaining }),
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
      (sum, f) =>
        assertExactMoney(
          sum
            .plus(
              assertExactMoney(
                moneyDecimal(f.price).mul(f.quantity),
                'Fill notional',
              ),
            )
            .minus(f.fee),
          'Fill proceeds',
        ),
      moneyDecimal(0),
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
  order: SettlementOrder,
  fills: readonly SettlementFill[],
): Promise<void> {
  const current = (
    await sql<{ id: string; total_quantity: string; average_cost: string }>`
      select id::text, total_quantity::text, average_cost::text from positions
      where session_id = ${order.sessionId}::uuid and market_code = ${order.market} and symbol = ${order.symbol} for update
    `.execute(executor)
  ).rows[0];
  // Cost basis is reconstructed from the stored average (the schema keeps no
  // total cost); the average itself is written with trading-core's canonical
  // 10-place rounding so successive fills round the same way the core does.
  let quantity = moneyDecimal(current?.total_quantity ?? '0');
  let totalCost = current
    ? assertExactMoney(
        moneyDecimal(current.average_cost).mul(current.total_quantity),
        'Position cost basis',
      )
    : moneyDecimal(0);
  for (const fill of fills) {
    quantity = quantity.plus(fill.quantity);
    totalCost = assertExactMoney(
      totalCost
        .plus(
          assertExactMoney(
            moneyDecimal(fill.price).mul(fill.quantity),
            'Fill notional',
          ),
        )
        .plus(fill.fee),
      'Position cost basis',
    );
  }
  const added = assertExactMoney(
    quantity.minus(current?.total_quantity ?? '0'),
    'Position increment',
  ).toString();
  const averageCost = calculateAverageCost({
    symbol: order.symbol,
    quantity: quantity.toString(),
    totalCost: totalCost.toString(),
    realizedPnl: '0',
  });
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
