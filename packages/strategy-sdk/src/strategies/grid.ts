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
  priceParameter,
  quantityParameter,
  type Strategy,
  type StrategyContext,
  type StrategyDecision,
  type StrategyPosition,
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
 * A grid on one instrument: buy a lot each time the price falls through a
 * level, sell it again when the price rises through the level above it.
 *
 * ## The grid is a step and a count, never a range divided up
 *
 * The obvious parameterisation — a lower bound, an upper bound and a number of
 * levels — is a division, and a division is where exactness goes. `(upper −
 * lower) / (levels − 1)` has no exact value for most of the ranges an operator
 * would actually write, so a grid built that way either rounds each level and
 * drifts, or accumulates `previous + step` and drifts differently. The drift is
 * not academic: a level is a *comparison boundary*, and a boundary that is a
 * hair off is a boundary the price lands on the wrong side of.
 *
 * So the operator writes the **step**, and the band is derived:
 * `level(i) = lowerPrice + step × i`, for `i` in `0 … levels − 1`. Every level
 * is one exact multiplication and one exact addition over `moneyDecimal`, taken
 * from the two configured values rather than from the level before it, so no
 * level's error can be another level's input. **There is no division in this
 * strategy, and therefore no rounding mode to configure** — the same discipline,
 * and for the same reason, as `sma-crossover`'s cross-multiplication.
 *
 * `grid.test.ts` pins the case that shows why, and it is worse than "floats are
 * imprecise". For `lowerPrice = 0.1`, `step = 0.2`, five levels, this strategy
 * answers `0.1 0.3 0.5 0.7 0.9`. In float64 the two obvious formulations of the
 * same configuration disagree with each other and with that:
 * `lower + step × i` gives `… 0.7000000000000001 0.9`, and `previous + step`
 * gives `… 0.7 0.8999999999999999`. A tick at exactly `0.7` is *at* the fourth
 * level here and *below* it under the first float grid — one rung lower, on the
 * far side of the boundary that decides whether a lot is bought.
 *
 * ## Rungs, slots, and why the hysteresis is two rungs deep
 *
 * The **rung** of a price is how many levels are at or below it, so it runs
 * `0 … levels`: rung 0 is below the whole band, rung `levels` is above it, and
 * rung `r` in between means the price sits in `[level(r−1), level(r))`. A price
 * outside the band is therefore clamped by the rung function itself — there is
 * no separate band check, and nothing is traded past the ends.
 *
 * A **slot** `k` is one lot, bought at `level(k)` and sold at `level(k + 1)`.
 * Slots run `0 … levels − 2`: the bottom level is buy-only and the top level is
 * sell-only, because a lot in slot `levels − 1` would have to be sold at a level
 * that does not exist.
 *
 * The price falling into rung `k` is the price crossing `level(k)` downwards, so
 * that is when slot `k` is bought. The price rising into rung `k + 2` is the
 * price crossing `level(k + 1)` upwards, so that is when slot `k` is sold. That
 * two-rung distance is the whole point and it is easy to get wrong: a grid that
 * sold slot `k` on re-entering rung `k + 1` would be selling at the same level
 * it bought at, and a round trip would earn exactly nothing. Here a round trip
 * earns one `step` per lot, gross of fees and slippage.
 *
 * A tick that jumps several rungs is one order for the aggregate quantity —
 * `quantity × slots`, an exact multiplication — rather than one order per slot.
 * The runner evaluates every decision from a tick against **one** portfolio
 * snapshot, so a second order on the same tick would be sized against a
 * position that the first has already changed; and the ledger charges one
 * commission per order rather than per slot. At most one order per tick, and
 * never both sides, since a rung cannot rise and fall at once.
 *
 * ## It places MARKET orders, and what that costs
 *
 * A real grid rests limit orders at every level. This one cannot: a strategy
 * sees `now`, `position` and `window` and **not** its own open orders, so it has
 * no way to know which of its resting orders are still there — and a strategy
 * that guessed would accumulate phantom orders until `maxOpenOrders` refused
 * everything. Extending `StrategyContext` to show open orders is a change to the
 * phase-A contract and is deliberately not made here.
 *
 * So this is a *crossing* grid: it trades at market on the tick that crosses a
 * level. The consequence is stated rather than hidden — the realised price is
 * the tick's price, not the level's, so a tick that jumps past a level takes the
 * whole overshoot out of the step the round trip was supposed to earn. A grid
 * whose `step` is small relative to how far the price moves between ticks is a
 * grid that loses money on fees and slippage, and the backtest harness
 * (`apps/strategy-runner/src/backtest`) exists to show that before a run does.
 *
 * ## The lot set is a belief, and the ledger corrects it
 *
 * `lots` records which slots the strategy thinks it is holding. It has to be a
 * strategy-local fact: the ledger knows the *total* quantity held, not which
 * grid slot each lot belongs to, so this is not a second copy of something the
 * ledger owns — it is the only copy of something the ledger never knew.
 *
 * It is recorded when the *decision* is taken, not when a fill arrives, because
 * a strategy that waited for a fill would re-buy the same slot on every tick
 * until one landed. The cost is that a buy the risk gate refuses, or one the
 * ledger rejects, leaves a slot recorded that nothing backs. That is a real
 * divergence and it is repaired rather than tolerated: when a slot is due to be
 * sold, the sell is sized from `position.available`, and if the ledger has
 * nothing to sell the lots are simply **dropped** (`unbacked-lots-dropped`).
 * The ledger is the original of what is held (design §7.3); when the two
 * disagree, this is the side that changes.
 *
 * Note what a slot is and is not. Shares are fungible, so releasing slot `k`
 * sells `quantity` of the position and not some particular shares that slot
 * owns — the slot decides *when* to trade, never *which* shares. That is why a
 * partially backed grid can still exit cleanly, and why the average cost the
 * ledger reports is the only cost basis there is.
 *
 * ## A gap re-baselines without claiming crossings
 *
 * Quote frames are not replayed (design §5.3), so the runner does not know what
 * the price did while it was not watching. A `gapBefore` tick therefore records
 * the new rung and trades nothing: the crossings between the old rung and the
 * new one were not observed, and inventing them would buy or sell a run of
 * levels the strategy never saw the price pass.
 *
 * The lots are **kept** across a gap, unlike `sma-crossover`'s window, and the
 * asymmetry is deliberate: that window is an *observation* of prices that are no
 * longer consecutive, while a lot is a position the ledger is still holding.
 * Discarding it would forget an exposure rather than forget a measurement.
 *
 * ## What it does not do
 *
 * It has no `onFill`, for the reason `sma-crossover` gives: the ledger owns the
 * position and the strategy reads it through `context.position`.
 *
 * It never shorts. A `SELL` is always an exit of a lot it believes it holds, and
 * it is capped at what the ledger says is available, because the paper ledger
 * reserves sold quantity from the position and refuses the rest with
 * `INSUFFICIENT_AVAILABLE_POSITION`.
 *
 * **Its sells are not capped by the runner's risk gate**, and an operator should
 * know that before configuring one. `RiskGate` returns early for any non-`BUY`
 * intent and `dailyEntryNotional` counts entries only — deliberately, because a
 * limit that refuses an exit traps exposure rather than capping it. A grid emits
 * both sides continuously, so it is the only strategy so far for which "the gate
 * saw it" means "the gate saw the buys". The bound on the sell side is this
 * strategy's own: it sells only slots it recorded, at most `quantity` each, and
 * only what `position.available` backs.
 */

