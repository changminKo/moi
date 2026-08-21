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

const nextStatusByEvent: Record<OrderEvent['type'], OrderStatus> = {
  REJECTED: 'REJECTED',
  OPENED: 'OPEN',
  PENDING_TRIGGER: 'PENDING_TRIGGER',
  TRIGGERED: 'TRIGGERED',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  IOC_REMAINDER: 'CANCELLED',
};

const eventsByStatus: Record<OrderStatus, ReadonlySet<OrderEvent['type']>> = {
  RECEIVED: new Set(['REJECTED', 'OPENED', 'PENDING_TRIGGER']),
  PENDING_TRIGGER: new Set(['TRIGGERED', 'CANCELLED', 'EXPIRED']),
  TRIGGERED: new Set(['OPENED', 'FILLED', 'CANCELLED']),
  OPEN: new Set([
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELLED',
    'EXPIRED',
    'IOC_REMAINDER',
  ]),
  PARTIALLY_FILLED: new Set([
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELLED',
    'EXPIRED',
    'IOC_REMAINDER',
  ]),
  FILLED: new Set(),
  CANCELLED: new Set(),
  EXPIRED: new Set(),
  REJECTED: new Set(),
};

const transitions: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  RECEIVED: new Set(['REJECTED', 'OPEN', 'PENDING_TRIGGER']),
  PENDING_TRIGGER: new Set(['TRIGGERED', 'CANCELLED', 'EXPIRED']),
  TRIGGERED: new Set(['OPEN', 'FILLED', 'CANCELLED']),
  OPEN: new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED']),
  PARTIALLY_FILLED: new Set([
    'PARTIALLY_FILLED',
    'FILLED',
    'CANCELLED',
    'EXPIRED',
  ]),
  FILLED: new Set(),
  CANCELLED: new Set(),
  EXPIRED: new Set(),
  REJECTED: new Set(),
};

export function transitionOrder(
  order: OrderSnapshot,
  event: OrderEvent,
): OrderSnapshot {
  const nextStatus = nextStatusByEvent[event.type];

  if (
    !eventsByStatus[order.status].has(event.type) ||
    !transitions[order.status].has(nextStatus)
  ) {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      `${order.status} cannot transition on ${event.type}`,
    );
  }

  if (event.type === 'IOC_REMAINDER') {
    assertPositiveWholeQuantity(event.filledQuantity);

    return {
      ...order,
      status: nextStatus,
      version: order.version + 1n,
      filledQuantity: event.filledQuantity,
      terminalReason: 'IOC_REMAINDER',
    };
  }

  return { ...order, status: nextStatus, version: order.version + 1n };
}
