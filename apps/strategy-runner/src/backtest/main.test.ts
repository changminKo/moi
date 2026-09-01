import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY } from '../registry.js';
import { backtestMain } from './main.js';

let directory: string;
let planPath: string;
let tickPath: string;

const PLAN = {
  strategies: [
    {
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
    },
  ],
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
};

const ticks = (prices: readonly string[]): string =>
  prices
    .map((price, index) =>
      JSON.stringify({
        market: 'KR',
        symbol: '005930',
        price,
        priceSource: 'rest-snapshot',
        bestBid: String(Number(price) - 10),
        bestAsk: String(Number(price) + 10),
        asOf: `2026-08-31T01:00:${String(index).padStart(2, '0')}.000Z`,
        marketDataVersion: String(index + 1),
        gapBefore: index === 0,
      }),
    )
    .join('\n')
    .concat('\n');

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'moi-backtest-cli-'));
  planPath = join(directory, 'plan.json');
  tickPath = join(directory, 'ticks.ndjson');
  writeFileSync(planPath, JSON.stringify(PLAN), 'utf8');
  writeFileSync(tickPath, ticks(['70800', '70600', '70900', '71200']), 'utf8');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const run = async (
  argv: readonly string[],
): Promise<{ readonly code: number; readonly output: string }> => {
  const written: string[] = [];
  const code = await backtestMain({
    argv,
    registry: DEFAULT_REGISTRY,
    write: (line) => written.push(line),
  });

  return { code, output: written.join('\n') };
};

describe('the backtest command', () => {
  it('replays the plan against the tick log and prints the report', async () => {
    const { code, output } = await run([
      '--plan',
      planPath,
      '--ticks',
      tickPath,
    ]);

    expect(code).toBe(0);
    expect(output).toContain('Backtest report');
    expect(output).toContain('4 ticks');
    expect(output).toContain('BUY 10 KR:005930 @ 70610');
  });

  it('refuses to run without both inputs, and says which is missing', async () => {
    const { code, output } = await run(['--plan', planPath]);

    expect(code).toBe(1);
    expect(output).toContain('--ticks');
  });

  it('reports a plan it cannot read as a message rather than a stack', async () => {
    writeFileSync(planPath, '{ not json', 'utf8');

    const { code, output } = await run([
      '--plan',
      planPath,
      '--ticks',
      tickPath,
    ]);

    expect(code).toBe(1);
    expect(output).toContain(planPath);
    expect(output).not.toContain('    at ');
  });

  it('reports a refused plan as the refusal it is', async () => {
    writeFileSync(
      planPath,
      JSON.stringify({ ...PLAN, marketPhase: '' }),
      'utf8',
    );

    const { code, output } = await run([
      '--plan',
      planPath,
      '--ticks',
      tickPath,
    ]);

    expect(code).toBe(1);
    expect(output).toContain('marketPhase');
  });
});