export const GRID_ID = 'grid';

/** The most levels an operator may configure, matching `sma-crossover`'s cap. */
const MAX_LEVELS = 512;

export interface GridParams {
  readonly market: Market;
  readonly symbol: string;
  /** `level(0)`. Every other level is derived from this and `step`. */
  readonly lowerPrice: DecimalString;
  /** The exact spacing between adjacent levels. Never divided out of a range. */
  readonly step: DecimalString;
  readonly levels: number;
  /** How much one slot holds. A full grid holds `quantity × (levels − 1)`. */
  readonly quantity: Quantity;
}

/**
 * Both refinements are the reason the runtime path has no domain check of its
 * own: the widest level and the largest order a full grid can ever produce are
 * decided here, at configuration time, where a refusal is a message an operator
 * reads rather than a `noop` buried in a decision log.
 */
export const gridParameterSchema: ParameterSchema<GridParams> =
  defineParameterSchema(
    {
      market: enumParameter(['KR', 'US']),
      symbol: symbolParameter(),
      lowerPrice: priceParameter(),
      step: priceParameter(),
      levels: integerParameter({ min: 2, max: MAX_LEVELS }),
      quantity: quantityParameter(),
    },
    (params) => {
      assertExactMoney(
        moneyDecimal(params.lowerPrice).plus(
          moneyDecimal(params.step).times(params.levels - 1),
        ),
        `a grid of ${params.levels} levels of ${params.step} from ${params.lowerPrice}`,
        'INVALID_PRICE',
      );
      assertExactMoney(
        moneyDecimal(params.quantity).times(params.levels - 1),
        `a full grid of ${params.levels - 1} lots of ${params.quantity}`,
        'INVALID_ORDER',
      );
    },
  );

