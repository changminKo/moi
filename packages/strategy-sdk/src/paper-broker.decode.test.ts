import { DomainError } from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import type { PlaceOrderCommand } from './broker.js';
import {
  PaperBroker,
  type PaperBrokerResponse,
  type PaperBrokerTransport,
} from './paper-broker.js';

const SESSION_ID = 'session-decode-1';

const stub = (response: PaperBrokerResponse): PaperBrokerTransport => ({
  request: async () => response,
});

const ok = (body: unknown): PaperBrokerTransport => stub({ status: 200, body });

const marketBuy: PlaceOrderCommand = {
  sessionId: SESSION_ID,
  idempotencyKey: 'decode-key-1',
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  quantity: '3',
};

const rejection = async (act: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { resolved: await act() };
  } catch (error) {
    return error;
  }
};

const codeOf = async (act: () => Promise<unknown>): Promise<unknown> => {
  const thrown = await rejection(act);

  return thrown instanceof DomainError
    ? thrown.code
    : thrown instanceof Error
      ? `${thrown.name}: ${thrown.message}`
      : thrown;
};

const wallet = (overrides: Record<string, unknown> = {}): unknown => ({
  currency: 'KRW',
  total: '1000',
  available: '1000',
  reserved: '0',
  version: '1',
  ...overrides,
});

const position = (overrides: Record<string, unknown> = {}): unknown => ({
  symbol: 'AAPL',
  total: '3',
  available: '3',
  reserved: '0',
  version: '1',
  ...overrides,
});

const portfolio = (overrides: Record<string, unknown> = {}): unknown => ({
  sessionId: SESSION_ID,
  wallets: [wallet()],
  positions: [position()],
  activeOrders: [],
  accountSequence: '7',
  ...overrides,
});

const receipt = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'conversion-1',
  quoteId: 'quote-1',
  sessionId: SESSION_ID,
  from: 'KRW',
  to: 'USD',
  sourceAmount: '1000000',
  rate: '0.00075',
  fee: '0',
  targetAmount: '750',
  executedAt: '2026-08-22T00:00:00.000Z',
  ...overrides,
});

const exchangeCommand = {
  sessionId: SESSION_ID,
  idempotencyKey: 'decode-key-2',
  quoteId: 'quote-1',
} as const;

const MALFORMED_DECIMALS = [
  'not-a-number',
  '',
  '-5',
  '1e3',
  '0x10',
  '+1',
  '.5',
  '5.',
  'Infinity',
  'NaN',
  '{}',
] as const;

describe('PaperBroker decodes money fields at the boundary', () => {
  it.each(MALFORMED_DECIMALS)('rejects a wallet total of %s', async (total) => {
    const broker = new PaperBroker(
      ok(portfolio({ wallets: [wallet({ total })] })),
    );

    await expect(codeOf(() => broker.getPortfolio(SESSION_ID))).resolves.toBe(
      'INVARIANT_VIOLATION',
    );
  });

  it.each(['available', 'reserved'])(
    'rejects a malformed wallet %s',
    async (field) => {
      const broker = new PaperBroker(
        ok(portfolio({ wallets: [wallet({ [field]: 'not-a-number' })] })),
      );

      await expect(codeOf(() => broker.getPortfolio(SESSION_ID))).resolves.toBe(
        'INVARIANT_VIOLATION',
      );
    },
  );

  it.each(['zzz', '-1', '1.5', '1e3', ''])(
    'rejects an account sequence of %s',
    async (accountSequence) => {
      const broker = new PaperBroker(ok(portfolio({ accountSequence })));

      await expect(codeOf(() => broker.getPortfolio(SESSION_ID))).resolves.toBe(
        'INVARIANT_VIOLATION',
      );
    },
  );

  it.each(['total', 'available', 'reserved'])(
    'holds a position %s to a whole quantity',
    async (field) => {
      const broker = new PaperBroker(
        ok(portfolio({ positions: [position({ [field]: '1.5' })] })),
      );

      await expect(codeOf(() => broker.getPortfolio(SESSION_ID))).resolves.toBe(
        'INVARIANT_VIOLATION',
      );
    },
  );

  it.each(['banana', '-3', '1.5', '1e3'])(
    'rejects a filled quantity of %s',
    async (filledQuantity) => {
      const broker = new PaperBroker(
        ok({ id: 'order-1', status: 'OPEN', version: '1', filledQuantity }),
      );

      await expect(codeOf(() => broker.placeOrder(marketBuy))).resolves.toBe(
        'INVARIANT_VIOLATION',
      );
    },
  );

  it.each(['sourceAmount', 'rate', 'fee', 'targetAmount'])(
    'rejects a malformed exchange %s',
    async (field) => {
      const broker = new PaperBroker(ok(receipt({ [field]: 'not-a-number' })));

      await expect(
        codeOf(() => broker.exchange(exchangeCommand)),
      ).resolves.toBe('INVARIANT_VIOLATION');
    },
  );

  it('rejects a malformed exchange execution time', async () => {
    const broker = new PaperBroker(ok(receipt({ executedAt: 'yesterday' })));

    await expect(codeOf(() => broker.exchange(exchangeCommand))).resolves.toBe(
      'INVARIANT_VIOLATION',
    );
  });

  it('accepts a well-formed portfolio and receipt', async () => {
    const snapshot = await new PaperBroker(ok(portfolio())).getPortfolio(
      SESSION_ID,
    );
    expect(snapshot.accountSequence).toBe('7');

    const decoded = await new PaperBroker(ok(receipt())).exchange(
      exchangeCommand,
    );
    expect(decoded.targetAmount).toBe('750');
  });

  it('rejects two wallets of the same currency', async () => {
    const broker = new PaperBroker(
      ok(portfolio({ wallets: [wallet(), wallet()] })),
    );

    await expect(codeOf(() => broker.getPortfolio(SESSION_ID))).resolves.toBe(
      'INVARIANT_VIOLATION',
    );
  });

  it('rejects two positions of the same symbol', async () => {
    const broker = new PaperBroker(
      ok(portfolio({ positions: [position(), position()] })),
    );

    await expect(codeOf(() => broker.getPortfolio(SESSION_ID))).resolves.toBe(
      'INVARIANT_VIOLATION',
    );
  });
});

