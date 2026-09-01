import { DomainError, type Market } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';

import type {
  InstrumentRef,
  StrategyContext,
  StrategyDecision,
  StrategyPosition,
  Tick,
} from '../strategy.js';
import {
  advanceSmaCrossover,
  createSmaCrossover,
  initialSmaCrossoverState,
  type SmaCrossoverParams,
  type SmaCrossoverState,
  smaCrossoverParameterSchema,
} from './sma-crossover.js';

const PARAMS: SmaCrossoverParams = smaCrossoverParameterSchema.parse({
  market: 'KR',
  symbol: '005930',
  fastPeriod: 2,
  slowPeriod: 3,
  quantity: '10',
});

type TickInput =
  | string
  | {
      readonly price: string;
      readonly market?: Market;
      readonly symbol?: string;
      readonly gapBefore?: boolean;
    };

const makeTick = (input: TickInput, index: number): Tick => {
  const spec = typeof input === 'string' ? { price: input } : input;

  return {
    market: spec.market ?? PARAMS.market,
    symbol: spec.symbol ?? PARAMS.symbol,
    price: spec.price,
    priceSource: 'book-mid',
    bestBid: null,
    bestAsk: null,
    asOf: `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`,
    marketDataVersion: String(index + 1),
    gapBefore: spec.gapBefore ?? false,
  };
};

const makeContext = (position: StrategyPosition | null): StrategyContext => ({
  now: () => '2026-08-31T00:01:00.000Z',
  position: (ref: InstrumentRef) =>
    position !== null &&
    position.market === ref.market &&
    position.symbol === ref.symbol
      ? position
      : null,
  window: () => [],
});

const heldPosition = (total: string, available: string): StrategyPosition => ({
  market: PARAMS.market,
  symbol: PARAMS.symbol,
  total,
  available,
  averageCost: '70000',
});

interface Replay {
  readonly state: SmaCrossoverState;
  readonly decisions: readonly StrategyDecision[];
}

/** Folds a tick series through the pure core and keeps the last answer. */
const replay = (
  ticks: readonly TickInput[],
  position: StrategyPosition | null,
  params: SmaCrossoverParams = PARAMS,
  from: SmaCrossoverState = initialSmaCrossoverState(params),
): Replay => {
  const context = makeContext(position);

  return ticks.reduce<Replay>(
    (carried, input, index) =>
      advanceSmaCrossover(
        carried.state,
        makeTick(input, index),
        context,
        params,
      ),
    { state: from, decisions: [] },
  );
};

const buy = (quantity: string, reason: string): StrategyDecision => ({
  kind: 'place',
  intent: {
    market: PARAMS.market,
    symbol: PARAMS.symbol,
    side: 'BUY',
    type: 'MARKET',
    quantity,
  },
  reason,
});

const sell = (quantity: string, reason: string): StrategyDecision => ({
  kind: 'place',
  intent: {
    market: PARAMS.market,
    symbol: PARAMS.symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity,
  },
  reason,
});

const noop = (reason: string): StrategyDecision => ({ kind: 'noop', reason });

/**
 * The decision table. With `fastPeriod: 2` and `slowPeriod: 3` the window is
 * four prices `p1..p4` and the two relations reduce to exact sums:
 *
 *   current  = sign(p3 + p4 - 2·p2)
 *   previous = sign(p2 + p3 - 2·p1)
 *
 * so every row below states the relation pair it means to produce. A cross is
 * confirmed only between two *strict* relations: a tie on either side
 * suppresses the signal rather than risking an entry the averages never made.
 */
interface DecisionCase {
  readonly previous: 'below' | 'equal' | 'above' | 'none';
  readonly current: 'below' | 'equal' | 'above' | 'none';
  readonly position: string;
  readonly ticks: readonly TickInput[];
  readonly expected: readonly StrategyDecision[];
}

