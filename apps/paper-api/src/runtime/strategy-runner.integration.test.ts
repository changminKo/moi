/**
 * Phase B's acceptance criteria (design §11), driven against the real thing:
 * **one order round-tripping** from a tick to a row in the ledger, and
 * **restart idempotency**.
 *
 * It lives in this app rather than in `apps/strategy-runner` for the same reason
 * `paper-broker-contract.integration.test.ts` does: proving the runner works
 * needs a real paper API, and design §3 forbids the runner from depending on one.
 * The dependency therefore points this way — `@moi/strategy-runner` is a
 * devDependency of `apps/paper-api` — and the runner's own `package-surface`
 * test pins that it never points back.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRecordingReporter,
  DEFAULT_REGISTRY,
  deriveIdempotencyKey,
  loadRunnerConfig,
  OrderGateway,
  PaperApiClient,
  type RunnerConfig,
  RunnerSupervisor,
  SessionClient,
  StateStore,
} from '@moi/strategy-runner';
import { PaperBroker } from '@moi/strategy-sdk';
import { SMA_CROSSOVER_ID } from '@moi/strategy-sdk/strategies/sma-crossover';
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
const TEST_TIMEOUT_MS = 120_000;
/**
 * The header value the CSRF plugin compares against, exactly as the contract
 * test does it: the runtime binds an ephemeral port, so its configured public
 * origin cannot be its own address. That is not a test artefact — it is the
 * production shape, where the bot reaches `http://paper-api:3000` and the public
 * origin is the browser app's. It is why `BOT_API_ORIGIN` and
 * `BOT_PUBLIC_ORIGIN` are two settings.
 */
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
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
  };
}

/**
 * A series that crosses. With `fastPeriod` 2 and `slowPeriod` 3 the window is
 * four prices, and phase A compares `sumFast · slowPeriod` against
 * `sumSlow · fastPeriod`:
 *
 * - after `70000, 69000, 68000` the fast pair sums to 137000 and the slow triple
 *   to 207000, so `411000 < 414000` — below;
 * - after `80000` arrives they are 148000 and 217000, so `444000 > 434000` —
 *   above.
 *
 * Two strictly opposite relations in a row is a confirmed golden cross, and the
 * strategy answers with a `MARKET` `BUY`. The numbers are written out here
 * because a test whose expected decision depends on arithmetic nobody can see is
 * a test that passes for reasons nobody can check.
 */
const PRICES = ['70000', '69000', '68000', '80000'] as const;

/**
 * Publishes a book and waits for the quote endpoint to report its price. The
 * runner reads `projectQuote`'s `price`, which with no trades is the best ask,
 * so the ask is the price the strategy will see.
 */
