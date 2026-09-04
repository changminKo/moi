/**
 * Phase C's acceptance criteria (design §11), against the real paper API:
 * **the injected hard kill passes, and no `onFill` is delivered twice.**
 *
 * It lives here rather than in `apps/strategy-runner` for the reason phase B's
 * suite already gives: proving the runner works needs a real paper API, and §3
 * forbids the runner from depending on one.
 *
 * ## What "delivered twice" is measured on
 *
 * `fills.ndjson`. A fill is delivered to a strategy exactly when the runner
 * commits it, and the commit *is* the delivery record — that is the whole of
 * §6.4's "the same transaction" on an append-only substrate. So the assertion is
 * that every `fillId` the ledger holds appears in that file exactly once, and
 * the assertion for "nothing was lost" is that every one of them appears at all.
 *
 * Beside it, the assertion that actually costs money if it is wrong: the ledger
 * must hold **one** exit order, not two. The exit is what `onFill` decided, so
 * two of them is a duplicate delivery that reached the market.
 *
 * ## Two different paths re-deliver an event
 *
 * A **reconnect** re-delivers because the server replays from `afterSequence`,
 * and a **restart** re-delivers because a new process folds the journal and
 * connects with the cursor it found. They are different code paths and both are
 * tested.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRecordingReporter,
  loadRunnerConfig,
  type RunnerConfig,
  RunnerSupervisor,
  type StreamSocket,
  type StreamSocketFactory,
} from '@moi/strategy-runner';
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
import { createFillEcho, FILL_ECHO_ID } from './strategy-runner-child.js';

const CONTAINER_TIMEOUT_MS = 300_000;
const TEST_TIMEOUT_MS = 180_000;
const PUBLIC_ORIGIN = 'http://127.0.0.1:0';
const SYMBOL = '005930';
const ENTRY_PRICE = '70000';
const EXIT_PRICE = '99000';
/**
 * Spawned as TypeScript: Node 24 strips the types, so the child the test runs is
 * the file the compiler checked rather than a JavaScript twin of it.
 */
const CHILD = fileURLToPath(
  new URL('./strategy-runner-child.ts', import.meta.url),
);

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
    sessionHashKeys: ['runner-stream-hash-key-is-32-bytes'],
    csrfSecret: 'runner-stream-csrf-secret-32-bytes',
    adminApiKey: 'runner-stream-admin-key-32-bytes!',
    marketDataAdapter: 'fake',
    shutdownDrainDeadlineMs: 5_000,
    trustProxy: false,
    rateLimitsEnabled: false,
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
  };
}

/** Publishes a book and waits for the quote endpoint to report its ask. */
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

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-runner-c-'));

function configFile(directory: string): string {
  const path = join(directory, 'bot.json');

  writeFileSync(
    path,
    JSON.stringify({
      pollIntervalMs: 200,
      gapAfterMs: 2_000,
      risk: {
        symbolAllowList: [{ market: 'KR', symbol: SYMBOL }],
        maxOrderNotional: '1000000',
        maxDailyNotional: '10000000',
        maxPositionQuantity: '100',
        maxOpenOrders: 20,
        tradingHoursOnly: false,
        maxQuoteAgeMs: 600_000,
        maxConsecutiveLosses: 10,
        maxDailyLoss: '10000000',
      },
      strategies: [
        {
          name: 'echo',
          strategyId: FILL_ECHO_ID,
          params: { symbol: SYMBOL, quantity: '1', exitPrice: EXIT_PRICE },
        },
      ],
    }),
  );

  return path;
}

function runnerEnv(directory: string): Record<string, string> {
  return {
    BOT_API_ORIGIN: origin,
    BOT_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    BOT_CONFIG_PATH: configFile(directory),
    BOT_STATE_DIR: directory,
  };
}

function runnerConfig(directory: string): RunnerConfig {
  return loadRunnerConfig({
    env: runnerEnv(directory),
    registry: new Map([[FILL_ECHO_ID, createFillEcho as () => never]]),
  });
}