const DECISION_TABLE: readonly DecisionCase[] = [
  {
    previous: 'none',
    current: 'none',
    position: 'flat (one tick in)',
    ticks: ['10'],
    expected: [noop('warming-up')],
  },
  {
    previous: 'none',
    current: 'none',
    position: 'flat (slowPeriod ticks in)',
    ticks: ['10', '10', '10'],
    expected: [noop('warming-up')],
  },
  {
    previous: 'below',
    current: 'above',
    position: 'flat',
    ticks: ['10', '9', '10', '12'],
    expected: [buy('10', 'golden-cross')],
  },
  {
    previous: 'below',
    current: 'above',
    position: 'flat (a zeroed-out position row)',
    ticks: ['10', '9', '10', '12'],
    expected: [buy('10', 'golden-cross')],
  },
  {
    previous: 'below',
    current: 'above',
    position: 'long 5',
    ticks: ['10', '9', '10', '12'],
    expected: [noop('golden-cross-already-long')],
  },
  {
    previous: 'above',
    current: 'below',
    position: 'long 5',
    ticks: ['10', '11', '10', '8'],
    expected: [sell('5', 'dead-cross')],
  },
  {
    previous: 'above',
    current: 'below',
    position: 'long 25',
    ticks: ['10', '11', '10', '8'],
    expected: [sell('25', 'dead-cross')],
  },
  {
    previous: 'above',
    current: 'below',
    position: 'long 5, none available',
    ticks: ['10', '11', '10', '8'],
    expected: [noop('dead-cross-no-sellable-quantity')],
  },
  {
    previous: 'above',
    current: 'below',
    position: 'flat',
    ticks: ['10', '11', '10', '8'],
    expected: [noop('dead-cross-no-position')],
  },
  {
    previous: 'above',
    current: 'above',
    position: 'long 5',
    ticks: ['10', '11', '10', '14'],
    expected: [noop('no-cross')],
  },
  {
    previous: 'below',
    current: 'below',
    position: 'flat',
    ticks: ['10', '9', '10', '6'],
    expected: [noop('no-cross')],
  },
  {
    previous: 'below',
    current: 'equal',
    position: 'flat',
    ticks: ['10', '9', '10', '8'],
    expected: [noop('tie')],
  },
  {
    previous: 'above',
    current: 'equal',
    position: 'long 5',
    ticks: ['10', '11', '10', '12'],
    expected: [noop('tie')],
  },
  {
    previous: 'equal',
    current: 'equal',
    position: 'flat',
    ticks: ['10', '9', '11', '7'],
    expected: [noop('tie')],
  },
  {
    previous: 'equal',
    current: 'above',
    position: 'flat',
    ticks: ['10', '9', '11', '12'],
    expected: [noop('unconfirmed-cross')],
  },
  {
    previous: 'equal',
    current: 'below',
    position: 'long 5',
    ticks: ['10', '11', '9', '10'],
    expected: [noop('unconfirmed-cross')],
  },
  {
    // A float64 average calls this a tie: `18.00000000000000000001` rounds to
    // `18`, both cross-products come out `54`, and the entry is suppressed.
    previous: 'below',
    current: 'above',
    position: 'flat (by one part in 10^20)',
    ticks: ['10', '9', '10', '8.00000000000000000001'],
    expected: [buy('10', 'golden-cross')],
  },
  {
    previous: 'above',
    current: 'below',
    position: 'long 5 (by one part in 10^20)',
    ticks: ['10', '11', '10', '11.99999999999999999999'],
    expected: [sell('5', 'dead-cross')],
  },
  {
    previous: 'none',
    current: 'none',
    position: 'long 5 (two ticks in)',
    ticks: ['10', '10'],
    expected: [noop('warming-up-while-long')],
  },
  {
    previous: 'below',
    current: 'above',
    position: 'flat, but the tick follows a market-data gap',
    ticks: ['10', '9', '10', { price: '12', gapBefore: true }],
    expected: [noop('gap-reset')],
  },
  {
    // The exit is suspended too, and says so. See the header note on gaps: the
    // kill switch and the RiskGate are the paths that flatten under stress.
    previous: 'above',
    current: 'below',
    position: 'long 5, and the tick follows a market-data gap',
    ticks: ['10', '11', '10', { price: '8', gapBefore: true }],
    expected: [noop('gap-reset-while-long')],
  },
  {
    previous: 'below',
    current: 'above',
    position: 'flat, but the tick is for another instrument',
    ticks: ['10', '9', '10', { price: '12', symbol: '000660' }],
    expected: [noop('other-instrument')],
  },
  {
    previous: 'below',
    current: 'above',
    position: 'flat, but the tick is for another market',
    ticks: ['10', '9', '10', { price: '12', market: 'US' }],
    expected: [noop('other-instrument')],
  },
];

