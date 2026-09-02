import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerWallet,
} from '@moi/strategy-sdk';
import type { OrderIntent, Tick } from '@moi/strategy-sdk/strategy';
import {
  applyFillToPosition,
  assertExactMoney,
  type Currency,
  calculateAverageCost,
  createFeeModel,
  type DecimalString,
  DomainError,
  type FeeModel,
  type FeeScheduleConfig,
  type Market,
  type Money,
  moneyDecimal,
  type OrderType,
  type PositionCost,
  type Quantity,
  type Side,
} from '@moi/trading-core';

/**
 * The fill model of design §8.2: *"a limit fills when the price reaches it, a
 * market fills at the opposite touch."* Plus the parts §8.2 leaves implied and
 * a backtest is worthless without — cash, position, fees and resting orders —
 * because a report that says a strategy made money without saying whether it
 * had the money to do it is not a report.
 *
 * This is **not** a second ledger and it must not become one. It is the
 * smallest thing that can answer "what would this strategy have done", and
 * every simplification below is a place its answer is knowably different from
 * the real one.
 *
 * ## What is simulated, and how
 *
 * | | |
 * |---|---|
 * | `MARKET` | fills on the tick, at `bestAsk` (buy) or `bestBid` (sell), falling back to `tick.price` when the payload carried no book |
 * | `LIMIT` | fills when the opposite touch has reached the limit, **at the limit** |
 * | `STOP`, `TAKE_PROFIT`, `OCO` | **refused**, not ignored |
 *
 * Refusing the trigger types rather than letting them rest for ever is the
 * important one. An order that silently never fills reports a strategy whose
 * protective exit did nothing as a strategy that never needed one, which is the
 * single most dangerous thing a backtest can say.
 *
 * A marketable limit fills at its own limit price rather than at the better
 * touch. A snapshot says what the touch was, not how much of it there was, so
 * price improvement here would be a number the harness invented; taking the
 * limit is the side of that which understates a buy's edge rather than
 * overstating it.
 *
 * ## What is knowably wrong
 *
 * **No depth, so no partial fills.** A resting order fills whole or not at all,
 * at one price. Real depth would fill a large order across levels and worse;
 * this harness will tell you a size is free that a real book would charge for.
 *
 * **No queue.** A limit resting at the touch fills the instant the touch
 * reaches it, where a real book would put it behind everything already there.
 * A strategy that lives on being filled at the touch will look better here than
 * it is.
 *
 * **Fees are configured, not the ledger's.** Design §1 row 13: there is no
 * public fee endpoint, so the schedule comes from the backtest plan and can
 * simply be wrong. §8.3 requires the report to say so, and it does.
 *
 * **Cash is reserved at what the fill will cost, fee included.** A resting buy
 * holds `limitPrice × quantity` *plus* the commission that fill will charge.
 * That is exact rather than conservative: a resting limit fills at its own
 * limit price, for its own quantity, in its own market, so the fee is fully
 * determined the moment the order is accepted — it is the same `notional + fee`
 * the immediate-fill path checks, so one rule covers both. Reserving the
 * notional alone was a real defect, found by a reviewer who ran the code: the
 * fill paid a fee nothing had been held for and the wallet went to `-690` with
 * no refusal and no flag. The real ledger's reservation is its own business and
 * this does not claim to mirror it — this one exists so that two resting buys
 * cannot both spend the same money, and so that an accepted order is one the
 * account can actually pay for.
 *
 * **A wallet never goes negative.** The reservation above makes that true by
 * construction, and `#settle` asserts it anyway, because an invariant that
 * holds only by construction is one a later change can quietly break. A
 * settlement that would take a balance below zero fails closed (AGENTS.md rule
 * 6): an aborted replay is a message, where a negative wallet is a report
 * nobody can tell is wrong.
 */

export const BACKTEST_SESSION_ID = 'backtest';

