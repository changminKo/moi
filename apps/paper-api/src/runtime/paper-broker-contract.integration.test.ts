/**
 * The contract between `@moi/strategy-sdk` and this app, driven against the
 * real thing.
 *
 * The SDK's own suites run `PaperBroker` over a fake transport it also owns, so
 * both sides of that test agreed with each other and neither agreed with the
 * server: the decoder demanded an order `version` no response carries, asked for
 * a portfolio `sessionId` the payload omitted, and posted `triggerPrice` and a
 * flat OCO body a `.strict()` schema rejects. Every one of those decoded fine in
 * the fake. This file is the guard that could have caught them — one real
 * runtime, one real ledger, the published adapter, and no fake in between.
 */
import { randomUUID } from 'node:crypto';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import {
  PaperBroker,
  type PaperBrokerRequest,
  type PaperBrokerResponse,
  type PaperBrokerTransport,
} from '@moi/strategy-sdk';
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
const TEST_TIMEOUT_MS = 90_000;
const PUBLIC_ORIGIN = 'http://127.0.0.1:0';

let postgres: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let runtime: ProductionRuntime;
let bundle: FakeProviderBundle;
let origin: string;

function config(databaseUrl: string): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    publicOrigin: PUBLIC_ORIGIN,
    databaseUrl,
    redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    sessionHashKeys: ['contract-session-hash-key-32-bytes!'],
    csrfSecret: 'contract-csrf-secret-at-least-32-bytes',
    adminApiKey: 'contract-admin-key-at-least-32-bytes',
    marketDataAdapter: 'fake',
    shutdownDrainDeadlineMs: 5_000,
    trustProxy: false,
    recoveryStabilityMs: 0,
    fees: ZERO_FEE_SCHEDULES,
  };
}

interface Session {
  readonly cookie: string;
  readonly csrf: string;
  readonly id: string;
}

async function anonymousSession(): Promise<Session> {
  const response = await fetch(`${origin}/api/v1/sessions/anonymous`, {
    method: 'POST',
    headers: { origin: PUBLIC_ORIGIN },
  });
  const cookie = response.headers.get('set-cookie')?.split(';')[0] as string;
  const body = (await response.json()) as {
    csrfToken: string;
    session: { id: string };
  };
  return { cookie, csrf: body.csrfToken, id: body.session.id };
}

/**
 * What a non-browser client has to do to be allowed in: send the session
 * cookie, echo `Origin` as the configured public origin, and carry the CSRF
 * token on every mutation. A bot that skips any of these is answered 403, which
 * is why the runner design pins all three.
 */
