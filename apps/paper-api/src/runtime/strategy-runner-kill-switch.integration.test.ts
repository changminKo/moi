/**
 * Phase D's done-criterion for the kill switch, against the real ledger: a
 * tripped runner cancels its resting orders and places nothing afterwards —
 * and still places nothing after a restart, because the latch is a file.
 *
 * It lives in this app for the same reason `strategy-runner.integration.test.ts`
 * does: proving the runner works needs a real paper API, and design §3 forbids
 * the runner from depending on one. The harness below is a copy of that file's,
 * deliberately — the two suites share no module, so neither can drift the other.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRecordingReporter,
  DEFAULT_REGISTRY,
  KILL_SWITCH_FILE,
  loadRunnerConfig,
  PaperApiClient,
  type RunnerConfig,
  RunnerSupervisor,
  StateStore,
} from '@moi/strategy-runner';
import { PaperBroker } from '@moi/strategy-sdk';
import { SMA_CROSSOVER_ID } from '@moi/strategy-sdk/strategies/sma-crossover';
import { moneyDecimal } from '@moi/trading-core';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { ZERO_FEE_SCHEDULES } from '../config.js';
import { ProductionRuntime } from './production-runtime.js';
import {
  createFakeProviderBundle,
  type FakeProviderBundle,
} from './provider-bundle.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 180_000;
const PUBLIC_ORIGIN = 'http://127.0.0.1:0';
const SYMBOL = '005930';

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let runtime: ProductionRuntime;
let bundle: FakeProviderBundle;
let origin: string;

function appConfig(databaseUrl: string): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    publicOrigin: PUBLIC_ORIGIN,
    databaseUrl,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    sessionHashKeys: ['runner-session-hash-key-is-32-bytes'],
    csrfSecret: 'runner-csrf-secret-at-least-32-bytes',
    adminApiKey: 'runner-admin-key-at-least-32-bytes',
    marketDataAdapter: 'fake',
    shutdownDrainDeadlineMs: 5_000,
    trustProxy: false,
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
  };
}

/**
 * The series that crosses (see `strategy-runner.integration.test.ts` for the
 * arithmetic): with `fastPeriod` 2 and `slowPeriod` 3 the fourth price confirms
 * a golden cross and the strategy answers with a `MARKET` `BUY`. Here that is
 * the order that must **not** go out.
 */
const PRICES = ['70000', '69000', '68000', '80000'] as const;

async function publishPrice(price: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  // Exact money, even in a fixture (AGENTS.md rule 5).
  const bid = moneyDecimal(price).minus('100').toString();

  while (Date.now() < deadline) {
    bundle.streamFor('KR').emitOrderBook({
      market: 'KR',
      symbol: SYMBOL,
      book: {
        market: 'KR',
        symbol: SYMBOL,
        currency: 'KRW',
        bids: [{ price: bid, volume: '100' }],
        asks: [{ price, volume: '100' }],
      },
      sourceTimestamp: new Date().toISOString(),
    });

    const response = await fetch(
      `${origin}/api/v1/markets/KR/symbols/${SYMBOL}/quote`,
    );
    const body = (await response.json().catch(() => ({}))) as {
      price?: unknown;
    };

    if (body.price === price) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`the quote for KR:${SYMBOL} never reported ${price}`);
}

