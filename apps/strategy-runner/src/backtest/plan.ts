import type { InstrumentRef } from '@moi/strategy-sdk/strategy';
import {
  type Currency,
  createFeeModel,
  DomainError,
  type FeeRoundingMode,
  type FeeScheduleConfig,
  type Market,
  type Money,
  readExactMoney,
} from '@moi/trading-core';
import {
  assertOneStrategyPerInstrument,
  type ConfiguredStrategy,
  type RiskLimits,
  readRiskLimits,
  readStrategies,
} from '../config.js';
import type { StrategyRegistry } from '../registry.js';

/**
 * What a backtest is told to do. It is deliberately the *runner's* `strategies`
 * and `risk` blocks, read by the runner's own readers, plus the three things a
 * replay has to supply because a replay has no paper API to ask:
 *
 * | | |
 * |---|---|
 * | `marketPhase` | design §6.3's trading-hours check reads `GET /markets/:m/session`. A recorded tick carries no calendar, so the phase is stated. |
 * | `cash` | the opening balances. A new ledger session is ₩10,000,000 / $0 (design §1 row 10); a plan may say something else, and should say why. |
 * | `fees` | design §1 row 13 and §8.3: there is no public fee endpoint, so the schedule is configuration and the report says so. |
 *
 * Sharing the readers is the point rather than a convenience. §8.2 asks for the
 * replay to go through the same `Strategy` and the same `RiskGate`; if it went
 * through a *differently validated* configuration then a plan could describe
 * limits the runner would refuse, and the backtest would be answering a
 * question about a bot that cannot exist.
 *
 * There is no `BOT_API_ORIGIN` and no state directory here, and there must not
 * be: a backtest reaches no network and writes no runner state.
 */

export interface BacktestPlan {
  readonly strategies: readonly ConfiguredStrategy[];
  readonly risk: RiskLimits;
  /** What `GET /api/v1/markets/:m/session` would have answered, throughout. */
  readonly marketPhase: string;
  readonly cash: readonly Money[];
  readonly fees: readonly FeeScheduleConfig[];
}

const ROUNDING_MODES: ReadonlySet<string> = new Set<FeeRoundingMode>([
  'HALF_UP',
  'HALF_EVEN',
  'UP',
  'DOWN',
]);
const CURRENCIES: ReadonlySet<string> = new Set<Currency>(['KRW', 'USD']);
const MARKETS: ReadonlySet<string> = new Set<Market>(['KR', 'US']);

function invalid(message: string): never {
  throw new DomainError('INVALID_ORDER', `invalid backtest plan: ${message}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }

  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalid(`${name} must be an array`);
  }

  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${name} must be a non-empty string`);
  }

  return value;
}

function member(
  value: unknown,
  allowed: ReadonlySet<string>,
  name: string,
): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    invalid(`${name} must be one of ${[...allowed].join(', ')}`);
  }

  return value;
}

/** An opening balance: non-negative exact money, because $0 is a real start. */
function readMoney(value: unknown, index: number): Money {
  const source = object(value, `cash[${index}]`);
  const amount = source.amount;

  if (typeof amount !== 'string') {
    invalid(`cash[${index}].amount must be a decimal string`);
  }

  let parsed: ReturnType<typeof readExactMoney>;

  try {
    parsed = readExactMoney(amount, 'INVALID_PRICE', `cash[${index}].amount`);
  } catch {
    invalid(`cash[${index}].amount must be inside the exact money domain`);
  }

  if (parsed.isNegative()) {
    invalid(`cash[${index}].amount must not be negative`);
  }

  return Object.freeze({
    currency: member(
      source.currency,
      CURRENCIES,
      `cash[${index}].currency`,
    ) as Currency,
    amount,
  });
}

/**
 * A fee schedule, validated by building the model trading-core would build from
 * it. Restating those rules here would be a second copy of the one place that
 * knows a KR schedule must be in KRW, and `createFeeModel` raising at plan time
 * is exactly the fail-closed message an operator wants — rather than a throw on
 * the first fill, half a replay in.
 */
function readFeeSchedule(value: unknown, index: number): FeeScheduleConfig {
  const source = object(value, `fees[${index}]`);
  const schedule: FeeScheduleConfig = Object.freeze({
    version: text(source.version, `fees[${index}].version`),
    market: member(source.market, MARKETS, `fees[${index}].market`) as Market,
    currency: member(
      source.currency,
      CURRENCIES,
      `fees[${index}].currency`,
    ) as Currency,
    commissionRate: text(
      source.commissionRate,
      `fees[${index}].commissionRate`,
    ),
    sellTaxRate: text(source.sellTaxRate, `fees[${index}].sellTaxRate`),
    roundingDecimals: Number(source.roundingDecimals),
    roundingMode: member(
      source.roundingMode,
      ROUNDING_MODES,
      `fees[${index}].roundingMode`,
    ) as FeeRoundingMode,
  });

  createFeeModel(schedule);

  return schedule;
}

const keyOf = (reference: InstrumentRef): string =>
  `${reference.market}:${reference.symbol}`;

export function readBacktestPlan(
  source: unknown,
  registry: StrategyRegistry,
): BacktestPlan {
  const plan = object(source, 'the plan');
  const strategies = readStrategies(plan.strategies, registry);
  const names = new Set(strategies.map((configured) => configured.name));

  if (names.size !== strategies.length) {
    invalid('two strategies share a name');
  }

  assertOneStrategyPerInstrument(strategies);

  const risk = readRiskLimits(plan.risk);
  const allowed = new Set(risk.symbolAllowList.map(keyOf));
  const subscriptions = strategies.flatMap(
    (configured) => configured.subscriptions,
  );

  for (const reference of subscriptions) {
    if (!allowed.has(keyOf(reference))) {
      invalid(
        `${keyOf(reference)} is subscribed but not on risk.symbolAllowList`,
      );
    }
  }

  const cash = Object.freeze(array(plan.cash, 'cash').map(readMoney));
  const fees = Object.freeze(array(plan.fees, 'fees').map(readFeeSchedule));
  const priced = new Map(fees.map((schedule) => [schedule.market, schedule]));
  const funded = new Set(cash.map((wallet) => wallet.currency));

  // Both checked here rather than discovered mid-replay. A market with no
  // schedule cannot be priced at all, and a currency with no opening balance is
  // a plan that would refuse its own first entry for want of cash it never
  // meant to be short of.
  for (const reference of subscriptions) {
    const schedule = priced.get(reference.market);

    if (schedule === undefined) {
      invalid(
        `${reference.market} is traded but the plan has no fee schedule for it`,
      );
    }

    if (!funded.has(schedule.currency)) {
      invalid(
        `${reference.market} settles in ${schedule.currency} and the plan opens no ${schedule.currency} cash`,
      );
    }
  }

  return Object.freeze({
    strategies,
    risk,
    marketPhase: text(plan.marketPhase, 'marketPhase'),
    cash,
    fees,
  });
}
