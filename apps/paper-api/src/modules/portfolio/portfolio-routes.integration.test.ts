import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerPortfolioRoutes } from './portfolio-routes.js';
import { PortfolioService } from './portfolio-service.js';

describe('portfolio routes', () => {
  it('serves one session-owned decimal snapshot and stable historical cursors', async () => {
    let runs = 0;
    const service = new PortfolioService({
      runSnapshot: async (work) => {
        runs += 1;
        return work({
          snapshot: async () => ({
            wallets: [
              {
                currency: 'USD',
                total: '100.10',
                available: '90.00',
                reserved: '10.10',
              },
            ],
            positions: [],
            reservations: [],
            activeOrders: [
              {
                id: 'active-1',
                status: 'OPEN',
                quantity: '2',
                filledQuantity: '0',
              },
            ],
            accountSequence: '42',
            market: {
              health: { KR: 'NORMAL', US: 'LOSSY' },
              recoveryFill: { KR: false, US: true },
            },
          }),
          listOrders: async () => ({
            items: [
              {
                id: 'old-1',
                status: 'FILLED',
                quantity: '1',
                filledQuantity: '1',
              },
            ],
            nextCursor: 'cursor-1',
          }),
          listFills: async (_sessionId, query) => ({
            items: [
              {
                id: 'fill-1',
                fillSequence: query.after === undefined ? '1' : '2',
                accountSequence: '7',
                orderId: 'order-1',
                market: 'KR',
                symbol: '005930',
                side: 'BUY',
                quantity: '1',
                price: '71200',
                fee: '10.6800',
                feeCurrency: 'KRW',
                isRecoveryFill: false,
                occurredAt: '2026-08-30T00:00:00.000Z',
              },
            ],
            ...(query.after === undefined ? { nextCursor: '1' } : {}),
          }),
          getOrder: async (_sessionId, id) =>
            id === 'old-1'
              ? { id, status: 'FILLED', quantity: '1', filledQuantity: '1' }
              : undefined,
        });
      },
    });
    const app = Fastify();
    await registerPortfolioRoutes(app, {
      principal: async () => ({ id: 'session-1', status: 'ACTIVE' }),
      service,
    });

    const snapshot = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio',
    });
    expect(snapshot.statusCode).toBe(200);
    // Asserted on its own, not folded into the `objectContaining` below: an
    // `objectContaining` would still pass if `sessionId` disappeared, and a
    // client that checks the payload names its own session (the SDK does, and
    // fails `INVARIANT_VIOLATION` when it does not) would break silently.
    expect(snapshot.json().sessionId).toBe('session-1');
    expect(snapshot.json()).toEqual(
      expect.objectContaining({
        accountSequence: '42',
        wallets: [
          {
            currency: 'USD',
            total: '100.10',
            available: '90.00',
            reserved: '10.10',
          },
        ],
      }),
    );
    expect(runs).toBe(1);

    const orders = await app.inject({
      method: 'GET',
      url: '/api/v1/orders?limit=1',
    });
    expect(orders.statusCode).toBe(200);
    expect(orders.json()).toEqual({
      items: [
        { id: 'old-1', status: 'FILLED', quantity: '1', filledQuantity: '1' },
      ],
      nextCursor: 'cursor-1',
    });

    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/orders/old-1',
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(expect.objectContaining({ id: 'old-1' }));
    await app.close();
  });

  it('pages fills on the session cursor, caps the limit and never lets a shared cache hold them', async () => {
    const seen: unknown[] = [];
    const service = new PortfolioService({
      runSnapshot: async (work) =>
        work({
          snapshot: async () => {
            throw new Error('not used');
          },
          listOrders: async () => ({ items: [] }),
          getOrder: async () => undefined,
          listFills: async (sessionId, query) => {
            seen.push({ sessionId, query });
            return {
              items: [
                {
                  id: 'fill-1',
                  fillSequence: '9',
                  accountSequence: '7',
                  orderId: 'order-1',
                  market: 'KR',
                  symbol: '005930',
                  side: 'BUY',
                  quantity: '1',
                  price: '71200',
                  fee: '10.6800',
                  feeCurrency: 'KRW',
                  isRecoveryFill: false,
                  occurredAt: '2026-08-30T00:00:00.000Z',
                },
              ],
              nextCursor: '9',
            };
          },
        }),
    });
    const app = Fastify();
    await registerPortfolioRoutes(app, {
      principal: async () => ({ id: 'session-1', status: 'ACTIVE' }),
      service,
    });

    const page = await app.inject({ method: 'GET', url: '/api/v1/fills' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['cache-control']).toBe('private, no-store');
    expect(page.json()).toEqual({
      items: [
        {
          id: 'fill-1',
          fillSequence: '9',
          accountSequence: '7',
          orderId: 'order-1',
          market: 'KR',
          symbol: '005930',
          side: 'BUY',
          quantity: '1',
          price: '71200',
          fee: '10.6800',
          feeCurrency: 'KRW',
          isRecoveryFill: false,
          occurredAt: '2026-08-30T00:00:00.000Z',
        },
      ],
      nextCursor: '9',
    });
    // The session comes from the principal, never from the query string.
    expect(seen[0]).toEqual({
      sessionId: 'session-1',
      query: { limit: 50 },
    });

    await app.inject({ method: 'GET', url: '/api/v1/fills?after=9&limit=200' });
    expect(seen[1]).toEqual({
      sessionId: 'session-1',
      query: { after: '9', limit: 200 },
    });

    for (const url of [
      '/api/v1/fills?limit=201',
      '/api/v1/fills?limit=0',
      '/api/v1/fills?after=abc',
      '/api/v1/fills?after=-1',
      // Beyond bigint: unbounded digits reach `::bigint`, which raises 22003
      // and surfaces as a 500 — a caller's bad cursor must read as a 400, and
      // must not pollute the deploy verification or the alerting signal.
      '/api/v1/fills?after=99999999999999999999',
      '/api/v1/fills?after=9223372036854775808',
      '/api/v1/fills?sessionId=other',
    ]) {
      const rejected = await app.inject({ method: 'GET', url });
      expect(rejected.statusCode, url).toBe(400);
      expect(rejected.json().code).toBe('VALIDATION_ERROR');
    }
    expect(seen).toHaveLength(2);
    await app.close();
  });

  it('requires an active session and never accepts a caller-supplied session id', async () => {
    const app = Fastify();
    await registerPortfolioRoutes(app, {
      principal: async () => {
        throw Object.assign(new Error('session is required'), {
          statusCode: 401,
        });
      },
      service: new PortfolioService(),
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio?sessionId=other',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
