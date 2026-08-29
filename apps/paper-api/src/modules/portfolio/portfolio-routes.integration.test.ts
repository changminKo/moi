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
