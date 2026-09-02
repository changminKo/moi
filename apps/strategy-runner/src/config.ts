import { readFileSync } from 'node:fs';
import type { InstrumentRef, Strategy } from '@moi/strategy-sdk/strategy';
import {
  type DecimalString,
  DomainError,
  type Market,
  type Quantity,
  readExactMoney,
} from '@moi/trading-core';
import { readApiOrigin, readPublicOrigin } from './api-origin.js';
import { createStrategy, type StrategyRegistry } from './registry.js';

/**
 * The runner's configuration: a JSON file for what the operator decides, and
 * the environment for where the runner is and where its state lives.
 *
 * Everything here is validated once, at startup, and the runner refuses to
 * start on anything it cannot make sense of (AGENTS.md rule 6). Nothing falls
 * back to a default — a risk limit that quietly defaults is exactly the value an
 * operator should have had to write down, which is the same judgement phase A's
 * `defineParameterSchema` already makes for strategy parameters.
 */

/**
 * `STREAM_MAX_QUOTE_SUBSCRIPTIONS` is 5 in `rate-limits.ts` and the check is
 * `current >= 5`, so the fifth subscription is refused and the effective limit
 * is four (design §1 row 2, §5.3). Configuration that exceeds it is **refused**;
 * there is no quiet REST fallback, because a strategy silently running on a
 * different data path than the one it was configured for is worse than a
 * runner that will not start.
 *
 * It is enforced in B even though B has no WS feed: the number is a property of
 * the API, and a configuration that phase C would refuse should not be one
 * phase B accepts.
 */
export const MAX_QUOTE_SUBSCRIPTIONS = 4;

export interface RiskLimits {
  /** Instruments the runner may trade at all. An order outside it is refused. */
  readonly symbolAllowList: readonly InstrumentRef[];
  readonly maxOrderNotional: DecimalString;
  readonly maxDailyNotional: DecimalString;
  readonly maxPositionQuantity: Quantity;
  readonly maxOpenOrders: number;
  /** Enter only while the market reports `phase === 'REGULAR'` (§6.3). */
  readonly tradingHoursOnly: boolean;
  /** A tick older than this cannot justify an entry (§6.3). */
  readonly maxQuoteAgeMs: number;
  /**
   * Closing fills that lost, in a row, after which no new entry is allowed
   * (§6.4). Counted over the fill journal, so it survives a restart — which is
   * the whole of design §1 row 7.
   */
  readonly maxConsecutiveLosses: number;
  /** How much may be realised as loss on one UTC day before entries stop (§6.4). */
  readonly maxDailyLoss: DecimalString;
}

export interface ConfiguredStrategy {
  /** The instance name. Distinct from the strategy id: two entries may share one. */
  readonly name: string;
  readonly strategy: Strategy<unknown>;
  readonly params: unknown;
  readonly subscriptions: readonly InstrumentRef[];
}

export interface RunnerConfig {
  /** Where the runner connects. Allow-listed (§4.1). */
  readonly apiOrigin: string;
  /** The `Origin` header value the paper API's CSRF check compares (§4.2). */
  readonly publicOrigin: string;
  readonly stateDir: string;
  readonly pollIntervalMs: number;
  /**
   * How long a break in the tick series has to be before the next tick is a
   * gap. See `RestQuoteFeed` for why this is a duration rather than a count.
   */
  readonly gapAfterMs: number;
  readonly risk: RiskLimits;
  readonly strategies: readonly ConfiguredStrategy[];
  readonly subscriptions: readonly InstrumentRef[];
}

export interface LoadConfigOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly registry: StrategyRegistry;
  readonly readFile?: (path: string) => string;
}

const MARKETS: ReadonlySet<string> = new Set<Market>(['KR', 'US']);
const MIN_POLL_INTERVAL_MS = 200;
const MAX_POLL_INTERVAL_MS = 300_000;

