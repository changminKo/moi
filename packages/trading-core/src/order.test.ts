import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type OrderEvent,
  type OrderSnapshot,
  transitionOrder,
} from './order.js';

const terminalStatuses = [
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
] as const;

const orderFixture = (
  overrides: Partial<OrderSnapshot> = {},
): OrderSnapshot => ({
  id: 'order-1',
  status: 'RECEIVED',
  version: 1n,
  ...overrides,
});

const events: readonly OrderEvent[] = [
  { type: 'REJECTED' },
  { type: 'OPENED' },
  { type: 'PENDING_TRIGGER' },
  { type: 'TRIGGERED' },
  { type: 'PARTIALLY_FILLED' },
  { type: 'FILLED' },
  { type: 'CANCELLED' },
  { type: 'EXPIRED' },
  { type: 'IOC_REMAINDER', filledQuantity: '1' },
];

describe('transitionOrder', () => {
  it.each([
    ['RECEIVED', { type: 'REJECTED' }, 'REJECTED'],
    ['RECEIVED', { type: 'OPENED' }, 'OPEN'],
    ['RECEIVED', { type: 'PENDING_TRIGGER' }, 'PENDING_TRIGGER'],
    ['PENDING_TRIGGER', { type: 'TRIGGERED' }, 'TRIGGERED'],
    ['PENDING_TRIGGER', { type: 'CANCELLED' }, 'CANCELLED'],
    ['PENDING_TRIGGER', { type: 'EXPIRED' }, 'EXPIRED'],
    ['TRIGGERED', { type: 'OPENED' }, 'OPEN'],
    ['TRIGGERED', { type: 'FILLED' }, 'FILLED'],
    ['TRIGGERED', { type: 'CANCELLED' }, 'CANCELLED'],
    ['OPEN', { type: 'PARTIALLY_FILLED' }, 'PARTIALLY_FILLED'],
    ['OPEN', { type: 'FILLED' }, 'FILLED'],
    ['OPEN', { type: 'CANCELLED' }, 'CANCELLED'],
    ['OPEN', { type: 'EXPIRED' }, 'EXPIRED'],
    ['PARTIALLY_FILLED', { type: 'PARTIALLY_FILLED' }, 'PARTIALLY_FILLED'],
    ['PARTIALLY_FILLED', { type: 'FILLED' }, 'FILLED'],
    ['PARTIALLY_FILLED', { type: 'CANCELLED' }, 'CANCELLED'],
    ['PARTIALLY_FILLED', { type: 'EXPIRED' }, 'EXPIRED'],
  ] as const)(
    'moves %s to %s for the corresponding domain event',
    (status, event, expectedStatus) => {
      const order = orderFixture({ status, version: 4n });

      expect(transitionOrder(order, event)).toEqual({
        ...order,
        status: expectedStatus,
        version: 5n,
      });
    },
  );

  it('never reactivates a terminal order', () => {
    const filled = orderFixture({ status: 'FILLED', version: 4n });

    expect(() => transitionOrder(filled, { type: 'OPENED' })).toThrowError(
      expect.objectContaining({
        code: 'ORDER_STATE_CONFLICT',
        retryable: false,
      }),
    );
  });

  it('rejects every event from every terminal state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...terminalStatuses),
        fc.constantFrom(...events),
        (status, event) => {
          expect(() =>
            transitionOrder(orderFixture({ status }), event),
          ).toThrowError(
            expect.objectContaining({
              code: 'ORDER_STATE_CONFLICT',
              retryable: false,
            }),
          );
        },
      ),
      { seed: 2_026_082_203, numRuns: 200 },
    );
  });

  it('records a positive partial IOC fill as a terminal cancellation', () => {
    const result = transitionOrder(
      orderFixture({ status: 'OPEN', version: 4n }),
      {
        type: 'IOC_REMAINDER',
        filledQuantity: '2',
      },
    );

    expect(result).toEqual({
      id: 'order-1',
      status: 'CANCELLED',
      version: 5n,
      filledQuantity: '2',
      terminalReason: 'IOC_REMAINDER',
    });
  });

  it('rejects an IOC remainder before an order is executable', () => {
    expect(() =>
      transitionOrder(orderFixture({ status: 'PENDING_TRIGGER' }), {
        type: 'IOC_REMAINDER',
        filledQuantity: '1',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'ORDER_STATE_CONFLICT',
        retryable: false,
      }),
    );
  });

  it.each(['0', '-1', '1.5', 'not-a-quantity'])(
    'rejects invalid IOC filled quantity %s',
    (filledQuantity) => {
      expect(() =>
        transitionOrder(orderFixture({ status: 'OPEN' }), {
          type: 'IOC_REMAINDER',
          filledQuantity,
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_QUANTITY', retryable: false }),
      );
    },
  );
});