/**
 * The persisted grid. `market` and `symbol` are recorded so a reconfiguration
 * is detectable — a rung and a lot set mean nothing for a different instrument.
 */
export type GridState = {
  readonly market: Market;
  readonly symbol: string;
  /** The rung of the last tick seen, or `null` before the first one. */
  readonly rung: number | null;
  /** Slots believed held, ascending and without duplicates. */
  readonly lots: readonly number[];
};

/** Every reason this strategy can give. The decision table pins all of them. */
export type GridReason =
  | 'other-instrument'
  | 'gap-reset'
  | 'priming'
  | 'inside-cell'
  | 'no-slot-to-fill'
  | 'no-lot-to-sell'
  | 'unbacked-lots-dropped'
  | 'grid-buy'
  | 'grid-sell'
  | 'grid-sell-partial';

export interface GridAdvance {
  readonly state: GridState;
  readonly decisions: readonly StrategyDecision[];
}

const freezeState = (
  params: GridParams,
  rung: number | null,
  lots: readonly number[],
): GridState =>
  Object.freeze({
    market: params.market,
    symbol: params.symbol,
    rung,
    lots: Object.freeze([...lots].sort(ascending)),
  });

const ascending = (left: number, right: number): number => left - right;

export const initialGridState = (params: GridParams): GridState =>
  freezeState(params, null, []);

/**
 * The levels, lowest first. Derived from `lowerPrice` and `step` on every call
 * rather than cached, so there is no second representation of the band to keep
 * in agreement with the parameters — the same judgement `sma-crossover` makes
 * about not storing a running sum. It is `levels` multiplications per tick, at a
 * tick rate of at most one per second.
 */
export function gridLevels(params: GridParams): readonly DecimalString[] {
  const lower = moneyDecimal(params.lowerPrice);
  const step = moneyDecimal(params.step);

  return Object.freeze(
    Array.from({ length: params.levels }, (_, index) =>
      assertExactMoney(
        lower.plus(step.times(index)),
        `grid level ${index}`,
        'INVALID_PRICE',
      ).toString(),
    ),
  );
}

/**
 * How many levels are at or below `price`: `0` below the band, `levels` above
 * it. Clamping is a property of the count rather than a separate check, which
 * is why there is no "outside the band" branch anywhere below.
 */
function rungOf(
  price: DecimalString,
  levels: readonly DecimalString[],
): number {
  const value = moneyDecimal(price);

  return levels.filter((level) => value.gte(level)).length;
}

/** The highest slot a lot may occupy: the top level is sell-only. */
const topSlotOf = (params: GridParams): number => params.levels - 2;

const smaller = (left: number, right: number): number =>
  left < right ? left : right;

/** The integers `from … to`, or nothing when the range is empty. */
const through = (from: number, to: number): readonly number[] =>
  to < from ? [] : Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * `quantity × count`, exactly. It cannot leave the money domain — the schema's
 * refinement already refused a configuration whose *full* grid would, and no
 * order is larger than that — so the assertion states the invariant rather than
 * handling a case.
 */
