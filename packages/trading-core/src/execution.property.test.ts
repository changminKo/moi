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
  readonly quantity: number;
  readonly alreadyFilled: number;
  readonly volumes: readonly number[];
};

const walkFixtureArbitrary = fc
  .record({
    side: fc.constantFrom('BUY', 'SELL'),
    quantity: fc.integer({ min: 1, max: 50 }),
    filledSeed: fc.integer({ min: 0, max: 1000 }),
    volumes: fc.array(fc.integer({ min: 1, max: 20 }), {
      minLength: 1,
      maxLength: 8,
    }),
  })
  .map(
    ({ side, quantity, filledSeed, volumes }): WalkFixture => ({
      side,
      quantity,
      alreadyFilled: filledSeed % quantity,
      volumes,
    }),
  );

const bookFor = (fixture: WalkFixture): OrderBookSnapshot => {
  const levels: OrderBookLevel[] = fixture.volumes.map((volume, index) => ({
    price:
      fixture.side === 'BUY'
        ? BigInt(100 + index).toString()
        : BigInt(99 - index).toString(),
    volume: BigInt(volume).toString(),
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
  quantity: BigInt(fixture.quantity).toString(),
  ...(fixture.alreadyFilled === 0
    ? {}
    : { filledQuantity: BigInt(fixture.alreadyFilled).toString() }),
});

describe('execution metamorphic properties', () => {
  it('conserves remaining quantity across generated deterministic walks', () => {
    assertProperty(
      fc.property(walkFixtureArbitrary, (fixture) => {
        const serialized = JSON.stringify(fixture);
        const remaining = BigInt(fixture.quantity - fixture.alreadyFilled);
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
          firstFee: fc.integer({ min: 0, max: 1000 }),
          secondFee: fc.integer({ min: 0, max: 1000 }),
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
            fee: BigInt(fixture.firstFee).toString(),
          };
          const second = {
            symbol: '005930',
            side: 'BUY' as const,
            price: BigInt(fixture.secondPrice).toString(),
            quantity: BigInt(fixture.secondQuantity).toString(),
            fee: BigInt(fixture.secondFee).toString(),
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
          const expectedCost =
            BigInt(fixture.firstPrice) * BigInt(fixture.firstQuantity) +
            BigInt(fixture.firstFee) +
            BigInt(fixture.secondPrice) * BigInt(fixture.secondQuantity) +
            BigInt(fixture.secondFee);

          expect(forward).toEqual(reversed);
          expect(BigInt(forward.quantity)).toBe(expectedQuantity);
          expect(BigInt(forward.totalCost)).toBe(expectedCost);
          expect(JSON.stringify(fixture)).toBe(serialized);
          return true;
        },
      ),
    );
  });
});
