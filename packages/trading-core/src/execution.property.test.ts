import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type {
  ExecutionOrder,
  OrderBookLevel,
  OrderBookSnapshot,
} from './execution.js';
import { calculateExecution } from './execution.js';
import type { FeeModel } from './fee-model.js';
import { applyFillToPosition } from './portfolio-math.js';

const propertySeed = 220826;

const zeroFeeModel: FeeModel = {
  version: 'property-zero-kr',
  market: 'KR',
  currency: 'KRW',
  calculate: () => '0',
};

const assertProperty = (property: fc.IProperty<unknown>): void => {
  try {
    fc.assert(property, { seed: propertySeed, verbose: 2 });
  } catch (error) {
    throw new Error(
      `Execution property failed with deterministic seed ${propertySeed}; fast-check reports the replay path in the cause.`,
      { cause: error },
    );
  }
};

type WalkFixture = {
  readonly side: 'BUY' | 'SELL';
  readonly quantity: string;
  readonly alreadyFilled: string;
  readonly volumes: readonly string[];
};

const walkFixtureArbitrary = fc
  .record({
    side: fc.constantFrom('BUY', 'SELL'),
    quantity: fc.integer({ min: 1, max: 50 }),
    filledSeed: fc.integer({ min: 0, max: 1000 }),
    magnitude: fc.integer({ min: 0, max: 30 }),
    volumes: fc.array(fc.integer({ min: 1, max: 20 }), {
      minLength: 1,
      maxLength: 8,
    }),
  })
  .map(({ side, quantity, filledSeed, magnitude, volumes }): WalkFixture => {
    const scale = 10n ** BigInt(magnitude);
    const scaledQuantity = BigInt(quantity) * scale;
    const alreadyFilled = BigInt(filledSeed) % scaledQuantity;

    return {
      side,
      quantity: scaledQuantity.toString(),
      alreadyFilled: alreadyFilled.toString(),
      volumes: volumes.map((volume) => (BigInt(volume) * scale).toString()),
    };
  });

const bookFor = (fixture: WalkFixture): OrderBookSnapshot => {
  const levels: OrderBookLevel[] = fixture.volumes.map((volume, index) => ({
    price:
      fixture.side === 'BUY'
        ? BigInt(100 + index).toString()
        : BigInt(99 - index).toString(),
    volume,
  }));

  return {
    symbol: '005930',
    market: 'KR',
    currency: 'KRW',
    bids: fixture.side === 'SELL' ? levels : [{ price: '99', volume: '100' }],
    asks: fixture.side === 'BUY' ? levels : [{ price: '100', volume: '100' }],
  };
};

const orderFor = (fixture: WalkFixture): ExecutionOrder => ({
  id: 'property-order',
  side: fixture.side,
  type: 'MARKET',
  market: 'KR',
  currency: 'KRW',
  symbol: '005930',
  quantity: fixture.quantity,
  ...(fixture.alreadyFilled === '0'
    ? {}
    : { filledQuantity: fixture.alreadyFilled }),
});

const decimalFromScaledInteger = (value: bigint, scale: number): string => {
  const digits = value.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
};

