import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeMarketData } from '@moi/market-data';
import { decimal } from '@moi/trading-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { buildApp } from '../paper-api/src/app.js';
import { type AppConfig, ZERO_FEE_SCHEDULES } from '../paper-api/src/config.js';
import { createDatabase, type Database } from '../paper-api/src/db/database.js';
import { UnitOfWork } from '../paper-api/src/db/unit-of-work.js';
import { PaperEngine } from '../paper-api/src/engine/paper-engine.js';
import type { LeaderLease } from '../paper-api/src/market-data/leader-lease.js';
import { MarketStateStore } from '../paper-api/src/market-data/market-state-store.js';
import { RecoveryCoordinator } from '../paper-api/src/market-data/recovery-coordinator.js';
import { registerFxRoutes } from '../paper-api/src/modules/fx/fx-routes.js';
import { FxService } from '../paper-api/src/modules/fx/fx-service.js';
import { registerHealthRoutes } from '../paper-api/src/modules/health/health-routes.js';
import { registerInstrumentRoutes } from '../paper-api/src/modules/instruments/instrument-routes.js';
import { InstrumentService } from '../paper-api/src/modules/instruments/instrument-service.js';
import { OrderPlacementService } from '../paper-api/src/modules/orders/order-placement-service.js';
import { registerOrderRoutes } from '../paper-api/src/modules/orders/order-routes.js';
import { OrderService } from '../paper-api/src/modules/orders/order-service.js';
import { registerPortfolioRoutes } from '../paper-api/src/modules/portfolio/portfolio-routes.js';
import { registerSessionRoutes } from '../paper-api/src/modules/session/session-routes.js';
import {
  createUnitOfWorkSessionStore,
  type SessionPrincipal,
  SessionService,
} from '../paper-api/src/modules/session/session-service.js';
import { SESSION_COOKIE } from '../paper-api/src/modules/session/session-token.js';
import {
  claimPendingOutbox,
  markOutboxPublished,
  OutboxPublisher,
} from '../paper-api/src/modules/stream/outbox-publisher.js';
import { StreamHeartbeatLoop } from '../paper-api/src/modules/stream/stream-heartbeat-loop.js';
import { StreamHub } from '../paper-api/src/modules/stream/stream-hub.js';
import type {
  DurableAccountEvent,
  DurableEventSource,
} from '../paper-api/src/modules/stream/stream-session.js';
import {
  createStreamUpgradeHandler,
  type StreamUpgradeHandler,
} from '../paper-api/src/modules/stream/stream-upgrade.js';
import { requireCsrf } from '../paper-api/src/plugins/csrf.js';
import { LayeredRateLimiter } from '../paper-api/src/plugins/rate-limits.js';
import { cookieValue } from '../paper-api/src/plugins/session-auth.js';
import { feeModelFor } from '../paper-api/src/runtime/fee-schedule.js';
import { createFillPersistence } from '../paper-api/src/runtime/fill-persistence.js';
import { createOrderCancellation } from '../paper-api/src/runtime/order-cancellation.js';
import { createTriggerPersistence } from '../paper-api/src/runtime/trigger-persistence.js';
import { stateFilePath } from './state-file.js';

const API_PORT = 3100;
const WEB_PORT = 4173;
const CONTROL_PORT = 3101;
// The second deployment shape (#25). Production comes in two:
//
//   * the Oracle reference host, where Caddy serves the app and the API from
//     one hostname and routes by path (spec §16.29) — modelled by the vite
//     preview proxy on WEB_PORT, which is what every project used to use;
//   * the base compose, where `apps/web/server.mjs` serves the bundle on its
//     own origin and injects `PUBLIC_API_ORIGIN` into `/runtime-config.js`,
//     so the browser talks to the API cross-origin.
//
// Only the first was ever exercised, and it is the one that cannot see a
// wrong API origin: every request goes to the page's own origin either way.
// These two ports carry the second shape. A different port is a different
// origin, so the browser really performs CORS preflight, credentialed fetch,
// the CSRF `Origin` check and the WebSocket `Origin` check. The API's
// `publicOrigin` is per-instance, so the shape needs its own listener rather
// than a second web server pointed at the first.
const CROSS_API_PORT = 3102;
const CROSS_WEB_PORT = 4174;
const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageRoot, '../..');
const publicOrigin = `http://127.0.0.1:${WEB_PORT}`;
const crossWebOrigin = `http://127.0.0.1:${CROSS_WEB_PORT}`;
const crossApiOrigin = `http://127.0.0.1:${CROSS_API_PORT}`;
const controlCredential = randomBytes(32).toString('base64url');

type Market = 'KR' | 'US';
type Book = Readonly<{
  bids: readonly { price: string; volume: string }[];
  asks: readonly { price: string; volume: string }[];
}>;
type Mode = 'NORMAL' | 'DEGRADED' | 'RECOVERING' | 'CANCEL_ONLY';
type JsonObject = Record<string, unknown>;

