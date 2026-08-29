import { describe, expect, it } from 'vitest';

import type { PositionCost, PositionFill } from './portfolio-math.js';
import {
  applyFillToPosition,
  calculateAverageCost,
  calculateUnrealizedPnl,
} from './portfolio-math.js';

const emptyPosition = (symbol: string): PositionCost => ({
  symbol,
  quantity: '0',
  totalCost: '0',
  realizedPnl: '0',
});

describe('KRW weighted-average cost and realized PnL golden', () => {
  it('accounts for buy fees, proportional cost removal, and full liquidation', () => {
    const empty = emptyPosition('005930');
    const firstBuy = applyFillToPosition(empty, {
      symbol: '005930',
      side: 'BUY',
      price: '70000',
      quantity: '3',
      fee: '32',
    });

    // 3 × 70000 + 32 = 210032; average = 70010.6666666667.
    expect(firstBuy).toEqual({
      symbol: '005930',
      quantity: '3',
      totalCost: '210032',
      realizedPnl: '0',
    });
    expect(calculateAverageCost(firstBuy)).toBe('70010.6666666667');

    const secondBuy = applyFillToPosition(firstBuy, {
      symbol: '005930',
      side: 'BUY',
      price: '71000',
      quantity: '2',
      fee: '22',
    });
    // 210032 + 2 × 71000 + 22 = 352054; / 5 = 70410.8.
    expect(secondBuy).toMatchObject({ quantity: '5', totalCost: '352054' });
    expect(calculateAverageCost(secondBuy)).toBe('70410.8');

    const partialSell = applyFillToPosition(secondBuy, {
      symbol: '005930',
      side: 'SELL',
      price: '72000',
      quantity: '2',
      fee: '292',
    });
    // Cost removed 352054 × 2/5 = 140821.6.
    // Realized 144000 - 292 - 140821.6 = 2886.4.
    expect(partialSell).toEqual({
      symbol: '005930',
      quantity: '3',
      totalCost: '211232.4',
      realizedPnl: '2886.4',
    });
    // 3 × 73000 - 211232.4 = 7767.6.
    expect(calculateUnrealizedPnl(partialSell, '73000')).toBe('7767.6');

    const liquidated = applyFillToPosition(partialSell, {
      symbol: '005930',
      side: 'SELL',
      price: '73000',
      quantity: '3',
      fee: '445',
    });
    // Added realized: 219000 - 445 - 211232.4 = 7322.6.
    expect(liquidated).toEqual({
      symbol: '005930',
      quantity: '0',
      totalCost: '0',
      realizedPnl: '10209',
    });
    expect(calculateAverageCost(liquidated)).toBe('0');
    expect(calculateUnrealizedPnl(liquidated, '999999')).toBe('0');
    expect(empty).toEqual(emptyPosition('005930'));
  });
});

describe('USD weighted-average cost and PnL golden', () => {
  it('preserves exact fee significance on buys', () => {
    const bought = applyFillToPosition(emptyPosition('AAPL'), {
      symbol: 'AAPL',
      side: 'BUY',
      price: '100',
      quantity: '1',
      fee: '0.00000000001',
    });

    expect(bought.totalCost).toBe('100.00000000001');
  });

  it('applies exact whole-quantity arithmetic beyond 20 significant digits', () => {
    const bought = applyFillToPosition(emptyPosition('AAPL'), {
      symbol: 'AAPL',
      side: 'BUY',
      price: '1',
      quantity: '1000000000000000000000000000000',
      fee: '0',
    });

    expect(bought.quantity).toBe('1000000000000000000000000000000');
    expect(bought.totalCost).toBe('1000000000000000000000000000000');
  });

  it('preserves decimal precision without binary floating point', () => {
    const firstBuy = applyFillToPosition(emptyPosition('AAPL'), {
      symbol: 'AAPL',
      side: 'BUY',
      price: '189.37',
      quantity: '10',
      fee: '4.73',
    });
    const secondBuy = applyFillToPosition(firstBuy, {
      symbol: 'AAPL',
      side: 'BUY',
      price: '191.02',
      quantity: '5',
      fee: '2.39',
    });

    expect(secondBuy).toEqual({
      symbol: 'AAPL',
      quantity: '15',
      totalCost: '2855.92',
      realizedPnl: '0',
    });
    expect(calculateAverageCost(secondBuy)).toBe('190.3946666667');

    const partialSell = applyFillToPosition(secondBuy, {
      symbol: 'AAPL',
      side: 'SELL',
      price: '195.50',
      quantity: '6',
      fee: '2.93',
    });
    // Removed cost 2855.92 × 6/15 = 1142.368.
    // Realized 1173 - 2.93 - 1142.368 = 27.702.
    expect(partialSell).toEqual({
      symbol: 'AAPL',
      quantity: '9',
      totalCost: '1713.552',
      realizedPnl: '27.702',
    });
    // 196 × 9 - 1713.552 = 50.448.
    expect(calculateUnrealizedPnl(partialSell, '196')).toBe('50.448');
  });
});