/**
 * Indexed off the published `BrokerPortfolio` rather than imported: the SDK
 * does not export `BrokerPortfolioOrder` on its main entry, and `risk-gate.ts`
 * already takes the same route for the same reason.
 */
type PortfolioOrder = BrokerPortfolio['activeOrders'][number];

export interface SimulatedFill {
  readonly orderId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly price: DecimalString;
  readonly quantity: Quantity;
  readonly fee: DecimalString;
  readonly currency: Currency;
  /**
   * What this fill realised: `0` for a buy, and for a sell the change in the
   * position's realised PnL that `applyFillToPosition` computed. It is recorded
   * per fill rather than only summed, because §6.4's consecutive-loss limit is
   * a question about individual closing fills.
   */
  readonly realizedDelta: DecimalString;
  /** The `asOf` of the tick that filled it — the recorded series' own clock. */
  readonly at: string;
  readonly marketDataVersion: string;
}

export type SubmitOutcome =
  | {
      readonly outcome: 'filled';
      readonly orderId: string;
      readonly fill: SimulatedFill;
    }
  | { readonly outcome: 'resting'; readonly orderId: string }
  | {
      readonly outcome: 'rejected';
      readonly code: string;
      readonly reason: string;
    };

export interface SimulatedExchangeOptions {
  /** One schedule per market the plan trades. A market without one is refused. */
  readonly fees: readonly FeeScheduleConfig[];
  /** Opening balances, in the order the wallets are reported. */
  readonly cash: readonly Money[];
}

interface RestingOrder {
  readonly id: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: Quantity;
  readonly limitPrice: DecimalString;
  /** What the fill will cost — notional plus fee — or `null` for a sell. */
  readonly reservedCash: DecimalString | null;
}

const FILLABLE: ReadonlySet<OrderType> = new Set<OrderType>([
  'MARKET',
  'LIMIT',
]);

const instrumentKey = (reference: {
  readonly market: Market;
  readonly symbol: string;
}): string => `${reference.market}:${reference.symbol}`;

const money = (value: DecimalString) => moneyDecimal(value);

const exact = (
  value: ReturnType<typeof moneyDecimal>,
  description: string,
): DecimalString => assertExactMoney(value, description).toString();

const emptyPosition = (symbol: string): PositionCost =>
  Object.freeze({
    symbol,
    quantity: '0',
    totalCost: '0',
    realizedPnl: '0',
  });

export class SimulatedExchange {
  readonly #fees: ReadonlyMap<Market, FeeModel>;
  readonly #currencies: readonly Currency[];
  readonly #cash = new Map<Currency, DecimalString>();
  readonly #reservedCash = new Map<Currency, DecimalString>();
  readonly #positions = new Map<string, PositionCost>();
  readonly #resting: RestingOrder[] = [];
  readonly #fills: SimulatedFill[] = [];
  readonly #paid = new Map<Currency, DecimalString>();
  #nextOrderId = 1;

