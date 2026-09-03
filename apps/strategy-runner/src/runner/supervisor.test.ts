import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTickRecorder, readTickLog } from '../backtest/tick-log.js';
import { loadRunnerConfig, type RunnerConfig } from '../config.js';
import type { StreamSocket } from '../feed/stream-client.js';
import { DEFAULT_REGISTRY } from '../registry.js';
import { createRecordingReporter } from '../reporter.js';
import { StateStore } from '../state/state-store.js';
import type { FetchLike } from '../transport/paper-api-client.js';
import { HEARTBEAT_MS } from './kill-switch.js';
import {
  RunnerSupervisor,
  SERVING_POLL_MS,
  SERVING_WAIT_MS,
} from './supervisor.js';

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
function api(
  quotes: Readonly<Record<string, readonly string[]>>,
  options: {
    /** When set, every order is answered with this status and error code. */
    readonly refuseOrders?: { readonly status: number; readonly code: string };
    /**
     * What `/health/market-data` reports as `runtime` on each call; `null`
     * answers 503 with no body. Defaults to SERVING at once.
     */
    readonly runtime?: () => string | null;
  } = {},
): {
  readonly fetch: FetchLike;
  readonly placed: { readonly symbol: string; readonly side: string }[];
  readonly attempts: () => number;
  /** Every path the runner asked for, in order. */
  readonly calls: string[];
} {
  const cursor = new Map<string, number>();
  const placed: { readonly symbol: string; readonly side: string }[] = [];
  const calls: string[] = [];
  let attempts = 0;

  return {
    placed,
    calls,
    attempts: () => attempts,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;

      calls.push(path);
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

      if (path === '/health/market-data') {
        const runtime =
          options.runtime === undefined ? 'SERVING' : options.runtime();

        return runtime === null
          ? reply(503)
          : reply(200, {
              runtime,
              KR: { state: 'NORMAL' },
              US: { state: 'NORMAL' },
            });
      }

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
        attempts += 1;

        if (options.refuseOrders !== undefined) {
          return reply(options.refuseOrders.status, {
            code: options.refuseOrders.code,
            message: 'refused by the test',
            retryable: true,
            requestId: 'r-1',
          });
        }

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

/** A socket the test drives: `open()` then `send()` frames as the server would. */
class ScriptedSocket implements StreamSocket {
  onopen?: () => void;
  onclose?: (event: { code?: number; reason?: string }) => void;
  onerror?: (event: { message?: string }) => void;
  onmessage?: (event: { data: unknown }) => void;

  close(): void {
    // Nothing to tear down; the test owns the frames.
  }

  open(): void {
    this.onopen?.();
  }

  send(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** Lets the event drain chain and the sweep it may have started run to rest. */
const settle = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

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

/**
 * #112: a deploy restarts the bot next to the API, and the API is not SERVING
 * for its first ~20 s. Connecting the stream into that window was five refused
 * upgrades and the hold band on every deploy.
 */
describe('startup waits for the API to serve', () => {
  it('asks /health/market-data until it says SERVING, then creates the session', async () => {
    const states = ['RECOVERING', null, 'RECOVERING', 'SERVING'];
    let probe = 0;
    const stub = api(
      { '005930': ['70800'] },
      {
        runtime: () =>
          states[Math.min(probe++, states.length - 1)] as string | null,
      },
    );
    const time = clock('2026-08-31T01:00:00.000Z');
    const slept: number[] = [];
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      sleep: async (ms) => {
        slept.push(ms);
        time.advance(ms);
      },
      socketFactory: idleSocket,
    });

    await supervisor.start();
    supervisor.close();

    const health = stub.calls.filter((p) => p === '/health/market-data');
    const session = stub.calls.indexOf('/api/v1/sessions/anonymous');
    expect(health).toHaveLength(4);
    expect(session).toBeGreaterThan(
      stub.calls.lastIndexOf('/health/market-data'),
    );
    expect(slept).toStrictEqual([
      SERVING_POLL_MS,
      SERVING_POLL_MS,
      SERVING_POLL_MS,
    ]);
    expect(
      reporter.lines.filter((l) => l.includes('is not serving yet')),
    ).toStrictEqual([
      '[info] the paper API is not serving yet; waiting before the first connect runtime=RECOVERING',
    ]);
    expect(reporter.lines).toContain(
      `[info] the paper API is serving waitedMs=${3 * SERVING_POLL_MS}`,
    );
  });

  it('names an answer without a runtime by its status, and keeps waiting through a missing response', async () => {
    // Probe 1: the stub's 503 with no body. Probe 2: no response at all.
    // Probe 3: SERVING.
    const answers: (string | null)[] = [null, 'SERVING'];
    const stub = api(
      { '005930': ['70800'] },
      {
        runtime: () => {
          const next = answers.shift();

          return next === undefined ? 'SERVING' : next;
        },
      },
    );
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    let probes = 0;
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).pathname === '/health/market-data') {
        probes += 1;

        if (probes === 2) {
          throw new Error('connect ECONNREFUSED');
        }
      }

      return stub.fetch(url, init);
    };
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch,
      now: time.now,
      sleep: async (ms) => {
        time.advance(ms);
      },
      socketFactory: idleSocket,
    });

    await supervisor.start();
    supervisor.close();

    expect(probes).toBe(3);
    expect(reporter.lines.filter((l) => l.includes('paper API'))).toStrictEqual(
      [
        '[info] the paper API is not serving yet; waiting before the first connect runtime=http 503',
        `[info] the paper API is serving waitedMs=${2 * SERVING_POLL_MS}`,
      ],
    );
  });

  it('does not swallow a refusal by the API client itself while waiting', async () => {
    const stub = api({ '005930': ['70800'] });
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).pathname === '/health/market-data') {
        throw new DomainError('INVARIANT_VIOLATION', 'the client refused');
      }

      return stub.fetch(url, init);
    };
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter: createRecordingReporter(),
      fetch,
      now: clock('2026-08-31T01:00:00.000Z').now,
      socketFactory: idleSocket,
    });

    await expect(supervisor.start()).rejects.toThrow('the client refused');
    supervisor.close();
    expect(stub.calls).not.toContain('/api/v1/sessions/anonymous');
  });

  it('stops waiting when stop() arrives, and creates no session', async () => {
    const stub = api({ '005930': ['70800'] }, { runtime: () => 'RECOVERING' });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      sleep: async (ms) => {
        time.advance(ms);
        // SIGTERM lands while the runner is still waiting for the API.
        supervisor.stop();
      },
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.run();
    supervisor.close();

    expect(stub.calls).not.toContain('/api/v1/sessions/anonymous');
    expect(stub.calls.filter((p) => p === '/health/market-data')).toHaveLength(
      1,
    );
    expect(
      reporter.lines.filter((l) => l.includes('did not reach')),
    ).toStrictEqual([]);
  });

  it('says nothing when the API is already serving', async () => {
    const stub = api({ '005930': ['70800'] });
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: clock('2026-08-31T01:00:00.000Z').now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    supervisor.close();

    expect(stub.calls.filter((p) => p === '/health/market-data')).toHaveLength(
      1,
    );
    expect(reporter.lines.some((l) => l.includes('paper API'))).toBe(false);
  });

  it('gives up waiting at the deadline, says so once, and connects anyway', async () => {
    // An API that never answers at all — the label is `unreachable`.
    const stub = api({ '005930': ['70800'] });
    let probes = 0;
    const fetch: FetchLike = async (url, init) => {
      if (new URL(url).pathname === '/health/market-data') {
        probes += 1;
        throw new Error('connect ECONNREFUSED');
      }

      return stub.fetch(url, init);
    };
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch,
      now: time.now,
      sleep: async (ms) => {
        time.advance(ms);
      },
      socketFactory: idleSocket,
    });

    await supervisor.start();
    supervisor.close();

    expect(stub.calls).toContain('/api/v1/sessions/anonymous');
    expect(probes).toBe(SERVING_WAIT_MS / SERVING_POLL_MS + 1);
    expect(
      reporter.lines.filter((l) => l.includes('did not reach SERVING')),
    ).toStrictEqual([
      `[warn] the paper API did not reach SERVING before the wait ran out; connecting anyway runtime=unreachable waitedMs=${SERVING_WAIT_MS}`,
    ]);
  });
});

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

