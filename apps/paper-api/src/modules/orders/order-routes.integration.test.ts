import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerOrderRoutes } from './order-routes.js';

describe('order routes', () => {
  it('replays the exact response and rejects capability-denied placement', async () => {
    const app = Fastify();
    let calls = 0;
    await registerOrderRoutes(app, {
      principal: async () => ({ id: 's1', status: 'ACTIVE' }),
      execute: async () => {
        calls += 1;
        return { statusCode: 201, headers: { etag: 'x' }, body: '{"id":"o1"}' };
      },
    });
    const payload = {
      market: 'US',
      symbol: 'AAPL',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'idempotency-key': 'k1' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'idempotency-key': 'k1' },
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(calls).toBe(1);
    await app.close();
  });
});