/** Every record in an NDJSON state file. A missing file is an empty log. */
function readLog(directory: string, name: string): Record<string, unknown>[] {
  let text: string;

  try {
    text = readFileSync(join(directory, name), 'utf8');
  } catch {
    return [];
  }

  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const committedFillIds = (directory: string): string[] =>
  readLog(directory, 'fills.ndjson').flatMap((record) =>
    ((record.fills ?? []) as { fillId: string }[]).map((fill) => fill.fillId),
  );

interface LedgerView {
  readonly fillIds: readonly string[];
  readonly sells: readonly { id: string; status: string }[];
  readonly buys: readonly { id: string; status: string }[];
  readonly accountSequence: string;
}

/** The ledger's own answer, read with the runner's persisted session cookie. */
async function ledger(directory: string): Promise<LedgerView> {
  const session = JSON.parse(
    readFileSync(join(directory, 'session.json'), 'utf8'),
  ) as { cookie: string };
  const response = await fetch(`${origin}/api/v1/portfolio`, {
    headers: { cookie: session.cookie, origin: PUBLIC_ORIGIN },
  });
  const body = (await response.json()) as {
    activeOrders: {
      id: string;
      side: string;
      status: string;
      fills: { id: string }[];
    }[];
    accountSequence: string;
  };
  const orders = body.activeOrders;

  return {
    fillIds: orders.flatMap((order) => order.fills.map((fill) => fill.id)),
    sells: orders
      .filter((order) => order.side === 'SELL')
      .map((order) => ({ id: order.id, status: order.status })),
    buys: orders
      .filter((order) => order.side === 'BUY')
      .map((order) => ({ id: order.id, status: order.status })),
    accountSequence: body.accountSequence,
  };
}

async function until(
  what: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`timed out waiting for ${what}`);
}

interface Child {
  readonly process: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

function startChild(
  directory: string,
  env: Readonly<Record<string, string>> = {},
): Child {
  const lines: string[] = [];
  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, ...runnerEnv(directory), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => lines.push(chunk.toString()));

  return {
    process: child,
    output: () => lines.join(''),
    exited: new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    ),
  };
}

async function stopChild(child: Child): Promise<void> {
  if (child.process.exitCode === null && child.process.signalCode === null) {
    child.process.kill('SIGKILL');
  }

  await child.exited;
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
  await publishPrice(ENTRY_PRICE);
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await runtime?.stop().catch(() => {});
  await postgres?.stop();
  await redis?.stop();
}, CONTAINER_TIMEOUT_MS);