const positionFor = (label: string): StrategyPosition | null => {
  if (label.startsWith('flat (a zeroed-out')) {
    return heldPosition('0', '0');
  }
  if (label.startsWith('long 5, none available')) {
    return heldPosition('5', '0');
  }
  if (label.startsWith('long 25')) {
    return heldPosition('25', '25');
  }
  if (label.startsWith('long 5')) {
    return heldPosition('5', '5');
  }

  return null;
};

describe('sma-crossover decision table', () => {
  it.each(DECISION_TABLE)(
    'previous $previous, current $current, position $position',
    ({ ticks, position, expected }) => {
      expect(replay(ticks, positionFor(position)).decisions).toStrictEqual(
        expected,
      );
    },
  );

  it('covers every relation pair the core can reach', () => {
    const reached = new Set(
      DECISION_TABLE.map((row) => `${row.previous}→${row.current}`),
    );

    expect([...reached].sort()).toStrictEqual([
      'above→above',
      'above→below',
      'above→equal',
      'below→above',
      'below→below',
      'below→equal',
      'equal→above',
      'equal→below',
      'equal→equal',
      'none→none',
    ]);
  });
});

describe('sma-crossover window', () => {
  it('keeps exactly slowPeriod + 1 prices, dropping the oldest', () => {
    const { state } = replay(['1', '2', '3', '4', '5', '6'], null);

    expect(state.prices).toStrictEqual(['3', '4', '5', '6']);
  });

  // The gap discards the window, so the hold before the next decision is
  // slowPeriod + 1 ticks — derived from the parameters, not configured.
  it('refills after a gap and only then decides again', () => {
    const gapped = replay(
      ['10', '9', '10', { price: '12', gapBefore: true }],
      null,
    );

    expect(gapped.state.prices).toStrictEqual(['12']);

    const warming = replay(['10', '9'], null, PARAMS, gapped.state);

    expect(warming.state.prices).toStrictEqual(['12', '10', '9']);
    expect(warming.decisions).toStrictEqual([noop('warming-up')]);

    const filled = replay(['10'], null, PARAMS, warming.state);

    expect(filled.state.prices).toStrictEqual(['12', '10', '9', '10']);
    expect(filled.decisions).toStrictEqual([noop('no-cross')]);

    const crossing = replay(['12'], null, PARAMS, filled.state);

    expect(crossing.state.prices).toStrictEqual(['10', '9', '10', '12']);
    expect(crossing.decisions).toStrictEqual([buy('10', 'golden-cross')]);
  });

  it('leaves the window untouched for a tick it does not own', () => {
    const before = replay(['10', '9', '10'], null);
    const after = replay(
      [{ price: '999', symbol: '000660' }],
      null,
      PARAMS,
      before.state,
    );

    expect(after.state).toStrictEqual(before.state);
  });

  it('refuses a tick whose price is not exact money', () => {
    expect(() => replay(['10', '9', 'NaN'], null)).toThrow(DomainError);
    expect(() => replay(['10', '9', '1e3'], null)).toThrow(
      /price must be a positive plain decimal string/u,
    );
  });
});