  constructor(options: SimulatedExchangeOptions) {
    this.#fees = new Map(
      options.fees.map((schedule) => [
        schedule.market,
        createFeeModel(schedule),
      ]),
    );
    this.#currencies = Object.freeze(
      options.cash.map((wallet) => wallet.currency),
    );

    for (const wallet of options.cash) {
      this.#cash.set(wallet.currency, exact(money(wallet.amount), 'cash'));
      this.#reservedCash.set(wallet.currency, '0');
      this.#paid.set(wallet.currency, '0');
    }
  }

  get fills(): readonly SimulatedFill[] {
    return Object.freeze([...this.#fills]);
  }

  /**
   * Every resting order this tick reaches, filled in submission order. Run
   * before the strategy sees the tick, so it decides against a position the
   * fills have already moved — which is what the runner's own cycle does by
   * reading the portfolio first.
   */
  match(tick: Tick): readonly SimulatedFill[] {
    const filled: SimulatedFill[] = [];

    for (const order of [...this.#resting]) {
      if (
        instrumentKey(order) !== instrumentKey(tick) ||
        !this.#reaches(order, tick)
      ) {
        continue;
      }

      this.#release(order);
      this.#resting.splice(this.#resting.indexOf(order), 1);
      filled.push(
        this.#settle(order.id, order, 'LIMIT', order.limitPrice, tick),
      );
    }

    return Object.freeze(filled);
  }

  submit(intent: OrderIntent, tick: Tick): SubmitOutcome {
    const model = this.#feeModel(intent.market);
    const id = `backtest-order-${this.#nextOrderId}`;

    if (!FILLABLE.has(intent.type)) {
      return refuse(
        'UNSUPPORTED_ORDER_TYPE',
        `the backtest harness simulates MARKET and LIMIT orders only, not ${intent.type}`,
      );
    }

    const touch = this.#touch(intent.side, tick);
    const limit = intent.type === 'LIMIT' ? intent.limitPrice : null;
    const fills =
      limit === null ||
      (intent.side === 'BUY'
        ? money(touch).lte(limit)
        : money(touch).gte(limit));
    const price = limit ?? touch;
    const held = this.#available(intent);

    if (intent.side === 'SELL' && money(held).lt(intent.quantity)) {
      return refuse(
        'INSUFFICIENT_AVAILABLE_POSITION',
        `${intent.quantity} of ${instrumentKey(intent)} was ordered and ${held} is available`,
      );
    }

    const notional = exact(
      money(price).times(intent.quantity),
      'simulated order notional',
    );

    // What this order costs when it settles, whether that is now or later. A
    // resting limit fills at `price` — its own limit — so this is the same
    // number either way, which is exactly why the reservation can be exact.
    const cost =
      intent.side === 'BUY'
        ? exact(
            money(notional).plus(
              model.calculate({
                market: intent.market,
                side: 'BUY',
                price,
                quantity: intent.quantity,
              }),
            ),
            'simulated order cost',
          )
        : notional;

    if (intent.side === 'BUY') {
      const spendable = this.#cash.get(model.currency) ?? '0';

      if (money(spendable).lt(cost)) {
        return refuse(
          'INSUFFICIENT_CASH',
          `${cost} ${model.currency} is needed and ${spendable} is available`,
        );
      }
    }

    this.#nextOrderId += 1;

    if (fills) {
      return Object.freeze({
        outcome: 'filled' as const,
        orderId: id,
        fill: this.#settle(id, intent, intent.type, price, tick),
      });
    }

    const order: RestingOrder = Object.freeze({
      id,
      market: intent.market,
      symbol: intent.symbol,
      side: intent.side,
      quantity: intent.quantity,
      limitPrice: price,
      reservedCash: intent.side === 'BUY' ? cost : null,
    });

    this.#resting.push(order);
    this.#reserve(order, model.currency);

    return Object.freeze({ outcome: 'resting' as const, orderId: id });
  }

  cancel(orderId: string): boolean {
    const order = this.#resting.find((resting) => resting.id === orderId);

    if (order === undefined) {
      return false;
    }

    this.#release(order);
    this.#resting.splice(this.#resting.indexOf(order), 1);

    return true;
  }

  /** Realised PnL for one instrument, keyed `MARKET:SYMBOL`. */
  realisedPnl(key: string): DecimalString {
    return this.#positions.get(key)?.realizedPnl ?? '0';
  }

  /** Every instrument that has ever traded, so a liquidated one still reports. */
  realisedPnlByInstrument(): readonly {
    readonly instrument: string;
    readonly amount: DecimalString;
    readonly currency: Currency;
  }[] {
    return Object.freeze(
      [...this.#positions.entries()].map(([key, position]) =>
        Object.freeze({
          instrument: key,
          amount: position.realizedPnl,
          currency: this.#feeModel(marketOf(key)).currency,
        }),
      ),
    );
  }

  /**
   * §6.4's daily-loss input, over the *recorded series'* UTC days rather than
   * the wall clock — the same bucketing `FillJournal.realizedPnlOn` uses, on
   * the only clock a replay has.
   */
  realizedPnlOn(day: string): DecimalString {
    return exact(
      this.#fills
        .filter((fill) => fill.at.slice(0, 10) === day)
        .reduce((sum, fill) => sum.plus(fill.realizedDelta), moneyDecimal(0)),
      'realised pnl on a day',
    );
  }

  /**
   * Closing fills that lost, counted back from the newest until one did not.
   * A `BUY` realises nothing, so it is skipped rather than counted or treated
   * as a break in the run — `FillJournal.consecutiveLosses` gives the reason,
   * and answering it differently here would make a replay's loss limit a
   * different limit from the runner's.
   */
  consecutiveLosses(): number {
    let run = 0;

    for (const fill of [...this.#fills].reverse()) {
      if (fill.side !== 'SELL') {
        continue;
      }

      if (!money(fill.realizedDelta).isNegative()) {
        return run;
      }

      run += 1;
    }

    return run;
  }

  feesPaid(): readonly Money[] {
    return Object.freeze(
      this.#currencies.map((currency) =>
        Object.freeze({
          currency,
          amount: this.#paid.get(currency) ?? '0',
        }),
      ),
    );
  }

  /**
   * The account as the paper API would report it, so the `RiskGate` and the
   * `RunnerContext` read a backtest exactly as they read a live run — which is
   * the whole of what design §8.2 means by replaying through the same gate.
   */
  portfolio(): BrokerPortfolio {
    const wallets: BrokerWallet[] = this.#currencies.map((currency) => {
      const available = this.#cash.get(currency) ?? '0';
      const reserved = this.#reservedCash.get(currency) ?? '0';

      return Object.freeze({
        currency,
        total: exact(money(available).plus(reserved), 'wallet total'),
        available,
        reserved,
      });
    });
    const positions: BrokerPosition[] = [...this.#positions.entries()]
      .filter(([, position]) => position.quantity !== '0')
      .map(([key, position]) => {
        const reserved = this.#reservedQuantity(key);

        return Object.freeze({
          market: marketOf(key),
          symbol: position.symbol,
          total: position.quantity,
          available: exact(
            money(position.quantity).minus(reserved),
            'available position',
          ),
          reserved,
          averageCost: calculateAverageCost(position),
        });
      });
    const activeOrders: PortfolioOrder[] = this.#resting.map((order) =>
      Object.freeze({
        id: order.id,
        market: order.market,
        symbol: order.symbol,
        type: 'LIMIT' as const,
        side: order.side,
        quantity: order.quantity,
        filledQuantity: '0',
        status: 'OPEN' as const,
        limitPrice: order.limitPrice,
        fills: Object.freeze([]),
        siblingOrderIds: Object.freeze([]),
      }),
    );

    return Object.freeze({
      sessionId: BACKTEST_SESSION_ID,
      wallets: Object.freeze(wallets),
      positions: Object.freeze(positions),
      activeOrders: Object.freeze(activeOrders),
      accountSequence: String(this.#fills.length),
    });
  }

  #feeModel(market: Market): FeeModel {
    const model = this.#fees.get(market);

    if (model === undefined) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `the backtest plan has no fee schedule for the ${market} market, so it cannot price a fill there`,
      );
    }

    return model;
  }

  /** The price a market order pays: the other side's touch, or the tick. */
  #touch(side: Side, tick: Tick): DecimalString {
    const opposite = side === 'BUY' ? tick.bestAsk : tick.bestBid;

    return opposite ?? tick.price;
  }

  #reaches(order: RestingOrder, tick: Tick): boolean {
    const touch = this.#touch(order.side, tick);

    return order.side === 'BUY'
      ? money(touch).lte(order.limitPrice)
      : money(touch).gte(order.limitPrice);
  }

  #available(intent: OrderIntent): Quantity {
    const key = instrumentKey(intent);
    const position = this.#positions.get(key);

    return position === undefined
      ? '0'
      : exact(
          money(position.quantity).minus(this.#reservedQuantity(key)),
          'available position',
        );
  }

  #reservedQuantity(key: string): Quantity {
    return this.#resting
      .filter((order) => order.side === 'SELL' && instrumentKey(order) === key)
      .reduce(
        (total, order) => exact(money(total).plus(order.quantity), 'reserved'),
        '0',
      );
  }

  #reserve(order: RestingOrder, currency: Currency): void {
    if (order.reservedCash === null) {
      return;
    }

    this.#cash.set(
      currency,
      exact(
        money(this.#cash.get(currency) ?? '0').minus(order.reservedCash),
        'cash',
      ),
    );
    this.#reservedCash.set(
      currency,
      exact(
        money(this.#reservedCash.get(currency) ?? '0').plus(order.reservedCash),
        'reserved cash',
      ),
    );
  }

  #release(order: RestingOrder): void {
    if (order.reservedCash === null) {
      return;
    }

    const currency = this.#feeModel(order.market).currency;

    this.#cash.set(
      currency,
      exact(
        money(this.#cash.get(currency) ?? '0').plus(order.reservedCash),
        'cash',
      ),
    );
    this.#reservedCash.set(
      currency,
      exact(
        money(this.#reservedCash.get(currency) ?? '0').minus(
          order.reservedCash,
        ),
        'reserved cash',
      ),
    );
  }

  /** Applies a fill to the cash, the position and the fee total. */
  #settle(
    orderId: string,
    order: {
      readonly market: Market;
      readonly symbol: string;
      readonly side: Side;
      readonly quantity: Quantity;
    },
    type: OrderType,
    price: DecimalString,
    tick: Tick,
  ): SimulatedFill {
    const model = this.#feeModel(order.market);
    const fee = model.calculate({
      market: order.market,
      side: order.side,
      price,
      quantity: order.quantity,
    });
    const notional = exact(
      money(price).times(order.quantity),
      'simulated fill notional',
    );
    const key = instrumentKey(order);
    const before = this.#positions.get(key) ?? emptyPosition(order.symbol);
    const after = applyFillToPosition(before, {
      symbol: order.symbol,
      side: order.side,
      price,
      quantity: order.quantity,
      fee,
    });
    // trading-core owns the cost basis, so the delta is read back from it
    // rather than recomputed here — a second derivation is a second answer.
    const realizedDelta = exact(
      money(after.realizedPnl).minus(before.realizedPnl),
      'realised delta',
    );

    this.#positions.set(key, after);

    const delta =
      order.side === 'BUY'
        ? money(notional).plus(fee).negated()
        : money(notional).minus(fee);

    const settled = exact(
      money(this.#cash.get(model.currency) ?? '0').plus(delta),
      'cash',
    );

    // Checked before it is stored, so the refusal names a balance that never
    // existed rather than one this method already wrote.
    if (money(settled).isNegative()) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `settling ${order.side} ${order.quantity} ${instrumentKey(order)} at ${price} would take the ${model.currency} balance below zero to ${settled}; a simulated wallet may not go negative`,
      );
    }

    this.#cash.set(model.currency, settled);
    this.#paid.set(
      model.currency,
      exact(
        money(this.#paid.get(model.currency) ?? '0').plus(fee),
        'fees paid',
      ),
    );

    const fill: SimulatedFill = Object.freeze({
      orderId,
      market: order.market,
      symbol: order.symbol,
      side: order.side,
      type,
      price,
      quantity: order.quantity,
      fee,
      currency: model.currency,
      realizedDelta,
      at: tick.asOf,
      marketDataVersion: tick.marketDataVersion,
    });

    this.#fills.push(fill);

    return fill;
  }
}

const refuse = (code: string, reason: string): SubmitOutcome =>
  Object.freeze({ outcome: 'rejected' as const, code, reason });

const marketOf = (key: string): Market => key.slice(0, 2) as Market;
