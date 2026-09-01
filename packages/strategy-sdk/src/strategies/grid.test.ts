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
  advanceGrid,
  createGrid,
  GRID_ID,
  type GridParams,
  type GridState,
  gridLevels,
  gridParameterSchema,
  initialGridState,
  readGridState,
} from './grid.js';

/**
 * Five levels 250 apart from 70,000: 70000 70250 70500 70750 71000.
 * Rungs are 0..5, slots 0..3.
 */
const PARAMS: GridParams = gridParameterSchema.parse({
  market: 'KR',
  symbol: '005930',
  lowerPrice: '70000',
  step: '250',
  levels: 5,
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
    priceSource: 'rest-snapshot',
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

const heldPosition = (
  total: string,
  available: string = total,
): StrategyPosition => ({
  market: PARAMS.market,
  symbol: PARAMS.symbol,
  total,
  available,
  averageCost: '70000',
});

interface Replay {
  readonly state: GridState;
  readonly decisions: readonly StrategyDecision[];
}

/** Folds a tick series through the pure core and keeps the last answer. */
const replay = (
  ticks: readonly TickInput[],
  position: StrategyPosition | null,
  params: GridParams = PARAMS,
  from: GridState = initialGridState(params),
): Replay => {
  const context = makeContext(position);

  return ticks.reduce<Replay>(
    (carried, input, index) =>
      advanceGrid(carried.state, makeTick(input, index), context, params),
    { state: from, decisions: [] },
  );
};

const order = (
  side: 'BUY' | 'SELL',
  quantity: string,
  reason: string,
): StrategyDecision => ({
  kind: 'place',
  intent: {
    market: PARAMS.market,
    symbol: PARAMS.symbol,
    side,
    type: 'MARKET',
    quantity,
  },
  reason,
});

const noop = (reason: string): readonly StrategyDecision[] => [
  { kind: 'noop', reason },
];

describe('grid levels', () => {
  it('derives every level by multiplication from the configured step', () => {
    expect(gridLevels(PARAMS)).toStrictEqual([
      '70000',
      '70250',
      '70500',
      '70750',
      '71000',
    ]);
  });

  /**
   * The concrete exactness case, and it is worse than "floats are imprecise":
   * the two obvious float formulations of the *same* configuration produce two
   * *different* grids, and neither is the one the operator wrote.
   *
   * The consequence is not cosmetic. The exact grid has a level at `0.7`, so a
   * tick at exactly `0.7` is at that level. The multiplying float grid's fourth
   * line is `0.7000000000000001`, so the same tick is *below* it — one rung
   * lower, on the far side of a boundary that decides whether a lot is bought.
   */
  it('places levels exactly where neither float formulation does', () => {
    const params = gridParameterSchema.parse({
      market: 'US',
      symbol: 'AAPL',
      lowerPrice: '0.1',
      step: '0.2',
      levels: 5,
      quantity: '1',
    });

    expect(gridLevels(params)).toStrictEqual([
      '0.1',
      '0.3',
      '0.5',
      '0.7',
      '0.9',
    ]);

    const multiplied = Array.from(
      { length: 5 },
      (_, index) => 0.1 + 0.2 * index,
    );
    const accumulated: number[] = [0.1];

    while (accumulated.length < multiplied.length) {
      accumulated.push((accumulated.at(-1) as number) + 0.2);
    }

    expect(multiplied.map(String)).toStrictEqual([
      '0.1',
      '0.30000000000000004',
      '0.5',
      '0.7000000000000001',
      '0.9',
    ]);
    expect(accumulated.map(String)).toStrictEqual([
      '0.1',
      '0.30000000000000004',
      '0.5',
      '0.7',
      '0.8999999999999999',
    ]);
    expect(multiplied).not.toStrictEqual(accumulated);
    expect(0.1 + 0.2 * 3).toBeGreaterThan(0.7);
  });

  it('keeps an 80-digit-scale step exact across every level', () => {
    const params = gridParameterSchema.parse({
      market: 'US',
      symbol: 'AAPL',
      lowerPrice: '1',
      step: `0.${'0'.repeat(78)}1`,
      levels: 3,
      quantity: '1',
    });

    expect(gridLevels(params)).toStrictEqual([
      '1',
      `1.${'0'.repeat(78)}1`,
      `1.${'0'.repeat(78)}2`,
    ]);
  });
});

describe('grid parameters', () => {
  it('refuses a top level outside the exact money domain', () => {
    expect(() =>
      gridParameterSchema.parse({
        market: 'KR',
        symbol: '005930',
        lowerPrice: '9'.repeat(80),
        step: '9'.repeat(80),
        levels: 4,
        quantity: '1',
      }),
    ).toThrow(DomainError);
  });

  it('refuses a full grid whose total quantity leaves the money domain', () => {
    expect(() =>
      gridParameterSchema.parse({
        market: 'KR',
        symbol: '005930',
        lowerPrice: '1',
        step: '1',
        levels: 3,
        quantity: '9'.repeat(80),
      }),
    ).toThrow(DomainError);
  });

  it('refuses fewer than two levels, and a step that is not positive money', () => {
    const base = {
      market: 'KR',
      symbol: '005930',
      lowerPrice: '70000',
      quantity: '10',
    };

    expect(() =>
      gridParameterSchema.parse({ ...base, step: '250', levels: 1 }),
    ).toThrow(DomainError);
    expect(() =>
      gridParameterSchema.parse({ ...base, step: '0', levels: 5 }),
    ).toThrow(DomainError);
    expect(() =>
      gridParameterSchema.parse({ ...base, step: '-250', levels: 5 }),
    ).toThrow(DomainError);
    expect(() =>
      gridParameterSchema.parse({ ...base, step: '2.5e2', levels: 5 }),
    ).toThrow(DomainError);
  });
});

describe('grid decisions', () => {
  it('takes no position on the first tick it sees', () => {
    const { state, decisions } = replay(['70800'], null);

    expect(decisions).toStrictEqual(noop('priming'));
    expect(state.rung).toBe(4);
    expect(state.lots).toStrictEqual([]);
  });

  it('stands still while the price stays inside one cell', () => {
    expect(replay(['70800', '70999'], null).decisions).toStrictEqual(
      noop('inside-cell'),
    );
  });

  it('buys one lot for each level crossed downwards', () => {
    // 70800 is rung 4; 70600 is rung 3, so level 70750 was crossed downwards.
    const first = replay(['70800', '70600'], null);

    expect(first.decisions).toStrictEqual([order('BUY', '10', 'grid-buy')]);
    expect(first.state.lots).toStrictEqual([3]);

    // 70100 is rung 1: levels 70500 and 70250 were crossed in one tick.
    const second = replay(['70800', '70100'], null);

    expect(second.decisions).toStrictEqual([order('BUY', '30', 'grid-buy')]);
    expect(second.state.lots).toStrictEqual([1, 2, 3]);
  });

  it('never fills the slot above the topmost buy line', () => {
    // From above the grid (rung 5) down to rung 4: entering rung 4 would fill
    // slot 4, whose paired sell would be a level that does not exist.
    const { state, decisions } = replay(['71500', '70800'], null);

    expect(decisions).toStrictEqual(noop('no-slot-to-fill'));
    expect(state.lots).toStrictEqual([]);
  });

  it('does not refill a slot it already holds', () => {
    const { state, decisions } = replay(
      ['70800', '70600', '70800', '70600'],
      null,
    );

    expect(decisions).toStrictEqual(noop('no-slot-to-fill'));
    expect(state.lots).toStrictEqual([3]);
  });

  /**
   * The whole point of the two-rung hysteresis: a lot bought on entering rung k
   * is sold on entering rung k+2, so it is bought at level k and sold at level
   * k+1 — one full step apart. Selling it back on the level it was bought at
   * would be a round trip that earns nothing.
   */
  it('holds a lot through the rung it was bought in and sells it one level up', () => {
    const held = heldPosition('10');
    const bought = replay(['70800', '70600'], held);

    expect(bought.state.lots).toStrictEqual([3]);

    const backUp = advanceGrid(
      bought.state,
      makeTick('70800', 2),
      makeContext(held),
      PARAMS,
    );

    expect(backUp.decisions).toStrictEqual(noop('no-lot-to-sell'));
    expect(backUp.state.lots).toStrictEqual([3]);

    const higher = advanceGrid(
      backUp.state,
      makeTick('71100', 3),
      makeContext(held),
      PARAMS,
    );

    expect(higher.decisions).toStrictEqual([order('SELL', '10', 'grid-sell')]);
    expect(higher.state.lots).toStrictEqual([]);
  });

  it('sells one lot for each paired level crossed upwards', () => {
    const held = heldPosition('30');
    const down = replay(['70800', '70100'], held);

    expect(down.state.lots).toStrictEqual([1, 2, 3]);

    const up = advanceGrid(
      down.state,
      makeTick('71100', 2),
      makeContext(held),
      PARAMS,
    );

    // Entering rungs 2, 3, 4 and 5 releases slots 0, 1, 2 and 3; slot 0 is not
    // held, so three lots are sold.
    expect(up.decisions).toStrictEqual([order('SELL', '30', 'grid-sell')]);
    expect(up.state.lots).toStrictEqual([]);
  });

  it('sells only what the ledger says is available, and forgets the rest', () => {
    const held = heldPosition('30', '10');
    const down = replay(['70800', '70100'], held);
    const up = advanceGrid(
      down.state,
      makeTick('71100', 2),
      makeContext(held),
      PARAMS,
    );

    expect(up.decisions).toStrictEqual([
      order('SELL', '10', 'grid-sell-partial'),
    ]);
    expect(up.state.lots).toStrictEqual([]);
  });

  /**
   * The self-healing path. A lot is recorded when the *decision* is taken, so a
   * buy the risk gate refused leaves a slot the ledger never filled. The next
   * time that slot is due to be sold the ledger says nothing is available, and
   * the lot is dropped rather than turned into a sell the ledger would refuse.
   */
  it('drops lots the ledger does not back rather than selling what it has not got', () => {
    const down = replay(['70800', '70600'], null);
    const up = advanceGrid(
      down.state,
      makeTick('71100', 2),
      makeContext(null),
      PARAMS,
    );

    expect(up.decisions).toStrictEqual(noop('unbacked-lots-dropped'));
    expect(up.state.lots).toStrictEqual([]);
  });

  it('clamps a price outside the band to the band and trades no further', () => {
    const held = heldPosition('40');
    // 60000 is below every level (rung 0) and 90000 above every level (rung 5).
    const bottom = replay(['71500', '60000'], held);

    expect(bottom.decisions).toStrictEqual([order('BUY', '40', 'grid-buy')]);
    expect(bottom.state.lots).toStrictEqual([0, 1, 2, 3]);

    const lower = advanceGrid(
      bottom.state,
      makeTick('50000', 2),
      makeContext(held),
      PARAMS,
    );

    expect(lower.decisions).toStrictEqual(noop('inside-cell'));
    expect(lower.state.lots).toStrictEqual([0, 1, 2, 3]);
  });

  it('treats a price exactly on a level as being at that level', () => {
    const params = gridParameterSchema.parse({
      market: 'US',
      symbol: 'AAPL',
      lowerPrice: '0.1',
      step: '0.2',
      levels: 5,
      quantity: '1',
    });
    const context = makeContext(null);
    const tick = (price: string, index: number): Tick => ({
      ...makeTick(price, index),
      market: 'US',
      symbol: 'AAPL',
    });

    // 0.7 is the fourth level, so four levels are at or below it: rung 4.
    const primed = advanceGrid(
      initialGridState(params),
      tick('0.7', 0),
      context,
      params,
    );

    expect(primed.state.rung).toBe(4);

    // A hair under it is rung 3, which crosses level index 3 downwards.
    const under = advanceGrid(primed.state, tick('0.69', 1), context, params);

    expect(under.state.rung).toBe(3);
    expect(under.state.lots).toStrictEqual([3]);
  });

  it('re-baselines on a gap without claiming the crossings it did not see', () => {
    const primed = replay(['70800'], null);
    const gapped = advanceGrid(
      primed.state,
      makeTick({ price: '70100', gapBefore: true }, 1),
      makeContext(null),
      PARAMS,
    );

    expect(gapped.decisions).toStrictEqual(noop('gap-reset'));
    expect(gapped.state.rung).toBe(1);
    expect(gapped.state.lots).toStrictEqual([]);

    // The lots it already holds survive the gap: the ledger still holds them.
    const held = replay(['70800', '70600'], heldPosition('10'));
    const afterGap = advanceGrid(
      held.state,
      makeTick({ price: '70100', gapBefore: true }, 2),
      makeContext(heldPosition('10')),
      PARAMS,
    );

    expect(afterGap.decisions).toStrictEqual(noop('gap-reset'));
    expect(afterGap.state.lots).toStrictEqual([3]);
  });

  it('ignores a tick for another instrument entirely', () => {
    const primed = replay(['70800'], null);
    const other = advanceGrid(
      primed.state,
      makeTick({ price: '10', symbol: '000660' }, 1),
      makeContext(null),
      PARAMS,
    );

    expect(other.decisions).toStrictEqual(noop('other-instrument'));
    expect(other.state).toStrictEqual(primed.state);
  });

  it('refuses a malformed price before it changes any state', () => {
    expect(() =>
      advanceGrid(
        initialGridState(PARAMS),
        makeTick('7e4', 0),
        makeContext(null),
        PARAMS,
      ),
    ).toThrow(DomainError);
  });
});

describe('grid state', () => {
  it('restores a snapshot exactly', () => {
    const saved = replay(['70800', '70100'], heldPosition('30')).state;

    expect(
      readGridState(JSON.parse(JSON.stringify(saved)), PARAMS),
    ).toStrictEqual(saved);
  });

  it('discards a window recorded for a different instrument', () => {
    const saved = replay(['70800', '70100'], heldPosition('30')).state;
    const repointed = gridParameterSchema.parse({
      ...PARAMS,
      symbol: '000660',
    });

    expect(readGridState(saved, repointed)).toStrictEqual(
      initialGridState(repointed),
    );
  });

  it('drops lots and a rung the reconfigured grid no longer has', () => {
    const narrower = gridParameterSchema.parse({ ...PARAMS, levels: 3 });

    expect(
      readGridState(
        { market: 'KR', symbol: '005930', rung: 5, lots: [0, 1, 2, 3] },
        narrower,
      ),
    ).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      rung: 3,
      lots: [0, 1],
    });
  });

  it('fails closed on corruption rather than repairing it', () => {
    for (const saved of [
      null,
      'nope',
      { market: 'KR', symbol: '005930', rung: 1.5, lots: [] },
      { market: 'KR', symbol: '005930', rung: 1, lots: 'all' },
      { market: 'KR', symbol: '005930', rung: 1, lots: [1.5] },
      { market: 'XX', symbol: '005930', rung: 1, lots: [] },
    ]) {
      expect(() => readGridState(saved, PARAMS)).toThrow(DomainError);
    }
  });
});

