import { describe, expect, it } from 'vitest';

import type {
  PositionSnapshot,
  ReservationOrder,
  WalletSnapshot,
} from './reservation.js';
import {
  planOcoReservation,
  planReservation,
  releaseReservation,
  reserveCash,
  reservePosition,
} from './reservation.js';

const walletFixture = (
  overrides: Partial<WalletSnapshot> = {},
): WalletSnapshot => ({
  currency: 'KRW',
  total: '1000',
  available: '1000',
  reserved: '0',
  version: 3n,
  ...overrides,
});

const positionFixture = (
  overrides: Partial<PositionSnapshot> = {},
): PositionSnapshot => ({
  symbol: '005930',
  total: '10',
  available: '10',
  reserved: '0',
  version: 6n,
  ...overrides,
});

describe('cash reservations', () => {
  it('moves cash from available to reserved without changing total', () => {
    const wallet = walletFixture();

    expect(reserveCash(wallet, '250')).toEqual({
      ...wallet,
      available: '750',
      reserved: '250',
      version: 4n,
    });
  });

  it('preserves exact fractional cash decimals', () => {
    expect(reserveCash(walletFixture(), '0.25')).toMatchObject({
      total: '1000',
      available: '999.75',
      reserved: '0.25',
    });
  });

  it('rejects two orders that spend the same available cash', () => {
    const once = reserveCash(walletFixture(), '800');

    expect(() => reserveCash(once, '300')).toThrowError(
      expect.objectContaining({
        code: 'INSUFFICIENT_AVAILABLE_CASH',
        retryable: false,
      }),
    );
  });

  it('releases only the unused cash after a partial execution', () => {
    const reserved = reserveCash(walletFixture(), '1000');

    expect(releaseReservation(reserved, '400')).toEqual({
      ...reserved,
      available: '400',
      reserved: '600',
      version: 5n,
    });
  });

  it('moves a cash reservation by only the amended exposure delta', () => {
    const original = reserveCash(walletFixture(), '500');
    const amended = reserveCash(original, '200');
    const reduced = releaseReservation(amended, '400');

    expect(original).toMatchObject({ available: '500', reserved: '500' });
    expect(amended).toMatchObject({ available: '300', reserved: '700' });
    expect(reduced).toMatchObject({ available: '700', reserved: '300' });
  });

  it('increments the version for zero-value cash reservation changes', () => {
    const reserved = reserveCash(walletFixture(), '0');

    expect(reserved).toEqual({ ...walletFixture(), version: 4n });
    expect(releaseReservation(reserved, '0')).toEqual({
      ...reserved,
      version: 5n,
    });
  });

  it.each(['NaN', 'Infinity', '-Infinity', '', 'not-a-decimal'])(
    'rejects non-finite or malformed cash reservation amount %s',
    (amount) => {
      expect(() => reserveCash(walletFixture(), amount)).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it('rejects a runtime numeric cash amount at the decimal-string boundary', () => {
    expect(() =>
      reserveCash(walletFixture(), 1 as unknown as string),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it.each(['NaN', 'Infinity', '-Infinity', '', 'not-a-decimal'])(
    'rejects non-finite or malformed cash release amount %s',
    (amount) => {
      expect(() =>
        releaseReservation(
          walletFixture({ reserved: '1', available: '999' }),
          amount,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it('rejects a release that exceeds the current cash reservation', () => {
    expect(() =>
      releaseReservation(
        walletFixture({ reserved: '1', available: '999' }),
        '2',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });
});

describe('position reservations', () => {
  it('moves shares from available to reserved without changing total', () => {
    const position = positionFixture();

    expect(reservePosition(position, '4')).toEqual({
      ...position,
      available: '6',
      reserved: '4',
      version: 7n,
    });
  });

  it('rejects a sell reservation that exceeds available shares', () => {
    expect(() => reservePosition(positionFixture(), '11')).toThrowError(
      expect.objectContaining({
        code: 'INSUFFICIENT_AVAILABLE_POSITION',
        retryable: false,
      }),
    );
  });

  it('releases shares for cancellation without changing another symbol', () => {
    const samsung = reservePosition(positionFixture(), '4');
    const skHynix = positionFixture({
      symbol: '000660',
      total: '8',
      available: '8',
    });

    expect(releaseReservation(samsung, '4')).toEqual({
      ...samsung,
      available: '10',
      reserved: '0',
      version: 8n,
    });
    expect(skHynix).toEqual(
      positionFixture({ symbol: '000660', total: '8', available: '8' }),
    );
  });

  it('moves a position reservation by only the partial-fill release delta', () => {
    const reserved = reservePosition(positionFixture(), '10');

    expect(releaseReservation(reserved, '4')).toMatchObject({
      available: '4',
      reserved: '6',
      version: 8n,
    });
  });

  it('rejects fractional shares and releases beyond the reserved quantity', () => {
    expect(() => reservePosition(positionFixture(), '0.5')).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
    expect(() =>
      releaseReservation(
        positionFixture({ reserved: '1', available: '9' }),
        '2',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });
});

describe('reservation planning', () => {
  it('reserves remaining limit-buy notional plus the estimated fee', () => {
    expect(
      planReservation({
        id: 'buy-limit',
        status: 'PARTIALLY_FILLED',
        side: 'BUY',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '10',
        filledQuantity: '3',
        limitPrice: '70000',
        estimatedFee: '140',
      }),
    ).toEqual({ cash: { currency: 'KRW', amount: '490140' } });
  });

  it('uses the five-percent protected reference price for a market buy', () => {
    expect(
      planReservation({
        id: 'buy-market',
        status: 'OPEN',
        side: 'BUY',
        type: 'MARKET',
        currency: 'USD',
        symbol: 'AAPL',
        quantity: '2',
        referencePrice: '193.20',
        estimatedFee: '1.50',
      }),
    ).toEqual({ cash: { currency: 'USD', amount: '407.22' } });
  });

  it('reserves only the remaining shares for a sell order', () => {
    expect(
      planReservation({
        id: 'sell',
        status: 'PARTIALLY_FILLED',
        side: 'SELL',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '10',
        filledQuantity: '3',
        limitPrice: '71000',
      }),
    ).toEqual({ position: { symbol: '005930', quantity: '7' } });
  });

  it('releases the full cash reservation after the final buy fill', () => {
    expect(
      planReservation({
        id: 'filled-buy',
        status: 'FILLED',
        side: 'BUY',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '10',
        filledQuantity: '10',
        limitPrice: '70000',
        estimatedFee: '140',
      }),
    ).toEqual({ cash: { currency: 'KRW', amount: '0' } });
  });

  it.each(['CANCELLED', 'EXPIRED', 'REJECTED'] as const)(
    'plans zero exposure for an unfilled %s order',
    (status) => {
      expect(
        planReservation({
          id: `terminal-${status}`,
          status,
          side: 'BUY',
          type: 'LIMIT',
          currency: 'KRW',
          symbol: '005930',
          quantity: '10',
          limitPrice: '70000',
          estimatedFee: '140',
        }),
      ).toEqual({ cash: { currency: 'KRW', amount: '0' } });
    },
  );

  it('plans zero exposure for a partially filled IOC cancellation', () => {
    expect(
      planReservation({
        id: 'ioc-remainder',
        status: 'CANCELLED',
        side: 'SELL',
        type: 'MARKET',
        currency: 'USD',
        symbol: 'AAPL',
        quantity: '10',
        filledQuantity: '4',
        referencePrice: '200',
      }),
    ).toEqual({ position: { symbol: 'AAPL', quantity: '0' } });
  });

  it.each([
    {
      status: 'CANCELLED',
      side: 'BUY',
      type: 'LIMIT',
      currency: 'KRW',
      symbol: '005930',
      limitPrice: '70000',
    },
    {
      status: 'EXPIRED',
      side: 'BUY',
      type: 'MARKET',
      currency: 'USD',
      symbol: 'AAPL',
      referencePrice: '200',
    },
    {
      status: 'CANCELLED',
      side: 'SELL',
      type: 'LIMIT',
      currency: 'KRW',
      symbol: '005930',
      limitPrice: '70000',
    },
    {
      status: 'EXPIRED',
      side: 'SELL',
      type: 'MARKET',
      currency: 'USD',
      symbol: 'AAPL',
      referencePrice: '200',
    },
  ] as const)(
    'rejects a fully filled $status $side order instead of treating it as terminal release',
    (order) => {
      expect(() =>
        planReservation({
          id: `${order.status}-${order.side}-complete`,
          ...order,
          quantity: '10',
          filledQuantity: '10',
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it('rejects a filled order whose fill quantity is absent or inconsistent', () => {
    const incompleteFilled: ReservationOrder = {
      id: 'incomplete',
      status: 'FILLED',
      side: 'BUY',
      type: 'LIMIT',
      currency: 'KRW',
      symbol: '005930',
      quantity: '10',
      limitPrice: '70000',
    };

    expect(() => planReservation(incompleteFilled)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
    expect(() =>
      planReservation({ ...incompleteFilled, filledQuantity: '9' }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it.each([
    { type: 'MARKET', limitPrice: '1' },
    { type: 'STOP', limitPrice: '1' },
    { type: 'TAKE_PROFIT', limitPrice: '1' },
  ] as const)(
    'rejects $type buy plans that try to bypass price protection with a limit price',
    ({ type, limitPrice }) => {
      expect(() =>
        planReservation({
          id: `${type}-bypass`,
          status: 'OPEN',
          side: 'BUY',
          type,
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          referencePrice: '100',
          limitPrice,
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it('rejects missing and forbidden price-field combinations', () => {
    expect(() =>
      planReservation({
        id: 'missing-limit',
        status: 'OPEN',
        side: 'BUY',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(() =>
      planReservation({
        id: 'missing-reference',
        status: 'OPEN',
        side: 'BUY',
        type: 'MARKET',
        currency: 'USD',
        symbol: 'AAPL',
        quantity: '1',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(() =>
      planReservation({
        id: 'limit-with-reference',
        status: 'OPEN',
        side: 'BUY',
        type: 'LIMIT',
        currency: 'KRW',
        symbol: '005930',
        quantity: '1',
        limitPrice: '70000',
        referencePrice: '69000',
      }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_ORDER' }));
  });

  it.each([
    ['status', 'UNKNOWN'],
    ['side', 'HOLD'],
    ['type', 'PEGGED'],
    ['currency', 'EUR'],
  ] as const)('rejects deserialized %s discriminant %s', (field, value) => {
    const order = {
      id: 'deserialized-invalid',
      status: 'OPEN',
      side: 'BUY',
      type: 'LIMIT',
      currency: 'KRW',
      symbol: '005930',
      quantity: '1',
      limitPrice: '70000',
      [field]: value,
    } as unknown as ReservationOrder;

    expect(() => planReservation(order)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it.each(['NaN', 'Infinity', '-Infinity', '', 'invalid'])(
    'rejects non-finite or malformed estimated fee %s',
    (estimatedFee) => {
      expect(() =>
        planReservation({
          id: 'bad-fee',
          status: 'OPEN',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'KRW',
          symbol: '005930',
          quantity: '1',
          limitPrice: '70000',
          estimatedFee,
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it.each(['NaN', 'Infinity', '-Infinity', '', 'invalid'])(
    'rejects non-finite or malformed order price %s',
    (price) => {
      expect(() =>
        planReservation({
          id: 'bad-price',
          status: 'OPEN',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'KRW',
          symbol: '005930',
          quantity: '1',
          limitPrice: price,
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it('uses one maximum cash exposure for two OCO buy legs', () => {
    expect(
      planOcoReservation([
        {
          id: 'oco-stop',
          status: 'PENDING_TRIGGER',
          side: 'BUY',
          type: 'STOP',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          referencePrice: '200',
          estimatedFee: '1',
        },
        {
          id: 'oco-limit',
          status: 'PENDING_TRIGGER',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          limitPrice: '190',
          estimatedFee: '2',
        },
      ]),
    ).toEqual({ cash: { currency: 'USD', amount: '421' } });
  });

  it('uses one shared quantity for two OCO sell legs', () => {
    expect(
      planOcoReservation([
        {
          id: 'oco-stop',
          status: 'PARTIALLY_FILLED',
          side: 'SELL',
          type: 'STOP',
          currency: 'KRW',
          symbol: '005930',
          quantity: '10',
          filledQuantity: '2',
          referencePrice: '70000',
        },
        {
          id: 'oco-limit',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'TAKE_PROFIT',
          currency: 'KRW',
          symbol: '005930',
          quantity: '10',
          referencePrice: '75000',
        },
      ]),
    ).toEqual({ position: { symbol: '005930', quantity: '10' } });
  });

  it('releases the group reservation after an OCO winner fills and sibling cancels', () => {
    expect(
      planOcoReservation([
        {
          id: 'winner',
          status: 'FILLED',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          filledQuantity: '2',
          limitPrice: '190',
        },
        {
          id: 'sibling',
          status: 'CANCELLED',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          limitPrice: '210',
        },
      ]),
    ).toEqual({ cash: { currency: 'USD', amount: '0' } });
  });

  it('rejects an OCO tuple with two progressed winners', () => {
    expect(() =>
      planOcoReservation([
        {
          id: 'first-winner',
          status: 'FILLED',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          filledQuantity: '2',
          limitPrice: '190',
        },
        {
          id: 'second-winner',
          status: 'OPEN',
          side: 'BUY',
          type: 'LIMIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '2',
          limitPrice: '210',
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it('rejects OCO plans with duplicate leg identities', () => {
    const leg: ReservationOrder = {
      id: 'same-leg',
      status: 'PENDING_TRIGGER',
      side: 'SELL',
      type: 'STOP',
      currency: 'KRW',
      symbol: '005930',
      quantity: '1',
      referencePrice: '70000',
    };

    expect(() => planOcoReservation([leg, leg])).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it('rejects an OCO plan that mixes currencies or symbols', () => {
    expect(() =>
      planOcoReservation([
        {
          id: 'first',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'STOP',
          currency: 'KRW',
          symbol: '005930',
          quantity: '1',
          referencePrice: '70000',
        },
        {
          id: 'second',
          status: 'PENDING_TRIGGER',
          side: 'SELL',
          type: 'TAKE_PROFIT',
          currency: 'USD',
          symbol: 'AAPL',
          quantity: '1',
          limitPrice: '190',
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });
});