function invalid(message: string): never {
  throw new DomainError(
    'INVALID_ORDER',
    `invalid runner configuration: ${message}`,
  );
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

function boundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    invalid(`${name} must be a whole number from ${min} to ${max}`);
  }

  return value;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    invalid(`${name} must be true or false`);
  }

  return value;
}

/**
 * A money limit, held to trading-core's own exact-money domain rather than to a
 * local restatement of it (AGENTS.md rule 5). `readExactMoney` accepts a sign,
 * so a negative limit is refused here — a limit below zero would refuse every
 * order and read as a configuration that had been "turned off".
 */
function moneyLimit(value: unknown, name: string): DecimalString {
  if (typeof value !== 'string') {
    invalid(`${name} must be a decimal string`);
  }

  let parsed: ReturnType<typeof readExactMoney>;

  try {
    parsed = readExactMoney(value, 'INVALID_PRICE', name);
  } catch {
    invalid(`${name} must be a decimal string inside the exact money domain`);
  }

  if (parsed.isNegative() || parsed.isZero()) {
    invalid(`${name} must be greater than zero`);
  }

  return value;
}

function quantityLimit(value: unknown, name: string): Quantity {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,79}$/u.test(value)) {
    invalid(`${name} must be a positive whole number in plain decimal form`);
  }

  return value;
}

function instrument(value: unknown, name: string): InstrumentRef {
  const source = object(value, name);
  const market = source.market;

  if (typeof market !== 'string' || !MARKETS.has(market)) {
    invalid(`${name}.market must be KR or US`);
  }

  return Object.freeze({
    market: market as Market,
    symbol: text(source.symbol, `${name}.symbol`),
  });
}

const keyOf = (ref: InstrumentRef): string => `${ref.market}:${ref.symbol}`;

export function readRiskLimits(value: unknown): RiskLimits {
  const source = object(value, 'risk');
  const allowList = array(source.symbolAllowList, 'risk.symbolAllowList').map(
    (entry, index) => instrument(entry, `risk.symbolAllowList[${index}]`),
  );

  if (allowList.length === 0) {
    invalid('risk.symbolAllowList must name at least one instrument');
  }

  const seen = new Set(allowList.map(keyOf));

  if (seen.size !== allowList.length) {
    invalid('risk.symbolAllowList lists the same instrument twice');
  }

  return Object.freeze({
    symbolAllowList: Object.freeze(allowList),
    maxOrderNotional: moneyLimit(
      source.maxOrderNotional,
      'risk.maxOrderNotional',
    ),
    maxDailyNotional: moneyLimit(
      source.maxDailyNotional,
      'risk.maxDailyNotional',
    ),
    maxPositionQuantity: quantityLimit(
      source.maxPositionQuantity,
      'risk.maxPositionQuantity',
    ),
    maxOpenOrders: boundedInteger(
      source.maxOpenOrders,
      'risk.maxOpenOrders',
      0,
      1_000,
    ),
    tradingHoursOnly: flag(source.tradingHoursOnly, 'risk.tradingHoursOnly'),
    maxQuoteAgeMs: boundedInteger(
      source.maxQuoteAgeMs,
      'risk.maxQuoteAgeMs',
      1_000,
      3_600_000,
    ),
    // At least one: a limit of zero would refuse every entry from the first
    // cycle, which reads as a runner that is broken rather than one that has
    // been turned off. Turning it off is `docker compose stop`.
    maxConsecutiveLosses: boundedInteger(
      source.maxConsecutiveLosses,
      'risk.maxConsecutiveLosses',
      1,
      1_000,
    ),
    maxDailyLoss: moneyLimit(source.maxDailyLoss, 'risk.maxDailyLoss'),
  });
}

