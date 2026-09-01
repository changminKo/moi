import type {
  BrokerPortfolio,
  BrokerPosition,
  BrokerWallet,
} from '@moi/strategy-sdk';
import type { StrategyDecision, Tick } from '@moi/strategy-sdk/strategy';
import {
  assertExactMoney,
  type Currency,
  type DecimalString,
  type Money,
  moneyDecimal,
  type Side,
} from '@moi/trading-core';
import { instrumentKey } from '../feed/rest-quote-feed.js';
import { createRecordingReporter, type Reporter } from '../reporter.js';
import {
  notionalOf,
  type RealisedPnlSource,
  RiskGate,
  type RiskLedgerSource,
} from '../risk/risk-gate.js';
import { RunnerContext } from '../runner/runner-context.js';
import { StrategyHost } from '../runner/strategy-host.js';
import { utcDay } from '../state/state-store.js';
import type { BacktestPlan } from './plan.js';
import { SimulatedExchange, type SimulatedFill } from './simulated-exchange.js';

/**
 * The replay of design §8.2: a recorded tick series through the *same*
 * `Strategy`, the *same* `StrategyHost`, and the *same* `RiskGate` the runner
 * uses, against a simulated exchange instead of the paper API.
 *
 * ## What "the same" is worth, and where it stops
 *
 * The value of a backtest is entirely in how much of the live path it actually
 * exercises. So the cycle below is `RunnerSupervisor`'s cycle with two things
 * swapped out — the feed becomes the recorded series, and the broker becomes
 * `SimulatedExchange` — and nothing else re-implemented. In particular the
 * strategy is hosted by `StrategyHost`, so a strategy that throws is contained
 * and quarantined here exactly as it would be in production, and decisions are
 * validated by the SDK's own `readStrategyDecisions` on the way out.
 *
 * Three things are honestly different and each is a deliberate answer:
 *
 * **The clock is the tick's, not the wall's.** `now()` is `tick.asOf`, so the
 * risk gate's quote-freshness check always sees an age of zero and its daily
 * notional budget rolls over on the recorded series' own UTC days. Freshness is
 * the right answer rather than a dodge: the runner measures a tick's age at the
 * instant it polled it, which *is* `asOf`. What a replay genuinely cannot
 * reproduce is a tick that was already stale when the runner saw it, because
 * the recorded log has no second timestamp to say so.
 *
 * **No state store.** Nothing here is durable, so no `onStart` is called and no
 * snapshot is kept — every strategy warms up from nothing. A replay is not a
 * restart, and pretending otherwise would need a state directory a backtest has
 * no business writing to.
 *
 * **One portfolio snapshot per tick.** The runner reads the portfolio once per
 * cycle and evaluates every decision from that cycle against it, so this does
 * too, rather than re-reading after each order. Both current strategies emit at
 * most one order per tick, so the difference is unobservable today; the reason
 * to match the runner anyway is that a backtest which is *more* accurate than
 * the thing it models reports fills the runner would not have got.
 *
 * The `SimulatedExchange` is not given the stale snapshot — it checks its own
 * live cash and position on every order, which is what the ledger does.
 */

/**
 * Indexed off the published `BrokerPortfolio` rather than imported: the SDK
 * does not export `BrokerPortfolioOrder` on its main entry, and `risk-gate.ts`
 * already takes the same route for the same reason.
 */
type PortfolioOrder = BrokerPortfolio['activeOrders'][number];

export interface BacktestOptions {
  readonly plan: BacktestPlan;
  readonly ticks: readonly Tick[];
  readonly reporter?: Reporter;
}

export interface BacktestCounts {
  readonly noop: number;
  readonly placed: number;
  readonly cancelled: number;
  readonly refused: number;
  readonly rejected: number;
}

export interface BacktestRefusal {
  readonly at: string;
  readonly strategy: string;
  readonly side: Side;
  /** The strategy's own reason for wanting the order. */
  readonly reason: string;
  /** The gate's reason for refusing it. */
  readonly refusal: string;
}

