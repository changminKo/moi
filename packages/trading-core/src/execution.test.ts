import { describe, expect, it } from 'vitest';

import { DomainError } from './domain-errors.js';
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

describe('fee model boundary snapshot', () => {
  it('maps a class-constructor callback failure to INVARIANT_VIOLATION', () => {
    class FeeConstructor {}
    const feeModel = {
      ...zeroFeeModel,
      calculate: FeeConstructor,
    } as unknown as FeeModel;

    expect(() =>
      calculateExecution(orderFixture(), bookFixture(), feeModel, protection()),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it('reads a changing calculate accessor exactly once', () => {
    let reads = 0;
    const calculate = () => '0';
    const feeModel = {
      version: 'accessor-1',
      market: 'KR',
      currency: 'KRW',
      get calculate() {
        reads += 1;
        return reads === 1 ? calculate : null;
      },
    } as unknown as FeeModel;

    const result = calculateExecution(
      orderFixture(),
      bookFixture(),
      feeModel,
      protection(),
    );

    expect(result.fills[0]?.fee).toBe('0');
    expect(reads).toBe(1);
  });

  it('snapshots every fee model property exactly once', () => {
    const reads = { version: 0, market: 0, currency: 0, calculate: 0 };
    const feeModel = {
      get version() {
        reads.version += 1;
        return 'snapshot-1';
      },
      get market() {
        reads.market += 1;
        return 'KR';
      },
      get currency() {
        reads.currency += 1;
        return 'KRW';
      },
      get calculate() {
        reads.calculate += 1;
        return () => '0';
      },
    } as FeeModel;

    const result = calculateExecution(
      orderFixture(),
      bookFixture(),
      feeModel,
      protection(),
    );

    expect(result.feeModelVersion).toBe('snapshot-1');
    expect(reads).toEqual({
      version: 1,
      market: 1,
      currency: 1,
      calculate: 1,
    });
  });

  it('returns the snapshotted version after callback identity mutation', () => {
    const feeModel: {
      version: string;
      market: FeeModel['market'];
      currency: FeeModel['currency'];
      calculate(): string;
    } = {
      version: 'audit-1',
      market: 'KR',
      currency: 'KRW',
      calculate() {
        this.version = '';
        this.market = 'US';
        this.currency = 'USD';
        return '0';
      },
    };

    const result = calculateExecution(
      orderFixture(),
      bookFixture(),
      feeModel,
      protection(),
    );

    expect(result.feeModelVersion).toBe('audit-1');
  });

  it('invokes the snapshotted callback with its original receiver', () => {
    const feeModel = {
      version: 'receiver-1',
      market: 'KR',
      currency: 'KRW',
      flatFee: '0',
      calculate() {
        return this.flatFee;
      },
    } as FeeModel & { flatFee: string };

    const result = calculateExecution(
      orderFixture(),
      bookFixture(),
      feeModel,
      protection(),
    );

    expect(result.fills).toEqual([{ price: '100', quantity: '1', fee: '0' }]);
  });

  it('maps a raw callback exception to INVARIANT_VIOLATION', () => {
    const feeModel: FeeModel = {
      ...zeroFeeModel,
      calculate() {
        throw new RangeError('boom');
      },
    };

    expect(() =>
      calculateExecution(orderFixture(), bookFixture(), feeModel, protection()),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it('preserves an intentional DomainError thrown by the callback', () => {
    const veto = new DomainError('INVALID_ORDER', 'custom veto');
    const feeModel: FeeModel = {
      ...zeroFeeModel,
      calculate() {
        throw veto;
      },
    };
    let caught: unknown;

    try {
      calculateExecution(orderFixture(), bookFixture(), feeModel, protection());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(veto);
    expect(caught).toMatchObject({
      code: 'INVALID_ORDER',
      retryable: false,
      message: 'custom veto',
    });
  });

  it.each(['version', 'market', 'currency', 'calculate'] as const)(
    'maps a throwing %s getter to INVARIANT_VIOLATION',
    (field) => {
      const feeModel = { ...zeroFeeModel };
      Object.defineProperty(feeModel, field, {
        get() {
          throw new Error(`cannot read ${field}`);
        },
      });

      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture(),
          feeModel,
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

  it.each([null, undefined, 'not-protection'])(
    'rejects invalid protection root %# with INVALID_ORDER',
    (invalidProtection) => {
      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture(),
          zeroFeeModel,
          invalidProtection as unknown as PriceProtection,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_ORDER',
          retryable: false,
        }),
      );
    },
  );
});

describe('book and order validation', () => {
  it.each(['0x10', '0b10', '+1', '.5', '1.', '1e1', ' 1', '1 ', '-0', '-0.0'])(
    'rejects non-plain custom fee output %s',
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

  it('normalizes accepted redundant fee zeros before recording the fill', () => {
    const result = calculateExecution(
      orderFixture(),
      bookFixture(),
      { ...zeroFeeModel, calculate: () => '0001.2300' },
      protection(),
    );

    expect(result.fills).toEqual([
      { price: '100', quantity: '1', fee: '1.23' },
    ]);
    expect(result.feeTotal).toBe('1.23');
    expect(result.netAmount).toBe('101.23');
  });

  it('accepts an exact 80-digit fee and rejects an 81-digit fee', () => {
    const boundaryFee = '1'.repeat(80);
    const accepted = calculateExecution(
      orderFixture(),
      bookFixture(),
      { ...zeroFeeModel, calculate: () => boundaryFee },
      protection(),
    );

    expect(accepted.fills[0]?.fee).toBe(boundaryFee);
    expect(accepted.feeTotal).toBe(boundaryFee);
    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture(),
        { ...zeroFeeModel, calculate: () => '1'.repeat(81) },
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it.each([
    { fee: '9'.repeat(80), boundary: 'carry' },
    { fee: `0.${'0'.repeat(79)}1`, boundary: 'scale' },
  ])('rejects execution $boundary overflow before returning', ({ fee }) => {
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
  });

  it.each([
    null,
    {
      version: 'invalid-shape',
      market: 'KR',
      currency: 'KRW',
      calculate: 'not-callable',
    },
  ])(
    'rejects invalid fee model shape %# with a stable domain error',
    (model) => {
      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture(),
          model as unknown as FeeModel,
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

describe('deterministic execution input snapshots', () => {
  it('reads every order field exactly once and uses only the snapshot', () => {
    const reads = {
      id: 0,
      side: 0,
      type: 0,
      market: 0,
      currency: 0,
      symbol: 0,
      quantity: 0,
      filledQuantity: 0,
      limitPrice: 0,
    };
    const order = {
      get id() {
        reads.id += 1;
        return 'snapshot-order';
      },
      get side() {
        reads.side += 1;
        return 'BUY';
      },
      get type() {
        reads.type += 1;
        return 'LIMIT';
      },
      get market() {
        reads.market += 1;
        return 'KR';
      },
      get currency() {
        reads.currency += 1;
        return 'KRW';
      },
      get symbol() {
        reads.symbol += 1;
        return '005930';
      },
      get quantity() {
        reads.quantity += 1;
        return '2';
      },
      get filledQuantity() {
        reads.filledQuantity += 1;
        return '0';
      },
      get limitPrice() {
        reads.limitPrice += 1;
        return '100';
      },
    } as ExecutionOrder;

    const result = calculateExecution(
      order,
      bookFixture({ asks: [{ price: '100', volume: '2' }] }),
      zeroFeeModel,
      protection(),
    );

    expect(result).toMatchObject({
      fills: [{ price: '100', quantity: '2', fee: '0' }],
      grossAmount: '200',
      netAmount: '200',
      slippageAmount: '0',
    });
    expect(reads).toEqual({
      id: 1,
      side: 1,
      type: 1,
      market: 1,
      currency: 1,
      symbol: 1,
      quantity: 1,
      filledQuantity: 1,
      limitPrice: 1,
    });
  });

  it.each([
    'id',
    'side',
    'type',
    'market',
    'currency',
    'symbol',
    'quantity',
    'filledQuantity',
    'limitPrice',
  ] as const)('maps a throwing order %s getter to INVALID_ORDER', (field) => {
    const order = orderFixture({
      type: 'LIMIT',
      quantity: '2',
      filledQuantity: '0',
      limitPrice: '100',
    });
    Object.defineProperty(order, field, {
      get() {
        throw new RangeError(`cannot read ${field}`);
      },
    });

    expect(() =>
      calculateExecution(order, bookFixture(), zeroFeeModel, protection()),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it('reads both protection fields exactly once and cannot widen the band', () => {
    const reads = { referenceMid: 0, maxDeviationBps: 0 };
    const guardedProtection = {
      get referenceMid() {
        reads.referenceMid += 1;
        return '100';
      },
      get maxDeviationBps() {
        reads.maxDeviationBps += 1;
        return reads.maxDeviationBps === 1 ? 0 : 10_000;
      },
    } as PriceProtection;

    const result = calculateExecution(
      orderFixture(),
      bookFixture({ asks: [{ price: '110', volume: '1' }] }),
      zeroFeeModel,
      guardedProtection,
    );

    expect(result).toMatchObject({
      fills: [],
      filledQuantity: '0',
      unfilledQuantity: '1',
      terminalReason: 'PRICE_PROTECTION',
    });
    expect(reads).toEqual({ referenceMid: 1, maxDeviationBps: 1 });
  });

  it.each(['referenceMid', 'maxDeviationBps'] as const)(
    'maps a throwing protection %s getter to INVALID_ORDER',
    (field) => {
      const guardedProtection = protection();
      Object.defineProperty(guardedProtection, field, {
        get() {
          throw new RangeError(`cannot read ${field}`);
        },
      });

      expect(() =>
        calculateExecution(
          orderFixture(),
          bookFixture(),
          zeroFeeModel,
          guardedProtection,
        ),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it('deep-snapshots book identity, arrays, and every level field once', () => {
    const reads = {
      symbol: 0,
      market: 0,
      currency: 0,
      bids: 0,
      asks: 0,
      bidPrice: 0,
      bidVolume: 0,
      askPrice: 0,
      askVolume: 0,
    };
    const bid = {
      get price() {
        reads.bidPrice += 1;
        return '99';
      },
      get volume() {
        reads.bidVolume += 1;
        return '5';
      },
    };
    const ask = {
      get price() {
        reads.askPrice += 1;
        return '100';
      },
      get volume() {
        reads.askVolume += 1;
        return '2';
      },
    };
    const bids = [bid];
    const asks = [ask];
    const book = {
      get symbol() {
        reads.symbol += 1;
        return '005930';
      },
      get market() {
        reads.market += 1;
        return 'KR';
      },
      get currency() {
        reads.currency += 1;
        return 'KRW';
      },
      get bids() {
        reads.bids += 1;
        return bids;
      },
      get asks() {
        reads.asks += 1;
        return asks;
      },
    } as OrderBookSnapshot;

    const result = calculateExecution(
      orderFixture({ quantity: '2' }),
      book,
      zeroFeeModel,
      protection(),
    );

    expect(result.fills).toEqual([{ price: '100', quantity: '2', fee: '0' }]);
    expect(reads).toEqual({
      symbol: 1,
      market: 1,
      currency: 1,
      bids: 1,
      asks: 1,
      bidPrice: 1,
      bidVolume: 1,
      askPrice: 1,
      askVolume: 1,
    });
  });

  it.each(['symbol', 'market', 'currency', 'bids', 'asks'] as const)(
    'maps a throwing book %s getter to INVALID_ORDER',
    (field) => {
      const book = bookFixture();
      Object.defineProperty(book, field, {
        get() {
          throw new RangeError(`cannot read ${field}`);
        },
      });

      expect(() =>
        calculateExecution(orderFixture(), book, zeroFeeModel, protection()),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it.each([
    { side: 'bids', field: 'price' },
    { side: 'bids', field: 'volume' },
    { side: 'asks', field: 'price' },
    { side: 'asks', field: 'volume' },
  ] as const)(
    'maps a throwing $side level $field getter to INVALID_ORDER',
    ({ side, field }) => {
      const book = bookFixture();
      const level = book[side][0];
      if (level === undefined) {
        throw new Error('fixture must contain a level');
      }
      Object.defineProperty(level, field, {
        get() {
          throw new RangeError(`cannot read ${side}.${field}`);
        },
      });

      expect(() =>
        calculateExecution(orderFixture(), book, zeroFeeModel, protection()),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it('maps a proxied book-array read failure to INVALID_ORDER', () => {
    const brokenBids = new Proxy([{ price: '99', volume: '1' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          throw new RangeError('cannot inspect bids');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture({ bids: brokenBids }),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it('maps a throwing book-array iterator to INVALID_ORDER', () => {
    const brokenAsks = [{ price: '100', volume: '1' }];
    Object.defineProperty(brokenAsks, Symbol.iterator, {
      get() {
        throw new RangeError('cannot iterate asks');
      },
    });

    expect(() =>
      calculateExecution(
        orderFixture(),
        bookFixture({ asks: brokenAsks }),
        zeroFeeModel,
        protection(),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it('isolates execution from fee-callback mutation of every original input', () => {
    const order: {
      id: string;
      side: ExecutionOrder['side'];
      type: ExecutionOrder['type'];
      market: ExecutionOrder['market'];
      currency: ExecutionOrder['currency'];
      symbol: string;
      quantity: string;
    } = {
      id: 'mutable-order',
      side: 'BUY',
      type: 'MARKET',
      market: 'KR',
      currency: 'KRW',
      symbol: '005930',
      quantity: '2',
    };
    const firstAsk = { price: '100', volume: '1' };
    const secondAsk = { price: '101', volume: '1' };
    const book: {
      symbol: string;
      market: OrderBookSnapshot['market'];
      currency: OrderBookSnapshot['currency'];
      bids: { price: string; volume: string }[];
      asks: { price: string; volume: string }[];
    } = {
      symbol: '005930',
      market: 'KR',
      currency: 'KRW',
      bids: [{ price: '99', volume: '2' }],
      asks: [firstAsk, secondAsk],
    };
    const guardedProtection = { referenceMid: '100', maxDeviationBps: 500 };
    const seenInputs: unknown[] = [];
    const feeModel: FeeModel = {
      ...zeroFeeModel,
      calculate(input) {
        seenInputs.push({ ...input });
        if (seenInputs.length === 1) {
          order.side = 'SELL';
          order.type = 'LIMIT';
          order.market = 'US';
          order.currency = 'USD';
          order.symbol = 'MUTATED';
          order.quantity = '999';
          guardedProtection.referenceMid = '1000';
          guardedProtection.maxDeviationBps = 10_000;
          firstAsk.price = '1';
          firstAsk.volume = '999';
          book.asks.splice(1);
          book.bids.splice(0);
        }
        return input.side === 'BUY' ? '1' : '9';
      },
    };

    const result = calculateExecution(order, book, feeModel, guardedProtection);

    expect(seenInputs).toEqual([
      { market: 'KR', side: 'BUY', price: '100', quantity: '1' },
      { market: 'KR', side: 'BUY', price: '101', quantity: '1' },
    ]);
    expect(result).toEqual({
      fills: [
        { price: '100', quantity: '1', fee: '1' },
        { price: '101', quantity: '1', fee: '1' },
      ],
      consumedLevels: [
        {
          side: 'ASK',
          index: 0,
          price: '100',
          availableVolume: '1',
          consumedQuantity: '1',
        },
        {
          side: 'ASK',
          index: 1,
          price: '101',
          availableVolume: '1',
          consumedQuantity: '1',
        },
      ],
      filledQuantity: '2',
      unfilledQuantity: '0',
      grossAmount: '201',
      feeTotal: '2',
      netAmount: '203',
      slippageAmount: '1',
      feeModelVersion: 'test-zero-kr',
    });
  });
});
