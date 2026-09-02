import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTickRecorder, readTickLog } from '../backtest/tick-log.js';
import { loadRunnerConfig, type RunnerConfig } from '../config.js';
import type { StreamSocket } from '../feed/stream-client.js';
import { DEFAULT_REGISTRY } from '../registry.js';
import { createRecordingReporter } from '../reporter.js';
import { StateStore } from '../state/state-store.js';
import type { FetchLike } from '../transport/paper-api-client.js';
import { HEARTBEAT_MS } from './kill-switch.js';
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
function api(
  quotes: Readonly<Record<string, readonly string[]>>,
  options: {
    /** When set, every order is answered with this status and error code. */
    readonly refuseOrders?: { readonly status: number; readonly code: string };
  } = {},
): {
  readonly fetch: FetchLike;
  readonly placed: { readonly symbol: string; readonly side: string }[];
  readonly attempts: () => number;
} {
  const cursor = new Map<string, number>();
  const placed: { readonly symbol: string; readonly side: string }[] = [];
  let attempts = 0;

  return {
    placed,
    attempts: () => attempts,
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
