import {
  assertExactMoney,
  type DecimalString,
  DomainError,
  type Market,
  moneyDecimal,
  type Quantity,
} from '@moi/trading-core';

import {
  defineParameterSchema,
  enumParameter,
  integerParameter,
  type OrderIntent,
  type ParameterSchema,
  quantityParameter,
  type Strategy,
  type StrategyContext,
  type StrategyDecision,
  type StrategyState,
  symbolParameter,
  type Tick,
} from '../strategy.js';
import {
  assertCommandObject,
  assertIdentifier,
  assertMember,
  assertPositivePrice,
  isNonNegativeWholeQuantity,
  MARKETS,
} from '../validation.js';

/**
 * A two-average crossover on one instrument: go long when the fast average
 * crosses above the slow one, close when it crosses back below.
 *
 * ## The averages are compared, never computed
 *
 * An average is a division, and a division is where exactness goes. Three
 * prices summing to `10` have no exact mean, so any implementation that divides
 * has to choose a rounding — and then the entry signal depends on that choice,
 * at exactly the moment the two averages are close, which is the only moment
 * the signal is decided.
 *
 * So this strategy never divides. Comparing `sumFast / fastPeriod` against
 * `sumSlow / slowPeriod` is the same question as comparing
 * `sumFast · slowPeriod` against `sumSlow · fastPeriod`, and the periods are
 * positive integers, so that second comparison is exact addition and
 * multiplication over `moneyDecimal` and nothing else. **There is no rounding
 * in this strategy, and therefore no rounding mode to configure.**
 *
 * What that buys is not theoretical. `sma-crossover.test.ts` pins a series where
 * the two averages differ by one part in 10^20: float64 calls it a tie and
 * suppresses the entry, and the exact comparison sees the cross. The mid-price
 * rounding the design's §5.2 does specify is the *runner's* — it decides what a
 * tick's price is — and by the time a price reaches here it is a fixed exact
 * decimal.
 *
 * The averages themselves are therefore not exposed, and not in `snapshot()`.
 * A report that wants to show one has to pick a rounding to display it, and
 * that is the reporting layer's choice to make and to state, not a number this
 * strategy can hand over as if it were exact.
 *
 * ## The window is the whole of the state
 *
 * State is a ring of the newest `slowPeriod + 1` prices and nothing else. Both
 * relations — this tick's and the previous tick's — are recomputed from that
 * ring on every tick, which is why the previous relation is not stored: a value
 * derived from the window is a second copy of the window's meaning, and a
 * second copy is a thing that can disagree with the first after a restart.
 *
 * A running sum was rejected for the same reason rather than for exactness —
 * decimal addition and subtraction are exact in both designs, so a running sum
 * would not drift. It would be a second representation of the same fact that
 * has to be kept in agreement with the ring across `snapshot()` and `onStart`,
 * and it would buy `slowPeriod` decimal additions per tick at a tick rate of at
 * most one per second. If that ever matters, an incremental sum can be added
 * without touching the state shape, because the shape stores the ring rather
 * than any sum.
 *
 * Consequently `snapshot()` → `onStart` restores the window *exactly*: the same
 * strings, in the same order, so the tick after a restart decides identically
 * to the tick that would have followed without one.
 *
 * ## A gap discards the window
 *
 * Quote frames are not replayed (design §5.3), so the prices either side of a
 * market-data gap are not consecutive observations and an average spanning one
 * is an average over a discontinuity — which shows up as a cross that the market
 * never made. Design §5.3 asks an indicator to hold off entering for N ticks
 * after a gap; this strategy discards the window instead, which makes
 * N = `slowPeriod + 1` — derived from the parameters rather than configured as a
 * number nobody can justify — and means no decision is ever taken from prices
 * that straddle a gap, rather than merely no entry.
 *
 * ## What it does not do
 *
 * It places `MARKET` orders only, so there is no resting order to manage and it
 * never returns a `cancel` decision. A limit entry needs cancel/replace over a
 * live order lifecycle, which is the runner's phase C, not the strategy's.
 *
 * It has no `onFill`. The ledger owns the position and the strategy reads it
 * through `context.position` — a strategy that accumulates its own copy from
 * fills is keeping the second, drifting copy that design §6.4 exists to
 * prevent.
 *
 * Short entries are not modelled: the paper ledger reserves position quantity
 * from what is held (`reservePosition`), so a `SELL` with nothing held is
 * refused with `INSUFFICIENT_AVAILABLE_POSITION`. A dead cross with no position
 * is therefore a `noop`, not a short.
 */

