import { DomainError } from './domain-errors.js';
import { type OrderSnapshot, transitionOrder } from './order.js';

export type OcoGroupStatus = 'ACTIVE' | 'RESOLVED';

export interface OcoGroupSnapshot {
  readonly id: string;
  readonly status: OcoGroupStatus;
  readonly legs: readonly [OrderSnapshot, OrderSnapshot];
  readonly winnerLegId?: string;
  readonly version: bigint;
}

export function resolveOco(
  group: OcoGroupSnapshot,
  winnerLegId: string,
): OcoGroupSnapshot {
  if (group.status !== 'ACTIVE') {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      `OCO group ${group.id} is not active`,
    );
  }

  if (group.winnerLegId !== undefined) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `Active OCO group ${group.id} already records a winner`,
    );
  }

  const [firstLeg, secondLeg] = group.legs;
  if (firstLeg.id === secondLeg.id) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      `OCO group ${group.id} must have two distinct legs`,
    );
  }

  if (winnerLegId !== firstLeg.id && winnerLegId !== secondLeg.id) {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      `Order ${winnerLegId} is not a leg of OCO group ${group.id}`,
    );
  }

  const winnerIsFirst = winnerLegId === firstLeg.id;
  const winner = winnerIsFirst ? firstLeg : secondLeg;
  if (
    winner.status === 'CANCELLED' ||
    winner.status === 'EXPIRED' ||
    winner.status === 'REJECTED'
  ) {
    throw new DomainError(
      'ORDER_STATE_CONFLICT',
      `Order ${winnerLegId} cannot win OCO group ${group.id}`,
    );
  }

  const cancelledSibling = transitionOrder(
    winnerIsFirst ? secondLeg : firstLeg,
    { type: 'CANCELLED' },
  );

  return {
    ...group,
    status: 'RESOLVED',
    winnerLegId,
    legs: winnerIsFirst
      ? [firstLeg, cancelledSibling]
      : [cancelledSibling, secondLeg],
    version: group.version + 1n,
  };
}