// The command side of this boundary reads each caller field exactly once, for a
// reason that is symmetric: a response body is also an object whose fields may be
// accessors, so a decoder that validates one read and returns another emits a
// value nothing checked. On `terminalReason` the emitted value is a *literal* the
// decoder writes itself, so the drift fabricates a reason the paper API never
// reported — on an order it also reports as `OPEN`.
describe('PaperBroker decodes the order snapshot it validated', () => {
  const driftingOrderBody = (
    field: string,
    values: readonly unknown[],
  ): { readonly body: Record<string, unknown>; reads: () => number } => {
    let reads = 0;
    const body: Record<string, unknown> = {
      id: 'order-decode-1',
      status: 'OPEN',
      version: '1',
    };

    Object.defineProperty(body, field, {
      enumerable: true,
      get: () => {
        const index = reads;
        reads += 1;

        return values[Math.min(index, values.length - 1)];
      },
    });

    return { body, reads: () => reads };
  };

  it('emits no terminal reason for a body that reported none', async () => {
    const { body, reads } = driftingOrderBody('terminalReason', [
      undefined,
      'IOC_REMAINDER',
    ]);

    const snapshot = await new PaperBroker(ok(body)).placeOrder(marketBuy);

    expect(snapshot).toStrictEqual({
      id: 'order-decode-1',
      status: 'OPEN',
      version: 1n,
    });
    expect(reads()).toBe(1);
  });

  it('emits the terminal reason it validated', async () => {
    const { body, reads } = driftingOrderBody('terminalReason', [
      'IOC_REMAINDER',
      undefined,
    ]);

    const snapshot = await new PaperBroker(ok(body)).placeOrder(marketBuy);

    expect(snapshot).toStrictEqual({
      id: 'order-decode-1',
      status: 'OPEN',
      version: 1n,
      terminalReason: 'IOC_REMAINDER',
    });
    expect(reads()).toBe(1);
  });

  it('reads a filled quantity once and returns that read', async () => {
    const { body, reads } = driftingOrderBody('filledQuantity', ['2', '-9']);

    const snapshot = await new PaperBroker(ok(body)).placeOrder(marketBuy);

    expect(snapshot).toStrictEqual({
      id: 'order-decode-1',
      status: 'OPEN',
      version: 1n,
      filledQuantity: '2',
    });
    expect(reads()).toBe(1);
  });
});

describe('PaperBroker scopes every response to the requested session', () => {
  it('rejects an exchange receipt issued for another session', async () => {
    const broker = new PaperBroker(
      ok(receipt({ sessionId: 'session-someone-else' })),
    );

    await expect(codeOf(() => broker.exchange(exchangeCommand))).resolves.toBe(
      'INVARIANT_VIOLATION',
    );
  });

  it('accepts an exchange receipt for the requested session', async () => {
    const decoded = await new PaperBroker(ok(receipt())).exchange(
      exchangeCommand,
    );

    expect(decoded.sessionId).toBe(SESSION_ID);
  });
});