/**
 * A window sum can leave the exact money domain even though every price in it
 * is valid on its own. The ring must still advance, or the price that caused it
 * can never be displaced and the strategy is wedged for the life of the
 * process.
 */
describe('sma-crossover out-of-domain sums', () => {
  // Valid on its own — 80 significant digits is exactly the money domain's
  // limit, and `isPositiveMoneyAmount` accepts it. Two of them are not.
  const HUGE = '9'.repeat(80);
  const WIDE: SmaCrossoverParams = smaCrossoverParameterSchema.parse({
    market: 'KR',
    symbol: '005930',
    fastPeriod: 1,
    slowPeriod: 2,
    quantity: '10',
  });

  /** Every tick's decisions, not only the last. */
  const trace = (
    ticks: readonly TickInput[],
  ): readonly StrategyDecision[][] => {
    const context = makeContext(null);
    const decisions: StrategyDecision[][] = [];
    let state = initialSmaCrossoverState(WIDE);

    for (const [index, input] of ticks.entries()) {
      const advanced = advanceSmaCrossover(
        state,
        makeTick(input, index),
        context,
        WIDE,
      );

      state = advanced.state;
      decisions.push([...advanced.decisions]);
    }

    return decisions;
  };

  it('stands still instead of raising when the window sum overflows', () => {
    expect(() => trace([HUGE, HUGE, HUGE])).not.toThrow();
    expect(trace([HUGE, HUGE, HUGE])).toStrictEqual([
      [noop('warming-up')],
      [noop('warming-up')],
      [noop('price-out-of-domain')],
    ]);
  });

  it('keeps deciding after the offending price ages out of the ring', () => {
    const reasons = trace([HUGE, HUGE, HUGE, '10', '11', '12']).map(
      (decisions) => (decisions[0] as { reason: string }).reason,
    );

    expect(reasons).toStrictEqual([
      'warming-up',
      'warming-up',
      'price-out-of-domain',
      // `HUGE` is still inside the two-price slow window.
      'price-out-of-domain',
      // Out of the slow window, still inside the ring the previous relation
      // is computed from.
      'price-out-of-domain',
      // Gone. `slowPeriod + 1` ticks, and no operator had to intervene.
      'no-cross',
    ]);
  });

  it('advances the ring on the tick it could not compare', () => {
    const context = makeContext(null);
    const wedged = [HUGE, HUGE, HUGE].reduce<Replay>(
      (carried, price, index) =>
        advanceSmaCrossover(
          carried.state,
          makeTick(price, index),
          context,
          WIDE,
        ),
      { state: initialSmaCrossoverState(WIDE), decisions: [] },
    );

    expect(wedged.state.prices).toStrictEqual([HUGE, HUGE, HUGE]);

    const after = advanceSmaCrossover(
      wedged.state,
      makeTick('10', 3),
      context,
      WIDE,
    );

    expect(after.state.prices).toStrictEqual([HUGE, HUGE, '10']);
  });

  // The contrast that makes the case above a different category: a malformed
  // price is rejected before any state changes, so it raises once and the next
  // valid tick resumes.
  it('still fails closed on a malformed price, and recovers on the next tick', () => {
    const strategy = createSmaCrossover();
    const context = makeContext(null);

    expect(() => strategy.onTick(makeTick('1e3', 0), context, WIDE)).toThrow(
      DomainError,
    );
    expect(strategy.onTick(makeTick('10', 1), context, WIDE)).toStrictEqual([
      noop('warming-up'),
    ]);
  });
});