describe('portfolio math validation', () => {
  it('accepts the 80-digit boundary and rejects 81-digit price input', () => {
    const boundaryPrice = '1'.repeat(80);
    const accepted = applyFillToPosition(emptyPosition('AAPL'), {
      symbol: 'AAPL',
      side: 'BUY',
      price: boundaryPrice,
      quantity: '1',
      fee: '0',
    });

    expect(accepted.totalCost).toBe(boundaryPrice);
    expect(() =>
      applyFillToPosition(emptyPosition('AAPL'), {
        symbol: 'AAPL',
        side: 'BUY',
        price: '1'.repeat(81),
        quantity: '1',
        fee: '0',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_PRICE', retryable: false }),
    );
  });

  it.each([
    { price: '9'.repeat(80), fee: '1', boundary: 'carry' },
    { price: '100', fee: `0.${'0'.repeat(79)}1`, boundary: 'scale' },
  ])(
    'rejects portfolio $boundary overflow before mutation',
    ({ price, fee }) => {
      const position = emptyPosition('AAPL');

      expect(() =>
        applyFillToPosition(position, {
          symbol: 'AAPL',
          side: 'BUY',
          price,
          quantity: '1',
          fee,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
      expect(position).toEqual(emptyPosition('AAPL'));
    },
  );

  it('rejects a sell beyond holdings without changing the position', () => {
    const position: PositionCost = {
      symbol: 'AAPL',
      quantity: '2',
      totalCost: '380',
      realizedPnl: '0',
    };

    expect(() =>
      applyFillToPosition(position, {
        symbol: 'AAPL',
        side: 'SELL',
        price: '200',
        quantity: '3',
        fee: '1',
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INSUFFICIENT_AVAILABLE_POSITION',
        retryable: false,
      }),
    );
    expect(position).toEqual({
      symbol: 'AAPL',
      quantity: '2',
      totalCost: '380',
      realizedPnl: '0',
    });
  });

  it('rejects symbol mismatches and malformed fill values with stable errors', () => {
    expect(() =>
      applyFillToPosition(emptyPosition('AAPL'), {
        symbol: 'MSFT',
        side: 'BUY',
        price: '100',
        quantity: '1',
        fee: '0',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
    expect(() =>
      applyFillToPosition(emptyPosition('AAPL'), {
        symbol: 'AAPL',
        side: 'BUY',
        price: 'NaN',
        quantity: '1',
        fee: '0',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_PRICE', retryable: false }),
    );
    expect(() =>
      applyFillToPosition(emptyPosition('AAPL'), {
        symbol: 'AAPL',
        side: 'BUY',
        price: '100',
        quantity: '0.5',
        fee: '0',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_QUANTITY', retryable: false }),
    );
    expect(() =>
      calculateUnrealizedPnl(emptyPosition('AAPL'), '-1'),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_PRICE', retryable: false }),
    );
  });
});

describe('portfolio root guards', () => {
  const position = emptyPosition('AAPL');
  const fill: PositionFill = {
    symbol: 'AAPL',
    side: 'BUY',
    price: '100',
    quantity: '1',
    fee: '0',
  };

  it.each([null, undefined, 'not-a-position'])(
    'rejects invalid apply-fill position root %#',
    (invalidPosition) => {
      expect(() =>
        applyFillToPosition(invalidPosition as unknown as PositionCost, fill),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it.each([null, undefined, 'not-a-fill'])(
    'rejects invalid fill root %#',
    (invalidFill) => {
      expect(() =>
        applyFillToPosition(position, invalidFill as unknown as PositionFill),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_ORDER',
          retryable: false,
        }),
      );
    },
  );

  it.each([null, undefined, 'not-a-position'])(
    'rejects invalid average-cost position root %#',
    (invalidPosition) => {
      expect(() =>
        calculateAverageCost(invalidPosition as unknown as PositionCost),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it.each([null, undefined, 'not-a-position'])(
    'rejects invalid unrealized-PnL position root %#',
    (invalidPosition) => {
      expect(() =>
        calculateUnrealizedPnl(
          invalidPosition as unknown as PositionCost,
          '100',
        ),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );
});

describe('deterministic portfolio input snapshots', () => {
  it('reads every position field exactly once and never spreads the source', () => {
    const reads = { symbol: 0, quantity: 0, totalCost: 0, realizedPnl: 0 };
    const position = {
      get symbol() {
        reads.symbol += 1;
        return 'AAPL';
      },
      get quantity() {
        reads.quantity += 1;
        return '1';
      },
      get totalCost() {
        reads.totalCost += 1;
        return '100';
      },
      get realizedPnl() {
        reads.realizedPnl += 1;
        return '5';
      },
    } as PositionCost;

    const result = applyFillToPosition(position, {
      symbol: 'AAPL',
      side: 'BUY',
      price: '20',
      quantity: '1',
      fee: '1',
    });

    expect(result).toEqual({
      symbol: 'AAPL',
      quantity: '2',
      totalCost: '121',
      realizedPnl: '5',
    });
    expect(reads).toEqual({
      symbol: 1,
      quantity: 1,
      totalCost: 1,
      realizedPnl: 1,
    });
  });

  it('reads every fill field exactly once and fixes the branch before math', () => {
    const reads = { symbol: 0, side: 0, price: 0, quantity: 0, fee: 0 };
    const fill = {
      get symbol() {
        reads.symbol += 1;
        return 'AAPL';
      },
      get side() {
        reads.side += 1;
        return reads.side === 1 ? 'BUY' : 'SELL';
      },
      get price() {
        reads.price += 1;
        return reads.price === 1 ? '20' : '999';
      },
      get quantity() {
        reads.quantity += 1;
        return reads.quantity === 1 ? '1' : '9';
      },
      get fee() {
        reads.fee += 1;
        return reads.fee === 1 ? '1' : '999';
      },
    } as PositionFill;

    const result = applyFillToPosition(
      {
        symbol: 'AAPL',
        quantity: '1',
        totalCost: '100',
        realizedPnl: '5',
      },
      fill,
    );

    expect(result).toEqual({
      symbol: 'AAPL',
      quantity: '2',
      totalCost: '121',
      realizedPnl: '5',
    });
    expect(reads).toEqual({
      symbol: 1,
      side: 1,
      price: 1,
      quantity: 1,
      fee: 1,
    });
  });

  it.each(['symbol', 'quantity', 'totalCost', 'realizedPnl'] as const)(
    'maps a throwing position %s getter to INVARIANT_VIOLATION',
    (field) => {
      const position = {
        symbol: 'AAPL',
        quantity: '1',
        totalCost: '100',
        realizedPnl: '0',
      };
      Object.defineProperty(position, field, {
        get() {
          throw new RangeError(`cannot read ${field}`);
        },
      });

      expect(() =>
        applyFillToPosition(position, {
          symbol: 'AAPL',
          side: 'BUY',
          price: '20',
          quantity: '1',
          fee: '0',
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    },
  );

  it.each(['symbol', 'side', 'price', 'quantity', 'fee'] as const)(
    'maps a throwing fill %s getter to INVALID_ORDER',
    (field) => {
      const fill = {
        symbol: 'AAPL',
        side: 'BUY',
        price: '20',
        quantity: '1',
        fee: '0',
      } as PositionFill;
      Object.defineProperty(fill, field, {
        get() {
          throw new RangeError(`cannot read ${field}`);
        },
      });

      expect(() =>
        applyFillToPosition(emptyPosition('AAPL'), fill),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
      );
    },
  );

  it.each([
    { name: 'average cost', run: calculateAverageCost },
    {
      name: 'unrealized PnL',
      run: (position: PositionCost) => calculateUnrealizedPnl(position, '120'),
    },
  ])('guards every position getter in $name', ({ run }) => {
    for (const field of [
      'symbol',
      'quantity',
      'totalCost',
      'realizedPnl',
    ] as const) {
      const position = {
        symbol: 'AAPL',
        quantity: '1',
        totalCost: '100',
        realizedPnl: '0',
      };
      Object.defineProperty(position, field, {
        get() {
          throw new RangeError(`cannot read ${field}`);
        },
      });

      expect(() => run(position)).toThrowError(
        expect.objectContaining({
          code: 'INVARIANT_VIOLATION',
          retryable: false,
        }),
      );
    }
  });

  it('does not modify successful caller-owned position or fill objects', () => {
    const position: PositionCost = {
      symbol: 'AAPL',
      quantity: '1',
      totalCost: '100',
      realizedPnl: '5',
    };
    const fill: PositionFill = {
      symbol: 'AAPL',
      side: 'BUY',
      price: '20',
      quantity: '1',
      fee: '1',
    };
    const before = JSON.stringify({ position, fill });

    expect(applyFillToPosition(position, fill)).toEqual({
      symbol: 'AAPL',
      quantity: '2',
      totalCost: '121',
      realizedPnl: '5',
    });
    expect(JSON.stringify({ position, fill })).toBe(before);
  });
});
