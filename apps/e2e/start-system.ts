import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeMarketData } from '@moi/market-data';
import { createFeeModel, decimal } from '@moi/trading-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { buildApp } from '../paper-api/src/app.js';
import type { AppConfig } from '../paper-api/src/config.js';
import { createDatabase, type Database } from '../paper-api/src/db/database.js';
import { UnitOfWork } from '../paper-api/src/db/unit-of-work.js';
import type { OrderMatch } from '../paper-api/src/engine/match-orders.js';
import {
  type ConditionalPaperOrder,
  PaperEngine,
  type PaperOrder,
} from '../paper-api/src/engine/paper-engine.js';
import type { PricingContext } from '../paper-api/src/engine/pricing-context.js';
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
  SessionService,
  verifyCsrfToken,
} from '../paper-api/src/modules/session/session-service.js';
import { SESSION_COOKIE } from '../paper-api/src/modules/session/session-token.js';
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
import { LayeredRateLimiter } from '../paper-api/src/plugins/rate-limits.js';
import { cookieValue } from '../paper-api/src/plugins/session-auth.js';
import { settleFill } from '../paper-api/src/runtime/fill-settlement.js';
import { stateFilePath } from './state-file.js';

const API_PORT = 3100;
const WEB_PORT = 4173;
const CONTROL_PORT = 3101;
const packageRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageRoot, '../..');
const publicOrigin = `http://127.0.0.1:${WEB_PORT}`;
const controlCredential = randomBytes(32).toString('base64url');

type Market = 'KR' | 'US';
type Book = Readonly<{
  bids: readonly { price: string; size: string }[];
  asks: readonly { price: string; size: string }[];
}>;
type Mode = 'NORMAL' | 'DEGRADED' | 'RECOVERING' | 'CANCEL_ONLY';
type JsonObject = Record<string, unknown>;

const books = new Map<string, Book>();
const streamHub = new StreamHub();
const streamEvents = new Map<string, DurableAccountEvent[]>();
const streamSessions = new Set<string>();
let streamBridge: StreamUpgradeHandler | undefined;
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
let controlServer: Server;
let webProcess: ChildProcess | undefined;
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

async function nextSequence(session: string, kind: string): Promise<string> {
  const result = await pool.query<{ sequence: string }>(
    `with next as (
       select coalesce(max(account_sequence), 0) + 1 as sequence
       from account_sequences where session_id = $1
     )
     insert into account_sequences (id, session_id, account_sequence, mutation_kind)
     select $2, $1, sequence, $3 from next
     returning account_sequence::text as sequence`,
    [session, randomUUID(), kind],
  );
  return result.rows[0]?.sequence ?? '0';
}

async function currentSequence(session: string): Promise<string> {
  const result = await pool.query<{ sequence: string }>(
    'select coalesce(max(account_sequence), 0)::text as sequence from account_sequences where session_id = $1',
    [session],
  );
  return result.rows[0]?.sequence ?? '0';
}

async function portfolio(session: string): Promise<JsonObject> {
  if (!unitOfWork) throw new Error('unit of work is not initialized');
  return (await unitOfWork.run((tx) =>
    tx.portfolio.snapshot(session),
  )) as unknown as JsonObject;
}

