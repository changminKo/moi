import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { OrderIntent, Tick } from '@moi/strategy-sdk/strategy';
import {
  assertExactMoney,
  type DecimalString,
  type Market,
  moneyDecimal,
} from '@moi/trading-core';
import type { RiskLimits } from '../config.js';
import { utcDay } from '../state/state-store.js';

/**
 * The risk gate of design §6.3 — the part of it that phase B can decide.
 *
 * ## Where the B/C line is, and why
 *
 * §6.3 lists eight limits and §6.4 adds realised-PnL bookkeeping. Everything
 * decidable from configuration, the portfolio snapshot, the market-session
 * endpoint and the tick itself is here:
 *
 * - the symbol allow-list
 * - per-order notional and per-day notional
 * - maximum position quantity
 * - maximum open orders
 * - trading-hours-only, from `phase === 'REGULAR'`
 * - quote freshness
 *
 * §6.4's consecutive-loss and daily-loss limits joined them in phase C, once
 * the `accountSequence` cursor existed to make realised PnL trustworthy. Both
 * are read straight off `FillJournal`, which is to say off the same durable
 * records that hold the cursor:
 *
 * - `maxConsecutiveLosses` over `consecutiveLosses()`
 * - `maxDailyLoss` over `realizedPnlOn(today)`
 *
 * Phase B was right to refuse to approximate them from the `fills` arrays
 * hanging off `activeOrders`: that would have been the fill path in disguise,
 * without the cursor that makes it exactly-once, and phase C would have
 * inherited a second PnL derived a different way. What is here is the first
 * one, and there is no second.
 *
 * Because both are folds over a file, they survive a restart by construction —
 * which is all §1 row 7 ever asked for. Nothing is counted in memory, so there
 * is nothing for a restart to reset.
 *
 * ## What a tripped loss limit does, and what it does not do yet
 *
 * It refuses new entries, like every other limit here, and exits stay open. It
 * does **not** cancel the resting orders that are already out, and it does not
 * stop the runner: that is the submission barrier of §7.2, which design §11
 * puts in phase D. The split is deliberate rather than a gap left open — a
 * limit that refuses entries is complete and safe on its own, and the barrier
 * is a different mechanism with a different failure mode (an in-flight
 * submission racing a cancel sweep) that deserves its own phase and its own
 * test.
 *
 * ## The gate limits risk-increasing orders
 *
 * Two rules apply to every order: the instrument must be on the allow-list, and
 * the market must be open if `tradingHoursOnly` is set. Both describe orders
 * that are wrong or that cannot execute at all.
 *
 * Every *limit* — notional, daily notional, position size, open orders, quote
 * freshness — applies to a `BUY` and not to a `SELL`. A limit exists to cap
 * exposure, and refusing an exit does not cap exposure, it traps it: a bot at
 * its open-order cap that cannot place the closing order holds the position
 * until a person notices. §6.3 already words quote freshness as refusing an
 * *entry*; this generalises the same reading to the rest, and says so rather
 * than leaving it to be inferred from which checks happen to be listed.
 *
 * Short entries do not exist here — the ledger reserves sold quantity from what
 * is held — so `SELL` is an exit and nothing else.
 */

/**
 * The market phase, from whatever knows it. `MarketSessionCache` is that in the
 * runner; in a backtest it is the configured phase, because a recorded tick
 * series does not carry the calendar the endpoint would have answered from.
 *
 * Named as an interface rather than taking the cache itself so the gate has one
 * collaborator it can be handed rather than one it must be given: design §8.2
 * requires the backtest to replay through *this* gate, and a class with private
 * fields cannot be substituted structurally.
 */
export interface MarketPhaseSource {
  phase(market: Market): Promise<string | null>;
}

/**
 * The realised-PnL questions §6.4's limits ask. `FillJournal` is this in the
 * runner, folded from `fills.ndjson`; in a backtest it is the simulated
 * exchange's own fills, which is the only realised PnL a replay has.
 */
export interface RealisedPnlSource {
  realizedPnlOn(day: string): DecimalString;
  consecutiveLosses(): number;
}

/**
 * Everything the gate asks its own records — how much entry notional a UTC day
 * has committed, and what the fills have realised. `StateStore` is this in the
 * runner (durably, which is the point of §1 row 7); the backtest's is in
 * memory, because a replay's budget and a replay's PnL are properties of the
 * replay.
 *
 * Named as an interface rather than taking `StateStore` itself so the gate has
 * one collaborator it can be *handed* rather than one it must be given: design
 * §8.2 requires the backtest to replay through this gate, and a class with
 * `#private` fields cannot be substituted structurally.
 */
export interface RiskLedgerSource {
  dailyEntryNotional(day: string): DecimalString;
  readonly fills: RealisedPnlSource;
}

export type RiskVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface RiskGateOptions {
  readonly limits: RiskLimits;
  readonly sessions: MarketPhaseSource;
  readonly state: RiskLedgerSource;
  readonly now?: () => number;
}

export interface RiskRequest {
  readonly intent: OrderIntent;
  readonly tick: Tick;
  readonly portfolio: BrokerPortfolio;
}

const allow: RiskVerdict = Object.freeze({ allowed: true });

const refuse = (reason: string): RiskVerdict =>
  Object.freeze({ allowed: false, reason });

/**
 * Orders the ledger can still act on. `activeOrders` has no server-side status
 * filter (#33, and the SDK's contract test pins that a cancelled order is still
 * listed), so the runner filters by status itself — design §1 row 12 says to,
 * until #33 lands.
 */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  'RECEIVED',
  'PENDING_TRIGGER',
  'TRIGGERED',
  'OPEN',
  'PARTIALLY_FILLED',
]);

