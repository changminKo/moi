import type { Tick } from '@moi/strategy-sdk/strategy';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY } from '../registry.js';
import { createRecordingReporter } from '../reporter.js';
import { runBacktest } from './engine.js';
import { type BacktestPlan, readBacktestPlan } from './plan.js';
import { formatBacktestReport } from './report.js';

const FEES = [
  {
    version: 'backtest-1',
    market: 'KR',
    currency: 'KRW',
    commissionRate: '0.001',
    sellTaxRate: '0.002',
    roundingDecimals: 0,
    roundingMode: 'HALF_UP',
  },
];

const grid = (name: string, symbol: string, lowerPrice: string) => ({
  name,
  strategyId: 'grid',
  params: {
    market: 'KR',
    symbol,
    lowerPrice,
    step: '250',
    levels: 5,
    quantity: '10',
  },
});

const plan = (
  strategies: readonly unknown[],
  allowList: readonly { readonly market: string; readonly symbol: string }[],
): BacktestPlan =>
  readBacktestPlan(
    {
      strategies,
      risk: {
        symbolAllowList: allowList,
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
      fees: FEES,
    },
    DEFAULT_REGISTRY,
  );

/** A ±10 spread around the quoted price, so the touch is not the price. */
const tick = (
  index: number,
  price: string,
  symbol = '005930',
  gapBefore = false,
): Tick => ({
  market: 'KR',
  symbol,
  price,
  priceSource: 'rest-snapshot',
  bestBid: String(Number(price) - 10),
  bestAsk: String(Number(price) + 10),
  asOf: `2026-08-31T01:00:${String(index).padStart(2, '0')}.000Z`,
  marketDataVersion: String(index + 1),
  gapBefore,
});

/**
 * The fixed series design §10 asks for. Every number below is worked out by
 * hand in `README.md`; the grid's levels are 70000 70250 70500 70750 71000.
 *
 * 70800 primes at rung 4; 70600 crosses 70750 down and buys slot 3; 70300
 * crosses 70500 down and buys slot 2; 70900 re-enters rung 4 and releases slot
 * 2; 71200 leaves the band upwards and releases slot 3.
 */
const SERIES: readonly Tick[] = [
  tick(0, '70800'),
  tick(1, '70600'),
  tick(2, '70300'),
  tick(3, '70900'),
  tick(4, '71200'),
];

describe('a fixed series through the grid', () => {
  it('produces exactly the fills the levels and the touches imply', async () => {
    const report = await runBacktest({
      plan: plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      ticks: SERIES,
    });

    expect(report.fills).toStrictEqual([
      expect.objectContaining({
        side: 'BUY',
        price: '70610',
        quantity: '10',
        fee: '706',
      }),
      expect.objectContaining({
        side: 'BUY',
        price: '70310',
        quantity: '10',
        fee: '703',
      }),
      expect.objectContaining({
        side: 'SELL',
        price: '70890',
        quantity: '10',
        fee: '2127',
      }),
      expect.objectContaining({
        side: 'SELL',
        price: '71190',
        quantity: '10',
        fee: '2136',
      }),
    ]);
  });

  it('lands the cash exactly on the realised PnL, to the won', async () => {
    const report = await runBacktest({
      plan: plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      ticks: SERIES,
    });

    expect(report.realisedPnl).toStrictEqual([
      { instrument: 'KR:005930', amount: '5928', currency: 'KRW' },
    ]);
    expect(report.feesPaid).toStrictEqual([
      { currency: 'KRW', amount: '5672' },
    ]);
    expect(report.finalWallets).toStrictEqual([
      {
        currency: 'KRW',
        total: '10005928',
        available: '10005928',
        reserved: '0',
      },
    ]);
    expect(report.finalPositions).toStrictEqual([]);
    expect(report.counts).toStrictEqual({
      noop: 1,
      placed: 4,
      cancelled: 0,
      refused: 0,
      rejected: 0,
    });
  });

  it('is reproducible: the same series replays to the same report', async () => {
    const configuration = () =>
      plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      );
    const first = await runBacktest({ plan: configuration(), ticks: SERIES });
    const second = await runBacktest({ plan: configuration(), ticks: SERIES });

    expect(formatBacktestReport(second)).toStrictEqual(
      formatBacktestReport(first),
    );
  });
});