export const SMA_CROSSOVER_ID = 'sma-crossover';

/** The longest window an operator may configure. */
const MAX_PERIOD = 512;

export interface SmaCrossoverParams {
  readonly market: Market;
  readonly symbol: string;
  readonly fastPeriod: number;
  readonly slowPeriod: number;
  /** How much to buy on an entry. An exit sells what is actually held. */
  readonly quantity: Quantity;
}

export const smaCrossoverParameterSchema: ParameterSchema<SmaCrossoverParams> =
  defineParameterSchema(
    {
      market: enumParameter(['KR', 'US']),
      symbol: symbolParameter(),
      fastPeriod: integerParameter({ min: 1, max: MAX_PERIOD }),
      slowPeriod: integerParameter({ min: 2, max: MAX_PERIOD }),
      quantity: quantityParameter(),
    },
    (params) => {
      if (params.fastPeriod >= params.slowPeriod) {
        throw new DomainError(
          'INVALID_ORDER',
          `fastPeriod must be shorter than slowPeriod, got ${params.fastPeriod} and ${params.slowPeriod}`,
        );
      }
    },
  );

/**
 * The persisted window. `market` and `symbol` are recorded so a reconfiguration
 * is detectable: prices for one instrument are not history for another, and
 * silently averaging them would cross on a series that never existed.
 */
export type SmaCrossoverState = {
  readonly market: Market;
  readonly symbol: string;
  /** Oldest first, newest last. At most `slowPeriod + 1` entries. */
  readonly prices: readonly DecimalString[];
};

/** Every reason this strategy can give. The decision table pins all of them. */
export type SmaCrossoverReason =
  | 'other-instrument'
  | 'gap-reset'
  | 'warming-up'
  | 'tie'
  | 'unconfirmed-cross'
  | 'no-cross'
  | 'golden-cross'
  | 'golden-cross-already-long'
  | 'dead-cross'
  | 'dead-cross-no-sellable-quantity'
  | 'dead-cross-no-position';

export interface SmaCrossoverAdvance {
  readonly state: SmaCrossoverState;
  readonly decisions: readonly StrategyDecision[];
}

/** `above` means the fast average is above the slow one. */
type Relation = 'below' | 'equal' | 'above';

const freezeState = (
  params: SmaCrossoverParams,
  prices: readonly DecimalString[],
): SmaCrossoverState =>
  Object.freeze({
    market: params.market,
    symbol: params.symbol,
    prices: Object.freeze(prices.slice()),
  });

export const initialSmaCrossoverState = (
  params: SmaCrossoverParams,
): SmaCrossoverState => freezeState(params, []);

const sumOf = (prices: readonly DecimalString[]) =>
  prices.reduce(
    (sum, price) =>
      assertExactMoney(sum.plus(price), 'sma window sum', 'INVALID_PRICE'),
    moneyDecimal(0),
  );

/**
 * Which side of the slow average the fast one is on, decided by
 * cross-multiplication so no division and no rounding is involved.
 * `prices` must hold at least `slowPeriod` entries.
 */
