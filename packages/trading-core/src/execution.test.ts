import { describe, expect, it } from 'vitest';

import type {
  ExecutionOrder,
  OrderBookSnapshot,
  PriceProtection,
} from './execution.js';
import { calculateExecution, withinProtection } from './execution.js';
import type { FeeModel } from './fee-model.js';
import { createFeeModel } from './fee-model.js';

const zeroFeeModel: FeeModel = {
  version: 'test-zero-kr',
  market: 'KR',
  currency: 'KRW',
  calculate: () => '0',
};

const bookFixture = (
  overrides: Partial<OrderBookSnapshot> = {},
): OrderBookSnapshot => ({
  symbol: '005930',
  market: 'KR',
  currency: 'KRW',
  bids: [{ price: '99', volume: '10' }],
  asks: [{ price: '100', volume: '10' }],
  ...overrides,
});

const orderFixture = (
  overrides: Partial<ExecutionOrder> = {},
): ExecutionOrder => ({
  id: 'order-1',
  side: 'BUY',
  type: 'MARKET',
  market: 'KR',
  currency: 'KRW',
  symbol: '005930',
  quantity: '1',
  ...overrides,
});

const protection = (
  overrides: Partial<PriceProtection> = {},
): PriceProtection => ({
  referenceMid: '100',
  maxDeviationBps: 500,
  ...overrides,
});

