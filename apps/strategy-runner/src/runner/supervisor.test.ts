import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTickRecorder, readTickLog } from '../backtest/tick-log.js';
import { loadRunnerConfig, type RunnerConfig } from '../config.js';
import type { StreamSocket } from '../feed/stream-client.js';
import { DEFAULT_REGISTRY } from '../registry.js';
import { createRecordingReporter } from '../reporter.js';
import type { FetchLike } from '../transport/paper-api-client.js';
import { RunnerSupervisor } from './supervisor.js';

const ORIGIN = 'http://127.0.0.1:3001';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'moi-supervisor-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

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

function config(
  strategies: readonly unknown[],
  allowList: readonly { readonly market: string; readonly symbol: string }[],
): RunnerConfig {
  return loadRunnerConfig({
    env: {
      BOT_API_ORIGIN: ORIGIN,
      BOT_CONFIG_PATH: '/plan.json',
      BOT_STATE_DIR: directory,
    },
    registry: DEFAULT_REGISTRY,
    readFile: () =>
      JSON.stringify({
        pollIntervalMs: 1000,
        // Longer than the clock steps below, so a re-read is a re-read and not
        // a gap: what is under test here is routing and recording, not §5.3.
        gapAfterMs: 120_000,
        strategies,
        risk: {
          symbolAllowList: allowList,
          maxOrderNotional: '5000000',
          maxDailyNotional: '20000000',
          maxPositionQuantity: '100',
          maxOpenOrders: 5,
          tradingHoursOnly: false,
          maxQuoteAgeMs: 60_000,
          maxConsecutiveLosses: 3,
          maxDailyLoss: '500000',
        },
      }),
  });
}

/**
 * A paper API that answers a fresh session, an empty portfolio, a quote per
 * symbol from a scripted series, and accepts every order. It is deliberately
 * the thinnest thing the supervisor will run against: what is under test here
 * is the supervisor's own routing, not the API.
 */
function api(quotes: Readonly<Record<string, readonly string[]>>): {
  readonly fetch: FetchLike;
  readonly placed: { readonly symbol: string; readonly side: string }[];
} {
  const cursor = new Map<string, number>();
  const placed: { readonly symbol: string; readonly side: string }[] = [];

  return {
    placed,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const reply = (
        status: number,
        body?: unknown,
        setCookie?: string,
      ): Awaited<ReturnType<FetchLike>> => ({
        status,
        headers: {
          get: (name) => (name === 'set-cookie' ? (setCookie ?? null) : null),
        },
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      });

      if (path === '/api/v1/sessions/anonymous') {
        return reply(
          200,
          { session: { id: 's-1' }, csrfToken: 'csrf-1' },
          'moi_session=cookie-1; Path=/; HttpOnly',
        );
      }

      if (path === '/api/v1/portfolio') {
        return reply(200, {
          sessionId: 's-1',
          wallets: [
            {
              currency: 'KRW',
              total: '10000000',
              available: '10000000',
              reserved: '0',
            },
          ],
          positions: [],
          activeOrders: [],
          accountSequence: '0',
        });
      }

      if (path === '/api/v1/orders') {
        const body = JSON.parse(init.body ?? '{}') as {
          readonly symbol: string;
          readonly side: string;
        };

        placed.push({ symbol: body.symbol, side: body.side });

        return reply(201, {
          order: { id: `o-${placed.length}`, status: 'FILLED' },
        });
      }

      const match = /\/symbols\/([^/]+)\/quote$/u.exec(path);

      if (match !== null) {
        const symbol = match[1] as string;
        const index = cursor.get(symbol) ?? 0;
        const series = quotes[symbol] ?? [];

        cursor.set(symbol, index + 1);

        if (index >= series.length) {
          return reply(200, { price: null });
        }

        return reply(200, {
          price: series[index],
          recoveryEpoch: '1',
          marketDataVersion: String(index + 1),
          bids: [{ price: String(Number(series[index]) - 10) }],
          asks: [{ price: String(Number(series[index]) + 10) }],
        });
      }

      throw new Error(`no stub for ${path}`);
    },
  };
}

/**
 * A socket that never opens, so the feed stays on its REST path. Phase C made
 * the stream the primary source and REST the re-baseline — `MarketFeed.drain`
 * re-reads an instrument once its last observation is older than half
 * `maxQuoteAgeMs` — so a test that wants a second tick advances the clock past
 * that rather than pretending the socket delivered one. Nothing is fired at it,
 * so it schedules no reconnect and leaves no timer behind.
 */
const idleSocket = (): StreamSocket => ({ close: () => undefined });

/** A clock the test moves by hand, so "time passed" is an explicit step. */
function clock(startedAt: string): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let at = Date.parse(startedAt);

  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

const HALF_A_FRESHNESS_WINDOW = 40_000;

/** Design §11, phase E, on the live path rather than in the replay. */
describe('two strategies in one runner', () => {
  it('gives each tick to the strategy that owns its instrument', async () => {
    const stub = api({
      '005930': ['70800', '70600'],
      '000660': ['170800', '170600'],
    });
    const time = clock('2026-08-31T01:00:00.000Z');
    const supervisor = new RunnerSupervisor({
      config: config(
        [
          grid('grid-samsung', '005930', '70000'),
          grid('grid-hynix', '000660', '170000'),
        ],
        [
          { market: 'KR', symbol: '005930' },
          { market: 'KR', symbol: '000660' },
        ],
      ),
      reporter: createRecordingReporter(),
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    // The first cycle primes both grids; the second crosses a level on each.
    await supervisor.cycle();
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(stub.placed).toStrictEqual([
      { symbol: '005930', side: 'BUY' },
      { symbol: '000660', side: 'BUY' },
    ]);
  });
});

describe('the tick recorder', () => {
  it('records every tick the feed produced, ready for a replay', async () => {
    const path = join(directory, 'ticks.ndjson');
    const stub = api({ '005930': ['70800', '70600'] });
    const time = clock('2026-08-31T01:00:00.000Z');
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter: createRecordingReporter(),
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
      recorder: openTickRecorder({
        path,
        reporter: createRecordingReporter(),
      }),
    });

    await supervisor.start();
    await supervisor.cycle();
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(readTickLog(path)).toStrictEqual([
      expect.objectContaining({ price: '70800', gapBefore: true }),
      expect.objectContaining({ price: '70600', gapBefore: false }),
    ]);
  });

  it('records nothing when no recorder is configured', async () => {
    const stub = api({ '005930': ['70800'] });
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter: createRecordingReporter(),
      fetch: stub.fetch,
      now: () => Date.parse('2026-08-31T01:00:00.000Z'),
      socketFactory: idleSocket,
    });

    await supervisor.start();

    await expect(supervisor.cycle()).resolves.toBeUndefined();

    supervisor.close();
  });
});
