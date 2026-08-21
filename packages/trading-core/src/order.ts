import { assertPositiveWholeQuantity } from './decimal.js';
import { DomainError } from './domain-errors.js';
import type { OrderStatus, Quantity } from './domain-types.js';

export interface OrderSnapshot {
  readonly id: string;
  readonly status: OrderStatus;
  readonly version: bigint;
  readonly filledQuantity?: Quantity;
  readonly terminalReason?: 'IOC_REMAINDER';
}

export type OrderEvent =
  | { readonly type: 'REJECTED' }
  | { readonly type: 'OPENED' }
  | { readonly type: 'PENDING_TRIGGER' }
  | { readonly type: 'TRIGGERED' }
  | { readonly type: 'PARTIALLY_FILLED' }
  | { readonly type: 'FILLED' }
  | { readonly type: 'CANCELLED' }
  | { readonly type: 'EXPIRED' }
  | { readonly type: 'IOC_REMAINDER'; readonly filledQuantity: Quantity };

interface TransitionRule {
  readonly eventType: OrderEvent['type'];
  readonly targetStatus: OrderStatus;
}

const transitionRules: Record<OrderStatus, readonly TransitionRule[]> = {
  RECEIVED: [
    { eventType: 'REJECTED', targetStatus: 'REJECTED' },
    { eventType: 'OPENED', targetStatus: 'OPEN' },
    { eventType: 'PENDING_TRIGGER', targetStatus: 'PENDING_TRIGGER' },
  ],
  PENDING_TRIGGER: [
    { eventType: 'TRIGGERED', targetStatus: 'TRIGGERED' },
    { eventType: 'CANCELLED', targetStatus: 'CANCELLED' },
    { eventType: 'EXPIRED', targetStatus: 'EXPIRED' },
  ],
  TRIGGERED: [
    { eventType: 'OPENED', targetStatus: 'OPEN' },
    { eventType: 'FILLED', targetStatus: 'FILLED' },
    { eventType: 'CANCELLED', targetStatus: 'CANCELLED' },
  ],
  OPEN: [
    { eventType: 'PARTIALLY_FILLED', targetStatus: 'PARTIALLY_FILLED' },
    { eventType: 'FILLED', targetStatus: 'FILLED' },
    { eventType: 'CANCELLED', targetStatus: 'CANCELLED' },
    { eventType: 'EXPIRED', targetStatus: 'EXPIRED' },
    { eventType: 'IOC_REMAINDER', targetStatus: 'CANCELLED' },
  ],
  PARTIALLY_FILLED: [
    { eventType: 'PARTIALLY_FILLED', targetStatus: 'PARTIALLY_FILLED' },
    { eventType: 'FILLED', targetStatus: 'FILLED' },
    { eventType: 'CANCELLED', targetStatus: 'CANCELLED' },
    { eventType: 'EXPIRED', targetStatus: 'EXPIRED' },
    { eventType: 'IOC_REMAINDER', targetStatus: 'CANCELLED' },
  ],
  FILLED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: [],
};

export function transitionOrder(
  order: OrderSnapshot,
  event: OrderEvent,
): OrderSnapshot {
  const transitionRule = transitionRules[order.status].find(
    (rule) => rule.eventType === event.type,
  );

  if (transitionRule === undefined) {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      `${order.status} cannot transition on ${event.type}`,
    );
  }

  if (event.type === 'IOC_REMAINDER') {
    assertPositiveWholeQuantity(event.filledQuantity);

    return {
      ...order,
      status: transitionRule.targetStatus,
      version: order.version + 1n,
      filledQuantity: event.filledQuantity,
      terminalReason: 'IOC_REMAINDER',
    };
  }

  return {
    ...order,
    status: transitionRule.targetStatus,
    version: order.version + 1n,
  };
}