const books = new Map<string, Book>();
const streamHub = new StreamHub();
const streamEvents = new Map<string, DurableAccountEvent[]>();
const streamSessions = new Set<string>();
let streamBridge: StreamUpgradeHandler | undefined;
let crossStreamBridge: StreamUpgradeHandler | undefined;
let streamHeartbeat: StreamHeartbeatLoop | undefined;
let mode: Mode = 'NORMAL';
let snapshotRequestCount = 0;
let snapshotCompletedCount = 0;
let snapshotInFlight = 0;
let snapshotMaxConcurrency = 0;
let snapshotBarrier: Promise<void> | undefined;
let releaseSnapshotBarrier: (() => void) | undefined;
let pool: Pool;
let postgres: StartedTestContainer;
let redis: StartedTestContainer;
let apiApp: FastifyInstance;
let crossApiApp: FastifyInstance | undefined;
let controlServer: Server;
let webProcess: ChildProcess | undefined;
let crossWebProcess: ChildProcess | undefined;
let database: Database | undefined;
let unitOfWork: UnitOfWork | undefined;
let sessionService: SessionService | undefined;
const engines = new Map<Market, PaperEngine>();
const recoveryCoordinators = new Map<Market, RecoveryCoordinator>();
let fakeMarketData: FakeMarketData | undefined;
let cleanupPromise: Promise<void> | undefined;

type PublicRequest = IncomingMessage | FastifyRequest;
type JsonResponse = ServerResponse | FastifyReply;

