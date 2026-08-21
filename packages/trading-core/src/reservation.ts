import { decimal } from './decimal.js';
import { DomainError } from './domain-errors.js';
import type {
  Currency,
  DecimalString,
  Money,
  OrderStatus,
  OrderType,
  Quantity,
  Side,
} from './domain-types.js';

export interface WalletSnapshot {
  readonly currency: Currency;
  readonly total: DecimalString;
  readonly available: DecimalString;
  readonly reserved: DecimalString;
  readonly version: bigint;
}

export interface PositionSnapshot {
  readonly symbol: string;
  readonly total: Quantity;
  readonly available: Quantity;
  readonly reserved: Quantity;
  readonly version: bigint;
}

export interface PositionReservation {
  readonly symbol: string;
  readonly quantity: Quantity;
}

export interface ReservationPlan {
  readonly cash?: Money;
  readonly position?: PositionReservation;
}

export interface ReservationOrder {
  readonly id: string;
  readonly status: OrderStatus;
  readonly side: Side;
  readonly type: Exclude<OrderType, 'OCO'>;
  readonly currency: Currency;
  readonly symbol: string;
  readonly quantity: Quantity;
  readonly filledQuantity?: Quantity;
  readonly limitPrice?: DecimalString;
  readonly referencePrice?: DecimalString;
  readonly estimatedFee?: DecimalString;
}

const priceProtectionMultiplier = decimal('1.05');

function invalidOrder(message: string): never {
  throw new DomainError('INVALID_ORDER', message);
}

