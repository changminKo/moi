import { Decimal } from 'decimal.js';

import { decimal } from './decimal.js';
import { DomainError } from './domain-errors.js';
import type { DecimalString, Quantity, Side } from './domain-types.js';

export interface PositionCost {
  readonly symbol: string;
  readonly quantity: Quantity;
  readonly totalCost: DecimalString;
  readonly realizedPnl: DecimalString;
}

export interface PositionFill {
  readonly symbol: string;
  readonly side: Side;
  readonly price: DecimalString;
  readonly quantity: Quantity;
  readonly fee: DecimalString;
}

const costPrecision = 10;

function invariantViolation(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function readFiniteDecimal(
  value: DecimalString,
  code: 'INVALID_ORDER' | 'INVALID_PRICE' | 'INVARIANT_VIOLATION',
  description: string,
) {
  if (typeof value !== 'string') {
    throw new DomainError(code, `${description} must be a decimal string`);
  }
  try {
    const result = decimal(value);
    if (!result.isFinite()) {
      throw new DomainError(code, `${description} must be finite`);
    }
    return result;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(code, `${description} must be a decimal string`);
  }
}

function readPositivePrice(value: DecimalString, description: string) {
  const price = readFiniteDecimal(value, 'INVALID_PRICE', description);
  if (!price.gt(0)) {
    throw new DomainError('INVALID_PRICE', `${description} must be positive`);
  }
  return price;
}

function readWholeQuantity(
  value: Quantity,
  allowZero: boolean,
  description: string,
) {
  if (typeof value !== 'string') {
    throw new DomainError(
      'INVALID_QUANTITY',
      `${description} must be a whole quantity`,
    );
  }
  try {
    const quantity = decimal(value);
    if (
      !quantity.isFinite() ||
      !quantity.isInteger() ||
      (allowZero ? quantity.isNegative() : !quantity.gt(0))
    ) {
      throw new DomainError(
        'INVALID_QUANTITY',
        `${description} must be ${allowZero ? 'non-negative' : 'positive'} and whole`,
      );
    }
    return quantity;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      'INVALID_QUANTITY',
      `${description} must be a whole quantity`,
    );
  }
}

function roundCost(value: Decimal): Decimal {
  return value.toDecimalPlaces(costPrecision, Decimal.ROUND_HALF_UP);
}

function assertPosition(position: PositionCost) {
  if (
    typeof position.symbol !== 'string' ||
    position.symbol.trim().length === 0
  ) {
    invariantViolation('Position symbol must be a non-empty string');
  }
  const quantity = readWholeQuantity(
    position.quantity,
    true,
    'Position quantity',
  );
  const totalCost = readFiniteDecimal(
    position.totalCost,
    'INVARIANT_VIOLATION',
    'Position total cost',
  );
  if (totalCost.isNegative()) {
    invariantViolation('Position total cost must not be negative');
  }
  if (quantity.isZero() && !totalCost.isZero()) {
    invariantViolation('An empty position must have zero total cost');
  }
  const realizedPnl = readFiniteDecimal(
    position.realizedPnl,
    'INVARIANT_VIOLATION',
    'Position realized PnL',
  );
  return { quantity, totalCost, realizedPnl };
}

export function applyFillToPosition(
  position: PositionCost,
  fill: PositionFill,
): PositionCost {
  const current = assertPosition(position);
  if (
    typeof fill.symbol !== 'string' ||
    fill.symbol.trim().length === 0 ||
    fill.symbol !== position.symbol ||
    (fill.side !== 'BUY' && fill.side !== 'SELL')
  ) {
    throw new DomainError(
      'INVALID_ORDER',
      'Fill identity must match the position',
    );
  }
  const price = readPositivePrice(fill.price, 'Fill price');
  const quantity = readWholeQuantity(fill.quantity, false, 'Fill quantity');
  const fee = readFiniteDecimal(fill.fee, 'INVALID_ORDER', 'Fill fee');
  if (fee.isNegative()) {
    throw new DomainError('INVALID_ORDER', 'Fill fee must not be negative');
  }

  if (fill.side === 'BUY') {
    return {
      ...position,
      quantity: current.quantity.plus(quantity).toString(),
      totalCost: roundCost(
        current.totalCost.plus(price.mul(quantity)).plus(fee),
      ).toString(),
    };
  }

  if (quantity.gt(current.quantity)) {
    throw new DomainError(
      'INSUFFICIENT_AVAILABLE_POSITION',
      'Sell fill exceeds the held position',
    );
  }
  const liquidated = quantity.eq(current.quantity);
  const costRemoved = liquidated
    ? current.totalCost
    : roundCost(current.totalCost.mul(quantity).div(current.quantity));
  const realizedDelta = price.mul(quantity).minus(fee).minus(costRemoved);

  return {
    ...position,
    quantity: current.quantity.minus(quantity).toString(),
    totalCost: liquidated
      ? '0'
      : roundCost(current.totalCost.minus(costRemoved)).toString(),
    realizedPnl: roundCost(current.realizedPnl.plus(realizedDelta)).toString(),
  };
}

export function calculateAverageCost(position: PositionCost): DecimalString {
  const { quantity, totalCost } = assertPosition(position);
  return quantity.isZero()
    ? '0'
    : roundCost(totalCost.div(quantity)).toString();
}

export function calculateUnrealizedPnl(
  position: PositionCost,
  currentPrice: DecimalString,
): DecimalString {
  const { quantity, totalCost } = assertPosition(position);
  const price = readPositivePrice(currentPrice, 'Current price');
  return roundCost(price.mul(quantity).minus(totalCost)).toString();
}