const json = (
  response: JsonResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  if ('raw' in response) {
    response.code(statusCode).headers(headers).send(body);
    return;
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
};

async function body(request: PublicRequest): Promise<JsonObject> {
  if ('raw' in request) return (request.body ?? {}) as JsonObject;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject;
}

const streamSource: DurableEventSource = {
  latest: (session) => currentSequence(session),
  oldest: async (session) => streamEvents.get(session)?.[0]?.accountSequence,
  replay: async (session, afterSequence) =>
    (streamEvents.get(session) ?? []).filter(
      (event) =>
        afterSequence === undefined ||
        BigInt(event.accountSequence) > BigInt(afterSequence),
    ),
};

function sendStream(session: string, value: unknown, repeats = 1): void {
  const frame = value as {
    type: string;
    eventId?: string;
    accountSequence?: string;
    eventType?: string;
    payload?: unknown;
  };
  if (frame.type !== 'event') {
    streamHub.sendControl(session, value);
    return;
  }
  const event: DurableAccountEvent = {
    id: randomUUID(),
    eventId: frame.eventId ?? randomUUID(),
    sessionId: session,
    accountSequence: frame.accountSequence ?? '0',
    eventType: frame.eventType ?? 'EVENT',
    payload: frame.payload,
    createdAt: new Date().toISOString(),
  };
  const log = streamEvents.get(session) ?? [];
  log.push(event);
  streamEvents.set(session, log);
  for (let index = 0; index < repeats; index += 1)
    void streamHub.deliver(session, event);
}

async function currentSequence(session: string): Promise<string> {
  const result = await pool.query<{ sequence: string }>(
    'select coalesce(max(account_sequence), 0)::text as sequence from account_sequences where session_id = $1',
    [session],
  );
  return result.rows[0]?.sequence ?? '0';
}

/**
 * Delivers the ledger's own outbox rows — the same publisher, enrichment and
 * frame shape production uses — instead of allocating a parallel account
 * sequence for a hand-made snapshot. Options exist only for the resync
 * journeys: `duplicate` redelivers each frame twice (at-least-once), and
 * `gap` is handled by `/sequence-gap`.
 */
async function drainOutbox(
  options: {
    duplicate?: boolean;
    /**
     * FAULT INJECTION for the sequence-gap journey: every claimed row is
     * consumed but only the newest frame is delivered, as if the frames were
     * lost in flight. Production delivers every row; recovery of the missing
     * ones is the browser's REST resync, which is what the journey asserts.
     */
    deliverOnlyLast?: boolean;
  } = {},
): Promise<void> {
  if (!database || !unitOfWork) throw new Error('database is not initialized');
  const db = database;
  const uow = unitOfWork;
  const pending = await db
    .transaction()
    .execute((trx) => claimPendingOutbox(trx, 1000));
  const lastId = pending.at(-1)?.id;
  const publisher = new OutboxPublisher({
    claim: () => Promise.resolve(pending),
    markPublished: (id) =>
      db.transaction().execute((trx) => markOutboxPublished(trx, id)),
    publish: async (event) => {
      // The gap journey: every row is consumed, only the newest is delivered,
      // so the browser observes a jump in account sequence exactly as it would
      // after missing frames from a real publisher.
      if (options.deliverOnlyLast && event.id !== lastId) return;
      const snapshot = (await uow.run((tx) =>
        tx.portfolio.snapshot(event.sessionId),
      )) as unknown as Record<string, unknown>;
      sendStream(
        event.sessionId,
        {
          type: 'event',
          eventId: event.eventId,
          accountSequence: event.accountSequence,
          eventType: event.eventType,
          payload: {
            ...(typeof event.payload === 'object' && event.payload !== null
              ? (event.payload as Record<string, unknown>)
              : {}),
            ...snapshot,
          },
        },
        options.duplicate ? 2 : 1,
      );
    },
  });
  await publisher.pollOnce();
}

function health(): JsonObject {
  const reasonCodes =
    mode === 'DEGRADED'
      ? ['MARKET_DATA_DEGRADED']
      : mode === 'RECOVERING'
        ? ['RECOVERY_IN_PROGRESS']
        : mode === 'CANCEL_ONLY'
          ? ['CANCEL_ONLY']
          : [];
  return {
    mode,
    canPlace: mode === 'NORMAL',
    canCancel: true,
    canFx: mode === 'NORMAL' || mode === 'DEGRADED' || mode === 'RECOVERING',
    reasonCodes,
  };
}

/**
 * Production seeds USD at 0 until the user converts; the browser journeys
 * place US orders directly, so the harness funds a USD balance per session.
 */
function fundedSessionStore(
  store: ReturnType<typeof createUnitOfWorkSessionStore>,
): ReturnType<typeof createUnitOfWorkSessionStore> {
  return {
    ...store,
    bootstrap: async (input) => {
      const principal = await store.bootstrap(input);
      await pool.query(
        `update wallets set total = 100000, available = 100000, version = version + 1
          where session_id = $1 and currency = 'USD' and total = 0`,
        [principal.id],
      );
      return principal;
    },
  };
}

/**
 * The harness persists fills, triggers, and cancellations through the SAME
 * modules production uses (lock order, settlement, terminal rejection), so a
 * browser journey exercises the real ledger semantics instead of a copy that
 * could drift from them.
 */
function ledgerPersistence(market: Market) {
  if (!database) throw new Error('database is not initialized');
  const feeModel = feeModelFor(ZERO_FEE_SCHEDULES, market);
  const log = (event: string, fields: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', event, ...fields }));
  return {
    feeModel,
    onFill: createFillPersistence({
      db: database,
      log,
      estimateFee: (price, quantity) =>
        feeModel.calculate({ market, side: 'BUY', price, quantity }),
    }),
    onConditionalTrigger: createTriggerPersistence({
      db: database,
      feeModelFor: () => feeModel,
      log,
    }),
  };
}

let marketVersion = 0n;
async function injectBook(
  input: {
    market: Market;
    symbol: string;
    bids: Book['bids'];
    asks: Book['asks'];
  },
  recovery = false,
): Promise<void> {
  const book = {
    market: input.market,
    symbol: input.symbol,
    currency: input.market === 'KR' ? ('KRW' as const) : ('USD' as const),
    bids: input.bids.map((level) => ({
      price: level.price,
      volume: level.volume,
    })),
    asks: input.asks.map((level) => ({
      price: level.price,
      volume: level.volume,
    })),
  };
  if (!recovery) {
    fakeMarketData?.emitOrderBook({
      market: input.market,
      symbol: input.symbol,
      book,
      sourceTimestamp: null,
    });
    const event = await fakeMarketData?.next();
    if (event?.kind !== 'orderBook')
      throw new Error('fake market-data barrier expected an order book');
  }
  marketVersion += 1n;
  const envelope = {
    recoveryEpoch: recovery ? 2n : 1n,
    leaderFencingToken: 1n,
    marketDataVersion: marketVersion,
    payload: book,
  };
  const marketEngine = engines.get(input.market);
  if (!marketEngine) throw new Error(`missing ${input.market} paper engine`);
  if (recovery) await marketEngine.onRecoveryOrderBook(envelope);
  else await marketEngine.onOrderBook(envelope);
  // What `MarketRuntime.#publishQuote` sends: the price and the instant as
  // well as the depth. The harness used to hand books straight to the engine
  // and publish nothing, so no e2e run ever pushed a `quote` frame at the
  // browser — the one path the production crash lived on.
  streamHub.publishQuote({
    market: input.market,
    symbol: input.symbol,
    recoveryEpoch: envelope.recoveryEpoch,
    marketDataVersion: envelope.marketDataVersion,
    payload: {
      market: input.market,
      symbol: input.symbol,
      price: book.asks[0]?.price ?? book.bids[0]?.price ?? null,
      asOf: new Date().toISOString(),
      currency: book.currency,
      bids: book.bids,
      asks: book.asks,
    },
  });
}

async function resetState(): Promise<void> {
  await streamHub.closeAll(1000, 'reset');
  streamEvents.clear();
  streamSessions.clear();
  await Promise.all(
    [...engines.values()].map((marketEngine) => marketEngine.reset()),
  );
  marketVersion = 0n;
  await fakeMarketData?.connect(new AbortController().signal);
  await fakeMarketData?.declare([
    { channel: 'orderBook', market: 'KR', symbols: ['005930'] },
    { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
    { channel: 'trade', market: 'US', symbols: ['AAPL'] },
  ]);
  books.clear();
  mode = 'NORMAL';
  snapshotRequestCount = 0;
  snapshotCompletedCount = 0;
  snapshotInFlight = 0;
  snapshotMaxConcurrency = 0;
  releaseSnapshotBarrier?.();
  snapshotBarrier = undefined;
  releaseSnapshotBarrier = undefined;
  await pool.query('truncate anonymous_sessions cascade');
}

async function controlApi(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.headers.authorization !== `Bearer ${controlCredential}`) {
    json(response, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${CONTROL_PORT}`);
  const input = request.method === 'POST' ? await body(request) : {};
  if (request.method === 'POST' && url.pathname === '/reset') {
    await resetState();
    json(response, 200, { reset: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/book') {
    const injected = {
      market: input.market as Market,
      symbol: String(input.symbol),
      bids: input.bids as Book['bids'],
      asks: input.asks as Book['asks'],
    };
    books.set(`${input.market}:${input.symbol}`, injected);
    await injectBook(injected);
    json(response, 200, { updated: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/mode') {
    mode = input.mode as Mode;
    json(response, 200, { mode });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/recover') {
    mode = 'RECOVERING';
    const snapshot = [...books.entries()][0];
    if (!snapshot) {
      json(response, 409, { error: 'recovery snapshot is missing' });
      return;
    }
    const [key, recoveredBook] = snapshot;
    const [market, symbol] = key.split(':') as [Market, string];
    const outcome = await recoveryCoordinators
      .get(market)
      ?.recover(market, new AbortController().signal);
    if (!outcome || outcome.blockedSymbols.length > 0) {
      mode = 'DEGRADED';
      json(response, 503, { error: 'REST recovery snapshot failed' });
      return;
    }
    await injectBook({ market, symbol, ...recoveredBook }, true);
    mode = 'NORMAL';
    json(response, 200, {
      mode,
      recoveredSymbols: outcome.recoveredSymbols,
      transitions: ['DEGRADED', 'RECOVERING', 'NORMAL'],
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/latest-order') {
    const result = await pool.query<{ id: string }>(
      'select id::text from orders order by created_at desc, id desc limit 1',
    );
    json(response, 200, { id: result.rows[0]?.id });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/order-status') {
    const result = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [url.searchParams.get('id')],
    );
    json(response, 200, { status: result.rows[0]?.status });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/fill') {
    const order = await pool.query<{
      sessionId: string;
      market: Market;
      symbol: string;
      side: string;
      quantity: string;
      filled: string;
      status: string;
    }>(
      `select session_id::text as "sessionId", market_code as market, symbol, side,
              quantity::text, filled_quantity::text as filled, status
       from orders where id = $1`,
      [input.orderId],
    );
    const row = order.rows[0];
    if (
      !row ||
      ['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(row.status)
    ) {
      json(response, 409, { error: 'order is terminal or missing' });
      return;
    }
    await injectBook({
      market: row.market,
      symbol: row.symbol,
      bids: [
        {
          price:
            row.side === 'SELL'
              ? String(input.price)
              : decimal(String(input.price)).minus('1').toString(),
          volume: String(input.quantity),
        },
      ],
      asks: [
        {
          price:
            row.side === 'BUY'
              ? String(input.price)
              : decimal(String(input.price)).plus('1').toString(),
          volume: String(input.quantity),
        },
      ],
    });
    const status = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [input.orderId],
    );
    await drainOutbox({ duplicate: input.duplicate === true });
    json(response, 200, { status: status.rows[0]?.status });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/trigger-oco') {
    const target = await pool.query<{
      market: Market;
      symbol: string;
      sessionId: string;
    }>(
      'select market_code as market, symbol, session_id::text as "sessionId" from orders where id = $1',
      [input.orderId],
    );
    const row = target.rows[0];
    if (!row) {
      json(response, 404, { error: 'order missing' });
      return;
    }
    fakeMarketData?.emitTrade({
      market: row.market,
      symbol: row.symbol,
      price: String(input.price),
      volume: '1',
      sourceTimestamp: null,
    });
    const event = await fakeMarketData?.next();
    if (event?.kind !== 'trade')
      throw new Error('fake market-data barrier expected a trade');
    marketVersion += 1n;
    await engines.get(row.market)?.onTrade({
      recoveryEpoch: 1n,
      leaderFencingToken: 1n,
      marketDataVersion: marketVersion,
      payload: {
        market: event.market,
        symbol: event.symbol,
        price: event.price,
        sourceTimestamp: event.sourceTimestamp,
        source: 'WEBSOCKET',
      },
    });
    // Production publishes the trigger's outbox rows; the harness drives its
    // browser stream from snapshots, so mirror the resolution to the session.
    await drainOutbox();
    json(response, 200, { resolved: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/sequence-gap') {
    const session = [...streamSessions][0];
    const count = Number(input.count ?? 1);
    if (session) {
      if (!unitOfWork) throw new Error('unit of work is not initialized');
      // Real ledger mutations (session lock, allocated sequences, outbox rows)
      // whose frames are then dropped except the last: a genuine gap.
      await unitOfWork.run(async (tx) => {
        await tx.sessions.lock(session);
        for (let index = 0; index < count; index += 1) {
          const sequence = await tx.sequences.allocate({
            sessionId: session,
            mutationKind: `SEQUENCE_GAP_${index}`,
          });
          await tx.outbox.append({
            id: randomUUID(),
            eventId: randomUUID(),
            sessionId: session,
            streamSequence: sequence,
            eventType: `SEQUENCE_GAP_${index}`,
            payload: { index },
          });
        }
      });
      await drainOutbox({ deliverOnlyLast: true });
      if (input.resync === true)
        sendStream(session, {
          type: 'resync-required',
          reason: 'OUTBOX_GAP',
        });
    }
    json(response, 200, { emitted: Boolean(session) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/snapshot-barrier') {
    if (input.action === 'hold' && !snapshotBarrier)
      snapshotBarrier = new Promise<void>((resolveBarrier) => {
        releaseSnapshotBarrier = resolveBarrier;
      });
    if (input.action === 'release') {
      releaseSnapshotBarrier?.();
      snapshotBarrier = undefined;
      releaseSnapshotBarrier = undefined;
    }
    json(response, 200, { held: snapshotBarrier !== undefined });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/stream-count') {
    json(response, 200, { count: streamHub.size() });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/snapshot-count') {
    json(response, 200, {
      count: snapshotRequestCount,
      completed: snapshotCompletedCount,
      inFlight: snapshotInFlight,
      maxConcurrency: snapshotMaxConcurrency,
    });
    return;
  }
  json(response, 404, { error: 'control not found' });
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

async function assertPortFree(port: number): Promise<void> {
  const probe = createServer();
  await listen(probe, port);
  await new Promise<void>((resolveClose, reject) =>
    probe.close((error) => (error ? reject(error) : resolveClose())),
  );
}

async function runPnpm(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('pnpm', [...args], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        VITE_MOI_ALLOW_LOCAL_HTTP: 'true',
      },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error(`pnpm ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function waitForWeb(origin: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // The condition is polled until the bounded readiness deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`web server at ${origin} did not become ready`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) =>
    child.once('exit', () => resolveExit()),
  );
  child.kill('SIGTERM');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), 5_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!graceful) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function settle(
  work: (() => Promise<unknown>) | undefined,
): Promise<void> {
  if (!work) return;
  try {
    await work();
  } catch (error) {
    console.error('E2E teardown step failed', error);
  }
}

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    await settle(
      controlServer
        ? () =>
            new Promise<void>((resolveClose) =>
              controlServer.close(() => resolveClose()),
            )
        : undefined,
    );
    streamHeartbeat?.stop();
    streamBridge?.detach();
    crossStreamBridge?.detach();
    await settle(() => streamHub.closeAll(1012, 'SERVICE_RESTART'));
    await settle(apiApp ? () => apiApp.close() : undefined);
    const crossApi = crossApiApp;
    await settle(crossApi ? () => crossApi.close() : undefined);
    await settle(() => stopChild(webProcess));
    await settle(() => stopChild(crossWebProcess));
    const feed = fakeMarketData;
    const ledger = database;
    await settle(feed ? () => feed.close() : undefined);
    await settle(ledger ? () => ledger.destroy() : undefined);
    await settle(pool ? () => pool.end() : undefined);
    await settle(redis ? () => redis.stop() : undefined);
    await settle(postgres ? () => postgres.stop() : undefined);
    await settle(() => rm(stateFilePath, { force: true }));
  })();
  return cleanupPromise;
}