export interface BacktestRejection {
  readonly at: string;
  readonly strategy: string;
  readonly side: Side;
  readonly code: string;
  readonly reason: string;
}

export interface StrategyTally {
  readonly name: string;
  readonly noop: number;
  readonly placed: number;
  readonly refused: number;
  readonly rejected: number;
}

export interface RealisedPnl {
  readonly instrument: string;
  readonly amount: DecimalString;
  readonly currency: Currency;
}

export interface BacktestReport {
  readonly ticks: number;
  /** The first and last recorded `asOf`, or `null` for an empty series. */
  readonly from: string | null;
  readonly to: string | null;
  readonly counts: BacktestCounts;
  readonly perStrategy: readonly StrategyTally[];
  readonly fills: readonly SimulatedFill[];
  readonly refusals: readonly BacktestRefusal[];
  readonly rejections: readonly BacktestRejection[];
  readonly realisedPnl: readonly RealisedPnl[];
  readonly feesPaid: readonly Money[];
  readonly finalWallets: readonly BrokerWallet[];
  readonly finalPositions: readonly BrokerPosition[];
  readonly openOrders: readonly PortfolioOrder[];
  /** `MARKET version`, so the report can name what it priced fills with (§8.3). */
  readonly feeScheduleVersions: readonly string[];
}

/**
 * What the gate asks its own records, in memory.
 *
 * The notional half answers the same question `StateStore` answers and answers
 * it the same way — record every decision's notional, filter to entries in the
 * query — so the gate cannot tell the two apart. The realised-PnL half that
 * §6.4's limits read is the `SimulatedExchange` itself: a replay's own fills
 * are the only fills there are, so pointing `fills` at the exchange is not a
 * stub standing in for the real thing, it *is* the real thing here.
 *
 * None of it is durable and none of it should be: a replay's budget and a
 * replay's PnL are properties of the replay. Design §1 row 7 is about a *live*
 * loss counter that a restart would reset, which is a different failure.
 */
class BacktestRiskLedger implements RiskLedgerSource {
  readonly #entries: {
    readonly day: string;
    readonly amount: DecimalString;
  }[] = [];
  readonly fills: RealisedPnlSource;

  constructor(fills: RealisedPnlSource) {
    this.fills = fills;
  }

  record(at: string, side: Side, amount: DecimalString): void {
    if (side !== 'BUY') {
      return;
    }

    this.#entries.push({ day: utcDay(at), amount });
  }

  dailyEntryNotional(day: string): DecimalString {
    return assertExactMoney(
      this.#entries
        .filter((entry) => entry.day === day)
        .reduce((sum, entry) => sum.plus(entry.amount), moneyDecimal(0)),
      'daily entry notional',
    ).toString();
  }
}

interface Tally {
  noop: number;
  placed: number;
  refused: number;
  rejected: number;
}