const relationOf = (
  prices: readonly DecimalString[],
  params: SmaCrossoverParams,
): Relation => {
  const difference = assertExactMoney(
    sumOf(prices.slice(-params.fastPeriod))
      .times(params.slowPeriod)
      .minus(sumOf(prices.slice(-params.slowPeriod)).times(params.fastPeriod)),
    'sma crossover comparison',
    'INVALID_PRICE',
  );

  if (difference.isZero()) {
    return 'equal';
  }

  return difference.gt(0) ? 'above' : 'below';
};

const standStill = (
  state: SmaCrossoverState,
  reason: SmaCrossoverReason,
): SmaCrossoverAdvance =>
  Object.freeze({
    state,
    decisions: Object.freeze([
      Object.freeze({ kind: 'noop' as const, reason }),
    ]),
  });

const place = (
  state: SmaCrossoverState,
  intent: OrderIntent,
  reason: SmaCrossoverReason,
): SmaCrossoverAdvance =>
  Object.freeze({
    state,
    decisions: Object.freeze([
      Object.freeze({ kind: 'place' as const, intent, reason }),
    ]),
  });

const marketOrder = (
  params: SmaCrossoverParams,
  side: 'BUY' | 'SELL',
  quantity: Quantity,
): OrderIntent =>
  Object.freeze({
    market: params.market,
    symbol: params.symbol,
    side,
    type: 'MARKET' as const,
    quantity,
  });

/**
 * The whole decision, as a function of the window, the tick, and what the
 * context answers. No clock, no randomness, no I/O, no hidden state — which is
 * what makes the decision table a complete statement of the behaviour, and what
 * lets the backtester (design §8.2) replay a recorded series and get the same
 * decisions the runner got.
 */
export function advanceSmaCrossover(
  state: SmaCrossoverState,
  tick: Tick,
  context: StrategyContext,
  params: SmaCrossoverParams,
): SmaCrossoverAdvance {
  if (tick.market !== params.market || tick.symbol !== params.symbol) {
    return standStill(state, 'other-instrument');
  }

  assertPositivePrice(tick.price, 'price');

  const windowSize = params.slowPeriod + 1;
  // A gap makes the earlier prices non-consecutive with this one, so they are
  // discarded rather than averaged across.
  const kept = tick.gapBefore ? [] : state.prices;
  // `slice(-slowPeriod)` rather than an arithmetic clamp: `slowPeriod` is at
  // least 2, so the negative index is never `-0`, and a window shorter than the
  // ring is kept whole — which is exactly the warming-up case.
  const next = freezeState(params, [
    ...kept.slice(-params.slowPeriod),
    tick.price,
  ]);

  if (tick.gapBefore) {
    return standStill(next, 'gap-reset');
  }

  if (next.prices.length < windowSize) {
    return standStill(next, 'warming-up');
  }

  const current = relationOf(next.prices, params);
  const previous = relationOf(next.prices.slice(0, -1), params);

  // A cross is confirmed only between two *strict* relations. An exact tie on
  // either side suppresses the signal instead: `above → equal → above` is not a
  // crossing, and treating the second step as one would enter a position the
  // averages never justified. Missing the rare genuine `below → equal → above`
  // is the conservative side of that trade, and an exact tie between two
  // 80-digit sums is not a thing real prices do.
  if (current === 'equal') {
    return standStill(next, 'tie');
  }

  if (previous === 'equal') {
    return standStill(next, 'unconfirmed-cross');
  }

  if (previous === current) {
    return standStill(next, 'no-cross');
  }

  const position = context.position({
    market: params.market,
    symbol: params.symbol,
  });

  // A quantity that is not a plain whole number cannot be reasoned about, and
  // must not be forwarded to the ledger as an order size.
  if (
    position !== null &&
    (!isNonNegativeWholeQuantity(position.total) ||
      !isNonNegativeWholeQuantity(position.available))
  ) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'position quantities must be non-negative whole numbers in plain decimal form',
    );
  }

  // `'0'` is the only zero a non-negative whole quantity can spell, so a string
  // comparison is a complete emptiness test here.
  const held = position !== null && position.total !== '0';

  if (current === 'above') {
    return held
      ? standStill(next, 'golden-cross-already-long')
      : place(
          next,
          marketOrder(params, 'BUY', params.quantity),
          'golden-cross',
        );
  }

  if (position === null || !held) {
    return standStill(next, 'dead-cross-no-position');
  }

  if (position.available === '0') {
    return standStill(next, 'dead-cross-no-sellable-quantity');
  }

  // Exit the whole sellable position rather than `params.quantity`: a dead cross
  // is "get out", one instrument is traded by exactly one strategy (design
  // §6.3), and a partially filled entry leaves less held than was ordered.
  return place(
    next,
    marketOrder(params, 'SELL', position.available),
    'dead-cross',
  );
}