/**
 * Typed off `BrokerPortfolio` rather than off the SDK's `BrokerPortfolioOrder`,
 * which the package does not publish on its main entry. Indexing the published
 * type keeps this in step with it without asking phase A for a new export.
 */
export type PortfolioOrder = BrokerPortfolio['activeOrders'][number];

export const isOpenOrder = (order: PortfolioOrder): boolean =>
  OPEN_STATUSES.has(order.status);

export class RiskGate {
  readonly #limits: RiskLimits;
  readonly #sessions: MarketPhaseSource;
  readonly #state: RiskLedgerSource;
  readonly #now: () => number;

  constructor(options: RiskGateOptions) {
    this.#limits = options.limits;
    this.#sessions = options.sessions;
    this.#state = options.state;
    this.#now = options.now ?? Date.now;
  }

  async evaluate(request: RiskRequest): Promise<RiskVerdict> {
    const { intent, tick, portfolio } = request;
    const key = `${intent.market}:${intent.symbol}`;

    if (
      !this.#limits.symbolAllowList.some(
        (reference) => `${reference.market}:${reference.symbol}` === key,
      )
    ) {
      return refuse(`${key} is not on the symbol allow-list`);
    }

    if (this.#limits.tradingHoursOnly) {
      const verdict = await this.#tradingHours(intent.market);

      if (verdict !== null) {
        return verdict;
      }
    }

    // Everything below caps exposure, and an exit reduces it. See the note above.
    if (intent.side !== 'BUY') {
      return allow;
    }

    const ageMs = this.#now() - Date.parse(tick.asOf);

    if (!Number.isFinite(ageMs) || ageMs > this.#limits.maxQuoteAgeMs) {
      return refuse(
        `the quote for ${key} is ${String(ageMs)}ms old, over the ${this.#limits.maxQuoteAgeMs}ms limit`,
      );
    }

    const open = portfolio.activeOrders.filter(isOpenOrder);

    if (open.length >= this.#limits.maxOpenOrders) {
      return refuse(
        `${open.length} orders are already open, at the limit of ${this.#limits.maxOpenOrders}`,
      );
    }

    const notional = notionalOf(intent, tick);

    if (moneyDecimal(notional).gt(this.#limits.maxOrderNotional)) {
      return refuse(
        `the order notional ${notional} is over the per-order limit of ${this.#limits.maxOrderNotional}`,
      );
    }

    const spent = this.#state.dailyEntryNotional(
      utcDay(new Date(this.#now()).toISOString()),
    );
    const wouldSpend = assertExactMoney(
      moneyDecimal(spent).plus(notional),
      'daily entry notional',
    );

    if (wouldSpend.gt(this.#limits.maxDailyNotional)) {
      return refuse(
        `${wouldSpend.toString()} would exceed today's notional limit of ${this.#limits.maxDailyNotional}`,
      );
    }

    const losses = this.#state.fills.consecutiveLosses();

    if (losses >= this.#limits.maxConsecutiveLosses) {
      return refuse(
        `${losses} closing fills in a row lost, at the limit of ${this.#limits.maxConsecutiveLosses}`,
      );
    }

    const realizedToday = moneyDecimal(
      this.#state.fills.realizedPnlOn(
        utcDay(new Date(this.#now()).toISOString()),
      ),
    );

    // Only a *loss* trips it. A day up on the session is not a day to stop
    // trading, and comparing a signed PnL against a positive limit directly
    // would refuse every entry on a profitable day.
    if (
      realizedToday.isNegative() &&
      realizedToday.abs().gte(this.#limits.maxDailyLoss)
    ) {
      return refuse(
        `today has realised ${realizedToday.toString()}, at the daily loss limit of ${this.#limits.maxDailyLoss}`,
      );
    }

    const held =
      portfolio.positions.find(
        (position) => `${position.market}:${position.symbol}` === key,
      )?.total ?? '0';
    const wouldHold = moneyDecimal(held).plus(intent.quantity);

    if (wouldHold.gt(this.#limits.maxPositionQuantity)) {
      return refuse(
        `holding ${wouldHold.toString()} of ${key} would exceed the position limit of ${this.#limits.maxPositionQuantity}`,
      );
    }

    return allow;
  }

  async #tradingHours(market: Market): Promise<RiskVerdict | null> {
    const phase = await this.#sessions.phase(market);

    if (phase === null) {
      // Fail closed. An unknown phase is not an open market.
      return refuse(
        `the ${market} market phase is unavailable and tradingHoursOnly is set`,
      );
    }

    return phase === 'REGULAR'
      ? null
      : refuse(`the ${market} market is in phase ${phase}, not REGULAR`);
  }
}

/**
 * What an order commits, in exact money (AGENTS.md rule 5).
 *
 * A `MARKET` order has no price of its own, so the tick's price is what it is
 * measured at — an estimate, and named as one wherever it is recorded. A priced
 * order is measured at its own limit or stop price, which is what the ledger
 * will actually reserve against.
 */
export function notionalOf(intent: OrderIntent, tick: Tick): DecimalString {
  const price =
    intent.type === 'LIMIT' || intent.type === 'OCO'
      ? intent.limitPrice
      : intent.type === 'STOP' || intent.type === 'TAKE_PROFIT'
        ? intent.stopPrice
        : tick.price;

  return assertExactMoney(
    moneyDecimal(price).times(intent.quantity),
    'order notional',
    'INVALID_PRICE',
  ).toString();
}