export async function runBacktest(
  options: BacktestOptions,
): Promise<BacktestReport> {
  const { plan, ticks } = options;
  const reporter = options.reporter ?? createRecordingReporter();
  const exchange = new SimulatedExchange({ fees: plan.fees, cash: plan.cash });
  const notional = new BacktestRiskLedger(exchange);

  let clock = ticks.length === 0 ? 0 : Date.parse(ticks[0]?.asOf ?? '');
  const now = (): number => clock;

  const context = new RunnerContext(now);
  const gate = new RiskGate({
    limits: plan.risk,
    // The phase the plan states, for every market and for the whole replay.
    // A recorded tick carries no calendar, so there is nothing else to say.
    sessions: { phase: () => Promise.resolve(plan.marketPhase) },
    state: notional,
    now,
  });
  const hosts = plan.strategies.map(
    (configured) => new StrategyHost({ configured, reporter }),
  );
  const tallies = new Map<string, Tally>(
    hosts.map((host) => [
      host.name,
      { noop: 0, placed: 0, refused: 0, rejected: 0 },
    ]),
  );
  const owner = new Map<string, StrategyHost>();

  for (const [index, configured] of plan.strategies.entries()) {
    for (const reference of configured.subscriptions) {
      owner.set(instrumentKey(reference), hosts[index] as StrategyHost);
    }
  }

  // No persisted state: a replay is not a restart. `StrategyHost.start` with
  // `null` deliberately does not call `onStart` at all.
  for (const host of hosts) {
    host.start(null, context);
  }

  const counts: Tally & { cancelled: number } = {
    noop: 0,
    placed: 0,
    cancelled: 0,
    refused: 0,
    rejected: 0,
  };
  const refusals: BacktestRefusal[] = [];
  const rejections: BacktestRejection[] = [];

  const apply = async (
    decision: StrategyDecision,
    strategy: string,
    tally: Tally,
    tick: Tick,
    portfolio: BrokerPortfolio,
  ): Promise<void> => {
    if (decision.kind === 'noop') {
      counts.noop += 1;
      tally.noop += 1;

      return;
    }

    if (decision.kind === 'cancel') {
      if (exchange.cancel(decision.orderId)) {
        counts.cancelled += 1;
      }

      return;
    }

    const { intent } = decision;
    const verdict = await gate.evaluate({ intent, tick, portfolio });

    if (!verdict.allowed) {
      counts.refused += 1;
      tally.refused += 1;
      refusals.push(
        Object.freeze({
          at: tick.asOf,
          strategy,
          side: intent.side,
          reason: decision.reason,
          refusal: verdict.reason,
        }),
      );

      return;
    }

    // Charged on the decision, before the submission, exactly as the runner's
    // `appendDecision` does: a decision that has been taken is one the budget
    // has committed to, whatever the exchange then says about it.
    notional.record(tick.asOf, intent.side, notionalOf(intent, tick));

    const result = exchange.submit(intent, tick);

    if (result.outcome === 'rejected') {
      counts.rejected += 1;
      tally.rejected += 1;
      rejections.push(
        Object.freeze({
          at: tick.asOf,
          strategy,
          side: intent.side,
          code: result.code,
          reason: result.reason,
        }),
      );

      return;
    }

    counts.placed += 1;
    tally.placed += 1;
  };

  for (const tick of ticks) {
    clock = Date.parse(tick.asOf);

    // Resting orders settle against the new tick before anything sees it, so a
    // strategy decides against the position its own earlier order has filled
    // into — the same ordering the runner gets from reading the ledger first.
    exchange.match(tick);

    context.observeTick(tick);

    const portfolio = exchange.portfolio();

    context.observePortfolio(portfolio);

    const host = owner.get(instrumentKey(tick));

    if (host === undefined) {
      continue;
    }

    const tally = tallies.get(host.name) as Tally;

    for (const decision of host.onTick(tick, context)) {
      await apply(decision, host.name, tally, tick, portfolio);
    }
  }

  const final = exchange.portfolio();

  return Object.freeze({
    ticks: ticks.length,
    from: ticks.at(0)?.asOf ?? null,
    to: ticks.at(-1)?.asOf ?? null,
    counts: Object.freeze({ ...counts }),
    perStrategy: Object.freeze(
      hosts.map((host) =>
        Object.freeze({
          name: host.name,
          ...(tallies.get(host.name) as Tally),
        }),
      ),
    ),
    fills: exchange.fills,
    refusals: Object.freeze([...refusals]),
    rejections: Object.freeze([...rejections]),
    realisedPnl: exchange.realisedPnlByInstrument(),
    feesPaid: exchange.feesPaid(),
    finalWallets: final.wallets,
    finalPositions: final.positions,
    openOrders: final.activeOrders,
    feeScheduleVersions: Object.freeze(
      plan.fees.map((schedule) => `${schedule.market} ${schedule.version}`),
    ),
  });
}
