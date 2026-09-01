import { SMA_CROSSOVER_ID } from '@moi/strategy-sdk/strategies/sma-crossover';
import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { loadRunnerConfig, MAX_QUOTE_SUBSCRIPTIONS } from './config.js';
import { DEFAULT_REGISTRY } from './registry.js';

const ENV = {
  BOT_API_ORIGIN: 'http://127.0.0.1:3001',
  BOT_CONFIG_PATH: '/etc/moi/bot.json',
  BOT_STATE_DIR: '/var/lib/moi-bot',
};

const SAMSUNG = { market: 'KR', symbol: '005930' };
const HYNIX = { market: 'KR', symbol: '000660' };

const params = (symbol: string) => ({
  market: 'KR',
  symbol,
  fastPeriod: 3,
  slowPeriod: 8,
  quantity: '1',
});

const FILE = {
  pollIntervalMs: 1_000,
  gapAfterMs: 5_000,
  risk: {
    symbolAllowList: [SAMSUNG],
    maxOrderNotional: '1000000',
    maxDailyNotional: '5000000',
    maxPositionQuantity: '100',
    maxOpenOrders: 4,
    tradingHoursOnly: true,
    maxQuoteAgeMs: 5_000,
    maxConsecutiveLosses: 3,
    maxDailyLoss: '200000',
  },
  strategies: [
    { name: 'samsung', strategyId: SMA_CROSSOVER_ID, params: params('005930') },
  ],
};

function load(
  file: unknown = FILE,
  env: Readonly<Record<string, string | undefined>> = ENV,
) {
  return loadRunnerConfig({
    env,
    registry: DEFAULT_REGISTRY,
    readFile: () => JSON.stringify(file),
  });
}

describe('loadRunnerConfig', () => {
  it('resolves the strategy, its parameters and its subscriptions', () => {
    const config = load();

    expect(config.apiOrigin).toBe('http://127.0.0.1:3001');
    expect(config.publicOrigin).toBe('http://127.0.0.1:3001');
    expect(config.stateDir).toBe('/var/lib/moi-bot');
    expect(config.strategies).toHaveLength(1);
    expect(config.strategies[0]?.name).toBe('samsung');
    expect(config.strategies[0]?.strategy.id).toBe(SMA_CROSSOVER_ID);
    expect(config.subscriptions).toStrictEqual([SAMSUNG]);
  });

  it('gives each configured entry its own strategy instance', () => {
    const config = load({
      ...FILE,
      risk: { ...FILE.risk, symbolAllowList: [SAMSUNG, HYNIX] },
      strategies: [
        ...FILE.strategies,
        {
          name: 'hynix',
          strategyId: SMA_CROSSOVER_ID,
          params: params('000660'),
        },
      ],
    });

    expect(config.strategies[0]?.strategy).not.toBe(
      config.strategies[1]?.strategy,
    );
  });

  it('reads a public origin that differs from the connect target', () => {
    expect(
      load(FILE, {
        ...ENV,
        BOT_API_ORIGIN: 'http://paper-api:3000',
        BOT_PUBLIC_ORIGIN: 'https://app.moi.example',
      }).publicOrigin,
    ).toBe('https://app.moi.example');
  });

  /** §4.1: the origin gate runs before anything else is even parsed. */
  it('refuses to load against an origin that is not on the allow-list', () => {
    expect(() =>
      load(FILE, { ...ENV, BOT_API_ORIGIN: 'https://api.live-venue.example' }),
    ).toThrow(/not on the allow-list/u);
  });

  it('requires every environment variable it reads', () => {
    for (const name of ['BOT_API_ORIGIN', 'BOT_CONFIG_PATH', 'BOT_STATE_DIR']) {
      expect(() => load(FILE, { ...ENV, [name]: undefined })).toThrow(
        DomainError,
      );
    }
  });
});

describe('loadRunnerConfig strategy isolation', () => {
  /** §6.3: one instrument, one strategy. */
  it('refuses two strategies that claim the same instrument', () => {
    expect(() =>
      load({
        ...FILE,
        strategies: [
          FILE.strategies[0],
          {
            name: 'samsung-slow',
            strategyId: SMA_CROSSOVER_ID,
            params: { ...params('005930'), slowPeriod: 20 },
          },
        ],
      }),
    ).toThrow(/KR:005930 is claimed by both samsung and samsung-slow/u);
  });

  it('accepts two strategies on different instruments', () => {
    expect(
      load({
        ...FILE,
        risk: { ...FILE.risk, symbolAllowList: [SAMSUNG, HYNIX] },
        strategies: [
          FILE.strategies[0],
          {
            name: 'hynix',
            strategyId: SMA_CROSSOVER_ID,
            params: params('000660'),
          },
        ],
      }).subscriptions,
    ).toStrictEqual([SAMSUNG, HYNIX]);
  });

  it('refuses two strategies that share a name', () => {
    expect(() =>
      load({
        ...FILE,
        risk: { ...FILE.risk, symbolAllowList: [SAMSUNG, HYNIX] },
        strategies: [
          FILE.strategies[0],
          {
            name: 'samsung',
            strategyId: SMA_CROSSOVER_ID,
            params: params('000660'),
          },
        ],
      }),
    ).toThrow(/share a name/u);
  });

  /** §5.3: the API refuses the fifth subscription, so five is refused here. */
  it('refuses more subscriptions than the API allows', () => {
    const symbols = ['005930', '000660', '035420', '051910', '005380'];
    const instruments = symbols.map((symbol) => ({ market: 'KR', symbol }));

    expect(MAX_QUOTE_SUBSCRIPTIONS).toBe(4);
    expect(() =>
      load({
        ...FILE,
        risk: { ...FILE.risk, symbolAllowList: instruments },
        strategies: symbols.map((symbol) => ({
          name: symbol,
          strategyId: SMA_CROSSOVER_ID,
          params: params(symbol),
        })),
      }),
    ).toThrow(/5 instruments are subscribed but the API allows 4/u);
  });

  it('refuses a strategy subscribed to an instrument the gate would never allow', () => {
    expect(() =>
      load({
        ...FILE,
        risk: { ...FILE.risk, symbolAllowList: [HYNIX] },
      }),
    ).toThrow(/KR:005930 is subscribed but not on risk.symbolAllowList/u);
  });

  it('refuses an unknown strategy id', () => {
    expect(() =>
      load({
        ...FILE,
        strategies: [{ name: 'x', strategyId: 'martingale', params: {} }],
      }),
    ).toThrow(/unknown strategy martingale/u);
  });

  /** The parameter schema is phase A's; this pins that it is actually applied. */
  it('refuses parameters the strategy schema rejects', () => {
    expect(() =>
      load({
        ...FILE,
        strategies: [
          {
            name: 'samsung',
            strategyId: SMA_CROSSOVER_ID,
            params: { ...params('005930'), fastPeriod: 9 },
          },
        ],
      }),
    ).toThrow(/fastPeriod must be shorter than slowPeriod/u);
  });
});

