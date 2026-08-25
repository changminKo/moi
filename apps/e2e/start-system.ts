import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { buildApp } from '../paper-api/src/app.js';
import type { AppConfig } from '../paper-api/src/config.js';
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
const csrfTokens = new Map<string, string>();
const fxQuotes = new Map<
  string,
  { sessionId: string; amount: string; destinationAmount: string }
>();
const idempotencyKeys = new Set<string>();
const streamSockets = new Map<string, Set<Socket>>();
const pendingPositions: { symbol: string; quantity: string }[] = [];
let mode: Mode = 'NORMAL';
let snapshotRequestCount = 0;
let pool: Pool;
let postgres: StartedTestContainer;
let redis: StartedTestContainer;
let apiApp: FastifyInstance;
let controlServer: Server;
let webProcess: ChildProcess | undefined;
let stopping = false;

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

function cookies(request: PublicRequest): Map<string, string> {
  return new Map(
    String(request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
}

function sessionId(request: PublicRequest): string | undefined {
  return cookies(request).get('skipjack_e2e_session');
}

function requireSession(
  request: PublicRequest,
  response: JsonResponse,
): string | undefined {
  const id = sessionId(request);
  if (!id) {
    json(response, 401, {
      code: 'SESSION_EXPIRED',
      message: 'Session is required',
      retryable: false,
      requestId: randomUUID(),
    });
  }
  return id;
}

function requireWrite(
  request: PublicRequest,
  response: JsonResponse,
  id: string,
): boolean {
  if (request.headers['x-csrf-token'] !== csrfTokens.get(id)) {
    json(response, 403, {
      code: 'FORBIDDEN',
      message: 'CSRF token is invalid',
      retryable: false,
      requestId: randomUUID(),
    });
    return false;
  }
  return true;
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126)
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function sendStream(session: string, value: unknown, repeats = 1): void {
  const frame = encodeFrame(value);
  for (const socket of streamSockets.get(session) ?? []) {
    for (let index = 0; index < repeats; index += 1) socket.write(frame);
  }
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
  const wallets = await pool.query<{
    currency: 'KRW' | 'USD';
    available: string;
    reserved: string;
    total: string;
  }>(
    'select currency, available::text, reserved::text, total::text from wallets where session_id = $1 order by currency',
    [session],
  );
  const positions = await pool.query<{
    market: Market;
    symbol: string;
    available: string;
    reserved: string;
    total: string;
  }>(
    `select market_code as market, symbol, available_quantity::text as available,
            reserved_quantity::text as reserved, total_quantity::text as total
       from positions where session_id = $1 order by market_code, symbol`,
    [session],
  );
  const orders = await pool.query<{
    id: string;
    market: Market;
    symbol: string;
    type: string;
    side: string;
    quantity: string;
    filledQuantity: string;
    status: string;
    groupId: string | null;
  }>(
    `select id::text, market_code as market, symbol, order_type as type, side,
            quantity::text, filled_quantity::text as "filledQuantity", status,
            oco_group_id::text as "groupId"
       from orders where session_id = $1 order by created_at, id`,
    [session],
  );
  const activeOrders = await Promise.all(
    orders.rows.map(async (order) => {
      const fills = await pool.query<{
        id: string;
        quantity: string;
        price: string;
        recoveryFill: boolean;
      }>(
        `select id::text, quantity::text, price::text,
                is_recovery_fill as "recoveryFill"
           from fills where order_id = $1 order by occurred_at, id`,
        [order.id],
      );
      const siblings = order.groupId
        ? await pool.query<{ id: string }>(
            'select id::text from orders where oco_group_id = $1 and id <> $2 order by id',
            [order.groupId, order.id],
          )
        : undefined;
      return {
        ...order,
        fills: fills.rows.map((fill) => ({ ...fill, symbol: order.symbol })),
        ...(siblings
          ? { siblingOrderIds: siblings.rows.map((row) => row.id) }
          : {}),
      };
    }),
  );
  return {
    wallets: wallets.rows,
    positions: positions.rows,
    reservations: [],
    activeOrders,
    accountSequence: await currentSequence(session),
    market: { health: { KR: mode, US: mode }, recoveryFill: {} },
  };
}

async function publishSnapshot(
  session: string,
  kind: string,
  options: { duplicate?: boolean; gap?: boolean } = {},
): Promise<void> {
  let sequence = await nextSequence(session, kind);
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

async function createSession(response: JsonResponse): Promise<void> {
  const id = randomUUID();
  const csrf = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await pool.query(
    `insert into anonymous_sessions (id, token_hash, expires_at) values ($1, $2, $3)`,
    [id, `e2e:${id}`, expiresAt],
  );
  await pool.query(
    `insert into wallets (id, session_id, currency, total, available, reserved)
     values ($1, $3, 'KRW', 10000000, 10000000, 0),
            ($2, $3, 'USD', 0, 0, 0)`,
    [randomUUID(), randomUUID(), id],
  );
  for (const seed of pendingPositions.splice(0)) {
    await pool.query(
      `insert into positions
         (id, session_id, market_code, symbol, total_quantity, available_quantity, reserved_quantity, average_cost)
       values ($1, $2, 'US', $3, $4, $4, 0, 200)`,
      [randomUUID(), id, seed.symbol, seed.quantity],
    );
  }
  csrfTokens.set(id, csrf);
  json(
    response,
    201,
    { session: { id, expiresAt: expiresAt.toISOString() }, csrfToken: csrf },
    {
      'set-cookie': `skipjack_e2e_session=${id}; Path=/; HttpOnly; SameSite=Lax`,
    },
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

async function placeOrder(
  request: PublicRequest,
  response: JsonResponse,
  session: string,
): Promise<void> {
  if (mode !== 'NORMAL') {
    json(response, 409, {
      code: mode === 'CANCEL_ONLY' ? 'CANCEL_ONLY' : 'MARKET_DATA_DEGRADED',
      message: 'Trading is currently restricted',
      retryable: false,
      requestId: randomUUID(),
    });
    return;
  }
  const key = String(request.headers['idempotency-key'] ?? '');
  if (!key || idempotencyKeys.has(`${session}:${key}`)) {
    json(response, 409, {
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'A fresh idempotency key is required',
      retryable: false,
      requestId: randomUUID(),
    });
    return;
  }
  idempotencyKeys.add(`${session}:${key}`);
  const input = await body(request);
  const market = input.market as Market;
  const symbol = String(input.symbol);
  const type = String(input.type);
  const side = String(input.side);
  const quantity = String(input.quantity);
  if (type === 'OCO') {
    const groupId = randomUUID();
    await pool.query(
      'insert into oco_groups (id, session_id) values ($1, $2)',
      [groupId, session],
    );
    const legs = input.legs as JsonObject[];
    const ids: string[] = [];
    for (const leg of legs) {
      const id = randomUUID();
      ids.push(id);
      await pool.query(
        `insert into orders
           (id, session_id, market_code, symbol, oco_group_id, order_type, side,
            limit_price, stop_price, quantity, status)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING_TRIGGER')`,
        [
          id,
          session,
          market,
          symbol,
          groupId,
          leg.type,
          side,
          leg.limitPrice ?? null,
          leg.stopPrice ?? null,
          quantity,
        ],
      );
    }
    if (side === 'SELL') {
      await pool.query(
        `update positions
            set available_quantity = available_quantity - $3::numeric,
                reserved_quantity = reserved_quantity + $3::numeric
          where session_id = $1 and symbol = $2`,
        [session, symbol, quantity],
      );
    }
    await publishSnapshot(session, 'ORDER_PLACED');
    json(response, 201, { id: ids[0], status: 'PENDING_TRIGGER' });
    return;
  }
  const id = randomUUID();
  const book = books.get(`${market}:${symbol}`);
  const depth = type === 'MARKET' ? BigInt(book?.asks[0]?.size ?? '0') : 0n;
  const requested = BigInt(quantity);
  const filled = String(requested < depth ? requested : depth);
  const status =
    BigInt(filled) === 0n
      ? 'OPEN'
      : BigInt(filled) === requested
        ? 'FILLED'
        : 'PARTIALLY_FILLED';
  await pool.query(
    `insert into orders
       (id, session_id, market_code, symbol, order_type, side, limit_price,
        stop_price, quantity, filled_quantity, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      session,
      market,
      symbol,
      type,
      side,
      input.limitPrice ?? null,
      input.stopPrice ?? null,
      quantity,
      filled,
      status,
    ],
  );
  if (BigInt(filled) > 0n) {
    const price = book?.asks[0]?.price ?? '1';
    await pool.query(
      `insert into fills (id, order_id, price, quantity, fee, slippage)
       values ($1, $2, $3, $4, 0, 0)`,
      [randomUUID(), id, price, filled],
    );
    await upsertPosition(session, market, symbol, filled);
  }
  await publishSnapshot(session, 'ORDER_PLACED');
  json(response, 201, { id, status, filledQuantity: filled, quantity });
}

async function upsertPosition(
  session: string,
  market: Market,
  symbol: string,
  quantity: string,
): Promise<void> {
  await pool.query(
    `insert into positions
       (id, session_id, market_code, symbol, total_quantity, available_quantity, reserved_quantity, average_cost)
     values ($1, $2, $3, $4, $5, $5, 0, 1)
     on conflict (session_id, market_code, symbol) do update
       set total_quantity = positions.total_quantity + excluded.total_quantity,
           available_quantity = positions.available_quantity + excluded.available_quantity`,
    [randomUUID(), session, market, symbol, quantity],
  );
}

async function publicApi(
  request: FastifyRequest,
  response: FastifyReply,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${API_PORT}`);
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    await pool.query('select 1');
    json(response, 200, { status: 'ready' });
    return;
  }
  if (
    request.method === 'POST' &&
    url.pathname === '/api/v1/sessions/anonymous'
  ) {
    const existing = sessionId(request);
    if (existing) {
      const expires = await pool.query<{ expiresAt: string }>(
        'select expires_at::text as "expiresAt" from anonymous_sessions where id = $1',
        [existing],
      );
      const csrf =
        csrfTokens.get(existing) ?? randomBytes(24).toString('base64url');
      csrfTokens.set(existing, csrf);
      json(response, 200, {
        session: { id: existing, expiresAt: expires.rows[0]?.expiresAt },
        csrfToken: csrf,
      });
      return;
    }
    await createSession(response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/health/trading') {
    json(response, 200, health());
    return;
  }
  const session = requireSession(request, response);
  if (!session) return;
  if (request.method === 'GET' && url.pathname === '/api/v1/instruments') {
    const query = (url.searchParams.get('q') ?? '').toUpperCase();
    const instruments = [
      {
        market: 'KR',
        symbol: '005930',
        name: 'Samsung Electronics',
        tradable: true,
      },
      { market: 'US', symbol: 'AAPL', name: 'Apple', tradable: true },
    ].filter((item) =>
      `${item.symbol} ${item.name}`.toUpperCase().includes(query),
    );
    json(response, 200, instruments);
    return;
  }
  const quoteMatch = url.pathname.match(
    /^\/api\/v1\/markets\/(KR|US)\/symbols\/([^/]+)\/quote$/,
  );
  if (request.method === 'GET' && quoteMatch) {
    const market = quoteMatch[1] as Market;
    const symbol = decodeURIComponent(quoteMatch[2] ?? '');
    const book = books.get(`${market}:${symbol}`) ?? {
      bids: [{ price: market === 'KR' ? '69900' : '199', size: '10' }],
      asks: [{ price: market === 'KR' ? '70000' : '200', size: '10' }],
    };
    json(response, 200, {
      market,
      symbol,
      price: book.asks[0]?.price ?? null,
      asOf: new Date().toISOString(),
      health: mode === 'NORMAL' ? 'HEALTHY' : mode,
      recoveryEpoch: '1',
      marketDataVersion: '1',
      ...book,
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/v1/portfolio') {
    snapshotRequestCount += 1;
    json(response, 200, await portfolio(session));
    return;
  }
  if (!requireWrite(request, response, session)) return;
  if (request.method === 'POST' && url.pathname === '/api/v1/fx/quotes') {
    if (mode === 'CANCEL_ONLY') {
      json(response, 409, {
        code: 'CANCEL_ONLY',
        message: 'FX is disabled in cancellation-only mode',
        retryable: false,
        requestId: randomUUID(),
      });
      return;
    }
    const input = await body(request);
    const amount = String(input.amount);
    const conversion = await pool.query<{ destinationAmount: string }>(
      'select ($1::numeric * 0.0007)::text as "destinationAmount"',
      [amount],
    );
    const destinationAmount = conversion.rows[0]?.destinationAmount;
    if (!destinationAmount) throw new Error('FX quote calculation failed');
    const quoteId = randomUUID();
    fxQuotes.set(quoteId, { sessionId: session, amount, destinationAmount });
    json(response, 200, {
      quoteId,
      rate: '0.0007',
      fee: '0',
      sourceAmount: amount,
      destinationAmount,
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/fx/conversions') {
    if (mode === 'CANCEL_ONLY') {
      json(response, 409, {
        code: 'CANCEL_ONLY',
        message: 'FX is disabled in cancellation-only mode',
        retryable: false,
        requestId: randomUUID(),
      });
      return;
    }
    const input = await body(request);
    const quote = fxQuotes.get(String(input.quoteId));
    if (!quote || quote.sessionId !== session) {
      json(response, 409, {
        code: 'QUOTE_EXPIRED',
        message: 'Quote expired',
        retryable: false,
        requestId: randomUUID(),
      });
      return;
    }
    await pool.query(
      `update wallets set total = total - $2::numeric, available = available - $2::numeric
       where session_id = $1 and currency = 'KRW'`,
      [session, quote.amount],
    );
    await pool.query(
      `update wallets set total = total + $2::numeric, available = available + $2::numeric
       where session_id = $1 and currency = 'USD'`,
      [session, quote.destinationAmount],
    );
    fxQuotes.delete(String(input.quoteId));
    await publishSnapshot(session, 'FX_CONVERTED');
    json(response, 200, { converted: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/orders') {
    await placeOrder(request, response, session);
    return;
  }
  const orderMatch = url.pathname.match(/^\/api\/v1\/orders\/([^/]+)$/);
  if (request.method === 'DELETE' && orderMatch) {
    const orderId = decodeURIComponent(orderMatch[1] ?? '');
    await pool.query(
      `update orders set status = 'CANCELLED', updated_at = now()
       where id = $1 and session_id = $2 and status not in ('FILLED','CANCELLED','EXPIRED','REJECTED')`,
      [orderId, session],
    );
    await publishSnapshot(session, 'ORDER_CANCELLED');
    json(response, 200, { id: orderId, status: 'CANCELLED' });
    return;
  }
  json(response, 404, {
    code: 'NOT_FOUND',
    message: 'Not found',
    retryable: false,
    requestId: randomUUID(),
  });
}

async function resetState(): Promise<void> {
  for (const sockets of streamSockets.values())
    for (const socket of sockets) socket.destroy();
  streamSockets.clear();
  csrfTokens.clear();
  fxQuotes.clear();
  idempotencyKeys.clear();
  pendingPositions.splice(0);
  books.clear();
  mode = 'NORMAL';
  snapshotRequestCount = 0;
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
    books.set(`${input.market}:${input.symbol}`, {
      bids: input.bids as Book['bids'],
      asks: input.asks as Book['asks'],
    });
    json(response, 200, { updated: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/mode') {
    mode = input.mode as Mode;
    json(response, 200, { mode });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/recover') {
    mode = 'NORMAL';
    json(response, 200, { mode });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/position') {
    pendingPositions.push({
      symbol: String(input.symbol),
      quantity: String(input.quantity),
    });
    json(response, 200, { seeded: true });
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
    const nextFilled = String(
      BigInt(row.filled) + BigInt(String(input.quantity)),
    );
    const nextStatus =
      BigInt(nextFilled) >= BigInt(row.quantity)
        ? 'FILLED'
        : 'PARTIALLY_FILLED';
    await pool.query(
      'update orders set filled_quantity = $2, status = $3, updated_at = now() where id = $1',
      [input.orderId, nextFilled, nextStatus],
    );
    await pool.query(
      `insert into fills (id, order_id, price, quantity, fee, slippage, is_recovery_fill)
       values ($1, $2, $3, $4, 0, 0, $5)`,
      [
        randomUUID(),
        input.orderId,
        input.price,
        input.quantity,
        input.recoveryFill === true,
      ],
    );
    if (row.side === 'BUY')
      await upsertPosition(
        row.sessionId,
        row.market,
        row.symbol,
        String(input.quantity),
      );
    await publishSnapshot(row.sessionId, 'FILL_CREATED', {
      duplicate: input.duplicate === true,
    });
    json(response, 200, { status: nextStatus });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/trigger-oco') {
    const winner = await pool.query<{
      sessionId: string;
      groupId: string;
      symbol: string;
      quantity: string;
    }>(
      `select session_id::text as "sessionId", oco_group_id::text as "groupId", symbol, quantity::text
       from orders where id = $1`,
      [input.orderId],
    );
    const row = winner.rows[0];
    if (!row) {
      json(response, 404, { error: 'order missing' });
      return;
    }
    await pool.query(
      `update orders set status = case when id = $1 then 'FILLED' else 'CANCELLED' end,
                         filled_quantity = case when id = $1 then quantity else filled_quantity end,
                         is_oco_winner = (id = $1), updated_at = now()
       where oco_group_id = $2`,
      [input.orderId, row.groupId],
    );
    await pool.query(
      `insert into fills (id, order_id, price, quantity, fee, slippage)
       values ($1, $2, $3, $4, 0, 0)`,
      [randomUUID(), input.orderId, input.price, row.quantity],
    );
    await pool.query(
      `update positions set available_quantity = 0, reserved_quantity = 0, total_quantity = 0
       where session_id = $1 and symbol = $2`,
      [row.sessionId, row.symbol],
    );
    await publishSnapshot(row.sessionId, 'OCO_RESOLVED');
    json(response, 200, { resolved: true });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/sequence-gap') {
    const session = [...streamSockets.keys()][0];
    if (session) await publishSnapshot(session, 'SEQUENCE_GAP', { gap: true });
    json(response, 200, { emitted: Boolean(session) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/stream-count') {
    const count = [...streamSockets.values()].reduce(
      (sum, sockets) => sum + sockets.size,
      0,
    );
    json(response, 200, { count });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/snapshot-count') {
    json(response, 200, { count: snapshotRequestCount });
    return;
  }
  json(response, 404, { error: 'control not found' });
}

function websocketUpgrade(request: IncomingMessage, socket: Socket): void {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${API_PORT}`);
  const session = sessionId(request);
  const key = request.headers['sec-websocket-key'];
  if (
    url.pathname !== '/api/v1/stream' ||
    !session ||
    typeof key !== 'string'
  ) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const sockets = streamSockets.get(session) ?? new Set<Socket>();
  sockets.add(socket);
  streamSockets.set(session, sockets);
  void currentSequence(session).then((sequence) =>
    socket.write(
      encodeFrame({
        type: 'ready',
        accountSequence: sequence,
        heartbeatIntervalMs: 30_000,
      }),
    ),
  );
  const remove = () => {
    sockets.delete(socket);
    if (sockets.size === 0) streamSockets.delete(session);
  };
  socket.on('close', remove);
  socket.on('error', remove);
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
        VITE_SKIPJACK_ALLOW_LOCAL_HTTP: 'true',
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

async function cleanup(): Promise<void> {
  if (stopping) return;
  stopping = true;
  webProcess?.kill('SIGTERM');
  await Promise.allSettled([
    apiApp?.close(),
    new Promise<void>((resolveClose) =>
      controlServer?.close(() => resolveClose()),
    ),
    pool?.end(),
    postgres?.stop(),
    redis?.stop(),
    rm(stateFilePath, { force: true }),
  ]);
}

async function main(): Promise<void> {
  await Promise.all([API_PORT, WEB_PORT, CONTROL_PORT].map(assertPortFree));
  postgres = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'skipjack',
      POSTGRES_PASSWORD: 'skipjack',
      POSTGRES_DB: 'skipjack',
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
    user: 'skipjack',
    password: 'skipjack',
    database: 'skipjack',
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
    databaseUrl: `postgresql://skipjack:skipjack@${postgres.getHost()}:${postgres.getMappedPort(5432)}/skipjack`,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    sessionHashKeys: [randomBytes(32).toString('base64url')],
    csrfSecret: randomBytes(32).toString('base64url'),
    adminApiKey: controlCredential,
  };
  apiApp = await buildApp(config, {
    clock: { now: () => Date.now() },
    registerRoutes: (app) => {
      app.route({
        method: ['GET', 'POST', 'DELETE'],
        url: '/*',
        handler: publicApi,
      });
    },
  });
  apiApp.server.on('upgrade', websocketUpgrade);
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
  await runPnpm(['--filter', '@skipjack/web', 'build']);
  webProcess = spawn(
    'pnpm',
    [
      '--filter',
      '@skipjack/web',
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
        SKIPJACK_DEV_API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
      },
      stdio: 'inherit',
    },
  );
  await waitForWeb();
  console.log(`Skipjack E2E system ready at ${publicOrigin}`);
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