async function publishSnapshot(
  session: string,
  kind: string,
  options: { duplicate?: boolean; gap?: boolean; sequence?: string } = {},
): Promise<void> {
  let sequence = options.sequence ?? (await nextSequence(session, kind));
  if (options.gap) sequence = await nextSequence(session, `${kind}_GAP`);
  sendStream(
    session,
    {
      type: 'event',
      eventId: randomUUID(),
      accountSequence: sequence,
      eventType: kind,
      payload: await portfolio(session),
    },
    options.duplicate ? 2 : 1,
  );
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

async function persistEngineFill(
  order: PaperOrder,
  match: OrderMatch,
  pricing: PricingContext,
): Promise<void> {
  await pool.query(
    `update orders
        set filled_quantity = $2, status = $3, terminal_reason = $4,
            market_data_epoch = $5, updated_at = now(), version = version + 1
      where id = $1`,
    [
      order.id,
      match.filledQuantity,
      match.nextStatus,
      match.execution.terminalReason ?? null,
      pricing.recoveryEpoch.toString(),
    ],
  );
  for (const fill of match.execution.fills) {
    await pool.query(
      `insert into fills (
         id, order_id, price, quantity, fee, slippage, reference_trade_price,
         recovery_epoch, market_data_version, leader_fencing_token,
         is_recovery_fill
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        randomUUID(),
        order.id,
        fill.price,
        fill.quantity,
        fill.fee,
        match.execution.slippageAmount,
        pricing.referencePrice,
        pricing.recoveryEpoch.toString(),
        pricing.marketDataVersion.toString(),
        pricing.leaderFencingToken.toString(),
        pricing.recoveryFill === true,
      ],
    );
  }
  if (!database) throw new Error('database is not initialized');
  await database.transaction().execute((trx) =>
    settleFill(trx, {
      order: {
        id: order.id,
        sessionId: order.sessionId,
        market: order.market,
        symbol: order.symbol,
        side: order.side,
      },
      fills: match.execution.fills,
      terminal:
        match.nextStatus === 'FILLED' || match.nextStatus === 'CANCELLED',
    }),
  );
}

async function persistConditionalTrigger(
  order: ConditionalPaperOrder,
  pricing: PricingContext,
): Promise<void> {
  const group = await pool.query<{
    groupId: string;
    sessionId: string;
    symbol: string;
    quantity: string;
  }>(
    `select oco_group_id::text as "groupId", session_id::text as "sessionId",
            symbol, quantity::text
       from orders where id = $1 and oco_group_id is not null`,
    [order.id],
  );
  const row = group.rows[0];
  if (!row) throw new Error('conditional order has no OCO group');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `update orders
          set status = case when id = $1 then 'FILLED' else 'CANCELLED' end,
              filled_quantity = case when id = $1 then quantity else filled_quantity end,
              is_oco_winner = (id = $1), updated_at = now(), version = version + 1
        where oco_group_id = $2`,
      [order.id, row.groupId],
    );
    await client.query(
      `insert into fills (
         id, order_id, price, quantity, fee, slippage, reference_trade_price,
         recovery_epoch, market_data_version, leader_fencing_token,
         is_recovery_fill
       ) values ($1, $2, $3, $4, 0, 0, $3, $5, $6, $7, $8)`,
      [
        randomUUID(),
        order.id,
        pricing.referencePrice,
        row.quantity,
        pricing.recoveryEpoch.toString(),
        pricing.marketDataVersion.toString(),
        pricing.leaderFencingToken.toString(),
        pricing.recoveryFill === true,
      ],
    );
    await client.query(
      `update positions
          set available_quantity = 0, reserved_quantity = 0,
              total_quantity = 0, version = version + 1
        where session_id = $1 and symbol = $2`,
      [row.sessionId, row.symbol],
    );
    await client.query(
      `update reservations set released = true, version = version + 1
        where oco_group_id = $1 and not released`,
      [row.groupId],
    );
    await client.query(
      `update oco_groups
          set status = 'RESOLVED', resolved_at = now(), version = version + 1
        where id = $1 and status = 'ACTIVE'`,
      [row.groupId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  await publishSnapshot(row.sessionId, 'OCO_RESOLVED');
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
      volume: level.size,
    })),
    asks: input.asks.map((level) => ({
      price: level.price,
      volume: level.size,
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
          size: String(input.quantity),
        },
      ],
      asks: [
        {
          price:
            row.side === 'BUY'
              ? String(input.price)
              : decimal(String(input.price)).plus('1').toString(),
          size: String(input.quantity),
        },
      ],
    });
    const status = await pool.query<{ status: string }>(
      'select status from orders where id = $1',
      [input.orderId],
    );
    await publishSnapshot(row.sessionId, 'FILL_CREATED', {
      duplicate: input.duplicate === true,
    });
    json(response, 200, { status: status.rows[0]?.status });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/trigger-oco') {
    const target = await pool.query<{
      market: Market;
      symbol: string;
    }>('select market_code as market, symbol from orders where id = $1', [
      input.orderId,
    ]);
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
    json(response, 200, { resolved: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/sequence-gap') {
    const session = [...streamSessions][0];
    const count = Number(input.count ?? 1);
    if (session) {
      for (let index = 0; index < count; index += 1)
        await publishSnapshot(session, `SEQUENCE_GAP_${index}`, { gap: true });
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

async function waitForWeb(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(publicOrigin);
      if (response.ok) return;
    } catch {
      // The condition is polled until the bounded readiness deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error('web preview did not become ready');
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
    await settle(() => streamHub.closeAll(1012, 'SERVICE_RESTART'));
    await settle(apiApp ? () => apiApp.close() : undefined);
    await settle(() => stopChild(webProcess));
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

async function principal(
  request: unknown,
): Promise<{ id: string; status: string }> {
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
    const target = await pool.query<{ market: Market }>(
      'select market_code as market from orders where id = $1 and session_id = $2',
      [command.orderId, command.sessionId],
    );
    const market = target.rows[0]?.market;
    if (market) await engines.get(market)?.cancelOrder(String(command.orderId));
    await pool.query(
      `update orders set status = 'CANCELLED', updated_at = now(), version = version + 1
        where id = $1 and session_id = $2
          and status not in ('FILLED','CANCELLED','EXPIRED','REJECTED')`,
      [command.orderId, command.sessionId],
    );
    await publishSnapshot(command.sessionId, 'ORDER_CANCELLED');
    return { id: command.orderId, status: 'CANCELLED' };
  }
  if (command.action === 'amend')
    throw Object.assign(new Error('amendment is unavailable in E2E'), {
      code: 'ORDER_STATE_CONFLICT',
      statusCode: 409,
    });
  throw new Error('placement must use OrderPlacementService');
}

async function main(): Promise<void> {
  await Promise.all([API_PORT, WEB_PORT, CONTROL_PORT].map(assertPortFree));
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
  for (const migration of ['001_ledger.sql', '002_audit_partitions.sql']) {
    await pool.query(
      await readFile(
        resolve(workspaceRoot, 'apps/paper-api/src/db/migrations', migration),
        'utf8',
      ),
    );
  }
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
    recoveryStabilityMs: 0,
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
        feeModel: createFeeModel({
          version: `e2e-${market}`,
          market,
          currency,
          commissionRate: '0',
          sellTaxRate: '0',
          roundingDecimals: 2,
          roundingMode: 'HALF_UP',
        }),
        isGateExclusive: () => mode === 'DEGRADED' || mode === 'CANCEL_ONLY',
        onFill: persistEngineFill,
        onConditionalTrigger: persistConditionalTrigger,
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
                  volume: level.size,
                })),
                asks: current.asks.map((level) => ({
                  price: level.price,
                  volume: level.size,
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
    afterPlacement: (sessionId, sequence) =>
      publishSnapshot(sessionId, 'ORDER_PLACED', {
        sequence: sequence.toString(),
      }),
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
      await publishSnapshot(quote.sessionId, 'FX_CONVERTED');
    },
  });
  apiApp = await buildApp(config, {
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
        const authenticated = await principal(request);
        const csrf = request.headers['x-csrf-token'];
        if (
          request.headers.origin !== publicOrigin ||
          typeof csrf !== 'string' ||
          !verifyCsrfToken(config.csrfSecret, authenticated.id, csrf)
        )
          throw Object.assign(new Error('CSRF validation failed'), {
            code: 'FORBIDDEN',
            statusCode: 403,
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
        (market, symbol) => {
          const current = books.get(`${market}:${symbol}`) ?? {
            bids: [{ price: market === 'KR' ? '69900' : '199', size: '10' }],
            asks: [{ price: market === 'KR' ? '70000' : '200', size: '10' }],
          };
          return {
            market,
            symbol,
            price: current.asks[0]?.price ?? null,
            asOf: new Date().toISOString(),
            health: mode === 'NORMAL' ? 'HEALTHY' : mode,
            recoveryEpoch: mode === 'NORMAL' ? '2' : '1',
            marketDataVersion: marketVersion.toString(),
            ...current,
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
  await apiApp.ready();
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
  await waitForWeb();
  console.log(`Moi E2E system ready at ${publicOrigin}`);
}

process.once('SIGTERM', () => void cleanup().finally(() => process.exit(0)));
process.once('SIGINT', () => void cleanup().finally(() => process.exit(0)));
process.once('exit', () => {
  webProcess?.kill('SIGTERM');
});

await main().catch(async (error: unknown) => {
  console.error(error);
  await cleanup();
  process.exitCode = 1;
});