async function principal(request: unknown): Promise<SessionPrincipal> {
  if (!sessionService) throw new Error('session service is not initialized');
  const token = cookieValue(request as FastifyRequest, SESSION_COOKIE);
  if (!token)
    throw Object.assign(new Error('session is required'), {
      code: 'SESSION_EXPIRED',
      statusCode: 401,
    });
  const authenticated = await sessionService.authenticate(token);
  return authenticated.session;
}

async function executeCancelOrAmend(command: {
  action: 'place' | 'amend' | 'cancel';
  sessionId: string;
  orderId?: string;
  input?: unknown;
}): Promise<unknown> {
  if (command.action === 'cancel') {
    if (!unitOfWork) throw new Error('unit of work is not initialized');
    const cancel = createOrderCancellation({
      uow: unitOfWork,
      engines: () => engines.values(),
      log: (event, fields) =>
        console.log(JSON.stringify({ level: 'info', event, ...fields })),
    });
    const result = await cancel({
      sessionId: command.sessionId,
      orderId: String(command.orderId),
    });
    if (result.cancelledOrderIds.length > 0) await drainOutbox();
    return { id: result.id, status: result.status };
  }
  if (command.action === 'amend')
    throw Object.assign(new Error('amendment is unavailable in E2E'), {
      code: 'ORDER_STATE_CONFLICT',
      statusCode: 409,
    });
  throw new Error('placement must use OrderPlacementService');
}