/** Design §11, phase E: two strategies running at once on different symbols. */
describe('two strategies on two symbols', () => {
  it('routes each tick to the one strategy that owns its instrument', async () => {
    const report = await runBacktest({
      plan: plan(
        [
          grid('grid-samsung', '005930', '70000'),
          grid('grid-hynix', '000660', '170000'),
        ],
        [
          { market: 'KR', symbol: '005930' },
          { market: 'KR', symbol: '000660' },
        ],
      ),
      ticks: [
        tick(0, '70800'),
        tick(1, '170800', '000660'),
        tick(2, '70600'),
        tick(3, '170600', '000660'),
      ],
    });

    expect(report.fills.map((fill) => [fill.symbol, fill.price])).toStrictEqual(
      [
        ['005930', '70610'],
        ['000660', '170610'],
      ],
    );
    expect(report.perStrategy).toStrictEqual([
      { name: 'grid-samsung', noop: 1, placed: 1, refused: 0, rejected: 0 },
      { name: 'grid-hynix', noop: 1, placed: 1, refused: 0, rejected: 0 },
    ]);
  });

  it('ignores a tick no configured strategy owns', async () => {
    const report = await runBacktest({
      plan: plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      ticks: [tick(0, '70800'), tick(1, '170800', '000660')],
    });

    expect(report.ticks).toBe(2);
    expect(report.counts.noop).toBe(1);
  });
});

describe('the gate and the exchange, in the replay', () => {
  it('records a refusal from the same risk gate the runner uses', async () => {
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const report = await runBacktest({
      plan: {
        ...configured,
        risk: { ...configured.risk, maxOrderNotional: '1000' },
      },
      ticks: SERIES,
    });

    expect(report.counts).toStrictEqual({
      noop: 3,
      placed: 0,
      cancelled: 0,
      refused: 2,
      rejected: 0,
    });
    expect(report.refusals[0]).toMatchObject({
      strategy: 'grid-samsung',
      side: 'BUY',
      reason: 'grid-buy',
      refusal: expect.stringContaining('per-order limit'),
    });
  });

  /**
   * The self-healing path, end to end and through the real gate. Both entries
   * are refused, so the grid holds two lots the ledger never filled — and when
   * each comes due it finds nothing available and drops the lot instead of
   * sending the exchange a sell it would refuse. The two extra `noop`s above
   * are exactly those two drops.
   */
  it('drops the lots a refused buy left behind instead of overselling', async () => {
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const report = await runBacktest({
      plan: {
        ...configured,
        risk: { ...configured.risk, maxOrderNotional: '1000' },
      },
      ticks: SERIES,
    });

    expect(report.refusals.every((refusal) => refusal.side === 'BUY')).toBe(
      true,
    );
    expect(report.rejections).toStrictEqual([]);
    expect(report.finalPositions).toStrictEqual([]);
  });

  /**
   * The BUY-only shape of the gate, made visible rather than assumed. The
   * budget below fits the two entries (706000 + 703000) and nothing more; the
   * two exits are worth 708900 and 711900 between them, so if the gate charged
   * them the second entry — or the first exit — would be refused. All four go
   * through, because `RiskGate` returns early for a non-BUY intent and
   * `dailyEntryNotional` counts entries only.
   */
  it('does not charge a grid exit against the daily entry budget', async () => {
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const report = await runBacktest({
      plan: {
        ...configured,
        risk: { ...configured.risk, maxDailyNotional: '1500000' },
      },
      ticks: SERIES,
    });

    expect(report.counts).toMatchObject({ placed: 4, refused: 0 });
    expect(report.fills.filter((fill) => fill.side === 'SELL')).toHaveLength(2);
  });

  it('refuses every entry when the configured phase is not REGULAR', async () => {
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const report = await runBacktest({
      plan: { ...configured, marketPhase: 'CLOSED' },
      ticks: SERIES,
    });

    expect(report.counts).toMatchObject({ placed: 0, refused: 2 });
    expect(report.refusals[0]?.refusal).toContain('not REGULAR');
  });

  it('charges the daily notional budget from the ticks own clock', async () => {
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const report = await runBacktest({
      plan: {
        ...configured,
        risk: { ...configured.risk, maxDailyNotional: '1000000' },
      },
      ticks: SERIES,
    });

    // The first entry commits 706000 and the second would take the day over
    // 1000000, so only one buy is allowed.
    expect(report.counts.placed).toBe(2);
    expect(report.refusals[0]?.refusal).toContain("today's notional limit");
  });
});

