import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { MarketCalendarService } from './market-calendar-service.js';
import { registerMarketSessionRoutes } from './market-session-routes.js';

const port = (
  overrides: Record<string, unknown> = {},
): { get: (market: 'KR' | 'US') => Promise<never> } =>
  ({
    get: vi.fn(async (market: 'KR' | 'US') => ({
      market,
      session: 'CLOSED' as const,
      asOf: '2026-08-31T00:00:00.000Z',
      source: 'toss-calendar',
      tradingDate: '2026-08-31',
      isTradingDay: true,
      opensAt: '2026-08-31T00:00:00.000Z',
      closesAt: '2026-08-31T06:30:00.000Z',
      ...overrides,
    })),
  }) as never;

async function appWith(clock: () => Date, calendarPort = port()) {
  const app = Fastify();
  const calendar = new MarketCalendarService(calendarPort as never, {
    now: clock,
    ttlMs: 86_400_000,
  });
  await registerMarketSessionRoutes(app, { calendar, now: clock });
  return app;
}

describe('market session route', () => {
  it('returns the session window and a phase derived from server time', async () => {
    const app = await appWith(() => new Date('2026-08-31T03:00:00.000Z'));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/markets/KR/session',
      headers: { 'x-request-id': 'req-session' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      market: 'KR',
      phase: 'REGULAR',
      isTradingDay: true,
      opensAt: '2026-08-31T00:00:00.000Z',
      closesAt: '2026-08-31T06:30:00.000Z',
      asOf: '2026-08-31T00:00:00.000Z',
      serverTime: '2026-08-31T03:00:00.000Z',
    });
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    // Bare Fastify generates its own id; the app config maps the header.
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    await app.close();
  });

  it('moves through the phases as server time crosses the window', async () => {
    let now = new Date('2026-08-30T22:00:00.000Z');
    const app = await appWith(() => now);
    const phaseAt = async (at: string) => {
      now = new Date(at);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/markets/KR/session',
      });
      return response.json().phase;
    };
    expect(await phaseAt('2026-08-30T22:00:00.000Z')).toBe('PRE_OPEN');
    expect(await phaseAt('2026-08-31T03:00:00.000Z')).toBe('REGULAR');
    expect(await phaseAt('2026-08-31T08:00:00.000Z')).toBe('POST_CLOSE');
    await app.close();
  });

  it('reports HOLIDAY on a non-trading day', async () => {
    const app = await appWith(
      () => new Date('2026-08-31T03:00:00.000Z'),
      port({ isTradingDay: false, opensAt: null, closesAt: null }),
    );
    const body = (
      await app.inject({ method: 'GET', url: '/api/v1/markets/US/session' })
    ).json();
    expect(body).toMatchObject({
      market: 'US',
      phase: 'HOLIDAY',
      isTradingDay: false,
      opensAt: null,
      closesAt: null,
    });
    await app.close();
  });

  it('rejects an unknown market with the public validation error', async () => {
    const app = await appWith(() => new Date('2026-08-31T03:00:00.000Z'));
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/markets/JP/session',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
    await app.close();
  });

  it('answers 503 rather than inventing a phase when the calendar is unavailable', async () => {
    const failing = {
      get: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const app = await appWith(
      () => new Date('2026-08-31T03:00:00.000Z'),
      failing as never,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/markets/KR/session',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
    await app.close();
  });

  it('reports a legacy calendar without a window as an unknown-window day', async () => {
    const legacy = {
      get: vi.fn(async (market: 'KR' | 'US') => ({
        market,
        session: 'REGULAR' as const,
        asOf: '2026-08-31',
        source: 'legacy',
      })),
    };
    const app = await appWith(
      () => new Date('2026-08-31T03:00:00.000Z'),
      legacy as never,
    );
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/v1/markets/KR/session' })
      ).json(),
    ).toMatchObject({
      phase: 'REGULAR',
      isTradingDay: true,
      opensAt: null,
      closesAt: null,
    });
    await app.close();
  });
});
