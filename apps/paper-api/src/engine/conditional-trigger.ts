import {
  type DecimalString,
  DomainError,
  decimal,
  type Side,
} from '@moi/trading-core';

export interface ConditionalOrder {
  readonly type: 'STOP' | 'TAKE_PROFIT';
  readonly side: Side;
  readonly stopPrice: DecimalString;
}

/** Evaluate a trigger without converting prices through binary floating point. */
export function evaluateConditional(
  order: ConditionalOrder,
  referencePrice: DecimalString,
): boolean {
  if (
    typeof referencePrice !== 'string' ||
    !/^-?[0-9]+(?:\.[0-9]+)?$/u.test(referencePrice)
  ) {
    throw new DomainError(
      'INVALID_PRICE',
      'Reference price must be a decimal string',
    );
  }
  if (
    typeof order.stopPrice !== 'string' ||
    !/^[0-9]+(?:\.[0-9]+)?$/u.test(order.stopPrice)
  ) {
    throw new DomainError(
      'INVALID_PRICE',
      'Conditional price must be a positive decimal string',
    );
  }
  const threshold = decimal(order.stopPrice);
  const reference = decimal(referencePrice);
  if (
    !threshold.isFinite() ||
    !threshold.gt(0) ||
    !reference.isFinite() ||
    reference.lt(0)
  ) {
    throw new DomainError(
      'INVALID_PRICE',
      'Conditional prices must be finite and positive',
    );
  }
  const stop = order.type === 'STOP';
  const upward = order.side === 'BUY' ? stop : !stop;
  return upward ? reference.gte(threshold) : reference.lte(threshold);
}

export function chooseRecoveryLeg(
  stopLegId: string,
  takeProfitLegId: string,
  bothConditionsTrue: boolean,
  requestedLegId: string,
): string {
  if (bothConditionsTrue) return stopLegId;
  if (requestedLegId !== stopLegId && requestedLegId !== takeProfitLegId) {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      'Requested leg is not part of the OCO group',
    );
  }
  return requestedLegId;
}
