import { Decimal } from 'decimal.js';

import { DomainError } from './domain-errors.js';
import type { DecimalString } from './domain-types.js';

export const decimal = (value: Decimal.Value): Decimal => new Decimal(value);

export const canonicalDecimal = (...values: Decimal.Value[]): DecimalString =>
  values
    .reduce<Decimal>((sum, value) => sum.plus(value), new Decimal(0))
    .toString();

export function assertPositiveWholeQuantity(value: DecimalString): void {
  const quantity = decimal(value);

  if (!quantity.isInteger() || !quantity.gt(0)) {
    throw new DomainError(
      'INVALID_QUANTITY',
      'Quantity must be a positive whole number',
    );
  }
}