function invariantViolation(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function readDecimal(
  value: DecimalString,
  code: 'INVALID_ORDER' | 'INVARIANT_VIOLATION',
  description: string,
) {
  try {
    return decimal(value);
  } catch {
    throw new DomainError(code, `${description} must be a decimal string`);
  }
}

function assertNonNegative(
  value: DecimalString,
  code: 'INVALID_ORDER' | 'INVARIANT_VIOLATION',
  description: string,
) {
  const result = readDecimal(value, code, description);
  if (result.isNegative()) {
    throw new DomainError(code, `${description} must not be negative`);
  }
  return result;
}

function assertPositiveWhole(value: DecimalString, description: string) {
  const result = readDecimal(value, 'INVALID_ORDER', description);
  if (!result.isInteger() || !result.gt(0)) {
    invalidOrder(`${description} must be a positive whole quantity`);
  }
  return result;
}

function assertNonNegativeWhole(value: DecimalString, description: string) {
  const result = readDecimal(value, 'INVALID_ORDER', description);
  if (!result.isInteger() || result.isNegative()) {
    invalidOrder(`${description} must be a non-negative whole quantity`);
  }
  return result;
}

function assertWalletSnapshot(wallet: WalletSnapshot): void {
  if (wallet.currency !== 'KRW' && wallet.currency !== 'USD') {
    invariantViolation('Wallet currency must be KRW or USD');
  }

  const total = assertNonNegative(
    wallet.total,
    'INVARIANT_VIOLATION',
    'Wallet total',
  );
  const available = assertNonNegative(
    wallet.available,
    'INVARIANT_VIOLATION',
    'Wallet available cash',
  );
  const reserved = assertNonNegative(
    wallet.reserved,
    'INVARIANT_VIOLATION',
    'Wallet reserved cash',
  );
  if (!total.eq(available.plus(reserved))) {
    invariantViolation('Wallet total must equal available plus reserved');
  }
}

function assertPositionSnapshot(position: PositionSnapshot): void {
  if (position.symbol.trim().length === 0) {
    invariantViolation('Position symbol must not be empty');
  }

  const total = assertNonNegative(
    position.total,
    'INVARIANT_VIOLATION',
    'Position total quantity',
  );
  const available = assertNonNegative(
    position.available,
    'INVARIANT_VIOLATION',
    'Position available quantity',
  );
  const reserved = assertNonNegative(
    position.reserved,
    'INVARIANT_VIOLATION',
    'Position reserved quantity',
  );
  if (!total.eq(available.plus(reserved))) {
    invariantViolation('Position total must equal available plus reserved');
  }
}

export function reserveCash(
  wallet: WalletSnapshot,
  amount: DecimalString,
): WalletSnapshot {
  assertWalletSnapshot(wallet);
  const requested = assertNonNegative(
    amount,
    'INVARIANT_VIOLATION',
    'Cash reservation',
  );
  const available = decimal(wallet.available);
  if (available.lt(requested)) {
    throw new DomainError(
      'INSUFFICIENT_AVAILABLE_CASH',
      'Available cash is insufficient',
    );
  }

  return {
    ...wallet,
    available: available.minus(requested).toString(),
    reserved: decimal(wallet.reserved).plus(requested).toString(),
    version: wallet.version + 1n,
  };
}

export function reservePosition(
  position: PositionSnapshot,
  quantity: Quantity,
): PositionSnapshot {
  assertPositionSnapshot(position);
  const requested = assertNonNegative(
    quantity,
    'INVARIANT_VIOLATION',
    'Position reservation',
  );
  const available = decimal(position.available);
  if (available.lt(requested)) {
    throw new DomainError(
      'INSUFFICIENT_AVAILABLE_POSITION',
      'Available position is insufficient',
    );
  }

  return {
    ...position,
    available: available.minus(requested).toString(),
    reserved: decimal(position.reserved).plus(requested).toString(),
    version: position.version + 1n,
  };
}

export function releaseReservation(
  wallet: WalletSnapshot,
  amount: DecimalString,
): WalletSnapshot;
export function releaseReservation(
  position: PositionSnapshot,
  quantity: Quantity,
): PositionSnapshot;
export function releaseReservation(
  asset: WalletSnapshot | PositionSnapshot,
  amount: DecimalString,
): WalletSnapshot | PositionSnapshot {
  const isWallet = 'currency' in asset;
  if (isWallet) {
    assertWalletSnapshot(asset);
  } else {
    assertPositionSnapshot(asset);
  }

  const requested = assertNonNegative(
    amount,
    'INVARIANT_VIOLATION',
    'Reservation release',
  );
  const reserved = decimal(asset.reserved);
  if (reserved.lt(requested)) {
    invariantViolation('Reservation release exceeds reserved balance');
  }

  return {
    ...asset,
    available: decimal(asset.available).plus(requested).toString(),
    reserved: reserved.minus(requested).toString(),
    version: asset.version + 1n,
  };
}

function remainingQuantity(order: ReservationOrder) {
  if (order.id.trim().length === 0 || order.symbol.trim().length === 0) {
    invalidOrder('Reservation order must identify an order and symbol');
  }

  const quantity = assertPositiveWhole(order.quantity, 'Order quantity');
  const filled = assertNonNegativeWhole(
    order.filledQuantity ?? '0',
    'Filled quantity',
  );
  if (filled.gt(quantity)) {
    invalidOrder('Filled quantity must not exceed order quantity');
  }
  return quantity.minus(filled);
}

function plannedBuyCash(
  order: ReservationOrder,
  remaining: ReturnType<typeof remainingQuantity>,
): Money {
  const fee = assertNonNegative(
    order.estimatedFee ?? '0',
    'INVALID_ORDER',
    'Estimated fee',
  );
  if (remaining.isZero()) {
    return { currency: order.currency, amount: '0' };
  }
  const isLimitBuy = order.type === 'LIMIT' || order.limitPrice !== undefined;
  if (isLimitBuy) {
    if (order.limitPrice === undefined) {
      invalidOrder('Limit buy reservation requires a limit price');
    }
    const limitPrice = readDecimal(
      order.limitPrice,
      'INVALID_ORDER',
      'Limit price',
    );
    if (!limitPrice.gt(0)) {
      throw new DomainError('INVALID_PRICE', 'Limit price must be positive');
    }
    return {
      currency: order.currency,
      amount: remaining.mul(limitPrice).plus(fee).toString(),
    };
  }

  if (order.referencePrice === undefined) {
    invalidOrder('Market buy reservation requires a reference price');
  }
  const referencePrice = readDecimal(
    order.referencePrice,
    'INVALID_ORDER',
    'Reference price',
  );
  if (!referencePrice.gt(0)) {
    throw new DomainError('INVALID_PRICE', 'Reference price must be positive');
  }
  return {
    currency: order.currency,
    amount: remaining
      .mul(referencePrice)
      .mul(priceProtectionMultiplier)
      .plus(fee)
      .toString(),
  };
}

export function planReservation(order: ReservationOrder): ReservationPlan {
  const remaining = remainingQuantity(order);
  if (order.side === 'BUY') {
    return { cash: plannedBuyCash(order, remaining) };
  }
  return { position: { symbol: order.symbol, quantity: remaining.toString() } };
}

export function planOcoReservation(
  legs: readonly [ReservationOrder, ReservationOrder],
): ReservationPlan {
  const [first, second] = legs;
  if (
    first.side !== second.side ||
    first.currency !== second.currency ||
    first.symbol !== second.symbol
  ) {
    invalidOrder(
      'OCO reservation legs must have the same side, currency, and symbol',
    );
  }

  const firstPlan = planReservation(first);
  const secondPlan = planReservation(second);
  if (first.side === 'BUY') {
    const firstCash = firstPlan.cash;
    const secondCash = secondPlan.cash;
    if (firstCash === undefined || secondCash === undefined) {
      invalidOrder('Buy OCO legs must reserve cash');
    }
    return {
      cash: {
        currency: first.currency,
        amount: decimal(firstCash.amount).gte(secondCash.amount)
          ? firstCash.amount
          : secondCash.amount,
      },
    };
  }

  const firstPosition = firstPlan.position;
  const secondPosition = secondPlan.position;
  if (firstPosition === undefined || secondPosition === undefined) {
    invalidOrder('Sell OCO legs must reserve position');
  }
  return {
    position: {
      symbol: first.symbol,
      quantity: decimal(firstPosition.quantity).gte(secondPosition.quantity)
        ? firstPosition.quantity
        : secondPosition.quantity,
    },
  };
}