/**
 * Reads a window back from the state store. This is a *file*, so it is
 * validated like any other untrusted input, and two of its failure modes are
 * deliberately not failures:
 *
 * - a window recorded for a different instrument is **discarded**. The operator
 *   repointed the strategy; that is a reconfiguration, not corruption, and the
 *   old prices are simply not this strategy's history.
 * - a window of a different length is **truncated to the newest**
 *   `slowPeriod + 1`. A longer one is history the operator kept; a shorter one
 *   just resumes warming up.
 *
 * Everything else — a state that is not an object, a price list that is not a
 * list, a price that is not exact money — is corruption, and fails closed
 * (AGENTS.md rule 6) rather than being silently repaired into a window that
 * would then drive real orders.
 */
export function readSmaCrossoverState(
  saved: unknown,
  params: SmaCrossoverParams,
): SmaCrossoverState {
  assertCommandObject(saved, 'sma-crossover state');

  const { market, symbol, prices } = saved;

  assertMember(market, MARKETS, 'market');
  assertIdentifier(symbol, 'symbol');

  if (!Array.isArray(prices)) {
    throw new DomainError(
      'INVALID_ORDER',
      'sma-crossover state prices must be an array',
    );
  }

  const restored: DecimalString[] = prices.map((price: unknown) => {
    assertPositivePrice(price, 'price');

    return price;
  });

  if (market !== params.market || symbol !== params.symbol) {
    return initialSmaCrossoverState(params);
  }

  return freezeState(params, restored.slice(-(params.slowPeriod + 1)));
}

export interface SmaCrossoverStrategy extends Strategy<SmaCrossoverParams> {
  onStart(
    state: StrategyState,
    context: StrategyContext,
    params: SmaCrossoverParams,
  ): void;
  snapshot(): SmaCrossoverState;
}

/**
 * A strategy instance: a thin stateful shell whose only job is to hold the
 * latest window and hand it to `advanceSmaCrossover`. Every decision is made by
 * that pure function, so the shell has nothing to get wrong and two instances
 * share nothing.
 */
export function createSmaCrossover(): SmaCrossoverStrategy {
  let state: SmaCrossoverState | null = null;

  return {
    id: SMA_CROSSOVER_ID,
    parameterSchema: smaCrossoverParameterSchema,
    subscriptions: (params) =>
      Object.freeze([
        Object.freeze({ market: params.market, symbol: params.symbol }),
      ]),
    onStart: (saved, _context, params) => {
      state = readSmaCrossoverState(saved, params);
    },
    onTick: (tick, context, params) => {
      const advanced = advanceSmaCrossover(
        state ?? initialSmaCrossoverState(params),
        tick,
        context,
        params,
      );

      state = advanced.state;

      return advanced.decisions;
    },
    // The runner calls `onStart` — with the stored state, or with an empty one —
    // before the first tick, so there is always a window to save by the time
    // anything asks. Reaching this without either is a runner bug, and saying so
    // is better than inventing an empty window whose instrument nobody declared.
    snapshot: () => {
      if (state === null) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'sma-crossover has no state to snapshot: onStart or onTick must run first',
        );
      }

      return state;
    },
  };
}
