import {
  DomainError,
  type OrderSnapshot,
  type PositionSnapshot,
  type WalletSnapshot,
} from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import type {
  ExchangeReceipt,
  PlaceOrderCommand,
  PortfolioSnapshot,
} from './broker.js';
import {
  CONTRACT_OPEN_ORDER_ID,
  CONTRACT_QUOTE_ID,
  CONTRACT_SESSION_ID,
  CONTRACT_TERMINAL_ORDER_ID,
  createPaperAccountFake,
  type PaperAccountFake,
  runBrokerContract,
} from './broker-contract.js';
import {
  PaperBroker,
  type PaperBrokerRequest,
  type PaperBrokerResponse,
  type PaperBrokerTransport,
} from './paper-broker.js';

const ORDERS_PATH = '/api/v1/orders';
const CONVERSIONS_PATH = '/api/v1/fx/conversions';
const PORTFOLIO_PATH = '/api/v1/portfolio';

// The fake paper API answers with the same stable status codes the real one
// documents, so error decoding is exercised rather than guessed.
const HTTP_STATUS_BY_CODE: Readonly<Record<string, number>> = {
  ACCOUNT_READ_ONLY: 403,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_ORDER: 400,
  INVALID_PRICE: 400,
  INVALID_QUANTITY: 400,
  INVARIANT_VIOLATION: 500,
  ORDER_STATE_CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
};

const wireOrder = (order: OrderSnapshot): unknown => ({
  id: order.id,
  status: order.status,
  version: order.version.toString(),
  ...(order.filledQuantity === undefined
    ? {}
    : { filledQuantity: order.filledQuantity }),
  ...(order.terminalReason === undefined
    ? {}
    : { terminalReason: order.terminalReason }),
});

const wireWallet = (wallet: WalletSnapshot): unknown => ({
  currency: wallet.currency,
  total: wallet.total,
  available: wallet.available,
  reserved: wallet.reserved,
  version: wallet.version.toString(),
});

const wirePosition = (position: PositionSnapshot): unknown => ({
  symbol: position.symbol,
  total: position.total,
  available: position.available,
  reserved: position.reserved,
  version: position.version.toString(),
});

const wirePortfolio = (snapshot: PortfolioSnapshot): unknown => ({
  sessionId: snapshot.sessionId,
  wallets: snapshot.wallets.map(wireWallet),
  positions: snapshot.positions.map(wirePosition),
  activeOrders: snapshot.activeOrders.map(wireOrder),
  accountSequence: snapshot.accountSequence,
});

const wireReceipt = (receipt: ExchangeReceipt): unknown => ({ ...receipt });

const requireKey = (request: PaperBrokerRequest): string => {
  if (request.idempotencyKey === undefined) {
    throw new Error(
      `${request.method} ${request.path} requires an idempotency key`,
    );
  }

  return request.idempotencyKey;
};

const route = (
  account: PaperAccountFake,
  request: PaperBrokerRequest,
): unknown => {
  if (request.method === 'POST' && request.path === ORDERS_PATH) {
    const body = request.body as Record<string, unknown>;
    const command = {
      ...body,
      sessionId: CONTRACT_SESSION_ID,
      idempotencyKey: requireKey(request),
    } as PlaceOrderCommand;

    return wireOrder(account.place(command));
  }

  if (
    request.method === 'DELETE' &&
    request.path.startsWith(`${ORDERS_PATH}/`)
  ) {
    return wireOrder(
      account.cancel({
        sessionId: CONTRACT_SESSION_ID,
        idempotencyKey: requireKey(request),
        orderId: request.path.slice(ORDERS_PATH.length + 1),
      }),
    );
  }

  if (request.method === 'POST' && request.path === CONVERSIONS_PATH) {
    const body = request.body as { readonly quoteId: string };

    return wireReceipt(
      account.exchange({
        sessionId: CONTRACT_SESSION_ID,
        idempotencyKey: requireKey(request),
        quoteId: body.quoteId,
      }),
    );
  }

  if (request.method === 'GET' && request.path === PORTFOLIO_PATH) {
    return wirePortfolio(account.portfolio(CONTRACT_SESSION_ID));
  }

  throw new Error(
    `fake paper API has no route for ${request.method} ${request.path}`,
  );
};

interface FakeTransport {
  readonly transport: PaperBrokerTransport;
  readonly requests: readonly PaperBrokerRequest[];
}

/**
 * A deterministic paper API: it owns the session the way a cookie would, and it
 * serializes every response through JSON so the adapter really decodes a wire
 * payload instead of receiving live objects.
 */
const createFakeTransport = (account: PaperAccountFake): FakeTransport => {
  const requests: PaperBrokerRequest[] = [];

  return {
    requests,
    transport: {
      request: async (request) => {
        requests.push(request);

        try {
          return {
            status: 200,
            body: JSON.parse(
              JSON.stringify(route(account, request)),
            ) as unknown,
          };
        } catch (error) {
          if (!(error instanceof DomainError)) {
            throw error;
          }

          return {
            status: HTTP_STATUS_BY_CODE[error.code] ?? 400,
            body: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.retryAfterSeconds === undefined
                ? {}
                : { retryAfter: error.retryAfterSeconds }),
              requestId: `req-${requests.length}`,
            },
          };
        }
      },
    },
  };
};

const stubTransport = (
  response: PaperBrokerResponse,
): PaperBrokerTransport => ({
  request: async () => response,
});

const marketBuy: PlaceOrderCommand = {
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey: 'paper-key-1',
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  quantity: '3',
};