/**
 * Phase C gave the gate §6.4's realised-PnL limits, and the replay inherited
 * them the moment it was rebased onto it — the backtest's `fills` source is the
 * simulated exchange, whose fills are the only realised PnL a replay has. This
 * is that, end to end: a losing round trip trips the daily-loss limit and the
 * next entry is refused by the same gate the runner uses.
 *
 * Before C this was a stated gap ("a replay cannot show a loss limit firing,
 * because there is none to fire"). It is no longer one, and the deviation table
 * says so rather than leaving the old sentence standing.
 */
describe('a loss limit, in the replay', () => {
  // A 5000-a-side spread, so the round trip loses far more than it pays in fees.
  const wide = (index: number, price: string): Tick => ({
    ...tick(index, price),
    bestBid: String(Number(price) - 5000),
    bestAsk: String(Number(price) + 5000),
  });

  it('refuses the next entry once the day has realised the daily loss limit', async () => {
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const report = await runBacktest({
      plan: {
        ...configured,
        risk: { ...configured.risk, maxDailyLoss: '50000' },
      },
      ticks: [
        wide(0, '70800'), // primes at rung 4
        wide(1, '70600'), // buys slot 3 at the ask, 75600
        wide(2, '70900'), // rung 4 again — the hysteresis holds the lot
        wide(3, '71200'), // rung 5 releases slot 3, sold at the bid, 66200
        wide(4, '70600'), // back down to rung 3: the entry that must be refused
      ],
    });

    const realised = report.realisedPnl[0];

    expect(realised?.instrument).toBe('KR:005930');
    expect(Number(realised?.amount)).toBeLessThan(-50_000);
    expect(report.refusals.at(-1)).toMatchObject({
      side: 'BUY',
      refusal: expect.stringContaining('daily loss limit'),
    });
  });
});

describe('the report', () => {
  it('names the fee schedules and warns that they are not the ledgers', async () => {
    const report = await runBacktest({
      plan: plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      ticks: SERIES,
    });
    const text = formatBacktestReport(report);

    expect(report.feeScheduleVersions).toStrictEqual(['KR backtest-1']);
    expect(text).toContain('backtest-1');
    expect(text.toLowerCase()).toContain('not the ledger');
  });

  it('masks a session cookie that somehow reached a reason string', async () => {
    const report = await runBacktest({
      plan: plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      ticks: SERIES,
    });
    const text = formatBacktestReport({
      ...report,
      refusals: [
        {
          at: '2026-08-31T01:00:00.000Z',
          strategy: 'grid-samsung',
          side: 'BUY',
          reason: 'grid-buy',
          refusal: 'moi_session=abcdef0123456789 was rejected',
        },
      ],
    });

    expect(text).not.toContain('abcdef0123456789');
  });

  it('reports an empty series without inventing a range', async () => {
    const report = await runBacktest({
      plan: plan(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      ticks: [],
    });

    expect(report).toMatchObject({ ticks: 0, from: null, to: null });
    expect(formatBacktestReport(report)).toContain('no ticks');
  });
});

describe('a strategy that throws', () => {
  it('is contained and quarantined without ending the replay', async () => {
    const reporter = createRecordingReporter();
    const configured = plan(
      [grid('grid-samsung', '005930', '70000')],
      [{ market: 'KR', symbol: '005930' }],
    );
    const broken = {
      ...configured,
      strategies: [
        {
          ...(configured
            .strategies[0] as (typeof configured.strategies)[number]),
          strategy: {
            ...(configured.strategies[0]?.strategy as NonNullable<
              (typeof configured.strategies)[number]
            >['strategy']),
            onTick: () => {
              throw new Error('deliberate');
            },
          },
        },
      ],
    };
    const report = await runBacktest({
      plan: broken,
      ticks: SERIES,
      reporter,
    });

    expect(report.ticks).toBe(5);
    expect(report.counts).toMatchObject({ placed: 0, noop: 0 });
    expect(reporter.lines.some((line) => line.includes('quarantined'))).toBe(
      true,
    );
  });
});