async function main(): Promise<void> {
  await Promise.all(
    [API_PORT, WEB_PORT, CONTROL_PORT, CROSS_API_PORT, CROSS_WEB_PORT].map(
      assertPortFree,
    ),
  );
  postgres = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'moi',
      POSTGRES_PASSWORD: 'moi',
      POSTGRES_DB: 'moi',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  pool = new Pool({
    host: postgres.getHost(),
    port: postgres.getMappedPort(5432),
    user: 'moi',
    password: 'moi',
    database: 'moi',
  });
  // Every migration, read from the directory in order, rather than a hardcoded
  // list: a list silently drifts from production the moment a migration is
  // added — it had already missed `003_leader_release`, and a schema the API
  // expects but the harness never applied fails as an opaque 500 in a browser
  // test rather than as a migration error.
  const migrationsDirectory = resolve(
    workspaceRoot,
    'apps/paper-api/src/db/migrations',
  );
  const migrations = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const migration of migrations) {
    await pool.query(
      await readFile(resolve(migrationsDirectory, migration), 'utf8'),
    );
  }
  // The harness is the only leader: production fill/trigger persistence
  // re-checks its envelope fencing token (1n) against leader_epochs (§7.1).
  await pool.query(
    `insert into leader_epochs (id, market_code, epoch, fencing_token, leader_id)
     values (gen_random_uuid(), 'KR', 1, 1, 'e2e-harness'), (gen_random_uuid(), 'US', 1, 1, 'e2e-harness')
     on conflict (market_code) do update set epoch = 1, fencing_token = 1, leader_id = 'e2e-harness'`,
  );
  const config: AppConfig = {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: API_PORT,
    publicOrigin,
    databaseUrl: `postgresql://moi:moi@${postgres.getHost()}:${postgres.getMappedPort(5432)}/moi`,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    sessionHashKeys: [randomBytes(32).toString('base64url')],
    csrfSecret: randomBytes(32).toString('base64url'),
    adminApiKey: controlCredential,
    marketDataAdapter: 'fake',
    shutdownDrainDeadlineMs: 30_000,
    trustProxy: false,
    rateLimitsEnabled: false,
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
  };
  // Same everything, one different port and one different browser origin.
  const crossConfig: AppConfig = {
    ...config,
    port: CROSS_API_PORT,
    publicOrigin: crossWebOrigin,
  };
  database = createDatabase(config.databaseUrl);
  unitOfWork = new UnitOfWork(database, { backoff: async () => undefined });
  sessionService = new SessionService({
    keys: config.sessionHashKeys,
    csrfSecret: config.csrfSecret,
    store: fundedSessionStore(createUnitOfWorkSessionStore(unitOfWork)),
    secureCookie: false,
  });
  fakeMarketData = new FakeMarketData();
  await fakeMarketData.connect(new AbortController().signal);
  await fakeMarketData.declare([
    { channel: 'orderBook', market: 'KR', symbols: ['005930'] },
    { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
    { channel: 'trade', market: 'US', symbols: ['AAPL'] },
  ]);
  for (const [market, currency] of [
    ['KR', 'KRW'],
    ['US', 'USD'],
  ] as const) {
    engines.set(
      market,
      new PaperEngine({
        ...ledgerPersistence(market),
        isGateExclusive: () => mode === 'DEGRADED' || mode === 'CANCEL_ONLY',
      }),
    );
    const symbols = market === 'KR' ? ['005930'] : ['AAPL'];
    recoveryCoordinators.set(
      market,
      new RecoveryCoordinator({
        stream: fakeMarketData,
        stateStore: new MarketStateStore(),
        symbols,
        subscriptions: [
          { channel: 'orderBook', market, symbols },
          { channel: 'trade', market, symbols },
        ],
        acquireLease: async () =>
          ({ epoch: 2n, fencingToken: 1n }) as LeaderLease,
        snapshots: {
          getRecoverySnapshot: async (_market, symbol) => {
            const current = books.get(`${market}:${symbol}`);
            if (!current) throw new Error('recovery book is not seeded');
            return {
              market,
              symbol,
              price: current.asks[0]?.price ?? current.bids[0]?.price ?? '0',
              book: {
                market,
                symbol,
                currency,
                bids: current.bids.map((level) => ({
                  price: level.price,
                  volume: level.volume,
                })),
                asks: current.asks.map((level) => ({
                  price: level.price,
                  volume: level.volume,
                })),
              },
              fetchedAt: new Date().toISOString(),
            };
          },
        },
        stabilityMs: 0,
      }),
    );
  }
  const orderPlacementService = new OrderPlacementService({
    unitOfWork,
    engine: (market) => engines.get(market),
    afterPlacement: () => drainOutbox(),
  });
  const orderService = new OrderService({
    placement: orderPlacementService,
    execute: executeCancelOrAmend,
    capabilities: () =>
      mode === 'NORMAL'
        ? new Set(['PLACE', 'AMEND', 'CANCEL'])
        : new Set(['CANCEL']),
  });
  const fxService = new FxService({
    loadWallets: async (sessionId) => {
      const rows = await pool.query<{
        currency: 'KRW' | 'USD';
        available: string;
      }>(
        'select currency, available::text from wallets where session_id = $1',
        [sessionId],
      );
      return new Map(rows.rows.map((row) => [row.currency, row.available]));
    },
    onExchange: async (quote) => {
      await pool.query(
        `update wallets
            set total = total - $2::numeric, available = available - $2::numeric,
                version = version + 1
          where session_id = $1 and currency = $3`,
        [quote.sessionId, quote.sourceAmount, quote.from],
      );
      await pool.query(
        `update wallets
            set total = total + $2::numeric, available = available + $2::numeric,
                version = version + 1
          where session_id = $1 and currency = $3`,
        [quote.sessionId, quote.targetAmount, quote.to],
      );
      await drainOutbox();
    },
  });
  // Both deployment shapes are the same system — one database, one engine
  // set, one control server — and differ only in the origin the browser
  // sits on. The API bakes that origin into `publicOrigin` (CORS, the
  // `Origin` fence in `buildApp`, the CSRF hook below and the WebSocket
  // upgrade all compare against it), so each shape gets its own listener
  // over the shared services.
  const buildPaperApi = (instanceConfig: AppConfig) =>
    buildApp(instanceConfig, {
      clock: { now: () => Date.now() },
      registerRoutes: async (app) => {
        app.addHook('preHandler', async (request) => {
          if (
            request.method === 'GET' &&
            request.url.startsWith('/api/v1/portfolio')
          ) {
            snapshotRequestCount += 1;
            snapshotInFlight += 1;
            snapshotMaxConcurrency = Math.max(
              snapshotMaxConcurrency,
              snapshotInFlight,
            );
            await snapshotBarrier;
          }
          if (
            request.method === 'POST' &&
            request.url.startsWith('/api/v1/sessions/anonymous')
          )
            return;
          if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))
            return;
          // The production CSRF rule itself, not a copy of its condition
          // (Codex review of #25): each listener passes its own origin and
          // secret, so the cross-origin listener rejects the single-origin
          // page's requests the way production would.
          requireCsrf(request, await principal(request), {
            secret: instanceConfig.csrfSecret,
            origin: instanceConfig.publicOrigin,
          });
        });
        app.addHook('onResponse', async (request) => {
          if (
            request.method === 'GET' &&
            request.url.startsWith('/api/v1/portfolio')
          ) {
            snapshotInFlight -= 1;
            snapshotCompletedCount += 1;
          }
        });
        await registerSessionRoutes(app, sessionService as SessionService);
        await registerHealthRoutes(app, {
          db: async () => {
            await pool.query('select 1');
            return true;
          },
          audit: () => true,
          marketData: () => ({ mode }),
          trading: () => health(),
        });
        await registerInstrumentRoutes(
          app,
          new InstrumentService({
            catalog: [
              {
                market: 'KR',
                symbol: '005930',
                name: 'Samsung Electronics',
                tradable: true,
                currency: 'KRW',
              },
              {
                market: 'US',
                symbol: 'AAPL',
                name: 'Apple',
                tradable: true,
                currency: 'USD',
              },
            ],
          }),
          // Mirrors `ProductionRuntime.#quote` field for field, including the
          // book: a harness that answers in a shape production never serves
          // cannot catch a wire/type mismatch, and this one used to answer
          // `bids`/`asks` spelled `size` — the web's spelling, not the wire's —
          // which is precisely why e2e stayed green through the crash.
          (market, symbol) => {
            const current = books.get(`${market}:${symbol}`) ?? {
              bids: [
                { price: market === 'KR' ? '69900' : '199', volume: '10' },
              ],
              asks: [
                { price: market === 'KR' ? '70000' : '200', volume: '10' },
              ],
            };
            return {
              market,
              symbol,
              price: current.asks[0]?.price ?? null,
              asOf: new Date().toISOString(),
              health: mode === 'NORMAL' ? 'HEALTHY' : mode,
              recoveryEpoch: mode === 'NORMAL' ? '2' : '1',
              marketDataVersion: marketVersion.toString(),
              currency: market === 'KR' ? 'KRW' : 'USD',
              bids: current.bids,
              asks: current.asks,
            };
          },
        );
        await registerPortfolioRoutes(app, {
          principal,
          unitOfWork: unitOfWork as UnitOfWork,
        });
        await registerFxRoutes(app, fxService, {
          principal,
          canFx: () => mode !== 'CANCEL_ONLY',
        });
        await registerOrderRoutes(app, {
          principal,
          service: orderService,
        });
      },
    });
  apiApp = await buildPaperApi(config);
  crossApiApp = await buildPaperApi(crossConfig);
  await apiApp.ready();
  await crossApiApp.ready();
  const streamSessionService = sessionService;
  streamBridge = createStreamUpgradeHandler({
    server: apiApp.server,
    publicOrigin,
    sessionService: {
      authenticate: async (token) => {
        const result = await streamSessionService.authenticate(token);
        streamSessions.add(result.session.id);
        return result;
      },
    },
    limiter: new LayeredRateLimiter(),
    hub: streamHub,
    gate: { isOpen: () => true },
    source: streamSource,
    tradableSymbols: new Set(['KR:005930', 'US:AAPL']),
  });
  streamBridge.attach();
  // The same hub behind the second listener: a browser on the cross-origin
  // page upgrades against `crossApiOrigin`, and the upgrade handler checks the
  // `Origin` header against that listener's own public origin.
  crossStreamBridge = createStreamUpgradeHandler({
    server: crossApiApp.server,
    publicOrigin: crossWebOrigin,
    sessionService: {
      authenticate: async (token) => {
        const result = await streamSessionService.authenticate(token);
        streamSessions.add(result.session.id);
        return result;
      },
    },
    limiter: new LayeredRateLimiter(),
    hub: streamHub,
    gate: { isOpen: () => true },
    source: streamSource,
    tradableSymbols: new Set(['KR:005930', 'US:AAPL']),
  });
  crossStreamBridge.attach();
  streamHeartbeat = new StreamHeartbeatLoop({ hub: streamHub });
  streamHeartbeat.start();
  controlServer = createServer((request, response) => {
    void controlApi(request, response).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent)
        json(response, 500, { error: 'control failed' });
    });
  });
  await Promise.all([
    apiApp.listen({ host: config.host, port: config.port }),
    crossApiApp.listen({ host: crossConfig.host, port: crossConfig.port }),
    listen(controlServer, CONTROL_PORT),
  ]);
  await writeFile(
    stateFilePath,
    JSON.stringify({
      controlOrigin: `http://127.0.0.1:${CONTROL_PORT}`,
      credential: controlCredential,
    }),
    { mode: 0o600 },
  );
  await runPnpm(['--filter', '@moi/web', 'build']);
  webProcess = spawn(
    'pnpm',
    [
      '--filter',
      '@moi/web',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(WEB_PORT),
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        MOI_DEV_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      },
      stdio: 'inherit',
    },
  );
  // The second shape serves the very same `dist` through the production static
  // server, which is what generates `/runtime-config.js` from
  // `PUBLIC_API_ORIGIN`. Nothing proxies `/api` here: the bundle reads that
  // origin and goes to the other listener itself.
  crossWebProcess = spawn(
    'node',
    [resolve(workspaceRoot, 'apps/web/server.mjs')],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        WEB_DIST_DIR: resolve(workspaceRoot, 'apps/web/dist'),
        HOST: '127.0.0.1',
        PORT: String(CROSS_WEB_PORT),
        PUBLIC_API_ORIGIN: crossApiOrigin,
      },
      stdio: 'inherit',
    },
  );
  await Promise.all([waitForWeb(publicOrigin), waitForWeb(crossWebOrigin)]);
  console.log(
    `Moi E2E system ready at ${publicOrigin} (single origin) and ${crossWebOrigin} → ${crossApiOrigin} (cross origin)`,
  );
}

process.once('SIGTERM', () => void cleanup().finally(() => process.exit(0)));
process.once('SIGINT', () => void cleanup().finally(() => process.exit(0)));
process.once('exit', () => {
  webProcess?.kill('SIGTERM');
  crossWebProcess?.kill('SIGTERM');
});

await main().catch(async (error: unknown) => {
  console.error(error);
  await cleanup();
  process.exitCode = 1;
});