describe('broker contract (PaperBroker over a deterministic fake transport)', () => {
  runBrokerContract(() => {
    const account = createPaperAccountFake();

    return {
      broker: new PaperBroker(createFakeTransport(account).transport),
      sessionId: CONTRACT_SESSION_ID,
      terminalOrderId: CONTRACT_TERMINAL_ORDER_ID,
      openOrderId: CONTRACT_OPEN_ORDER_ID,
      exchangeQuoteId: CONTRACT_QUOTE_ID,
    };
  });
});

describe('PaperBroker', () => {
  it('maps commands onto only the three paper endpoints', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const broker = new PaperBroker(transport);

    await broker.placeOrder(marketBuy);
    await broker.cancelOrder({
      sessionId: CONTRACT_SESSION_ID,
      idempotencyKey: 'paper-key-2',
      orderId: CONTRACT_OPEN_ORDER_ID,
    });
    await broker.exchange({
      sessionId: CONTRACT_SESSION_ID,
      idempotencyKey: 'paper-key-3',
      quoteId: CONTRACT_QUOTE_ID,
    });
    await broker.getPortfolio(CONTRACT_SESSION_ID);

    expect(
      requests.map((request) => `${request.method} ${request.path}`),
    ).toStrictEqual([
      `POST ${ORDERS_PATH}`,
      `DELETE ${ORDERS_PATH}/${CONTRACT_OPEN_ORDER_ID}`,
      `POST ${CONVERSIONS_PATH}`,
      `GET ${PORTFOLIO_PATH}`,
    ]);
  });

  it('forwards idempotency keys unchanged and never sends the session id', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const broker = new PaperBroker(transport);

    await broker.placeOrder(marketBuy);

    const [placed] = requests;
    expect(placed?.idempotencyKey).toBe('paper-key-1');
    expect(placed?.body).toStrictEqual({
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      quantity: '3',
    });
  });

  it('omits the idempotency key on the read-only portfolio request', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );

    await new PaperBroker(transport).getPortfolio(CONTRACT_SESSION_ID);

    expect(requests[0]?.idempotencyKey).toBeUndefined();
  });

  it('validates a command before touching the transport', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const invalid = {
      ...marketBuy,
      limitPrice: '190.25',
    } as unknown as PlaceOrderCommand;

    await expect(
      new PaperBroker(transport).placeOrder(invalid),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(requests).toHaveLength(0);
  });

  it('decodes a stable paper-API error into the same domain code', async () => {
    const broker = new PaperBroker(
      stubTransport({
        status: 409,
        body: {
          code: 'CANCEL_ONLY',
          message: 'market is cancel-only',
          retryable: false,
          requestId: 'req-cancel-only',
        },
      }),
    );

    const rejection = await broker
      .placeOrder(marketBuy)
      .catch((error) => error);

    expect(rejection).toBeInstanceOf(DomainError);
    expect(rejection).toMatchObject({ code: 'CANCEL_ONLY', retryable: false });
    expect((rejection as DomainError).message).toContain('req-cancel-only');
  });

  it('preserves retryAfter for a retryable stable error', async () => {
    const broker = new PaperBroker(
      stubTransport({
        status: 429,
        body: {
          code: 'RATE_LIMITED',
          message: 'slow down',
          retryable: true,
          retryAfter: 3,
          requestId: 'req-rate',
        },
      }),
    );

    const rejection = await broker
      .placeOrder(marketBuy)
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: 3,
    });
  });

  it('classifies an unknown 4xx code as a non-retryable domain error', async () => {
    const broker = new PaperBroker(
      stubTransport({
        status: 400,
        body: {
          code: 'QUOTE_EXPIRED',
          message: 'quote expired',
          retryable: false,
        },
      }),
    );

    const rejection = await broker
      .exchange({
        sessionId: CONTRACT_SESSION_ID,
        idempotencyKey: 'paper-key-4',
        quoteId: CONTRACT_QUOTE_ID,
      })
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'INVALID_ORDER',
      retryable: false,
    });
    expect((rejection as DomainError).message).toContain('QUOTE_EXPIRED');
  });

  it('classifies an unknown 5xx code as a retryable domain error', async () => {
    const broker = new PaperBroker(
      stubTransport({
        status: 502,
        body: { code: 'UPSTREAM_GONE', message: 'gone' },
      }),
    );

    const rejection = await broker
      .getPortfolio(CONTRACT_SESSION_ID)
      .catch((error) => error);

    expect(rejection).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('rejects a portfolio snapshot that belongs to another session', async () => {
    const account = createPaperAccountFake();
    const snapshot = account.portfolio(CONTRACT_SESSION_ID);
    const broker = new PaperBroker(
      stubTransport({
        status: 200,
        body: {
          ...(wirePortfolio(snapshot) as Record<string, unknown>),
          sessionId: 'session-someone-else',
        },
      }),
    );

    await expect(broker.getPortfolio(CONTRACT_SESSION_ID)).rejects.toThrow(
      expect.objectContaining({ code: 'INVARIANT_VIOLATION' }),
    );
  });

  it('rejects a malformed order snapshot', async () => {
    const broker = new PaperBroker(
      stubTransport({
        status: 200,
        body: { id: 'order-1', status: 'NOPE', version: '1' },
      }),
    );

    await expect(broker.placeOrder(marketBuy)).rejects.toThrow(
      expect.objectContaining({ code: 'INVARIANT_VIOLATION' }),
    );
  });

  it('rejects a non-numeric order version', async () => {
    const broker = new PaperBroker(
      stubTransport({
        status: 200,
        body: { id: 'order-1', status: 'OPEN', version: '1.5' },
      }),
    );

    await expect(broker.placeOrder(marketBuy)).rejects.toThrow(
      expect.objectContaining({ code: 'INVARIANT_VIOLATION' }),
    );
  });
});