function httpTransport(session?: Session): PaperBrokerTransport {
  return {
    async request(request: PaperBrokerRequest): Promise<PaperBrokerResponse> {
      const headers: Record<string, string> = { origin: PUBLIC_ORIGIN };
      if (session !== undefined) {
        headers.cookie = session.cookie;
        headers['x-csrf-token'] = session.csrf;
      }
      if (request.idempotencyKey !== undefined) {
        headers['idempotency-key'] = request.idempotencyKey;
      }
      if (request.body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      const response = await fetch(`${origin}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => undefined),
      };
    },
  };
}

const key = () => randomUUID();

async function awaitPosition(
  session: Session,
  broker: PaperBroker,
  symbol: string,
): Promise<BrokerPortfolio> {
  const deadline = Date.now() + 30_000;
  let portfolio = await broker.getPortfolio(session.id);
  while (
    Date.now() < deadline &&
    !portfolio.positions.some((position) => position.symbol === symbol)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    portfolio = await broker.getPortfolio(session.id);
  }
  return portfolio;
}

/**
 * A MARKET order is sized against the book's touch, so a book has to exist
 * before the first placement. The fake provider publishes one on demand, and
 * waiting for the quote to report it keeps the test honest about what it needs
 * rather than sleeping and hoping.
 */
async function awaitQuotedBook(
  market: 'KR' | 'US',
  symbol: string,
  bid: string,
  ask: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    bundle.streamFor(market).emitOrderBook({
      market,
      symbol,
      book: {
        market,
        symbol,
        currency: market === 'KR' ? 'KRW' : 'USD',
        // A real book is never locked or crossed, and the engine rejects one
        // that is, so the touch carries a spread.
        bids: [{ price: bid, volume: '100' }],
        asks: [{ price: ask, volume: '100' }],
      },
      sourceTimestamp: new Date().toISOString(),
    });
    const response = await fetch(
      `${origin}/api/v1/markets/${market}/symbols/${symbol}/quote`,
    );
    const body = (await response.json().catch(() => ({}))) as {
      price?: unknown;
    };
    if (typeof body.price === 'string') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no quoted book for ${market}:${symbol} within 30s`);
}

beforeAll(async () => {
  postgres = await new PostgreSqlContainer('postgres:17.5-alpine').start();
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  bundle = createFakeProviderBundle();
  runtime = new ProductionRuntime({
    config: config(postgres.getConnectionUri()),
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

describe('PaperBroker against the real paper API', () => {
  it(
    'decodes every order type the API accepts, plus cancel and portfolio',
    async () => {
      await awaitQuotedBook('KR', '005930', '69900', '70000');
      const session = await anonymousSession();
      const broker = new PaperBroker(httpTransport(session));
      const base = {
        sessionId: session.id,
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        quantity: '1',
      } as const;

      const market = await broker.placeOrder({
        ...base,
        idempotencyKey: key(),
        type: 'MARKET',
      });
      expect(market.id).toEqual(expect.any(String));
      expect(market.status).toBe('OPEN');
      // The ledger's optimistic-concurrency token is not part of the payload,
      // and a strategy must never start depending on one.
      expect(market).not.toHaveProperty('version');

      const limit = await broker.placeOrder({
        ...base,
        idempotencyKey: key(),
        type: 'LIMIT',
        limitPrice: '69000',
      });
      expect(limit.status).toBe('OPEN');

      const stop = await broker.placeOrder({
        ...base,
        idempotencyKey: key(),
        type: 'STOP',
        stopPrice: '71000',
      });
      expect(stop.status).toBe('PENDING_TRIGGER');

      const takeProfit = await broker.placeOrder({
        ...base,
        idempotencyKey: key(),
        type: 'TAKE_PROFIT',
        stopPrice: '75000',
      });
      expect(takeProfit.status).toBe('PENDING_TRIGGER');

      // The one command whose request shape differs from its command shape: the
      // API takes two explicit legs and rejects the flat body outright.
      const oco = await broker.placeOrder({
        ...base,
        idempotencyKey: key(),
        type: 'OCO',
        limitPrice: '69000',
        stopPrice: '71000',
      });
      expect(oco.status).toBe('PENDING_TRIGGER');

      const cancelled = await broker.cancelOrder({
        sessionId: session.id,
        idempotencyKey: key(),
        orderId: limit.id,
      });
      // The runtime narrows a cancellation to `{ id, status }`, so a cancel
      // does not name the siblings it also closed. Pinned as it is.
      expect(cancelled).toStrictEqual({ id: limit.id, status: 'CANCELLED' });

      // A MARKET buy settles asynchronously, so the position it creates has to
      // be waited for; asserting the portfolio before it lands would leave
      // `positions` empty and never exercise the decoder at all.
      const portfolio = await awaitPosition(session, broker, '005930');
      expect(portfolio.sessionId).toBe(session.id);

      const position = portfolio.positions.find(
        (candidate) => candidate.symbol === '005930',
      );
      // `market` and `averageCost` are the two fields the old decoder dropped.
      expect(position?.market).toBe('KR');
      expect(position?.averageCost).toMatch(/^\d+(\.\d+)?$/);
      expect(position?.total).toMatch(/^\d+$/);

      // A portfolio order carries what a write's answer does not, and a
      // strategy cannot recognise its own orders without it.
      const limitRow = portfolio.activeOrders.find(
        (order) => order.id === limit.id,
      );
      expect(limitRow).toMatchObject({
        market: 'KR',
        symbol: '005930',
        type: 'LIMIT',
        side: 'BUY',
        quantity: '1',
        limitPrice: '69000',
      });

      // `activeOrders` has no status filter server-side (#33): a cancelled
      // order is still listed. Pinned deliberately — the field name is wrong,
      // not the data, and narrowing it waits on #37 because these rows are
      // today the only path by which a client reaches fill data.
      expect(limitRow?.status).toBe('CANCELLED');
      expect(
        portfolio.wallets.map((wallet) => wallet.currency).sort(),
      ).toStrictEqual(['KRW', 'USD']);
      expect(portfolio.accountSequence).toMatch(/^\d+$/);
      for (const wallet of portfolio.wallets) {
        expect(wallet).not.toHaveProperty('version');
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'replays an order under a repeated idempotency key rather than placing twice',
    async () => {
      const session = await anonymousSession();
      const broker = new PaperBroker(httpTransport(session));
      const command = {
        sessionId: session.id,
        idempotencyKey: key(),
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        quantity: '1',
        type: 'LIMIT',
        limitPrice: '69000',
      } as const;

      const first = await broker.placeOrder(command);
      const replayed = await broker.placeOrder(command);

      expect(replayed).toStrictEqual(first);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'answers a write without a CSRF token as FORBIDDEN, not as read-only',
    async () => {
      const session = await anonymousSession();
      // The cookie is present, the CSRF token is not: `requireCsrf` answers 403.
      // A client that read this as ACCOUNT_READ_ONLY would abandon a healthy
      // account over a header it could simply have sent.
      const broker = new PaperBroker({
        async request(request) {
          const response = await fetch(`${origin}${request.path}`, {
            method: request.method,
            headers: {
              origin: PUBLIC_ORIGIN,
              cookie: session.cookie,
              'content-type': 'application/json',
              ...(request.idempotencyKey === undefined
                ? {}
                : { 'idempotency-key': request.idempotencyKey }),
            },
            ...(request.body === undefined
              ? {}
              : { body: JSON.stringify(request.body) }),
          });
          return {
            status: response.status,
            body: await response.json().catch(() => undefined),
          };
        },
      });

      await expect(
        broker.placeOrder({
          sessionId: session.id,
          idempotencyKey: key(),
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          quantity: '1',
          type: 'LIMIT',
          limitPrice: '69000',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reports a missing session as SESSION_EXPIRED, not as a read-only account',
    async () => {
      const broker = new PaperBroker(httpTransport());

      // Distinguishing these is the difference between re-establishing the
      // session and abandoning an account that is perfectly healthy.
      await expect(
        broker.getPortfolio('session-that-was-never-issued'),
      ).rejects.toMatchObject({ code: 'SESSION_EXPIRED', retryable: false });
    },
    TEST_TIMEOUT_MS,
  );
});
