import {
  type DecimalString,
  DomainError,
  type Market,
  type OrderSnapshot,
  type PositionSnapshot,
  type Quantity,
  type Side,
  type WalletSnapshot,
} from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import type {
  CancelOrderCommand,
  ExchangeCommand,
  ExchangeReceipt,
  PlaceLimitOrderCommand,
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

/**
 * The ordinary way a strategy computes a price: an interface implementation
 * whose accessor lives on the prototype, so the value is reachable only through
 * a property read.
 */
class LimitBuyFromMid implements PlaceLimitOrderCommand {
  readonly type = 'LIMIT' as const;
  readonly market: Market = 'US';
  readonly side: Side = 'BUY';
  readonly sessionId: string = CONTRACT_SESSION_ID;
  readonly idempotencyKey: string = 'getter-key';
  readonly symbol: string = 'AAPL';
  readonly quantity: Quantity = '3';

  constructor(private readonly mid: number) {}

  get limitPrice(): DecimalString {
    return this.mid.toFixed(2);
  }
}

/**
 * A command whose fields are prototype accessors handing back a different value
 * on each read — the deterministic form of a price computed from a live quote.
 * The accessors sit on the prototype because an own `get` would be flattened by
 * a spread and hide the extra read.
 */
const drifting = (
  fields: Readonly<Record<string, readonly unknown[]>>,
): {
  readonly command: unknown;
  readonly reads: Record<string, number>;
} => {
  const reads: Record<string, number> = {};
  const prototype: Record<string, unknown> = {};

  for (const [field, values] of Object.entries(fields)) {
    reads[field] = 0;
    Object.defineProperty(prototype, field, {
      enumerable: true,
      get: () => {
        const index = reads[field] ?? 0;
        reads[field] = index + 1;

        return values[Math.min(index, values.length - 1)];
      },
    });
  }

  return { command: Object.create(prototype), reads };
};

const DRIFTING_LIMIT: Readonly<Record<string, readonly unknown[]>> = {
  sessionId: [CONTRACT_SESSION_ID],
  idempotencyKey: ['drift-key-1'],
  market: ['US'],
  symbol: ['AAPL'],
  side: ['BUY'],
  type: ['LIMIT'],
  quantity: ['3'],
  limitPrice: ['190.25'],
};

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

  // The validator's presence policy and this body builder's read must agree,
  // or a command the SDK blessed carries a price the validator never inspected
  // — or a legal accessor-backed command never reaches the wire at all.
  it('puts an accessor-supplied limit price on the wire', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    // A class instance, not an object literal: a literal's `get` is an *own*
    // accessor, so only a prototype-borne one probes the two readings apart.
    await new PaperBroker(transport).placeOrder(new LimitBuyFromMid(190.25));

    expect(requests[0]?.body).toStrictEqual({
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '3',
      limitPrice: '190.25',
    });
  });

  it('never lets an inherited forbidden price reach the transport', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const inherited = Object.assign(
      Object.create({ limitPrice: '190.25', triggerPrice: '5.00' }),
      marketBuy,
    ) as PlaceOrderCommand;

    await expect(
      new PaperBroker(transport).placeOrder(inherited),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(requests).toHaveLength(0);
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

  // Every field of a command is read once, at the boundary, and the request is
  // built from that snapshot. A second read is a second call into caller code,
  // so without the snapshot the wire carries a value the validator never saw.
  it('POSTs the price the validator inspected, not a later read', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const { command, reads } = drifting({
      ...DRIFTING_LIMIT,
      // `1e-8` is the exponent form this boundary exists to refuse, and
      // `not-a-number` is not money at all.
      limitPrice: ['190.25', '1e-8', 'not-a-number'],
    });

    await new PaperBroker(transport).placeOrder(command as PlaceOrderCommand);

    expect(requests[0]?.body).toStrictEqual({
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '3',
      limitPrice: '190.25',
    });
    expect(reads.limitPrice).toBe(1);
  });

  // The order type is the field the price rules hang off, so a drifting one
  // turns a validated LIMIT into a MARKET order carrying a limit price — the
  // exact shape `planReservation` rejects.
  it('never POSTs an order type the validator did not inspect', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const { command, reads } = drifting({
      ...DRIFTING_LIMIT,
      type: ['LIMIT', 'MARKET'],
    });

    await new PaperBroker(transport).placeOrder(command as PlaceOrderCommand);

    expect(requests[0]?.body).toMatchObject({
      type: 'LIMIT',
      limitPrice: '190.25',
    });
    expect(reads.type).toBe(1);
  });

  // The read-once pin. It is also what defends the shared
  // `projectOptionalField` call: an inline `=== undefined` ternary reads the
  // field a second time, and a getter can answer differently.
  it('reads every field of a place command exactly once', async () => {
    const { transport } = createFakeTransport(createPaperAccountFake());
    const { command, reads } = drifting(DRIFTING_LIMIT);

    await new PaperBroker(transport).placeOrder(command as PlaceOrderCommand);

    expect(reads).toStrictEqual({
      sessionId: 1,
      idempotencyKey: 1,
      market: 1,
      symbol: 1,
      side: 1,
      type: 1,
      quantity: 1,
      limitPrice: 1,
    });
  });

  it('addresses and keys the cancel the validator inspected', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const { command, reads } = drifting({
      sessionId: [CONTRACT_SESSION_ID],
      idempotencyKey: ['drift-cancel-1', 'other-key\n'],
      orderId: [CONTRACT_OPEN_ORDER_ID, 'x/../../admin'],
    });

    await new PaperBroker(transport).cancelOrder(command as CancelOrderCommand);

    expect(requests[0]?.path).toBe(`${ORDERS_PATH}/${CONTRACT_OPEN_ORDER_ID}`);
    expect(requests[0]?.idempotencyKey).toBe('drift-cancel-1');
    expect(reads).toStrictEqual({
      sessionId: 1,
      idempotencyKey: 1,
      orderId: 1,
    });
  });

  it('exchanges the quote the validator inspected', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const { command, reads } = drifting({
      sessionId: [CONTRACT_SESSION_ID, 'session-someone-else'],
      idempotencyKey: ['drift-exchange-1', 'other-key\n'],
      quoteId: [CONTRACT_QUOTE_ID, 'quote-someone-else'],
    });

    await new PaperBroker(transport).exchange(command as ExchangeCommand);

    expect(requests[0]?.body).toStrictEqual({ quoteId: CONTRACT_QUOTE_ID });
    expect(requests[0]?.idempotencyKey).toBe('drift-exchange-1');
    expect(reads).toStrictEqual({
      sessionId: 1,
      idempotencyKey: 1,
      quoteId: 1,
    });
  });

  // Not a RED cycle: this pins behaviour that already holds, so the cost of a
  // prototype-inclusive presence read is a decision rather than an accident. A
  // polluted `Object.prototype.limitPrice` is indistinguishable from a caller's
  // own accessor, so it supplies a LIMIT order's price — and makes an ordinary
  // MARKET order fail closed at the boundary instead of at the engine. The
  // alternatives are worse: own-property-only refuses the class and builder
  // shapes the published interfaces bless, and walking descriptors to exclude
  // `Object.prototype` — which would work, a `get`-trap Proxy having no resolved
  // descriptor to find — costs a descriptor read on every supplied optional
  // field, which the pin below measures.
  it('reads a polluted Object.prototype as a supplied price, both ways', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const broker = new PaperBroker(transport);
    const limitWithoutOwnPrice = {
      ...marketBuy,
      idempotencyKey: 'polluted-1',
      type: 'LIMIT',
    } as unknown as PlaceOrderCommand;
    let marketRejection: unknown;

    try {
      (Object.prototype as Record<string, unknown>).limitPrice = '999.99';

      await broker.placeOrder(limitWithoutOwnPrice);
      marketRejection = await broker
        .placeOrder({ ...marketBuy, idempotencyKey: 'polluted-2' })
        .catch((error: unknown) => error);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'limitPrice');
    }

    expect(requests[0]?.body).toStrictEqual({
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '3',
      limitPrice: '999.99',
    });
    expect(marketRejection).toMatchObject({ code: 'INVALID_ORDER' });
    expect(requests).toHaveLength(1);
  });

  // What the snapshot's null prototype actually buys, as the one input that can
  // tell: a null-prototype caller command cannot see a polluted
  // `Object.prototype`, so its MARKET order supplies no price — and neither does
  // the snapshot taken from it. A snapshot with the default prototype would see
  // the pollution the caller could not, and the order would be refused on
  // ambient state nothing on this call path touched.
  //
  // The transport here records and answers rather than replaying the request
  // through the in-memory account: the account would rebuild the command as a
  // plain object in this same realm and see the pollution itself, which is a
  // property of the harness and not of the adapter. A real paper API is another
  // process.
  //
  // Note what this does *not* pin, because the doc comment used to claim it: the
  // price rules and the request body cannot disagree whatever the snapshot's
  // prototype is, since both read it through the same `readOptionalField`. The
  // null prototype removes an ambient-refusal path; it is not what makes the
  // validated value and the wire value the same value.
  it('keeps a null-prototype command clear of a polluted Object.prototype', async () => {
    const requests: PaperBrokerRequest[] = [];
    const transport: PaperBrokerTransport = {
      request: async (request) => {
        requests.push(request);

        return {
          status: 200,
          body: { id: 'order-null-proto', status: 'FILLED', version: '2' },
        };
      },
    };
    const command = Object.assign(
      Object.create(null) as Record<string, unknown>,
      { ...marketBuy, idempotencyKey: 'null-proto-1' },
    ) as unknown as PlaceOrderCommand;
    let outcome: unknown;

    try {
      (Object.prototype as Record<string, unknown>).limitPrice = '999.99';

      outcome = await new PaperBroker(transport)
        .placeOrder(command)
        .catch((error: unknown) => error);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'limitPrice');
    }

    expect(outcome).toMatchObject({ id: 'order-null-proto' });
    expect(requests[0]?.body).toStrictEqual({
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      quantity: '3',
    });
  });

  // The other half of that trade, and the reason it survives re-examination.
  // Excluding a polluted `Object.prototype` means resolving each optional
  // field's descriptor, and a descriptor read is a second call into caller code
  // on the happy path — a `Proxy` whose `getOwnPropertyDescriptor` trap throws
  // or lies is a shape the published interfaces bless. The present policy asks
  // for a descriptor only when the value read came back `undefined`, so the OCO
  // command below — both prices supplied through `get` — never touches the trap
  // and is accepted. A descriptor walk would touch it and this order would be
  // refused, which is the cost the README states.
  it('never asks a supplied field for its descriptor', async () => {
    const { transport, requests } = createFakeTransport(
      createPaperAccountFake(),
    );
    const target: Record<string, unknown> = {
      sessionId: CONTRACT_SESSION_ID,
      idempotencyKey: 'proxy-descriptor-1',
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'OCO',
      quantity: '3',
      limitPrice: '190.25',
      triggerPrice: '180.00',
    };
    let descriptorReads = 0;
    const command = new Proxy(target, {
      get: (source, key) => source[key as string],
      getOwnPropertyDescriptor: (source, key) => {
        descriptorReads += 1;

        return Object.getOwnPropertyDescriptor(source, key);
      },
    }) as unknown as PlaceOrderCommand;

    await new PaperBroker(transport).placeOrder(command);

    expect(requests[0]?.body).toStrictEqual({
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'OCO',
      quantity: '3',
      limitPrice: '190.25',
      triggerPrice: '180.00',
    });
    expect(descriptorReads).toBe(0);
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