/** Design §6's kill switch, wired (kill-switch design §2.5). */
describe('the kill switch in the runner', () => {
  it('engages from an operator file and then hands no tick to any strategy', async () => {
    const stub = api({ '005930': ['70800', '70600', '70400'] });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle(); // primes the grid
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'operator drill' }),
    );
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle(); // would have crossed a level and bought
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(stub.placed).toStrictEqual([]);
    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'operator',
      reason: 'operator drill',
    });
    expect(reporter.lines).toContain(
      '[error] the kill switch is engaged; new orders are refused and resting orders are being cancelled source=operator reason=operator drill',
    );
    expect(reporter.lines).toContain(
      '[info] the cancel sweep found no resting orders passes=0',
    );
    // The feed still ran: cursors moved on the engaged cycles.
    expect(
      (supervisor.state.runtime.read() as { cursors: Record<string, unknown> })
        .cursors,
    ).not.toStrictEqual({});
    // And no strategy was asked: the grid would have decided to buy on those
    // ticks, and a decision that reached the gateway would be on disk as
    // halted. The barrier is the second line; this pins the first.
    expect(
      readFileSync(join(directory, 'decisions.ndjson'), 'utf8'),
    ).not.toContain('"kind":"place"');
  });

  it('engages from a tripped loss limit at the start of a cycle', async () => {
    const seeded = StateStore.open({ directory });

    for (const sequence of [1, 2, 3]) {
      seeded.fills.commit({
        accountSequence: String(sequence),
        at: '2026-08-31T00:59:00.000Z',
        eventId: `event-${sequence}`,
        eventType: 'ORDER_FILLED',
        fills: [
          {
            fillId: `f-${sequence}`,
            orderId: `o-${sequence}`,
            market: 'KR',
            symbol: '005930',
            side: 'SELL',
            quantity: '1',
            price: '70000',
            fee: '0',
            realizedDelta: '-100',
          },
        ],
        positions: {},
        decisions: [],
      });
    }

    seeded.close();

    const stub = api({ '005930': ['70800', '70600'] });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle();
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(stub.placed).toStrictEqual([]);
    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'loss-limit',
      reason: '3 closing fills in a row lost, at the limit of 3',
    });
  });

  it('comes back engaged after a restart and says so', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({
        engagedAt: '2026-08-30T00:00:00.000Z',
        source: 'fill-wedge',
        reason: 'a fill record could not be read',
      }),
    );

    const stub = api({ '005930': ['70800', '70600'] });
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: () => Date.parse('2026-08-31T01:00:00.000Z'),
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle();
    supervisor.close();

    expect(supervisor.killSwitch.engaged).toBe(true);
    expect(reporter.lines.join('\n')).toContain(
      'the kill switch is still engaged from a previous run; delete kill-switch.json and restart to resume trading source=fill-wedge',
    );
    expect(stub.placed).toStrictEqual([]);
  });

  /**
   * Pins the barrier *wiring* (`barrier: (kind) => killSwitch.permits(kind)`):
   * a place recorded before the trip and never settled is what `recoverPending`
   * resubmits at start, and under the latch it must settle as halted instead of
   * reaching the ledger. Delete the wiring and this places an order.
   */
  it('halts a recovered pending place under the latch instead of submitting it', async () => {
    const seeded = StateStore.open({ directory });

    seeded.appendDecision({
      decisionId: 'd-before-trip',
      at: '2026-08-31T00:59:00.000Z',
      strategy: 'grid-samsung',
      kind: 'place',
      reason: 'level crossed',
      intent: {
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      },
      notional: '70000',
    });
    seeded.close();
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'tripped before the restart' }),
    );

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
    supervisor.close();

    expect(stub.placed).toStrictEqual([]);
    expect(supervisor.state.pendingDecisions()).toStrictEqual([]);
    expect(readFileSync(join(directory, 'submissions.ndjson'), 'utf8')).toMatch(
      /"decisionId":"d-before-trip".*"outcome":"halted"/u,
    );
  });

  /** Pins the `onExhausted` wiring: design §7.2's ten failures reach the latch. */
  it('engages from ten failed submission attempts in a row', async () => {
    const stub = api(
      { '005930': ['70800', '70600', '70400', '70100'] },
      { refuseOrders: { status: 503, code: 'SERVICE_UNAVAILABLE' } },
    );
    const time = clock('2026-08-31T01:00:00.000Z');
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter: createRecordingReporter(),
      fetch: stub.fetch,
      now: time.now,
      sleep: async () => {},
      socketFactory: idleSocket,
    });

    await supervisor.start();

    for (
      let cycle = 0;
      cycle < 4 && !supervisor.killSwitch.engaged;
      cycle += 1
    ) {
      await supervisor.cycle();
      time.advance(HALF_A_FRESHNESS_WINDOW);
    }

    supervisor.close();

    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'submission-failures',
      reason: '10 submission attempts failed in a row',
    });
    expect(stub.attempts()).toBeGreaterThanOrEqual(10);
  });

  /** Pins the `killSwitch` wiring into `FillProcessor`: §16.46's wedge reaches the latch. */
  it('engages from an unexplainable fill on the stream', async () => {
    const sockets: ScriptedSocket[] = [];
    const stub = api({ '005930': ['70800'] });
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: () => Date.parse('2026-08-31T01:00:00.000Z'),
      socketFactory: () => {
        const socket = new ScriptedSocket();

        sockets.push(socket);

        return socket;
      },
    });

    await supervisor.start();

    // The first connect is scheduled through the reconnect policy's jittered
    // delay (up to ATTEMPT_BASE_MS), so the socket appears a moment later.
    const deadline = Date.now() + 5_000;

    while (sockets.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const socket = sockets[0] as ScriptedSocket;

    socket.open();
    socket.send({
      type: 'ready',
      accountSequence: '0',
      heartbeatIntervalMs: 30_000,
    });
    // An ORDER_FILLED with no fill records: shape (c) of §16.46.
    socket.send({
      type: 'event',
      eventId: 'event-1',
      accountSequence: '1',
      eventType: 'ORDER_FILLED',
      payload: { orderId: 'order-a', filledQuantity: '1' },
    });
    await settle();
    supervisor.close();

    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'fill-wedge',
    });
    // The wedge itself is intact: the cursor did not move.
    expect(supervisor.state.fills.cursor).toBeNull();
    expect(reporter.lines.join('\n')).toContain(
      'the kill switch is engaged; new orders are refused and resting orders are being cancelled source=fill-wedge',
    );
  });

  /** Pins the `heartbeat()` call in the cycle. */
  it('says it is still engaged once the heartbeat interval has passed', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'drill' }),
    );

    const stub = api({ '005930': ['70800', '70600', '70400'] });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle();
    expect(
      reporter.lines.filter((line) => line.includes('still engaged source=')),
    ).toStrictEqual([]);

    time.advance(HEARTBEAT_MS);
    await supervisor.cycle();
    supervisor.close();

    expect(reporter.lines).toContain(
      '[warn] the kill switch is still engaged source=operator reason=drill engagedAt=2026-08-31T01:00:00.000Z',
    );
  });
});