describe('execution metamorphic properties', () => {
  it('classifies exact integer and scale money boundaries', () => {
    assertProperty(
      fc.property(
        fc.constantFrom('integer', 'scale'),
        fc.integer({ min: 79, max: 81 }),
        (kind, width) => {
          const price =
            kind === 'integer'
              ? `1${'0'.repeat(width - 1)}`
              : `0.${'0'.repeat(width - 1)}1`;
          const apply = () =>
            applyFillToPosition(
              {
                symbol: 'BOUNDARY',
                quantity: '0',
                totalCost: '0',
                realizedPnl: '0',
              },
              {
                symbol: 'BOUNDARY',
                side: 'BUY',
                price,
                quantity: '1',
                fee: '0',
              },
            );

          if (width <= 80) {
            expect(apply().totalCost).toBe(price);
          } else {
            expect(apply).toThrowError(
              expect.objectContaining({
                code: 'INVALID_PRICE',
                retryable: false,
              }),
            );
          }
          return true;
        },
      ),
    );
  });

  it('conserves remaining quantity across generated deterministic walks', () => {
    assertProperty(
      fc.property(walkFixtureArbitrary, (fixture) => {
        const serialized = JSON.stringify(fixture);
        const remaining =
          BigInt(fixture.quantity) - BigInt(fixture.alreadyFilled);
        const available = fixture.volumes.reduce(
          (sum, volume) => sum + BigInt(volume),
          0n,
        );
        const expectedFilled = available < remaining ? available : remaining;

        const result = calculateExecution(
          orderFor(fixture),
          bookFor(fixture),
          zeroFeeModel,
          { referenceMid: '100', maxDeviationBps: 10_000 },
        );

        expect(BigInt(result.filledQuantity)).toBe(expectedFilled);
        expect(BigInt(result.unfilledQuantity)).toBe(
          remaining - expectedFilled,
        );
        expect(
          result.fills.reduce((sum, fill) => sum + BigInt(fill.quantity), 0n),
        ).toBe(expectedFilled);
        for (const level of result.consumedLevels) {
          expect(
            BigInt(level.consumedQuantity) <= BigInt(level.availableVolume),
          ).toBe(true);
        }
        expect(JSON.stringify(fixture)).toBe(serialized);
        return true;
      }),
    );
  });

  it('does not change a completed fill when worse depth is appended', () => {
    assertProperty(
      fc.property(
        fc.record({
          quantity: fc.integer({ min: 1, max: 50 }),
          extraVolume: fc.integer({ min: 1, max: 50 }),
        }),
        (fixture) => {
          const serialized = JSON.stringify(fixture);
          const order: ExecutionOrder = {
            id: 'append-order',
            side: 'BUY',
            type: 'MARKET',
            market: 'KR',
            currency: 'KRW',
            symbol: '005930',
            quantity: BigInt(fixture.quantity).toString(),
          };
          const baseBook: OrderBookSnapshot = {
            symbol: '005930',
            market: 'KR',
            currency: 'KRW',
            bids: [{ price: '99', volume: '100' }],
            asks: [
              {
                price: '100',
                volume: BigInt(fixture.quantity).toString(),
              },
            ],
          };
          const extendedBook: OrderBookSnapshot = {
            ...baseBook,
            asks: [
              ...baseBook.asks,
              {
                price: '101',
                volume: BigInt(fixture.extraVolume).toString(),
              },
            ],
          };

          const before = calculateExecution(order, baseBook, zeroFeeModel, {
            referenceMid: '100',
            maxDeviationBps: 500,
          });
          const after = calculateExecution(order, extendedBook, zeroFeeModel, {
            referenceMid: '100',
            maxDeviationBps: 500,
          });

          expect(after).toEqual(before);
          expect(JSON.stringify(fixture)).toBe(serialized);
          return true;
        },
      ),
    );
  });

  it('never fills more quantity when the protection band is tightened', () => {
    assertProperty(
      fc.property(
        fc.array(fc.integer({ min: 100, max: 110 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (priceSeeds) => {
          const prices = [...new Set(priceSeeds)].sort((a, b) => a - b);
          const serialized = JSON.stringify(prices);
          const book: OrderBookSnapshot = {
            symbol: '005930',
            market: 'KR',
            currency: 'KRW',
            bids: [{ price: '99', volume: '100' }],
            asks: prices.map((price) => ({
              price: BigInt(price).toString(),
              volume: '1',
            })),
          };
          const order: ExecutionOrder = {
            id: 'protection-order',
            side: 'BUY',
            type: 'MARKET',
            market: 'KR',
            currency: 'KRW',
            symbol: '005930',
            quantity: BigInt(prices.length).toString(),
          };

          const loose = calculateExecution(order, book, zeroFeeModel, {
            referenceMid: '100',
            maxDeviationBps: 1000,
          });
          const tight = calculateExecution(order, book, zeroFeeModel, {
            referenceMid: '100',
            maxDeviationBps: 500,
          });

          expect(
            BigInt(tight.filledQuantity) <= BigInt(loose.filledQuantity),
          ).toBe(true);
          expect(JSON.stringify(prices)).toBe(serialized);
          return true;
        },
      ),
    );
  });

  it('keeps weighted cost independent of buy fill order', () => {
    assertProperty(
      fc.property(
        fc.record({
          firstPrice: fc.integer({ min: 1, max: 100_000 }),
          secondPrice: fc.integer({ min: 1, max: 100_000 }),
          firstQuantity: fc.integer({ min: 1, max: 50 }),
          secondQuantity: fc.integer({ min: 1, max: 50 }),
          firstFeeUnits: fc.integer({ min: 0, max: 1000 }),
          secondFeeUnits: fc.integer({ min: 0, max: 1000 }),
        }),
        (fixture) => {
          const serialized = JSON.stringify(fixture);
          const empty = {
            symbol: '005930',
            quantity: '0',
            totalCost: '0',
            realizedPnl: '0',
          };
          const first = {
            symbol: '005930',
            side: 'BUY' as const,
            price: BigInt(fixture.firstPrice).toString(),
            quantity: BigInt(fixture.firstQuantity).toString(),
            fee: `0.${fixture.firstFeeUnits.toString().padStart(11, '0')}`,
          };
          const second = {
            symbol: '005930',
            side: 'BUY' as const,
            price: BigInt(fixture.secondPrice).toString(),
            quantity: BigInt(fixture.secondQuantity).toString(),
            fee: `0.${fixture.secondFeeUnits.toString().padStart(11, '0')}`,
          };

          const forward = applyFillToPosition(
            applyFillToPosition(empty, first),
            second,
          );
          const reversed = applyFillToPosition(
            applyFillToPosition(empty, second),
            first,
          );
          const expectedQuantity = BigInt(
            fixture.firstQuantity + fixture.secondQuantity,
          );
          const moneyScale = 100_000_000_000n;
          const expectedCost = decimalFromScaledInteger(
            BigInt(fixture.firstPrice) *
              BigInt(fixture.firstQuantity) *
              moneyScale +
              BigInt(fixture.firstFeeUnits) +
              BigInt(fixture.secondPrice) *
                BigInt(fixture.secondQuantity) *
                moneyScale +
              BigInt(fixture.secondFeeUnits),
            11,
          );

          expect(forward).toEqual(reversed);
          expect(BigInt(forward.quantity)).toBe(expectedQuantity);
          expect(forward.totalCost).toBe(expectedCost);
          expect(JSON.stringify(fixture)).toBe(serialized);
          return true;
        },
      ),
    );
  });
});