describe('the grid strategy instance', () => {
  it('answers to its registered id and subscribes to its one instrument', () => {
    const grid = createGrid();

    expect(grid.id).toBe(GRID_ID);
    expect(grid.subscriptions(PARAMS)).toStrictEqual([
      { market: 'KR', symbol: '005930' },
    ]);
  });

  it('carries its window across a snapshot and a restart', () => {
    const context = makeContext(heldPosition('10'));
    const first = createGrid();

    first.onStart(initialGridState(PARAMS), context, PARAMS);
    first.onTick(makeTick('70800', 0), context, PARAMS);
    first.onTick(makeTick('70600', 1), context, PARAMS);

    const saved = JSON.parse(JSON.stringify(first.snapshot())) as unknown;
    const restarted = createGrid();

    restarted.onStart(saved as GridState, context, PARAMS);

    // The tick after a restart decides exactly as it would have without one.
    expect(
      restarted.onTick(makeTick('71100', 2), context, PARAMS),
    ).toStrictEqual([order('SELL', '10', 'grid-sell')]);
    expect(first.onTick(makeTick('71100', 2), context, PARAMS)).toStrictEqual([
      order('SELL', '10', 'grid-sell'),
    ]);
  });

  it('refuses to snapshot before it has any state', () => {
    expect(() => createGrid().snapshot()).toThrow(DomainError);
  });
});