describe('sma-crossover position handling', () => {
  it.each([
    ['a fractional total', '5.5', '5'],
    ['a negative total', '-5', '5'],
    ['exponent notation', '5', '1e1'],
    ['a signed available', '5', '+5'],
  ])('refuses %s from the context', (_label, total, available) => {
    expect(() =>
      replay(['10', '11', '10', '8'], heldPosition(total, available)),
    ).toThrow(/position quantities must be non-negative whole numbers/u);
  });

  it('ignores a position the context reports for another instrument', () => {
    const foreign: StrategyContext = {
      now: () => '2026-08-31T00:01:00.000Z',
      position: () => ({
        market: 'US',
        symbol: 'AAPL',
        total: '5',
        available: '5',
        averageCost: '190',
      }),
      window: () => [],
    };
    const decisions = ['10', '11', '10', '8'].reduce<Replay>(
      (carried, price, index) =>
        advanceSmaCrossover(
          carried.state,
          makeTick(price, index),
          foreign,
          PARAMS,
        ),
      { state: initialSmaCrossoverState(PARAMS), decisions: [] },
    ).decisions;

    // The context answered with a position, and it is the context's job to
    // answer for the instrument it was asked about — so this strategy takes the
    // answer at face value and exits it. What it must not do is invent one.
    expect(decisions).toStrictEqual([sell('5', 'dead-cross')]);
  });
});

describe('sma-crossover purity', () => {
  it('returns the same decisions for the same inputs, and mutates nothing', () => {
    const ticks = ['10', '9', '10', '12'] as const;
    const first = replay(ticks, null);
    const second = replay(ticks, null);

    expect(second).toStrictEqual(first);
    expect(Object.isFrozen(first.decisions)).toBe(true);
    expect(Object.isFrozen(first.state)).toBe(true);
    expect(Object.isFrozen(first.state.prices)).toBe(true);
  });

  it('does not read the clock, and never touches the tick it was handed', () => {
    const tick = makeTick('10', 0);
    const clock = {
      now: () => {
        throw new Error('onTick must not read the clock');
      },
      position: () => null,
      window: () => [],
    } satisfies StrategyContext;

    expect(() =>
      advanceSmaCrossover(
        initialSmaCrossoverState(PARAMS),
        tick,
        clock,
        PARAMS,
      ),
    ).not.toThrow();
    expect(tick).toStrictEqual(makeTick('10', 0));
  });

  it('shares no state between two strategy instances', () => {
    const one = createSmaCrossover();
    const two = createSmaCrossover();
    const context = makeContext(null);

    for (const [index, price] of ['10', '9', '10'].entries()) {
      one.onTick(makeTick(price, index), context, PARAMS);
    }

    expect(two.onTick(makeTick('12', 3), context, PARAMS)).toStrictEqual([
      noop('warming-up'),
    ]);
    expect(one.onTick(makeTick('12', 3), context, PARAMS)).toStrictEqual([
      buy('10', 'golden-cross'),
    ]);
  });
});

