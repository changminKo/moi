import { describe, expect, it } from 'vitest';

import type { FeeScheduleConfig } from './fee-model.js';
import { createFeeModel } from './fee-model.js';

const krConfig: FeeScheduleConfig = {
  version: 'kr-2026-08-01',
  market: 'KR',
  currency: 'KRW',
  commissionRate: '0.00015',
  sellTaxRate: '0.0018',
  roundingDecimals: 0,
  roundingMode: 'HALF_UP',
};

const usConfig: FeeScheduleConfig = {
  version: 'us-2026-08-01',
  market: 'US',
  currency: 'USD',
  commissionRate: '0.0025',
  sellTaxRate: '0',
  roundingDecimals: 2,
  roundingMode: 'HALF_UP',
};

describe('versioned fee schedules', () => {
  it('is immune to caller mutation of the configuration object', () => {
    const config = { ...usConfig, version: 'v1' };
    const model = createFeeModel(config);
    const input = {
      market: 'US',
      side: 'BUY',
      price: '2',
      quantity: '1',
    } as const;

    expect(model.calculate(input)).toBe('0.01');
    config.roundingDecimals = 0;
    config.market = 'KR';
    expect(model.calculate(input)).toBe('0.01');
  });

  it('rejects inherited rounding-mode keys with INVARIANT_VIOLATION', () => {
    expect(() =>
      createFeeModel({
        ...usConfig,
        roundingMode:
          '__proto__' as unknown as FeeScheduleConfig['roundingMode'],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });

  it('keeps two explicit schedule versions independent', () => {
    const original = createFeeModel(krConfig);
    const raised = createFeeModel({
      ...krConfig,
      version: 'kr-2026-09-01',
      commissionRate: '0.0003',
    });
    const input = {
      market: 'KR',
      side: 'BUY',
      price: '70000',
      quantity: '3',
    } as const;

    // 210000 × 0.00015 = 31.5 -> 32; doubled rate -> 63.
    expect(original).toMatchObject({
      version: 'kr-2026-08-01',
      market: 'KR',
      currency: 'KRW',
    });
    expect(original.calculate(input)).toBe('32');
    expect(raised.calculate(input)).toBe('63');
  });

  it.each([
    { field: 'version', value: '' },
    { field: 'market', value: 'JP' },
    { field: 'currency', value: 'JPY' },
    { field: 'commissionRate', value: '-0.001' },
    { field: 'commissionRate', value: 'Infinity' },
    { field: 'sellTaxRate', value: 'NaN' },
    { field: 'roundingDecimals', value: -1 },
    { field: 'roundingDecimals', value: 1.5 },
    { field: 'roundingMode', value: 'CEILING' },
  ])('rejects malformed configuration $field=$value', ({ field, value }) => {
    expect(() =>
      createFeeModel({
        ...krConfig,
        [field]: value,
      } as unknown as FeeScheduleConfig),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVARIANT_VIOLATION',
        retryable: false,
      }),
    );
  });
});

describe('hand-calculated market fee goldens', () => {
  it('rounds KRW commission and sell tax after summing both charges', () => {
    const model = createFeeModel(krConfig);

    // BUY: 210000 × 0.00015 = 31.5 -> 32 KRW.
    expect(
      model.calculate({
        market: 'KR',
        side: 'BUY',
        price: '70000',
        quantity: '3',
      }),
    ).toBe('32');
    // SELL: 31.5 commission + 378 tax = 409.5 -> 410 KRW.
    expect(
      model.calculate({
        market: 'KR',
        side: 'SELL',
        price: '70000',
        quantity: '3',
      }),
    ).toBe('410');
    // 139800 × (0.00015 + 0.0018) = 272.61 -> 273 KRW.
    expect(
      model.calculate({
        market: 'KR',
        side: 'SELL',
        price: '69900',
        quantity: '2',
      }),
    ).toBe('273');
  });

  it('rounds USD commission to two decimal places', () => {
    const model = createFeeModel(usConfig);

    // 189.37 × 7 × 0.0025 = 3.313975 -> 3.31 USD.
    expect(
      model.calculate({
        market: 'US',
        side: 'BUY',
        price: '189.37',
        quantity: '7',
      }),
    ).toBe('3.31');
    // 189.50 × 1 × 0.0025 = 0.47375 -> 0.47 USD.
    expect(
      model.calculate({
        market: 'US',
        side: 'SELL',
        price: '189.50',
        quantity: '1',
      }),
    ).toBe('0.47');
  });

  it.each([
    { roundingMode: 'HALF_UP', expected: '0.01' },
    { roundingMode: 'HALF_EVEN', expected: '0' },
    { roundingMode: 'UP', expected: '0.01' },
    { roundingMode: 'DOWN', expected: '0' },
  ] as const)(
    'resolves an exact 0.005 tie as $expected with $roundingMode',
    ({ roundingMode, expected }) => {
      const model = createFeeModel({
        ...usConfig,
        version: `us-${roundingMode}`,
        roundingMode,
      });

      expect(
        model.calculate({
          market: 'US',
          side: 'BUY',
          price: '2',
          quantity: '1',
        }),
      ).toBe(expected);
    },
  );
});

describe('fee calculation validation', () => {
  const model = createFeeModel(krConfig);

  it('rejects a market or side outside the schedule contract', () => {
    expect(() =>
      model.calculate({
        market: 'US',
        side: 'BUY',
        price: '70000',
        quantity: '3',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
    expect(() =>
      model.calculate({
        market: 'KR',
        side: 'HOLD' as unknown as 'BUY',
        price: '70000',
        quantity: '3',
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_ORDER', retryable: false }),
    );
  });

  it.each(['0', '-1', 'abc', 'Infinity', 70000])(
    'rejects invalid price %s with INVALID_PRICE',
    (price) => {
      expect(() =>
        model.calculate({
          market: 'KR',
          side: 'BUY',
          price: price as string,
          quantity: '3',
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'INVALID_PRICE', retryable: false }),
      );
    },
  );

  it.each(['0', '-1', '1.5', 'abc', 'Infinity', 3])(
    'rejects invalid quantity %s with INVALID_QUANTITY',
    (quantity) => {
      expect(() =>
        model.calculate({
          market: 'KR',
          side: 'BUY',
          price: '70000',
          quantity: quantity as string,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'INVALID_QUANTITY',
          retryable: false,
        }),
      );
    },
  );
});
