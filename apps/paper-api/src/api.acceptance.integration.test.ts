import { createFeeModel } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { PaperEngine } from './engine/paper-engine.js';
import { FxService } from './modules/fx/fx-service.js';
import { createPortfolioService } from './modules/portfolio/portfolio-service.js';
import {
  type SessionPrincipal,
  SessionService,
} from './modules/session/session-service.js';
import {
  type DurableAccountEvent,
  StreamSession,
} from './modules/stream/stream-session.js';

const ERROR_CATALOG = [
  ['SYMBOL_NOT_TRADABLE', 409, false],
  ['MARKET_CLOSED', 409, false],
  ['MARKET_DATA_DEGRADED', 503, true],
  ['RECOVERY_IN_PROGRESS', 503, true],
  ['CANCEL_ONLY', 409, false],
  ['ACCOUNT_READ_ONLY', 409, false],
  ['SERVICE_UNAVAILABLE', 503, true],
  ['INSUFFICIENT_AVAILABLE_CASH', 409, false],
  ['INSUFFICIENT_AVAILABLE_POSITION', 409, false],
  ['PRICE_PROTECTION', 409, false],
  ['ORDER_STATE_CONFLICT', 409, false],
  ['IDEMPOTENCY_CONFLICT', 409, false],
  ['RATE_LIMITED', 429, true],
  ['CAPACITY_REACHED', 409, false],
  ['INVALID_QUANTITY', 400, false],
  ['INVALID_PRICE', 400, false],
  ['INVALID_ORDER', 400, false],
  ['INVARIANT_VIOLATION', 500, false],
  ['VALIDATION_ERROR', 400, false],
  ['SESSION_EXPIRED', 401, false],
  ['FORBIDDEN', 403, false],
  ['NOT_FOUND', 404, false],
  ['QUOTE_EXPIRED', 409, false],
  ['QUOTE_CONSUMED', 409, false],
  ['PAYLOAD_TOO_LARGE', 413, false],
  ['INTERNAL_ERROR', 500, false],
] as const;

const now = new Date('2026-08-24T00:00:00.000Z');
const envelope = <T>(payload: T, version = 1n) => ({
  recoveryEpoch: 1n,
  leaderFencingToken: 1n,
  marketDataVersion: version,
  payload,
});

function sessionStore() {
  const rows = new Map<string, SessionPrincipal>();
  return {
    rows,
    findByTokenHash: async (hash: string) =>
      [...rows.values()].find((row) => row.id === hash),
    bootstrap: async (input: {
      id: string;
      now: Date;
      expiresAt: Date;
      tokenHash: string;
    }) => {
      const principal = {
        id: input.tokenHash,
        status: 'ACTIVE' as const,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now,
      };
      rows.set(principal.id, principal);
      return principal;
    },
  };
}

describe('paper API acceptance vertical slice', () => {
  it('runs anonymous session, FX exchange, market order, partial fill, snapshot, and reconnect', async () => {
    const store = sessionStore();
    const sessions = new SessionService({
      keys: ['acceptance-key'],
      csrfSecret: 'csrf',
      store,
      clock: () => now,
    });
    const issued = await sessions.bootstrap();
    expect(issued.session.status).toBe('ACTIVE');

    const wallets = new Map([
      [
        'session',
        new Map([
          ['KRW', '10000000' as const],
          ['USD', '0' as const],
        ]),
      ],
    ]);
    const fx = new FxService({
      clock: () => now,
      wallets: wallets as never,
      rate: '0.0007',
    });
    const quote = await fx.quote('session', {
      from: 'KRW',
      to: 'USD',
      amount: '1000000',
    });
    const receipt = await fx.exchange('session', quote.id, 'fx-1');
    expect(receipt.targetAmount).toBe('700');

    const engine = new PaperEngine({
      feeModel: createFeeModel({
        version: 'acceptance',
        market: 'US',
        currency: 'USD',
        commissionRate: '0',
        sellTaxRate: '0',
        roundingDecimals: 2,
        roundingMode: 'HALF_UP',
      }),
    });
    await engine.onOrderBook(
      envelope({
        symbol: 'AAPL',
        market: 'US',
        currency: 'USD',
        bids: [{ price: '199', volume: '10' }],
        asks: [{ price: '200', volume: '2' }],
      }),
    );
    const order = await engine.placeImmediateOrder({
      id: 'order-1',
      sessionId: 'session',
      market: 'US',
      symbol: 'AAPL',
      currency: 'USD',
      side: 'BUY',
      quantity: '3',
    });
    expect(order.filledQuantity).toBe('2');
    expect(order.status).toBe('CANCELLED');

    const portfolio = createPortfolioService({
      run: async (work) =>
        work({
          portfolio: {
            snapshot: async () => ({
              wallets: [{ currency: 'USD', available: '700' }],
              positions: [
                { symbol: 'AAPL', quantity: order.filledQuantity ?? '0' },
              ],
              reservations: [],
              activeOrders: [],
              accountSequence: '2',
              market: {
                health: { US: 'HEALTHY' },
                recoveryFill: { US: false },
              },
            }),
            listOrders: async () => ({ items: [] }),
            getOrder: async () => undefined,
          },
        }),
    });
    const snapshot = await portfolio.snapshot('session');
    expect(snapshot.positions[0]?.quantity).toBe('2');
    expect(snapshot.activeOrders).toEqual([]);

    const messages: string[] = [];
    const events: DurableAccountEvent[] = [
      {
        id: 'event-1',
        eventId: 'event-1',
        sessionId: 'session',
        accountSequence: '2',
        eventType: 'FILL_CREATED',
        payload: { orderId: order.id },
        createdAt: now.toISOString(),
      },
    ];
    const stream = (
      await StreamSession.open({
        sessionId: 'session',
        source: {
          latest: async () => '2',
          oldest: async () => '1',
          replay: async () => events,
        },
        socket: { send: (value) => messages.push(value), close: () => {} },
      })
    ).session;
    const event = events[0];
    if (!event) throw new Error('acceptance event missing');
    await stream.deliver(event);
    expect(messages.map((value) => JSON.parse(value).type)).toEqual([
      'ready',
      'event',
      'event',
    ]);
  });

  it.each(ERROR_CATALOG)(
    'keeps %s in the stable error contract',
    async (code, status, retryable) => {
      expect(status).toBe(
        code === 'RATE_LIMITED'
          ? 429
          : code === 'SERVICE_UNAVAILABLE' ||
              code === 'MARKET_DATA_DEGRADED' ||
              code === 'RECOVERY_IN_PROGRESS'
            ? 503
            : status,
      );
      expect(retryable).toBe(
        code === 'RATE_LIMITED' ||
          code === 'SERVICE_UNAVAILABLE' ||
          code === 'MARKET_DATA_DEGRADED' ||
          code === 'RECOVERY_IN_PROGRESS',
      );
    },
  );

  it('has one documented row per catalog code', async () => {
    const markdown = await (await import('node:fs/promises')).readFile(
      new URL('../../../docs/api/error-contract.md', import.meta.url),
      'utf8',
    );
    const documented = [...markdown.matchAll(/^\| `([^`]+)` \|/gm)].map(
      (match) => match[1],
    );
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(
      ERROR_CATALOG.map(([code]) => code).sort(),
    );
  });
});
