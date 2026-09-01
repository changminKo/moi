import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { loadRunnerConfig, MAX_QUOTE_SUBSCRIPTIONS } from '../config.js';
import { DEFAULT_REGISTRY } from '../registry.js';
import { readBacktestPlan } from './plan.js';

const GRID = {
  name: 'grid-samsung',
  strategyId: 'grid',
  params: {
    market: 'KR',
    symbol: '005930',
    lowerPrice: '70000',
    step: '250',
    levels: 5,
    quantity: '10',
  },
};

const source = (
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  strategies: [GRID],
  risk: {
    symbolAllowList: [{ market: 'KR', symbol: '005930' }],
    maxOrderNotional: '5000000',
    maxDailyNotional: '20000000',
    maxPositionQuantity: '100',
    maxOpenOrders: 5,
    tradingHoursOnly: true,
    maxQuoteAgeMs: 60_000,
    maxConsecutiveLosses: 3,
    maxDailyLoss: '500000',
  },
  marketPhase: 'REGULAR',
  cash: [{ currency: 'KRW', amount: '10000000' }],
  fees: [
    {
      version: 'backtest-1',
      market: 'KR',
      currency: 'KRW',
      commissionRate: '0.001',
      sellTaxRate: '0.002',
      roundingDecimals: 0,
      roundingMode: 'HALF_UP',
    },
  ],
  ...overrides,
});

const read = (overrides: Readonly<Record<string, unknown>> = {}) =>
  readBacktestPlan(source(overrides), DEFAULT_REGISTRY);

describe('a backtest plan', () => {
  it('builds the strategies through the same registry the runner uses', () => {
    const plan = read();

    expect(plan.strategies).toHaveLength(1);
    expect(plan.strategies[0]?.name).toBe('grid-samsung');
    expect(plan.strategies[0]?.strategy.id).toBe('grid');
    expect(plan.strategies[0]?.subscriptions).toStrictEqual([
      { market: 'KR', symbol: '005930' },
    ]);
  });

  it('refuses two strategies claiming one instrument, as the runner does', () => {
    expect(() =>
      read({ strategies: [GRID, { ...GRID, name: 'grid-again' }] }),
    ).toThrow(/one instrument is traded by exactly one strategy/u);
  });

  it('refuses an instrument the risk limits would refuse every order for', () => {
    expect(() =>
      read({
        risk: {
          ...(source().risk as Record<string, unknown>),
          symbolAllowList: [{ market: 'KR', symbol: '000660' }],
        },
      }),
    ).toThrow(/not on risk.symbolAllowList/u);
  });

  /**
   * A market with no schedule cannot be priced, and a backtest that priced its
   * fills at zero fees would report the one number a fee-sensitive strategy
   * exists to beat.
   */
  it('refuses a plan with no fee schedule for a market it trades', () => {
    expect(() => read({ fees: [] })).toThrow(/fee schedule/u);
  });

  it('refuses a plan with no opening cash in the currency it would spend', () => {
    expect(() => read({ cash: [{ currency: 'USD', amount: '1000' }] })).toThrow(
      /KRW/u,
    );
  });

  it('refuses a market phase that is not a phase', () => {
    expect(() => read({ marketPhase: '' })).toThrow(DomainError);
    expect(() => read({ marketPhase: 7 })).toThrow(DomainError);
  });

  /**
   * §5.3's subscription cap is a property of the *live* API — `current >= 5` in
   * `rate-limits.ts` — and a replay subscribes to nothing. Replaying a recorded
   * five-symbol series is a legitimate question even though the runner would
   * refuse to trade that configuration, so the cap is deliberately not applied
   * here. Both halves are asserted, because the deviation is only safe while
   * the live half still holds.
   */
  it('accepts more instruments than the live subscription cap, which still refuses them', () => {
    const symbols = ['005930', '000660', '035420', '051910', '005380'];
    const strategies = symbols.map((symbol, index) => ({
      ...GRID,
      name: `grid-${index}`,
      params: { ...GRID.params, symbol },
    }));
    const allowList = symbols.map((symbol) => ({ market: 'KR', symbol }));
    const plan = read({
      strategies,
      risk: {
        ...(source().risk as Record<string, unknown>),
        symbolAllowList: allowList,
      },
    });

    expect(plan.strategies).toHaveLength(5);
    expect(MAX_QUOTE_SUBSCRIPTIONS).toBe(4);

    // The same five, through the runner's own loader, are refused.
    expect(() =>
      loadRunnerConfig({
        env: {
          BOT_API_ORIGIN: 'http://127.0.0.1:3001',
          BOT_CONFIG_PATH: '/plan.json',
          BOT_STATE_DIR: '/tmp/moi-plan-test',
        },
        registry: DEFAULT_REGISTRY,
        readFile: () =>
          JSON.stringify({
            pollIntervalMs: 1000,
            gapAfterMs: 5000,
            strategies,
            risk: {
              ...(source().risk as Record<string, unknown>),
              symbolAllowList: allowList,
            },
          }),
      }),
    ).toThrow(/5 instruments are subscribed but the API allows 4/u);
  });

  it('keeps the fee schedule versions so the report can name them', () => {
    expect(read().fees.map((schedule) => schedule.version)).toStrictEqual([
      'backtest-1',
    ]);
  });
});