export function readStrategies(
  value: unknown,
  registry: StrategyRegistry,
): readonly ConfiguredStrategy[] {
  const entries = array(value, 'strategies');

  if (entries.length === 0) {
    invalid('strategies must name at least one strategy');
  }

  return Object.freeze(
    entries.map((entry, index) => {
      const source = object(entry, `strategies[${index}]`);
      const name = text(source.name, `strategies[${index}].name`);
      const strategy = createStrategy(registry, source.strategyId);
      const params = strategy.parameterSchema.parse(source.params);

      return Object.freeze({
        name,
        strategy,
        params,
        subscriptions: Object.freeze([...strategy.subscriptions(params)]),
      });
    }),
  );
}

/**
 * Design §6.3: one instrument is traded by exactly one strategy, and a duplicate
 * is refused at configuration time. Two strategies sharing a symbol would share
 * one session's wallet and one position, so neither could size an exit from what
 * it believes it holds — and separating logical positions inside one ledger
 * account is explicitly out of scope.
 */
export function assertOneStrategyPerInstrument(
  strategies: readonly ConfiguredStrategy[],
): void {
  const owner = new Map<string, string>();

  for (const configured of strategies) {
    for (const reference of configured.subscriptions) {
      const key = keyOf(reference);
      const existing = owner.get(key);

      if (existing !== undefined) {
        invalid(
          `${key} is claimed by both ${existing} and ${configured.name}; one instrument is traded by exactly one strategy`,
        );
      }

      owner.set(key, configured.name);
    }
  }
}

export function loadRunnerConfig(options: LoadConfigOptions): RunnerConfig {
  const read =
    options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const apiOrigin = readApiOrigin(options.env.BOT_API_ORIGIN);
  // Defaults to the connect target, which is correct on a loopback stack where
  // the two are the same host, and must be set explicitly in compose where they
  // are not. Defaulting rather than requiring keeps a development run to one
  // variable; getting it wrong in production is a 403 on the first order, which
  // is loud.
  const publicOrigin =
    options.env.BOT_PUBLIC_ORIGIN === undefined
      ? apiOrigin
      : readPublicOrigin(options.env.BOT_PUBLIC_ORIGIN);
  const configPath = text(options.env.BOT_CONFIG_PATH, 'BOT_CONFIG_PATH');
  const stateDir = text(options.env.BOT_STATE_DIR, 'BOT_STATE_DIR');

  let parsed: unknown;

  try {
    parsed = JSON.parse(read(configPath));
  } catch (error) {
    invalid(`${configPath} could not be read as JSON: ${String(error)}`);
  }

  const source = object(parsed, 'the configuration file');
  const strategies = readStrategies(source.strategies, options.registry);
  const names = new Set(strategies.map((configured) => configured.name));

  if (names.size !== strategies.length) {
    invalid('two strategies share a name');
  }

  assertOneStrategyPerInstrument(strategies);

  const risk = readRiskLimits(source.risk);
  const allowed = new Set(risk.symbolAllowList.map(keyOf));
  const subscriptions = strategies.flatMap(
    (configured) => configured.subscriptions,
  );

  // A strategy subscribed to an instrument the gate would refuse every order for
  // is a runner that trades nothing and says nothing about why. Refusing at
  // startup turns a silent misconfiguration into a message.
  for (const reference of subscriptions) {
    if (!allowed.has(keyOf(reference))) {
      invalid(
        `${keyOf(reference)} is subscribed but not on risk.symbolAllowList`,
      );
    }
  }

  if (subscriptions.length > MAX_QUOTE_SUBSCRIPTIONS) {
    invalid(
      `${subscriptions.length} instruments are subscribed but the API allows ${MAX_QUOTE_SUBSCRIPTIONS}`,
    );
  }

  const pollIntervalMs = boundedInteger(
    source.pollIntervalMs,
    'pollIntervalMs',
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );

  return Object.freeze({
    apiOrigin,
    publicOrigin,
    stateDir,
    pollIntervalMs,
    gapAfterMs: boundedInteger(
      source.gapAfterMs,
      'gapAfterMs',
      pollIntervalMs,
      86_400_000,
    ),
    risk,
    strategies,
    subscriptions: Object.freeze(subscriptions),
  });
}