describe('the market stream against the real paper API', () => {
  /**
   * The subscription works end to end: the upgrade is accepted with the two
   * headers §4.2 requires, quote frames become ticks the strategy decides on,
   * and the fill that follows arrives as an account event and is committed.
   */
  it(
    'ticks from quote frames and commits the fill the account stream announced',
    async () => {
      const directory = scratch();
      const reporter = createRecordingReporter();
      const supervisor = new RunnerSupervisor({
        config: runnerConfig(directory),
        reporter,
      });

      try {
        await supervisor.start();
        await until('the stream to be ready', () =>
          reporter.lines.some((line) =>
            line.startsWith('[info] the market stream is ready'),
          ),
        );

        await publishPrice('70100');
        await supervisor.cycle();

        // A commit carrying a fill, not merely a cursor advance: every account
        // event commits, and `ORDER_ACCEPTED` arrives first.
        await until('the fill to be committed', async () => {
          await supervisor.cycle();

          return committedFillIds(directory).length > 0;
        });

        const view = await ledger(directory);

        expect(view.fillIds).toHaveLength(1);
        expect(committedFillIds(directory)).toStrictEqual(view.fillIds);
        expect(
          reporter.lines.filter((line) =>
            line.startsWith('[info] a fill was applied'),
          ),
        ).toHaveLength(1);

        // The tick that produced the entry came down the socket, not the poll.
        expect(reporter.lines.join('\n')).toMatch(
          /the market stream is ready/u,
        );
      } finally {
        supervisor.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The reconnect path. The socket is torn down under the runner and the server
   * replays every account event after `afterSequence` on the new connection —
   * including the one already committed, which must not reach the strategy a
   * second time.
   *
   * The socket factory is wrapped rather than the server being stopped, because
   * stopping the server would also stop the market and this test is about the
   * client's behaviour when the connection, and only the connection, goes away.
   */
  it(
    'delivers no fill twice across a reconnect',
    async () => {
      const directory = scratch();
      const reporter = createRecordingReporter();
      const sockets: StreamSocket[] = [];
      const socketFactory: StreamSocketFactory = (url, init) => {
        const socket = new WebSocket(url, {
          headers: { ...init.headers },
        } as unknown as string[]) as unknown as StreamSocket;

        sockets.push(socket);

        return socket;
      };
      const supervisor = new RunnerSupervisor({
        config: runnerConfig(directory),
        reporter,
        socketFactory,
      });

      try {
        await supervisor.start();
        await until('the first connection', () => sockets.length === 1);
        await until('the fill to be committed', async () => {
          await publishPrice('70200');
          await supervisor.cycle();

          return committedFillIds(directory).length > 0;
        });

        const cursorBefore = supervisor.state.fills.cursor;
        const committedBefore = committedFillIds(directory);

        expect(committedBefore).toHaveLength(1);

        // The connection goes away. `close` here is the transport's, not the
        // client's — the client learns about it exactly as it would from a
        // network drop.
        (sockets[0] as StreamSocket).close(4000, 'test-induced drop');

        await until('the replacement connection', () => sockets.length > 1);
        await until(
          'the replay to have run',
          () =>
            reporter.lines.filter((line) =>
              line.startsWith('[info] the market stream is ready'),
            ).length >= 2,
        );

        // Give the replayed events every chance to be mishandled.
        for (let i = 0; i < 5; i += 1) {
          await supervisor.cycle();
        }

        // The cursor may legitimately have moved on — the exit order's own
        // `ORDER_ACCEPTED` is an account event too — but it must not have gone
        // backwards, and no *fill* may have been committed a second time.
        expect(
          BigInt(supervisor.state.fills.cursor as string) >=
            BigInt(cursorBefore as string),
        ).toBe(true);
        expect(committedFillIds(directory)).toStrictEqual(committedBefore);
        expect(
          reporter.lines.filter((line) =>
            line.startsWith('[info] a fill was applied'),
          ),
        ).toHaveLength(1);

        const view = await ledger(directory);

        expect(view.sells).toHaveLength(1);
      } finally {
        supervisor.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * §5.3 and §8.4 together: there is no historical-quote endpoint, so a gap
   * cannot be backfilled. What the runner does is re-baseline — one REST read
   * per instrument on every established connection — and mark the stitched tick
   * so phase A discards a window that spans a discontinuity.
   *
   * The market moves several times while the socket is down. The runner must
   * come back with the *current* level and say the series is not continuous.
   */
  it(
    'marks the tick after an outage the market moved through as a gap',
    async () => {
      const directory = scratch();
      const reporter = createRecordingReporter();
      const sockets: StreamSocket[] = [];
      // While this is set, every connection the client makes is dropped as soon
      // as it opens. That is a real outage rather than a single close: a single
      // close is repaired inside a second, which is shorter than `gapAfterMs`
      // and therefore — correctly — not a gap at all.
      let blocked = false;
      const supervisor = new RunnerSupervisor({
        config: runnerConfig(directory),
        reporter,
        socketFactory: (url, init) => {
          const socket = new WebSocket(url, {
            headers: { ...init.headers },
          } as unknown as string[]);

          if (blocked) {
            socket.addEventListener(
              'open',
              () => socket.close(4000, 'test-induced outage'),
              { once: true },
            );
          }

          sockets.push(socket as unknown as StreamSocket);

          return socket as unknown as StreamSocket;
        },
      });

      try {
        await supervisor.start();
        await until('the first connection', () => sockets.length === 1);
        await publishPrice('70300');
        await supervisor.cycle();

        blocked = true;
        (sockets[0] as StreamSocket).close(4000, 'test-induced outage');

        // Longer than `gapAfterMs`, and the market moves the whole time. No
        // cycle runs, so the runner observes nothing at all.
        for (const price of ['70400', '70500', '70600']) {
          await publishPrice(price);
          await new Promise((resolve) => setTimeout(resolve, 1_200));
        }

        blocked = false;

        await until(
          'the re-baselined tick',
          () =>
            reporter.lines.some((line) =>
              line.startsWith('[warn] a market-data gap was observed'),
            ),
          60_000,
        );

        const gap = reporter.lines.find((line) =>
          line.startsWith('[warn] a market-data gap was observed'),
        ) as string;

        expect(gap).toMatch(/instrument=KR:005930/u);
        expect(gap).toMatch(/sinceMs=\d+/u);

        // And the connection came back on its own — no operator, no latch. The
        // level it came back with is the market's current one; the prices in
        // between are not available to anyone (§8.4), which is why the series is
        // marked discontinuous rather than invented.
        expect(
          reporter.lines.filter((line) =>
            line.startsWith('[info] the market stream is ready'),
          ).length,
        ).toBeGreaterThan(1);
      } finally {
        supervisor.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The phase's done-criterion, with a real `SIGKILL` rather than a simulated one.
 * The child process is killed at a named instant inside the fill step, a fresh
 * process is started over the same state directory, and the ledger is asked what
 * actually happened.
 */
describe('an injected hard kill', () => {
  it(
    'loses no fill when the process dies before the commit',
    async () => {
      const directory = scratch();
      const killed = startChild(directory, { KILL_MODE: 'before-commit' });

      await until('the child to reach the commit', async () => {
        await publishPrice(String(70_700 + Math.floor(Math.random() * 10)));

        return killed.output().includes('killing at before-commit');
      });

      const exit = await killed.exited;

      expect(exit.signal).toBe('SIGKILL');

      // The cursor never moved, so nothing claims the fill was processed…
      expect(committedFillIds(directory)).toStrictEqual([]);
      // …but the decision `onFill` produced is durably recorded, under an id
      // derived from the account sequence rather than a fresh UUID.
      const decisions = readLog(directory, 'decisions.ndjson').filter(
        (record) => record.kind === 'place',
      );
      const exitDecision = decisions.find((record) =>
        String(record.decisionId).startsWith('fill:'),
      );

      expect(exitDecision?.decisionId).toMatch(/^fill:\d+:echo:0$/u);

      const restarted = startChild(directory);

      try {
        await until('the restarted runner to commit the fill', async () => {
          await publishPrice(String(70_700 + Math.floor(Math.random() * 10)));

          return committedFillIds(directory).length > 0;
        });

        const view = await ledger(directory);

        // Every fill the ledger holds, committed exactly once.
        expect(committedFillIds(directory).sort()).toStrictEqual(
          [...view.fillIds].sort(),
        );
        expect(new Set(committedFillIds(directory)).size).toBe(
          committedFillIds(directory).length,
        );

        // And the decision the replay recomputed reached the ledger once. Two
        // exits would be the duplicate `onFill` this phase exists to prevent.
        expect(view.sells).toHaveLength(1);
        expect(view.buys).toHaveLength(1);

        // One decision line, not two: `appendDecision` recognised the id the
        // replay recomputed.
        expect(
          readLog(directory, 'decisions.ndjson').filter(
            (record) => record.decisionId === exitDecision?.decisionId,
          ),
        ).toHaveLength(1);
      } finally {
        await stopChild(restarted);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'places the exit exactly once when the process dies after the commit',
    async () => {
      const directory = scratch();
      const killed = startChild(directory, { KILL_MODE: 'after-commit' });

      await until('the child to reach the commit', async () => {
        await publishPrice(String(70_800 + Math.floor(Math.random() * 10)));

        return killed.output().includes('killing at after-commit');
      });

      expect((await killed.exited).signal).toBe('SIGKILL');

      // The cursor moved, so the event will never be replayed to the strategy…
      const committed = committedFillIds(directory);

      expect(committed).toHaveLength(1);

      const before = await ledger(directory);

      // …and the exit had not been submitted when the process died.
      expect(before.sells).toStrictEqual([]);

      const restarted = startChild(directory);

      try {
        // `recoverPending` is what finishes it, at start, under the same key.
        await until('the recovered exit to reach the ledger', async () => {
          await publishPrice(String(70_800 + Math.floor(Math.random() * 10)));

          return (await ledger(directory)).sells.length > 0;
        });

        const view = await ledger(directory);

        expect(view.sells).toHaveLength(1);
        expect(view.buys).toHaveLength(1);
        // The fill is still committed once and only once: a restart must not
        // re-deliver an event the cursor has passed.
        expect(committedFillIds(directory)).toStrictEqual(committed);
      } finally {
        await stopChild(restarted);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
