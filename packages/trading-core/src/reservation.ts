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
const orderStatuses = new Set<string>([
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
const sides = new Set<string>(['BUY', 'SELL']);
const reservationOrderTypes = new Set<string>([
  'MARKET',
  'LIMIT',
  'STOP',
  'TAKE_PROFIT',
]);
const currencies = new Set<string>(['KRW', 'USD']);
const terminalStatuses = new Set<string>([
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
]);
const progressedOcoStatuses = new Set<string>([
  'TRIGGERED',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
]);

function invalidOrder(message: string): never {
  throw new DomainError('INVALID_ORDER', message);
}

function legFilledQuantity(order: ReservationOrder) {
  return assertNonNegativeWhole(order.filledQuantity ?? '0', 'Filled quantity');
}

// An OCO leg has group progress when it is currently progressed or when it
// already realized a fill. Terminal CANCELLED/EXPIRED legs legitimately keep a
// positive partial fill, so status alone cannot detect execution.
function hasGroupProgress(
  order: ReservationOrder,
  filled: ReturnType<typeof legFilledQuantity>,
): boolean {
  return progressedOcoStatuses.has(order.status) || filled.gt(0);
}

function invariantViolation(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function readDecimal(
  value: DecimalString,
  code: 'INVALID_ORDER' | 'INVARIANT_VIOLATION',
  description: string,
) {
  if (typeof value !== 'string') {
    throw new DomainError(code, `${description} must be a decimal string`);
  }
  try {
    const result = decimal(value);
    if (!result.isFinite()) {
      throw new Error('Decimal must be finite');
    }
    return result;
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

function assertNonNegativeInvariantWhole(
  value: DecimalString,
  description: string,
) {
  const result = assertNonNegative(value, 'INVARIANT_VIOLATION', description);
  if (!result.isInteger()) {
    invariantViolation(`${description} must be a whole quantity`);
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
  if (typeof position.symbol !== 'string') {
    invariantViolation('Position symbol must be a string');
  }
  if (position.symbol.trim().length === 0) {
    invariantViolation('Position symbol must not be empty');
  }

  const total = assertNonNegativeInvariantWhole(
    position.total,
    'Position total quantity',
  );
  const available = assertNonNegativeInvariantWhole(
    position.available,
    'Position available quantity',
  );
  const reserved = assertNonNegativeInvariantWhole(
    position.reserved,
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
  const requested = assertNonNegativeInvariantWhole(
    quantity,
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

  const requested = isWallet
    ? assertNonNegative(amount, 'INVARIANT_VIOLATION', 'Reservation release')
    : assertNonNegativeInvariantWhole(amount, 'Reservation release');
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

function assertReservationOrderShape(
  order: unknown,
): asserts order is ReservationOrder {
  if (typeof order !== 'object' || order === null) {
    invalidOrder('Reservation order must be an object');
  }

  const candidate = order as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.trim().length === 0 ||
    typeof candidate.symbol !== 'string' ||
    candidate.symbol.trim().length === 0 ||
    typeof candidate.quantity !== 'string' ||
    typeof candidate.status !== 'string' ||
    !orderStatuses.has(candidate.status) ||
    typeof candidate.side !== 'string' ||
    !sides.has(candidate.side) ||
    typeof candidate.type !== 'string' ||
    !reservationOrderTypes.has(candidate.type) ||
    typeof candidate.currency !== 'string' ||
    !currencies.has(candidate.currency)
  ) {
    invalidOrder('Reservation order has an invalid identity or discriminant');
  }

  for (const field of [
    'filledQuantity',
    'limitPrice',
    'referencePrice',
    'estimatedFee',
  ]) {
    const value = candidate[field];
    if (value !== undefined && typeof value !== 'string') {
      invalidOrder(`${field} must be a decimal string when present`);
    }
  }

  const isLimit = candidate.type === 'LIMIT';
  if (
    (isLimit &&
      (candidate.limitPrice === undefined ||
        candidate.referencePrice !== undefined)) ||
    (!isLimit &&
      (candidate.referencePrice === undefined ||
        candidate.limitPrice !== undefined))
  ) {
    invalidOrder('Order price fields do not match its order type');
  }

  if (candidate.limitPrice !== undefined) {
    const limitPrice = readDecimal(
      candidate.limitPrice as DecimalString,
      'INVALID_ORDER',
      'Limit price',
    );
    if (!limitPrice.gt(0)) {
      throw new DomainError('INVALID_PRICE', 'Limit price must be positive');
    }
  }
  if (candidate.referencePrice !== undefined) {
    const referencePrice = readDecimal(
      candidate.referencePrice as DecimalString,
      'INVALID_ORDER',
      'Reference price',
    );
    if (!referencePrice.gt(0)) {
      throw new DomainError(
        'INVALID_PRICE',
        'Reference price must be positive',
      );
    }
  }
  if (candidate.estimatedFee !== undefined) {
    assertNonNegative(
      candidate.estimatedFee as DecimalString,
      'INVALID_ORDER',
      'Estimated fee',
    );
  }
}

function remainingQuantity(order: ReservationOrder) {
  const quantity = assertPositiveWhole(order.quantity, 'Order quantity');
  const filled = assertNonNegativeWhole(
    order.filledQuantity ?? '0',
    'Filled quantity',
  );
  if (filled.gt(quantity)) {
    invalidOrder('Filled quantity must not exceed order quantity');
  }
  if (
    (order.status === 'FILLED' &&
      (order.filledQuantity === undefined || !filled.eq(quantity))) ||
    (order.status === 'REJECTED' && !filled.isZero()) ||
    ((order.status === 'CANCELLED' || order.status === 'EXPIRED') &&
      !filled.lt(quantity)) ||
    (order.status === 'PARTIALLY_FILLED' &&
      (order.filledQuantity === undefined ||
        !filled.gt(0) ||
        !filled.lt(quantity))) ||
    ((order.status === 'RECEIVED' ||
      order.status === 'PENDING_TRIGGER' ||
      order.status === 'TRIGGERED' ||
      order.status === 'OPEN') &&
      !filled.isZero())
  ) {
    invalidOrder('Filled quantity is inconsistent with order status');
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
  if (order.type === 'LIMIT') {
    const limitPrice = readDecimal(
      order.limitPrice as DecimalString,
      'INVALID_ORDER',
      'Limit price',
    );
    return {
      currency: order.currency,
      amount: remaining.mul(limitPrice).plus(fee).toString(),
    };
  }

  const referencePrice = readDecimal(
    order.referencePrice as DecimalString,
    'INVALID_ORDER',
    'Reference price',
  );
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
  assertReservationOrderShape(order);
  const remaining = remainingQuantity(order);
  if (terminalStatuses.has(order.status)) {
    return order.side === 'BUY'
      ? { cash: { currency: order.currency, amount: '0' } }
      : { position: { symbol: order.symbol, quantity: '0' } };
  }
  if (order.side === 'BUY') {
    return { cash: plannedBuyCash(order, remaining) };
  }
  return { position: { symbol: order.symbol, quantity: remaining.toString() } };
}

export function planOcoReservation(
  legs: readonly [ReservationOrder, ReservationOrder],
): ReservationPlan {
  if (!Array.isArray(legs) || legs.length !== 2) {
    invalidOrder('OCO reservation must contain exactly two legs');
  }
  const [first, second] = legs;
  assertReservationOrderShape(first);
  assertReservationOrderShape(second);
  if (
    first.side !== second.side ||
    first.currency !== second.currency ||
    first.symbol !== second.symbol ||
    first.id === second.id
  ) {
    invalidOrder(
      'OCO reservation legs must have the same side, currency, and symbol',
    );
  }

  // Each leg must be individually consistent before any group reasoning.
  remainingQuantity(first);
  remainingQuantity(second);

  const quantity = assertPositiveWhole(first.quantity, 'Order quantity');
  if (!quantity.eq(assertPositiveWhole(second.quantity, 'Order quantity'))) {
    invalidOrder('OCO reservation legs must share one quantity');
  }

  const firstFilled = legFilledQuantity(first);
  const secondFilled = legFilledQuantity(second);
  if (
    hasGroupProgress(first, firstFilled) &&
    hasGroupProgress(second, secondFilled)
  ) {
    invalidOrder('OCO reservation cannot have two progressed legs');
  }

  // At most one leg may execute, so the group's realized fill is whichever leg
  // progressed, and the shared exposure is the single remainder after it.
  const groupRemaining = quantity.minus(
    firstFilled.gte(secondFilled) ? firstFilled : secondFilled,
  );
  const liveLegs = [first, second].filter(
    (leg) => !terminalStatuses.has(leg.status),
  );
  if (groupRemaining.isZero() || liveLegs.length === 0) {
    return first.side === 'BUY'
      ? { cash: { currency: first.currency, amount: '0' } }
      : { position: { symbol: first.symbol, quantity: '0' } };
  }

  if (first.side === 'BUY') {
    const amount = liveLegs
      .map((leg) => decimal(plannedBuyCash(leg, groupRemaining).amount))
      .reduce((highest, value) => (value.gt(highest) ? value : highest));
    return {
      cash: { currency: first.currency, amount: amount.toString() },
    };
  }

  return {
    position: { symbol: first.symbol, quantity: groupRemaining.toString() },
  };
}