function runnerConfig(stateDir: string): RunnerConfig {
  return loadRunnerConfig({
    env: {
      BOT_API_ORIGIN: origin,
      BOT_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      BOT_CONFIG_PATH: '/in-memory/bot.json',
      BOT_STATE_DIR: stateDir,
    },
    registry: DEFAULT_REGISTRY,
    readFile: () =>
      JSON.stringify({
        pollIntervalMs: 200,
        gapAfterMs: 3_600_000,
        risk: {
          symbolAllowList: [{ market: 'KR', symbol: SYMBOL }],
          maxOrderNotional: '1000000',
          maxDailyNotional: '10000000',
          maxPositionQuantity: '100',
          maxOpenOrders: 20,
          tradingHoursOnly: false,
          maxQuoteAgeMs: 600_000,
          // Far out of reach: the trip under test is the operator's, not a
          // loss limit's — those have their own unit tests in the runner.
          maxConsecutiveLosses: 100,
          maxDailyLoss: '100000000',
        },
        strategies: [
          {
            name: 'samsung',
            strategyId: SMA_CROSSOVER_ID,
            params: {
              market: 'KR',
              symbol: SYMBOL,
              fastPeriod: 2,
              slowPeriod: 3,
              quantity: '1',
            },
          },
        ],
      }),
  });
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-runner-d-'));

const observed = (supervisor: RunnerSupervisor): string =>
  JSON.stringify(
    (supervisor.state.runtime.read() as { cursors?: unknown } | null)
      ?.cursors ?? {},
  );

/**
 * Waits for the runner's stream to report `ready`. Quotes are not replayed
 * (§5.3), so a price published before the socket is up reaches the runner only
 * through the one REST re-baseline at connect; feeding a series before that is
 * a race the stream suite already learned not to run.
 */
async function streamReady(
  reporter: ReturnType<typeof createRecordingReporter>,
): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (
      reporter.lines.some((line) =>
        line.startsWith('[info] the market stream is ready'),
      )
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('the market stream never became ready');
}

/** Publishes a price and drives cycles until the runner has observed it. */
async function feedPrice(
  supervisor: RunnerSupervisor,
  price: string,
): Promise<void> {
  const before = observed(supervisor);

  await publishPrice(price);

  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    await supervisor.cycle();

    if (observed(supervisor) !== before) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`the runner never observed ${price}`);
}

interface SessionCell {
  readonly sessionId: string;
  readonly cookie: string;
  readonly csrfToken: string;
}

/** A broker over the runner's own session, so the ledger can be asked directly. */
function brokerOf(supervisor: RunnerSupervisor): {
  readonly broker: PaperBroker;
  readonly sessionId: string;
} {
  const session = (): SessionCell =>
    supervisor.state.session.read() as unknown as SessionCell;

  return {
    sessionId: session().sessionId,
    broker: new PaperBroker(
      new PaperApiClient({
        origin,
        publicOrigin: PUBLIC_ORIGIN,
        credentials: () => session(),
      }).brokerTransport(),
    ),
  };
}

async function statusesOf(
  broker: PaperBroker,
  sessionId: string,
): Promise<readonly string[]> {
  const portfolio = await broker.getPortfolio(sessionId);

  return portfolio.activeOrders
    .filter((order) => order.symbol === SYMBOL)
    .map((order) => order.status)
    .sort();
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  bundle = createFakeProviderBundle();
  runtime = new ProductionRuntime({
    config: appConfig(postgres.getConnectionUri()),
    bundle,
    signals: false,
    log: () => {},
  });
  await runtime.start();
  origin = `http://127.0.0.1:${runtime.port}`;
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await runtime?.stop().catch(() => {});
  await postgres?.stop();
  await redis?.stop();
}, CONTAINER_TIMEOUT_MS);