async function publishPrice(price: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const bid = String(Number(price) - 100);

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
          // The fake calendar's phase follows the wall clock, so asserting on it
          // would make this suite pass only during Seoul market hours. The
          // trading-hours rule has its own unit tests in the runner, against a
          // calendar the test controls.
          tradingHoursOnly: false,
          maxQuoteAgeMs: 600_000,
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

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-runner-b-'));

interface Placed {
  readonly id: string;
  readonly side: string;
  readonly quantity: string;
}

/** Every order the ledger holds for a session, however it ended. */
async function ordersOf(
  broker: PaperBroker,
  sessionId: string,
): Promise<Placed[]> {
  const portfolio = await broker.getPortfolio(sessionId);

  return portfolio.activeOrders
    .filter((order) => order.symbol === SYMBOL)
    .map((order) => ({
      id: order.id,
      side: order.side,
      quantity: order.quantity,
    }));
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

describe('the strategy runner against the real paper API', () => {
  /**
   * Phase B's first done-criterion: **one order round-trips**. A tick goes in,
   * the strategy decides, the risk gate allows it, the gateway promotes the
   * intent and submits it, and the order is visible in the ledger's own
   * portfolio.
   */
  it(
    'round-trips one order from a tick to a row in the ledger',
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

        for (const price of PRICES) {
          await publishPrice(price);
          await supervisor.cycle();
        }

        const accepted = reporter.lines.filter((line) =>
          line.startsWith('[info] the place was accepted'),
        );

        // Exactly one: the cross is confirmed on the fourth price and the
        // strategy is already long thereafter.
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatch(/reason=golden-cross/u);

        const session = supervisor.state.session.read() as {
          sessionId: string;
        };
        const broker = new PaperBroker(
          new PaperApiClient({
            origin,
            publicOrigin: PUBLIC_ORIGIN,
            credentials: () => ({
              sessionId: session.sessionId,
              cookie: (supervisor.state.session.read() as { cookie: string })
                .cookie,
              csrfToken: (
                supervisor.state.session.read() as { csrfToken: string }
              ).csrfToken,
            }),
          }).brokerTransport(),
        );

        await expect(
          ordersOf(broker, session.sessionId),
        ).resolves.toStrictEqual([
          { id: expect.any(String), side: 'BUY', quantity: '1' },
        ]);

        // The decision that produced it is on disk, settled, and named.
        expect(supervisor.state.pendingDecisions()).toStrictEqual([]);
      } finally {
        supervisor.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The gate is real, not bypassed: the same series against a per-order notional
   * the entry would exceed places nothing, and says why.
   */
  it(
    'places nothing when the risk gate refuses the entry',
    async () => {
      const stateDir = scratch();
      const reporter = createRecordingReporter();
      const base = runnerConfig(stateDir);
      const supervisor = new RunnerSupervisor({
        config: {
          ...base,
          risk: { ...base.risk, maxOrderNotional: '1000' },
        },
        reporter,
      });

      try {
        await publishPrice(PRICES[0]);
        await supervisor.start();

        for (const price of PRICES) {
          await publishPrice(price);
          await supervisor.cycle();
        }

        expect(
          reporter.lines.filter((line) => line.includes('was accepted')),
        ).toStrictEqual([]);
        expect(reporter.lines.join('\n')).toMatch(
          /the risk gate refused an order .*refusal=the order notional 80000 is over the per-order limit of 1000/u,
        );

        const session = supervisor.state.session.read() as {
          sessionId: string;
        };
        const broker = new PaperBroker(
          new PaperApiClient({
            origin,
            publicOrigin: PUBLIC_ORIGIN,
            credentials: () => ({
              sessionId: session.sessionId,
              cookie: (supervisor.state.session.read() as { cookie: string })
                .cookie,
              csrfToken: (
                supervisor.state.session.read() as { csrfToken: string }
              ).csrfToken,
            }),
          }).brokerTransport(),
        );

        await expect(
          ordersOf(broker, session.sessionId),
        ).resolves.toStrictEqual([]);
      } finally {
        supervisor.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * Phase B's second done-criterion, and the sharper half of it.
   *
   * The runner is killed **between recording the decision and submitting it**.
   * A new process over the same state directory recovers the decision and
   * submits it under the key recomputed from the recorded `decisionId` — and
   * because the first process had in fact already reached the ledger, the
   * ledger *replays* the original order rather than placing a second one.
   *
   * This is the shape that actually costs money if it is wrong: a bot that
   * cannot recognise its own in-flight order doubles the position on every
   * restart. The assertion is therefore on the ledger's order list, not on the
   * runner's own bookkeeping.
   */
  it(
    'resubmits an unsettled decision under the same key and places no second order',
    async () => {
      // Built from the parts rather than through `RunnerSupervisor`, because the
      // crash this reproduces happens *inside* a cycle — between the decision
      // append and the submission — and the supervisor has no seam there.
      const stateDir = scratch();
      const reporter = createRecordingReporter();
      const state = StateStore.open({ directory: stateDir });
      const client = new PaperApiClient({
        origin,
        publicOrigin: PUBLIC_ORIGIN,
        credentials: () => session.credentials(),
      });
      const session = new SessionClient({
        api: client,
        cell: state.session,
        reporter,
      });
      const credentials = await session.establish();
      const broker = new PaperBroker(client.brokerTransport());
      const gateway = new OrderGateway({
        broker,
        state,
        sessionId: () => credentials.sessionId,
        reporter,
        reestablishSession: async () => {
          await session.reestablish();
        },
      });

      // Step 1 of §6.2 and no further: the decision is durably on disk.
      const record = gateway.record(
        'samsung',
        {
          kind: 'place',
          reason: 'golden-cross',
          intent: {
            market: 'KR',
            symbol: SYMBOL,
            side: 'BUY',
            type: 'LIMIT',
            limitPrice: '60000',
            quantity: '1',
          },
        },
        {
          market: 'KR',
          symbol: SYMBOL,
          price: '60000',
          priceSource: 'rest-snapshot',
          bestBid: '59900',
          bestAsk: '60000',
          asOf: new Date().toISOString(),
          marketDataVersion: '1',
          gapBefore: false,
        },
      );

      expect(record).not.toBeNull();

      const decisionId = (record as { decisionId: string }).decisionId;
      const key = deriveIdempotencyKey(decisionId);

      // The nastier crash: the order *did* reach the ledger, and the process
      // died before the submission could be recorded. The state now says
      // "decided, outcome unknown", which is exactly what a restart must handle
      // without placing a second order.
      const placed = await broker.placeOrder({
        sessionId: credentials.sessionId,
        idempotencyKey: key,
        market: 'KR',
        symbol: SYMBOL,
        side: 'BUY',
        type: 'LIMIT',
        limitPrice: '60000',
        quantity: '1',
      });

      expect(await ordersOf(broker, credentials.sessionId)).toHaveLength(1);

      state.close();

      // The restart. A fresh store, a fresh gateway, the same directory.
      const restarted = StateStore.open({ directory: stateDir });
      const restartedReporter = createRecordingReporter();
      const restartedClient = new PaperApiClient({
        origin,
        publicOrigin: PUBLIC_ORIGIN,
        credentials: () => restartedSession.credentials(),
      });
      const restartedSession = new SessionClient({
        api: restartedClient,
        cell: restarted.session,
        reporter: restartedReporter,
      });
      const reused = await restartedSession.establish();

      // The session was reused from state, not replaced — otherwise the
      // idempotency key would be scoped to a different account and the replay
      // could not happen at all.
      expect(reused.sessionId).toBe(credentials.sessionId);

      const restartedGateway = new OrderGateway({
        broker: new PaperBroker(restartedClient.brokerTransport()),
        state: restarted,
        sessionId: () => reused.sessionId,
        reporter: restartedReporter,
        reestablishSession: async () => {
          await restartedSession.reestablish();
        },
      });

      try {
        expect(
          restarted.pendingDecisions().map((each) => each.decisionId),
        ).toStrictEqual([decisionId]);

        const results = await restartedGateway.recoverPending();

        // The same key, recomputed rather than remembered — and the ledger
        // answered with the order it already had.
        expect(results).toStrictEqual([
          { decisionId, outcome: 'accepted', orderId: placed.id },
        ]);
        expect(
          await ordersOf(
            new PaperBroker(restartedClient.brokerTransport()),
            reused.sessionId,
          ),
        ).toStrictEqual([{ id: placed.id, side: 'BUY', quantity: '1' }]);
        expect(restarted.pendingDecisions()).toStrictEqual([]);
      } finally {
        restarted.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The other half of §4.3: a second start reuses the persisted session rather
   * than creating one — which is what makes the idempotency scope survive, since
   * the ledger keys it by `(session_id, key)`.
   */
  it(
    'reuses the persisted session across a restart',
    async () => {
      const stateDir = scratch();
      const first = new RunnerSupervisor({
        config: runnerConfig(stateDir),
        reporter: createRecordingReporter(),
      });

      await first.start();

      const created = (first.state.session.read() as { sessionId: string })
        .sessionId;

      first.close();

      const reporter = createRecordingReporter();
      const second = new RunnerSupervisor({
        config: runnerConfig(stateDir),
        reporter,
      });

      try {
        await second.start();

        expect(
          (second.state.session.read() as { sessionId: string }).sessionId,
        ).toBe(created);
        expect(reporter.lines).toContain(
          `[info] reusing the stored session sessionId=${created}`,
        );
      } finally {
        second.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /** §4.1, against the real client: an unknown host cannot even be constructed. */
  it('refuses to build a runner pointed at a host that is not allow-listed', () => {
    expect(() =>
      loadRunnerConfig({
        env: {
          BOT_API_ORIGIN: 'https://api.live-venue.example',
          BOT_CONFIG_PATH: '/in-memory/bot.json',
          BOT_STATE_DIR: scratch(),
        },
        registry: DEFAULT_REGISTRY,
        readFile: () => '{}',
      }),
    ).toThrow(/not on the allow-list/u);
  });
});
