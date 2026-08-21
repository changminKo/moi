import { Decimal } from 'decimal.js';

import { DomainError } from './domain-errors.js';
import type { DecimalString } from './domain-types.js';

export const decimal = (value: Decimal.Value): Decimal => new Decimal(value);

// Public money is plain base-10 with a bounded coefficient and exponent. The
// internal precision is wide enough to inspect any binary operation on two
// accepted values exactly; callers must validate every operation immediately.
export const MONEY_PRECISION = 80;
export const MONEY_MAX_INTEGER_DIGITS = 80;
export const MONEY_MAX_DECIMAL_PLACES = 80;
const MONEY_OPERATION_PRECISION = MONEY_PRECISION * 2 + 1;
const MAX_PLAIN_MONEY_LENGTH =
  MONEY_MAX_INTEGER_DIGITS + MONEY_MAX_DECIMAL_PLACES + 2;
const MoneyDecimal = Decimal.clone({
  precision: MONEY_OPERATION_PRECISION,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export const moneyDecimal = (value: Decimal.Value): Decimal =>
  new MoneyDecimal(value);

type MoneyErrorCode = 'INVALID_ORDER' | 'INVALID_PRICE' | 'INVARIANT_VIOLATION';

function moneyDomainError(code: MoneyErrorCode, description: string): never {
  throw new DomainError(code, `${description} exceeds the exact money domain`);
}

export function assertExactMoney(
  value: Decimal,
  description: string,
  code: MoneyErrorCode = 'INVARIANT_VIOLATION',
): Decimal {
  const integerDigits = value.isZero() ? 1 : Math.max(value.e + 1, 1);
  if (
    !value.isFinite() ||
    value.precision() > MONEY_PRECISION ||
    integerDigits > MONEY_MAX_INTEGER_DIGITS ||
    value.decimalPlaces() > MONEY_MAX_DECIMAL_PLACES
  ) {
    moneyDomainError(code, description);
  }
  return value;
}

export function readExactMoney(
  value: unknown,
  code: MoneyErrorCode,
  description: string,
): Decimal {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PLAIN_MONEY_LENGTH ||
    value.match(/-?[0-9]+(?:\.[0-9]+)?/u)?.[0] !== value
  ) {
    moneyDomainError(code, description);
  }

  try {
    return assertExactMoney(moneyDecimal(value), description, code);
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    moneyDomainError(code, description);
  }
}

export const canonicalDecimal = (...values: Decimal.Value[]): DecimalString =>
  values
    .reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0))
    .toString();

export function assertPositiveWholeQuantity(value: DecimalString): void {
  let quantity: Decimal;

  try {
    quantity = decimal(value);
  } catch {
    throw new DomainError(
      'INVALID_QUANTITY',
      'Quantity must be a positive whole number',
    );
  }

  if (!quantity.isInteger() || !quantity.gt(0)) {
    throw new DomainError(
      'INVALID_QUANTITY',
      'Quantity must be a positive whole number',
    );
  }
}