describe('the kill switch against the real paper API', () => {
  it(
    'cancels resting orders on a trip and places nothing afterwards, across a restart',
    async () => {
      const stateDir = scratch();
      const reporter = createRecordingReporter();
      const supervisor = new RunnerSupervisor({
        config: runnerConfig(stateDir),
        reporter,
      });

      try {
        await publishPrice(PRICES[0]);
        await supervisor.start();
        await streamReady(reporter);
        await feedPrice(supervisor, PRICES[0]);

        const { broker, sessionId } = brokerOf(supervisor);

        // Two limit bids far below the market rest in the ledger.
        for (const key of ['rest-1', 'rest-2']) {
          await broker.placeOrder({
            sessionId,
            idempotencyKey: key,
            market: 'KR',
            symbol: SYMBOL,
            side: 'BUY',
            type: 'LIMIT',
            quantity: '1',
            limitPrice: '50000',
          });
        }

        expect(
          (await statusesOf(broker, sessionId)).filter(
            (status) => status !== 'CANCELLED',
          ),
        ).toHaveLength(2);

        // The operator pulls the switch; the next cycle sees the file.
        writeFileSync(
          join(stateDir, KILL_SWITCH_FILE),
          JSON.stringify({ reason: 'integration drill' }),
        );
        await supervisor.cycle();

        expect(supervisor.killSwitch.engagement).toMatchObject({
          source: 'operator',
          reason: 'integration drill',
        });
        expect(await statusesOf(broker, sessionId)).toStrictEqual([
          'CANCELLED',
          'CANCELLED',
        ]);

        // The series that would have bought: nothing is placed.
        for (const price of PRICES.slice(1)) {
          await feedPrice(supervisor, price);
        }

        expect(
          reporter.lines.filter((line) =>
            line.includes('the place was accepted'),
          ),
        ).toStrictEqual([]);
        expect(await statusesOf(broker, sessionId)).toStrictEqual([
          'CANCELLED',
          'CANCELLED',
        ]);
      } finally {
        supervisor.close();
      }

      // Before the restart: a place the previous process recorded and never
      // settled, and a cancel from an interrupted sweep for an order that is
      // *still resting* — placed here, after the sweep, as the sweep would
      // have missed it. `recoverPending` meets the restored barrier: the place
      // must settle as halted without reaching the ledger, the cancel must go
      // out and the ledger must show the order cancelled. This is the gateway
      // barrier's one path in this suite: once engaged, no tick reaches a
      // strategy, so nothing else here can produce a place decision.
      const { broker: late, sessionId: lateSession } = brokerOf(supervisor);
      const missed = await late.placeOrder({
        sessionId: lateSession,
        idempotencyKey: 'rest-missed',
        market: 'KR',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '50000',
      });
      const seeded = StateStore.open({ directory: stateDir });

      seeded.appendDecision({
        decisionId: 'd-before-trip',
        at: new Date().toISOString(),
        strategy: 'samsung',
        kind: 'place',
        reason: 'golden-cross',
        intent: {
          market: 'KR',
          symbol: SYMBOL,
          side: 'BUY',
          type: 'MARKET',
          quantity: '1',
        },
        notional: '80000',
      });
      seeded.appendDecision({
        decisionId: `kill:seeded:${missed.id}`,
        at: new Date().toISOString(),
        strategy: 'kill-switch',
        kind: 'cancel',
        reason: 'kill switch: interrupted sweep',
        orderId: missed.id,
      });
      seeded.close();

      // Restart on the same state: still engaged, still nothing placed.
      const restartedReporter = createRecordingReporter();
      const restarted = new RunnerSupervisor({
        config: runnerConfig(stateDir),
        reporter: restartedReporter,
      });

      try {
        await restarted.start();
        await streamReady(restartedReporter);

        expect(restarted.killSwitch.engaged).toBe(true);
        expect(restarted.state.pendingDecisions()).toStrictEqual([]);
        expect(
          restartedReporter.lines.filter((line) =>
            line.includes('the place was halted by the kill switch'),
          ),
        ).toHaveLength(1);
        expect(
          restartedReporter.lines.filter((line) =>
            line.includes('the cancel was accepted'),
          ).length,
        ).toBeGreaterThanOrEqual(1);

        for (const price of PRICES) {
          await feedPrice(restarted, price);
        }

        const { broker, sessionId } = brokerOf(restarted);

        // Three: the two the sweep cancelled, and the one the seeded pending
        // cancel (and `resume`'s re-sweep) cancelled after the restart.
        expect(await statusesOf(broker, sessionId)).toStrictEqual([
          'CANCELLED',
          'CANCELLED',
          'CANCELLED',
        ]);
      } finally {
        restarted.close();
      }

      const latch = JSON.parse(
        readFileSync(join(stateDir, KILL_SWITCH_FILE), 'utf8'),
      ) as Record<string, unknown>;

      expect(latch).toMatchObject({
        source: 'operator',
        reason: 'integration drill',
      });
      // The sweep's cancels are ordinary, recorded decisions (two from the
      // first sweep, one seeded above, and at most one more from `resume`'s
      // re-sweep for the same order under the restart's own id), and the
      // pre-trip place settled as halted.
      expect(
        readFileSync(join(stateDir, 'decisions.ndjson'), 'utf8').match(
          /"decisionId":"kill:[^"]+"/gu,
        )?.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        readFileSync(join(stateDir, 'submissions.ndjson'), 'utf8'),
      ).toMatch(/"decisionId":"d-before-trip".*"outcome":"halted"/u);
    },
    TEST_TIMEOUT_MS,
  );
});