describe('loadRunnerConfig risk limits', () => {
  const withRisk = (risk: Record<string, unknown>) =>
    load({ ...FILE, risk: { ...FILE.risk, ...risk } });

  it('reads every limit', () => {
    expect(load().risk).toStrictEqual({
      symbolAllowList: [SAMSUNG],
      maxOrderNotional: '1000000',
      maxDailyNotional: '5000000',
      maxPositionQuantity: '100',
      maxOpenOrders: 4,
      tradingHoursOnly: true,
      maxQuoteAgeMs: 5_000,
      maxConsecutiveLosses: 3,
      maxDailyLoss: '200000',
    });
  });

  /**
   * §6.4's two limits. Both are folds over the fill journal at evaluation time,
   * so what configuration owns is only the threshold — and a threshold of zero
   * losses would refuse every entry from the first cycle, which reads as a
   * broken runner rather than a disabled one.
   */
  it('refuses a loss limit that would stop trading before it started', () => {
    for (const bad of [0, -1, 1.5, '3', null]) {
      expect(() => withRisk({ maxConsecutiveLosses: bad })).toThrow(
        DomainError,
      );
    }

    for (const bad of [200_000, '0', '-1', 'abc', null]) {
      expect(() => withRisk({ maxDailyLoss: bad })).toThrow(DomainError);
    }
  });

  /** AGENTS.md rule 5: a money limit is exact decimal, never a JS number. */
  it('refuses a money limit that is not exact decimal money', () => {
    for (const bad of [1_000_000, '1e6', 'abc', '-5', '0', '', null]) {
      expect(() => withRisk({ maxOrderNotional: bad })).toThrow(DomainError);
    }
  });

  it('refuses a position limit that is not a positive whole quantity', () => {
    for (const bad of ['0', '1.5', '-1', 100, '007']) {
      expect(() => withRisk({ maxPositionQuantity: bad })).toThrow(DomainError);
    }
  });

  it('refuses an empty or duplicated allow-list', () => {
    expect(() => withRisk({ symbolAllowList: [] })).toThrow(/at least one/u);
    expect(() => withRisk({ symbolAllowList: [SAMSUNG, SAMSUNG] })).toThrow(
      /same instrument twice/u,
    );
  });

  it('refuses a non-boolean tradingHoursOnly rather than coercing it', () => {
    for (const bad of ['true', 1, null]) {
      expect(() => withRisk({ tradingHoursOnly: bad })).toThrow(DomainError);
    }
  });

  it('requires every limit to be written down', () => {
    for (const name of [
      'symbolAllowList',
      'maxOrderNotional',
      'maxDailyNotional',
      'maxPositionQuantity',
      'maxOpenOrders',
      'tradingHoursOnly',
      'maxQuoteAgeMs',
      'maxConsecutiveLosses',
      'maxDailyLoss',
    ]) {
      const risk: Record<string, unknown> = { ...FILE.risk };

      delete risk[name];

      expect(() => load({ ...FILE, risk })).toThrow(DomainError);
    }
  });
});

describe('loadRunnerConfig timings', () => {
  it('refuses a poll interval outside its bounds', () => {
    for (const bad of [0, 100, 1.5, 400_000, '1000']) {
      expect(() => load({ ...FILE, pollIntervalMs: bad })).toThrow(DomainError);
    }
  });

  /**
   * A gap threshold below the poll interval would mark every tick a gap, and a
   * strategy that resets its window on every tick never produces a signal.
   */
  it('refuses a gap threshold shorter than the poll interval', () => {
    expect(() => load({ ...FILE, gapAfterMs: 999 })).toThrow(DomainError);
    expect(load({ ...FILE, gapAfterMs: 1_000 }).gapAfterMs).toBe(1_000);
  });

  it('refuses a configuration file that is not JSON', () => {
    expect(() =>
      loadRunnerConfig({
        env: ENV,
        registry: DEFAULT_REGISTRY,
        readFile: () => 'not json',
      }),
    ).toThrow(/could not be read as JSON/u);
  });
});