describe('price protection', () => {
  it.each([
    { price: '105', expected: true },
    { price: '95', expected: true },
    { price: '105.01', expected: false },
    { price: '94.99', expected: false },
  ])(
    'classifies $price at an inclusive 500 bps boundary',
    ({ price, expected }) => {
      expect(withinProtection(price, '100', 500)).toBe(expected);
    },
  );

  it('rejects malformed price-band inputs with stable domain errors', () => {
    expect(() => withinProtection('100', '0', 500)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PRICE', retryable: false }),
    );
    expect(() => withinProtection('100', '100', -1)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
    expect(() => withinProtection('100', '100', 1.5)).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });
});

describe('deterministic order-book walking', () => {
  it('conserves fills for quantities beyond 20 significant digits', () => {
    const result = calculateExecution(
      orderFixture({ quantity: '1000000000000000000000000000000' }),
      bookFixture({ asks: [{ price: '100', volume: '1' }] }),
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([{ price: '100', quantity: '1', fee: '0' }]);
    expect(result.filledQuantity).toBe('1');
    expect(result.unfilledQuantity).toBe('999999999999999999999999999999');
    expect(result.terminalReason).toBe('IOC_REMAINDER');
  });

  it('walks asks low-to-high and cancels a market IOC remainder', () => {
    const result = calculateExecution(
      orderFixture({ quantity: '5' }),
      bookFixture({
        asks: [
          { price: '100', volume: '2' },
          { price: '101', volume: '2' },
        ],
      }),
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([
      { price: '100', quantity: '2', fee: '0' },
      { price: '101', quantity: '2', fee: '0' },
    ]);
    expect(result.consumedLevels).toEqual([
      {
        side: 'ASK',
        index: 0,
        price: '100',
        availableVolume: '2',
        consumedQuantity: '2',
      },
      {
        side: 'ASK',
        index: 1,
        price: '101',
        availableVolume: '2',
        consumedQuantity: '2',
      },
    ]);
    expect(result).toMatchObject({
      filledQuantity: '4',
      unfilledQuantity: '1',
      grossAmount: '402',
      feeTotal: '0',
      netAmount: '402',
      slippageAmount: '2',
      feeModelVersion: 'test-zero-kr',
      terminalReason: 'IOC_REMAINDER',
    });
  });

  it('walks bids high-to-low and only consumes the final level partially', () => {
    const result = calculateExecution(
      orderFixture({ side: 'SELL', quantity: '4' }),
      bookFixture({
        bids: [
          { price: '99', volume: '1' },
          { price: '98', volume: '1' },
          { price: '97', volume: '5' },
        ],
      }),
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([
      { price: '99', quantity: '1', fee: '0' },
      { price: '98', quantity: '1', fee: '0' },
      { price: '97', quantity: '2', fee: '0' },
    ]);
    expect(result.consumedLevels.map(({ side }) => side)).toEqual([
      'BID',
      'BID',
      'BID',
    ]);
    expect(result).toMatchObject({
      filledQuantity: '4',
      unfilledQuantity: '0',
      grossAmount: '391',
      slippageAmount: '9',
    });
  });

  it('never exceeds the quantity remaining from earlier fills', () => {
    const result = calculateExecution(
      orderFixture({ quantity: '5', filledQuantity: '3' }),
      bookFixture({ asks: [{ price: '100', volume: '100' }] }),
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([{ price: '100', quantity: '2', fee: '0' }]);
    expect(result.filledQuantity).toBe('2');
    expect(result.unfilledQuantity).toBe('0');
    expect(result.terminalReason).toBeUndefined();
  });

  it('does not mutate the supplied order or book', () => {
    const order = orderFixture({ quantity: '3' });
    const book = bookFixture({
      asks: [
        { price: '100', volume: '1' },
        { price: '101', volume: '3' },
      ],
    });
    const before = JSON.stringify({ order, book });

    calculateExecution(order, book, zeroFeeModel, protection());

    expect(JSON.stringify({ order, book })).toBe(before);
  });
});

describe('limit and protection checks before level consumption', () => {
  it.each([
    {
      side: 'BUY',
      limitPrice: '100',
      bids: [{ price: '99', volume: '5' }],
      asks: [
        { price: '100', volume: '2' },
        { price: '101', volume: '5' },
      ],
      expectedPrice: '100',
    },
    {
      side: 'SELL',
      limitPrice: '99',
      bids: [
        { price: '99', volume: '2' },
        { price: '98', volume: '5' },
      ],
      asks: [{ price: '100', volume: '5' }],
      expectedPrice: '99',
    },
  ] as const)(
    'stops a $side limit before the first worse level',
    ({ side, limitPrice, bids, asks, expectedPrice }) => {
      const result = calculateExecution(
        orderFixture({ side, type: 'LIMIT', quantity: '5', limitPrice }),
        bookFixture({ bids, asks }),
        zeroFeeModel,
        protection(),
      );

      expect(result.fills).toEqual([
        { price: expectedPrice, quantity: '2', fee: '0' },
      ]);
      expect(result.unfilledQuantity).toBe('3');
      expect(result.terminalReason).toBeUndefined();
    },
  );

  it('does not apply the market protection band to a limit-capped fill', () => {
    const result = calculateExecution(
      orderFixture({ type: 'LIMIT', quantity: '2', limitPrice: '110' }),
      bookFixture({ asks: [{ price: '110', volume: '5' }] }),
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([{ price: '110', quantity: '2', fee: '0' }]);
    expect(result.terminalReason).toBeUndefined();
  });

  it.each([
    { type: 'STOP', limitPrice: undefined, reason: 'IOC_REMAINDER' },
    { type: 'TAKE_PROFIT', limitPrice: '99', reason: undefined },
  ] as const)(
    'uses the stored execution style for a triggered $type order',
    ({ type, limitPrice, reason }) => {
      const result = calculateExecution(
        orderFixture({
          side: 'SELL',
          type,
          quantity: '3',
          ...(limitPrice === undefined ? {} : { limitPrice }),
        }),
        bookFixture({ bids: [{ price: '99', volume: '1' }] }),
        zeroFeeModel,
        protection(),
      );

      expect(result.fills).toEqual([{ price: '99', quantity: '1', fee: '0' }]);
      expect(result.unfilledQuantity).toBe('2');
      expect(result.terminalReason).toBe(reason);
    },
  );

  it('stops a market walk before an out-of-band level is consumed', () => {
    const result = calculateExecution(
      orderFixture({ quantity: '3' }),
      bookFixture({
        asks: [
          { price: '100', volume: '1' },
          { price: '110', volume: '5' },
        ],
      }),
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([{ price: '100', quantity: '1', fee: '0' }]);
    expect(result.unfilledQuantity).toBe('2');
    expect(result.terminalReason).toBe('PRICE_PROTECTION');
  });
});

describe('hand-calculated KRW and USD execution goldens', () => {
  it('records each KRW sell fill with configured fees and signed slippage', () => {
    const feeModel = createFeeModel({
      version: 'kr-2026-08-01',
      market: 'KR',
      currency: 'KRW',
      commissionRate: '0.00015',
      sellTaxRate: '0.0018',
      roundingDecimals: 0,
      roundingMode: 'HALF_UP',
    });
    const result = calculateExecution(
      orderFixture({ side: 'SELL', quantity: '5' }),
      bookFixture({
        bids: [
          { price: '70000', volume: '3' },
          { price: '69900', volume: '4' },
        ],
        asks: [{ price: '70100', volume: '5' }],
      }),
      feeModel,
      protection({ referenceMid: '69950' }),
    );

    expect(result.fills).toEqual([
      { price: '70000', quantity: '3', fee: '410' },
      { price: '69900', quantity: '2', fee: '273' },
    ]);
    expect(result).toMatchObject({
      grossAmount: '349800',
      feeTotal: '683',
      netAmount: '349117',
      slippageAmount: '-50',
      feeModelVersion: 'kr-2026-08-01',
    });
  });

  it('records each USD buy fill with cent-rounded fees', () => {
    const feeModel = createFeeModel({
      version: 'us-2026-08-01',
      market: 'US',
      currency: 'USD',
      commissionRate: '0.0025',
      sellTaxRate: '0',
      roundingDecimals: 2,
      roundingMode: 'HALF_UP',
    });
    const result = calculateExecution(
      {
        id: 'usd-order',
        side: 'BUY',
        type: 'MARKET',
        market: 'US',
        currency: 'USD',
        symbol: 'AAPL',
        quantity: '4',
      },
      {
        symbol: 'AAPL',
        market: 'US',
        currency: 'USD',
        bids: [{ price: '189.30', volume: '5' }],
        asks: [
          { price: '189.37', volume: '3' },
          { price: '189.50', volume: '5' },
        ],
      },
      feeModel,
      { referenceMid: '189.40', maxDeviationBps: 500 },
    );

    expect(result.fills).toEqual([
      { price: '189.37', quantity: '3', fee: '1.42' },
      { price: '189.50', quantity: '1', fee: '0.47' },
    ]);
    expect(result).toMatchObject({
      grossAmount: '757.61',
      feeTotal: '1.89',
      netAmount: '759.5',
      slippageAmount: '0.01',
      feeModelVersion: 'us-2026-08-01',
    });
  });
});

describe('book and order validation', () => {
  it.each(['NaN', '-5', 'abc', 'Infinity', 12 as unknown as string])(
    'rejects fee model output %s with a stable domain error',
    (fee) => {
      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture(),
          { ...zeroFeeModel, calculate: () => fee },
          protection(),
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it.each([
    { bids: [], asks: [{ price: '100', volume: '1' }] },
    { bids: [{ price: '99', volume: '1' }], asks: [] },
    {
      bids: [{ price: '100', volume: '1' }],
      asks: [{ price: '100', volume: '1' }],
    },
    {
      bids: [{ price: '101', volume: '1' }],
      asks: [{ price: '100', volume: '1' }],
    },
  ])(
    'fails closed for a one-sided, locked, or crossed book',
    ({ bids, asks }) => {
      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture({ bids, asks }),
          zeroFeeModel,
          protection(),
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'CANCEL_ONLY', retryable: false }),
      );
    },
  );

  it('rejects unsorted or duplicate normalized levels', () => {
    for (const asks of [
      [
        { price: '101', volume: '1' },
        { price: '100', volume: '1' },
      ],
      [
        { price: '100', volume: '1' },
        { price: '100', volume: '2' },
      ],
    ]) {
      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture({ asks }),
          zeroFeeModel,
          protection(),
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    }
  });

  it('rejects malformed level values and non-array book sides', () => {
    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture({ asks: [{ price: 'NaN', volume: '1' }] }),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_PRICE', retryable: false }),
    );
    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture({ asks: [{ price: '100', volume: '1.5' }] }),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_QUANTITY', retryable: false }),
    );
    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture({ asks: undefined as unknown as [] }),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it('rejects identity mismatches and a fee model for another market', () => {
    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture({ symbol: '000660' }),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture(),
        { ...zeroFeeModel, market: 'US', currency: 'USD' },
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it('rejects malformed quantities and incompatible execution price shapes', () => {
    expect(() =>
      calculateExecution(
        orderFixture({ quantity: '1.5' }),
        bookFixture(),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_QUANTITY', retryable: false }),
    );
    expect(() =>
      calculateExecution(
        orderFixture({ quantity: '5', filledQuantity: '5' }),
        bookFixture(),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(expect.objectContaining({ retryable: false }));
    expect(() =>
      calculateExecution(
        orderFixture({ type: 'MARKET', limitPrice: '100' }),
        bookFixture(),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
    expect(() =>
      calculateExecution(
        orderFixture({ type: 'LIMIT' }),
        bookFixture(),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });
});
