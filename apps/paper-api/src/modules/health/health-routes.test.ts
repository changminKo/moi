import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerHealthRoutes } from './health-routes.js';

describe('health routes', () => {
  it('separates readiness from degraded market data and emits stable headers', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, {
      db: async () => true,
      audit: async () => true,
      marketData: () => ({ US: { state: 'DEGRADED', reason: 'STALE_FEED' } }),
    });
    const ready = await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-request-id': 'req-1' },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.headers['x-request-id']).toBe('req-1');
    expect(
      (await app.inject({ method: 'GET', url: '/health/market-data' })).json(),
    ).toMatchObject({ US: { state: 'DEGRADED' } });
    await app.close();
  });

  it('degrades readiness when database or audit is unavailable', async () => {
    const app = Fastify();
    await registerHealthRoutes(app, {
      db: async () => false,
      audit: async () => true,
      marketData: () => ({}),
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'NOT_READY',
      retryable: true,
    });
    await app.close();
  });
});