describe('sma-crossover snapshot round-trip', () => {
  const feed = (
    strategy: ReturnType<typeof createSmaCrossover>,
    prices: readonly string[],
    offset = 0,
  ) => {
    const context = makeContext(null);

    return prices.map((price, index) =>
      strategy.onTick(makeTick(price, offset + index), context, PARAMS),
    );
  };

  it('restores the window exactly, so the next tick decides identically', () => {
    const original = createSmaCrossover();

    feed(original, ['10', '9', '10']);

    const saved = JSON.parse(JSON.stringify(original.snapshot()));
    const restored = createSmaCrossover();

    restored.onStart(saved, makeContext(null), PARAMS);

    expect(restored.snapshot()).toStrictEqual(original.snapshot());

    const fromRestored = feed(restored, ['12'], 3);
    const fromOriginal = feed(original, ['12'], 3);

    expect(fromRestored).toStrictEqual(fromOriginal);
    expect(fromRestored[0]).toStrictEqual([buy('10', 'golden-cross')]);
  });

  it('refuses to snapshot before it has any state to save', () => {
    expect(() => createSmaCrossover().snapshot()).toThrow(
      /onStart or onTick must run first/u,
    );
  });

  it('starts cold from an empty snapshot', () => {
    const strategy = createSmaCrossover();

    strategy.onStart(
      initialSmaCrossoverState(PARAMS),
      makeContext(null),
      PARAMS,
    );

    expect(strategy.snapshot()).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      prices: [],
    });
  });

  // A longer window is price history the operator kept; a shorter one just
  // resumes warming up. Neither is corruption, so neither refuses to start.
  it('keeps the newest slowPeriod + 1 prices when the periods changed', () => {
    const strategy = createSmaCrossover();

    strategy.onStart(
      {
        market: 'KR',
        symbol: '005930',
        prices: ['1', '2', '3', '4', '5', '6'],
      },
      makeContext(null),
      PARAMS,
    );

    expect(strategy.snapshot()).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      prices: ['3', '4', '5', '6'],
    });
  });

  // Prices for a different instrument are not this strategy's history, and a
  // reconfiguration is not a failure — so the window is discarded, not refused.
  it('discards a window recorded for another instrument', () => {
    const strategy = createSmaCrossover();

    strategy.onStart(
      { market: 'US', symbol: 'AAPL', prices: ['10', '9', '10'] },
      makeContext(null),
      PARAMS,
    );

    expect(strategy.snapshot()).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      prices: [],
    });
  });

  it.each([
    ['a non-object', 42],
    ['a missing price list', { market: 'KR', symbol: '005930' }],
    [
      'a price list that is not an array',
      { market: 'KR', symbol: '005930', prices: '10' },
    ],
    [
      'a price that is not exact money',
      { market: 'KR', symbol: '005930', prices: ['10', '1e3'] },
    ],
    ['a negative price', { market: 'KR', symbol: '005930', prices: ['-10'] }],
    [
      'a market that is not a market',
      { market: 'JP', symbol: '005930', prices: [] },
    ],
    [
      'a symbol that is not an identifier',
      { market: 'KR', symbol: '', prices: [] },
    ],
  ])('refuses to start from %s', (_label, saved) => {
    const strategy = createSmaCrossover();

    expect(() =>
      strategy.onStart(saved as never, makeContext(null), PARAMS),
    ).toThrow(DomainError);
  });
});

describe('sma-crossover contract', () => {
  it('subscribes to exactly the one instrument it trades', () => {
    expect(createSmaCrossover().subscriptions(PARAMS)).toStrictEqual([
      { market: 'KR', symbol: '005930' },
    ]);
  });

  it('is registered under a stable id', () => {
    expect(createSmaCrossover().id).toBe('sma-crossover');
  });

  // §7.3: the ledger is the original of the position and the bot's state is a
  // cache, so the strategy reads it through the context. Mirroring fills into a
  // second copy is the drift that warning is about, so there is deliberately no
  // `onFill`.
  it('does not mirror fills into its own position', () => {
    expect(createSmaCrossover().onFill).toBeUndefined();
  });

  it('emits decisions the contract reader accepts', () => {
    const { decisions } = replay(['10', '9', '10', '12'], null);

    expect(decisions).toStrictEqual([buy('10', 'golden-cross')]);
  });
});

describe('sma-crossover parameters', () => {
  it('refuses a fast period that is not shorter than the slow period', () => {
    for (const [fastPeriod, slowPeriod] of [
      [3, 3],
      [5, 3],
    ]) {
      expect(() =>
        smaCrossoverParameterSchema.parse({
          market: 'KR',
          symbol: '005930',
          fastPeriod,
          slowPeriod,
          quantity: '10',
        }),
      ).toThrow(/fastPeriod must be shorter than slowPeriod/u);
    }
  });

  it('declares exactly the five parameters it reads', () => {
    expect(smaCrossoverParameterSchema.fieldNames).toStrictEqual([
      'market',
      'symbol',
      'fastPeriod',
      'slowPeriod',
      'quantity',
    ]);
  });
});