describe('PaperBroker guards every public method at the runtime boundary', () => {
  const orderResponse = ok({ id: 'order-1', status: 'OPEN', version: '1' });

  it.each([
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['whitespace', '   '],
  ])('rejects %s order id with a domain error', async (_label, orderId) => {
    const broker = new PaperBroker(orderResponse);

    await expect(
      codeOf(() =>
        broker.cancelOrder({
          sessionId: SESSION_ID,
          idempotencyKey: 'k',
          orderId,
        } as never),
      ),
    ).resolves.toBe('INVALID_ORDER');
  });

  it.each([
    ['a number', 12345],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s quote id with a domain error', async (_label, quoteId) => {
    const broker = new PaperBroker(ok(receipt()));

    await expect(
      codeOf(() =>
        broker.exchange({
          sessionId: SESSION_ID,
          idempotencyKey: 'k',
          quoteId,
        } as never),
      ),
    ).resolves.toBe('INVALID_ORDER');
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['an array', []],
  ])('rejects %s as a whole command', async (_label, value) => {
    const broker = new PaperBroker(orderResponse);

    await expect(
      codeOf(() => broker.cancelOrder(value as never)),
    ).resolves.toBe('INVALID_ORDER');
    await expect(codeOf(() => broker.exchange(value as never))).resolves.toBe(
      'INVALID_ORDER',
    );
  });

  it.each([
    ['null', null],
    ['a number', 7],
  ])('rejects %s as a session id on the read', async (_label, value) => {
    const broker = new PaperBroker(ok(portfolio()));

    await expect(
      codeOf(() => broker.getPortfolio(value as never)),
    ).resolves.toBe('INVALID_ORDER');
  });

  it('keeps a hostile order id inside the orders path', async () => {
    const paths: string[] = [];
    const broker = new PaperBroker({
      request: async (request) => {
        paths.push(request.path);

        return { status: 200, body: { id: 'o', status: 'OPEN', version: '1' } };
      },
    });

    await broker.cancelOrder({
      sessionId: SESSION_ID,
      idempotencyKey: 'k',
      orderId: '../../../live/orders',
    });

    expect(paths).toStrictEqual([
      '/api/v1/orders/..%2F..%2F..%2Flive%2Forders',
    ]);
  });
});

describe('PaperBroker classifies transport statuses', () => {
  const CASES: readonly (readonly [number, string, boolean])[] = [
    [400, 'INVALID_ORDER', false],
    [401, 'ACCOUNT_READ_ONLY', false],
    [403, 'ACCOUNT_READ_ONLY', false],
    [404, 'INVALID_ORDER', false],
    [408, 'SERVICE_UNAVAILABLE', true],
    [409, 'ORDER_STATE_CONFLICT', false],
    [422, 'INVALID_ORDER', false],
    [425, 'SERVICE_UNAVAILABLE', true],
    [429, 'RATE_LIMITED', true],
    [500, 'SERVICE_UNAVAILABLE', true],
    [503, 'SERVICE_UNAVAILABLE', true],
  ];

  it.each(CASES)('maps status %i to %s', async (status, code, retryable) => {
    const broker = new PaperBroker(
      stub({ status, body: { message: 'unknown to the sdk' } }),
    );
    const thrown = await rejection(() => broker.placeOrder(marketBuy));

    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({ code, retryable });
  });

  it.each([301, 302, 307])(
    'treats a %i redirect as a broken contract',
    async (status) => {
      const broker = new PaperBroker(stub({ status, body: {} }));

      await expect(codeOf(() => broker.placeOrder(marketBuy))).resolves.toBe(
        'INVARIANT_VIOLATION',
      );
    },
  );

  it('still trusts a stable server code over the status', async () => {
    const broker = new PaperBroker(
      stub({
        status: 409,
        body: { code: 'IDEMPOTENCY_CONFLICT', message: 'key in flight' },
      }),
    );

    await expect(codeOf(() => broker.placeOrder(marketBuy))).resolves.toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it.each([
    ['negative', -5],
    ['not finite', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
  ])('drops a %s retryAfter hint', async (_label, retryAfter) => {
    const broker = new PaperBroker(
      stub({
        status: 429,
        body: { code: 'RATE_LIMITED', message: 'slow down', retryAfter },
      }),
    );
    const thrown = await rejection(() => broker.placeOrder(marketBuy));

    expect(thrown).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect((thrown as DomainError).retryAfterSeconds).toBeUndefined();
  });

  it('keeps a fractional retryAfter hint', async () => {
    const broker = new PaperBroker(
      stub({
        status: 503,
        body: { message: 'draining', retryAfter: 0.5 },
      }),
    );
    const thrown = await rejection(() => broker.placeOrder(marketBuy));

    expect(thrown).toMatchObject({ retryAfterSeconds: 0.5 });
  });
});
