import { Decimal } from 'decimal.js';

import { assertExactMoney, decimal, readExactMoney } from './decimal.js';
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

// Weighted-cost division is the only inexact portfolio operation. Round that
// quotient deterministically; exact additions and subtractions retain every
// supplied fee/cost digit.
const DIVISION_DECIMAL_PLACES = 10;

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
    const result = readExactMoney(value, code, description);
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
    return BigInt(quantity.toFixed());
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

function roundDivision(value: Decimal): Decimal {
  return assertExactMoney(
    value.toDecimalPlaces(DIVISION_DECIMAL_PLACES, Decimal.ROUND_HALF_UP),
    'Rounded portfolio division',
  );
}

function assertPosition(position: PositionCost) {
  if (typeof position !== 'object' || position === null) {
    invariantViolation('Position must be an object');
  }
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
  if (quantity === 0n && !totalCost.isZero()) {
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
  if (typeof fill !== 'object' || fill === null) {
    throw new DomainError('INVALID_ORDER', 'Fill must be an object');
  }
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
    const notional = assertExactMoney(
      price.mul(quantity.toString()),
      'Portfolio buy notional',
    );
    const costBeforeFee = assertExactMoney(
      current.totalCost.plus(notional),
      'Portfolio cost before fee',
    );
    return {
      ...position,
      quantity: (current.quantity + quantity).toString(),
      totalCost: assertExactMoney(
        costBeforeFee.plus(fee),
        'Portfolio total cost',
      ).toString(),
    };
  }

  if (quantity > current.quantity) {
    throw new DomainError(
      'INSUFFICIENT_AVAILABLE_POSITION',
      'Sell fill exceeds the held position',
    );
  }
  const liquidated = quantity === current.quantity;
  const calculatedCostRemoved = liquidated
    ? current.totalCost
    : roundDivision(
        assertExactMoney(
          current.totalCost.mul(quantity.toString()),
          'Weighted cost numerator',
        ).div(current.quantity.toString()),
      );
  const costRemoved = calculatedCostRemoved.gt(current.totalCost)
    ? current.totalCost
    : calculatedCostRemoved;
  const proceeds = assertExactMoney(
    price.mul(quantity.toString()),
    'Portfolio sell proceeds',
  );
  const proceedsAfterFee = assertExactMoney(
    proceeds.minus(fee),
    'Portfolio proceeds after fee',
  );
  const realizedDelta = assertExactMoney(
    proceedsAfterFee.minus(costRemoved),
    'Portfolio realized delta',
  );

  return {
    ...position,
    quantity: (current.quantity - quantity).toString(),
    totalCost: liquidated
      ? '0'
      : assertExactMoney(
          current.totalCost.minus(costRemoved),
          'Remaining portfolio cost',
        ).toString(),
    realizedPnl: assertExactMoney(
      current.realizedPnl.plus(realizedDelta),
      'Portfolio realized PnL',
    ).toString(),
  };
}

export function calculateAverageCost(position: PositionCost): DecimalString {
  const { quantity, totalCost } = assertPosition(position);
  return quantity === 0n
    ? '0'
    : roundDivision(totalCost.div(quantity.toString())).toString();
}

export function calculateUnrealizedPnl(
  position: PositionCost,
  currentPrice: DecimalString,
): DecimalString {
  const { quantity, totalCost } = assertPosition(position);
  const price = readPositivePrice(currentPrice, 'Current price');
  const marketValue = assertExactMoney(
    price.mul(quantity.toString()),
    'Portfolio market value',
  );
  return assertExactMoney(
    marketValue.minus(totalCost),
    'Portfolio unrealized PnL',
  ).toString();
}