const lotQuantity = (params: GridParams, count: number): Quantity =>
  assertExactMoney(
    moneyDecimal(params.quantity).times(count),
    'grid order quantity',
  ).toString();

/**
 * The ledger's view of what is held, validated. A quantity that is not a plain
 * whole number cannot be reasoned about, and must not be forwarded to the
 * ledger as an order size.
 */
const readPosition = (
  context: StrategyContext,
  params: GridParams,
): StrategyPosition | null => {
  const position = context.position({
    market: params.market,
    symbol: params.symbol,
  });

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

  return position;
};

const standStill = (state: GridState, reason: GridReason): GridAdvance =>
  Object.freeze({
    state,
    decisions: Object.freeze([
      Object.freeze({ kind: 'noop' as const, reason }),
    ]),
  });

const place = (
  state: GridState,
  intent: OrderIntent,
  reason: GridReason,
): GridAdvance =>
  Object.freeze({
    state,
    decisions: Object.freeze([
      Object.freeze({ kind: 'place' as const, intent, reason }),
    ]),
  });

const marketOrder = (
  params: GridParams,
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
 * The whole decision, as a function of the recorded grid, the tick, and what the
 * context answers. No clock, no randomness, no I/O, no hidden state — which is
 * what makes the decision table a complete statement of the behaviour, and what
 * lets the backtester (design §8.2) replay a recorded series and get the same
 * decisions the runner got.
 */
export function advanceGrid(
  state: GridState,
  tick: Tick,
  context: StrategyContext,
  params: GridParams,
): GridAdvance {
  if (tick.market !== params.market || tick.symbol !== params.symbol) {
    return standStill(state, 'other-instrument');
  }

  assertPositivePrice(tick.price, 'price');

  const rung = rungOf(tick.price, gridLevels(params));

  // The crossings between the old rung and this one were never observed, so
  // none of them are claimed. The lots stay: the ledger is still holding them.
  if (tick.gapBefore) {
    return standStill(freezeState(params, rung, state.lots), 'gap-reset');
  }

  const previous = state.rung;

  if (previous === null) {
    return standStill(freezeState(params, rung, state.lots), 'priming');
  }

  if (rung === previous) {
    return standStill(freezeState(params, rung, state.lots), 'inside-cell');
  }

  return rung < previous
    ? fall(state, rung, previous, params)
    : rise(state, rung, previous, context, params);
}

/** Entering rung `k` on the way down buys slot `k`. */
function fall(
  state: GridState,
  rung: number,
  previous: number,
  params: GridParams,
): GridAdvance {
  const held = new Set(state.lots);
  const wanted = through(rung, smaller(previous - 1, topSlotOf(params))).filter(
    (slot) => !held.has(slot),
  );

  if (wanted.length === 0) {
    return standStill(freezeState(params, rung, state.lots), 'no-slot-to-fill');
  }

  return place(
    freezeState(params, rung, [...state.lots, ...wanted]),
    marketOrder(params, 'BUY', lotQuantity(params, wanted.length)),
    'grid-buy',
  );
}

/**
 * Entering rung `m` on the way up sells slot `m − 2` — the lot bought at
 * `level(m − 2)`, whose paired sell sits at `level(m − 1)`, the level this tick
 * has just crossed.
 */
function rise(
  state: GridState,
  rung: number,
  previous: number,
  context: StrategyContext,
  params: GridParams,
): GridAdvance {
  const due = state.lots.filter(
    (slot) => slot >= previous - 1 && slot <= rung - 2,
  );

  if (due.length === 0) {
    return standStill(freezeState(params, rung, state.lots), 'no-lot-to-sell');
  }

  const released = new Set(due);
  // The lots go whatever the ledger says, because whatever it says is the truth
  // about them: either they are being sold now, or they were never there.
  const next = freezeState(
    params,
    rung,
    state.lots.filter((slot) => !released.has(slot)),
  );
  const position = readPosition(context, params);
  // `'0'` is the only zero a non-negative whole quantity can spell, so a string
  // comparison is a complete emptiness test here.
  const available = position === null ? '0' : position.available;

  if (available === '0') {
    return standStill(next, 'unbacked-lots-dropped');
  }

  const wanted = lotQuantity(params, due.length);
  const short = moneyDecimal(available).lt(wanted);

  return place(
    next,
    marketOrder(params, 'SELL', short ? available : wanted),
    short ? 'grid-sell-partial' : 'grid-sell',
  );
}

function corrupt(message: string): never {
  throw new DomainError('INVALID_ORDER', `grid state ${message}`);
}

const isWholeNumberAtLeast = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least;

/**
 * Reads a grid back from the state store. This is a *file*, so it is validated
 * like any other untrusted input, and the same three-way split `sma-crossover`
 * uses applies:
 *
 * - state recorded for a **different instrument** is discarded. The operator
 *   repointed the strategy; a rung and a lot set are not this instrument's.
 * - a rung or a slot the **reconfigured** grid no longer has is clamped or
 *   dropped. Narrowing a grid is a reconfiguration, and the lots that survive
 *   are the ones the new band can still sell.
 * - everything else — a state that is not an object, a rung that is not a whole
 *   number, a lot list that is not a list of them — is corruption, and fails
 *   closed (AGENTS.md rule 6) rather than being repaired into a grid that would
 *   then drive real orders.
 *
 * Dropping a lot is not free and the log should say so: it forgets that the
 * ledger is holding that quantity, and nothing in this strategy will sell it
 * again. That is the honest outcome — the slot it belonged to no longer exists —
 * and it is why narrowing a live grid is an operator action, not a hot reload.
 */
export function readGridState(saved: unknown, params: GridParams): GridState {
  assertCommandObject(saved, 'grid state');

  const { market, symbol, rung, lots } = saved;

  assertMember(market, MARKETS, 'market');
  assertIdentifier(symbol, 'symbol');

  if (rung !== null && !isWholeNumberAtLeast(rung, 0)) {
    corrupt('rung must be a non-negative whole number, or null');
  }

  if (!Array.isArray(lots)) {
    corrupt('lots must be an array');
  }

  for (const slot of lots as readonly unknown[]) {
    if (!isWholeNumberAtLeast(slot, 0)) {
      corrupt('every lot must be a non-negative whole number');
    }
  }

  if (market !== params.market || symbol !== params.symbol) {
    return initialGridState(params);
  }

  const topSlot = topSlotOf(params);

  return freezeState(
    params,
    rung === null ? null : smaller(rung, params.levels),
    [...new Set(lots as readonly number[])].filter((slot) => slot <= topSlot),
  );
}

export interface GridStrategy extends Strategy<GridParams> {
  onStart(
    state: StrategyState,
    context: StrategyContext,
    params: GridParams,
  ): void;
  snapshot(): GridState;
}

/**
 * A strategy instance: a thin stateful shell whose only job is to hold the
 * latest grid and hand it to `advanceGrid`. Every decision is made by that pure
 * function, so the shell has nothing to get wrong and two instances share
 * nothing.
 */
export function createGrid(): GridStrategy {
  let state: GridState | null = null;

  return {
    id: GRID_ID,
    parameterSchema: gridParameterSchema,
    subscriptions: (params) =>
      Object.freeze([
        Object.freeze({ market: params.market, symbol: params.symbol }),
      ]),
    onStart: (saved, _context, params) => {
      state = readGridState(saved, params);
    },
    onTick: (tick, context, params) => {
      const advanced = advanceGrid(
        state ?? initialGridState(params),
        tick,
        context,
        params,
      );

      state = advanced.state;

      return advanced.decisions;
    },
    // The runner calls `onStart` with the stored state — or not at all, when
    // there is none — before the first tick, so there is always a grid to save
    // by the time anything asks. Reaching this without either is a runner bug,
    // and saying so is better than inventing an empty grid whose instrument
    // nobody declared.
    snapshot: () => {
      if (state === null) {
        throw new DomainError(
          'INVARIANT_VIOLATION',
          'grid has no state to snapshot: onStart or onTick must run first',
        );
      }

      return state;
    },
  };
}
