import { describe, expect, it, vi } from 'vitest';
import { MarketCalendarService } from './market-calendar-service.js';

describe('market calendar cache', () => {
  it('reads the REST port once until invalidated', async () => {
    const port = {
      get: vi.fn(async (market: 'KR' | 'US') => ({
        market,
        session: 'REGULAR' as const,
        asOf: '2026-08-22',
        source: 'toss-snapshot',
      })),
    };
    const service = new MarketCalendarService(port);
    await service.get('KR');
    await service.get('KR');
    expect(port.get).toHaveBeenCalledTimes(1);
    service.clear('KR');
    await service.get('KR');
    expect(port.get).toHaveBeenCalledTimes(2);
  });

  it('re-derives the phase from the clock without refetching the day', async () => {
    const port = {
      get: vi.fn(async (market: 'KR' | 'US') => ({
        market,
        session: 'CLOSED' as const,
        asOf: '2026-08-31T00:00:00.000Z',
        source: 'toss-calendar',
        tradingDate: '2026-08-31',
        isTradingDay: true,
        opensAt: '2026-08-31T00:00:00.000Z',
        closesAt: '2026-08-31T06:30:00.000Z',
      })),
    };
    let now = new Date('2026-08-30T23:00:00.000Z');
    // A day-long ttl isolates this case to the derivation; the refetch clock
    // has its own test below.
    const service = new MarketCalendarService(port, {
      now: () => now,
      ttlMs: 86_400_000,
    });

    expect((await service.get('KR')).phase).toBe('PRE_OPEN');
    now = new Date('2026-08-31T03:00:00.000Z');
    const open = await service.get('KR');
    expect(open.phase).toBe('REGULAR');
    // The session field the order service reads follows the derived phase.
    expect(open.session).toBe('REGULAR');
    now = new Date('2026-08-31T07:00:00.000Z');
    const closed = await service.get('KR');
    expect(closed.phase).toBe('POST_CLOSE');
    expect(closed.session).toBe('CLOSED');
    // One fetch: the window is cached, only the derivation moved.
    expect(port.get).toHaveBeenCalledTimes(1);
  });

  it('keeps a legacy port without a window working, mapping session to phase', async () => {
    const port = {
      get: vi.fn(async (market: 'KR' | 'US') => ({
        market,
        session: 'REGULAR' as const,
        asOf: '2026-08-22',
        source: 'legacy',
      })),
    };
    const service = new MarketCalendarService(port);
    const value = await service.get('US');
    expect(value.phase).toBe('REGULAR');
    expect(value.session).toBe('REGULAR');
  });

  it('refetches once the cached day is older than the ttl', async () => {
    const port = {
      get: vi.fn(async (market: 'KR' | 'US') => ({
        market,
        session: 'REGULAR' as const,
        asOf: '2026-08-31',
        source: 'toss-calendar',
      })),
    };
    let now = new Date('2026-08-31T00:00:00.000Z');
    const service = new MarketCalendarService(port, {
      now: () => now,
      ttlMs: 60_000,
    });
    await service.get('KR');
    now = new Date('2026-08-31T00:00:30.000Z');
    await service.get('KR');
    expect(port.get).toHaveBeenCalledTimes(1);
    now = new Date('2026-08-31T00:01:30.000Z');
    await service.get('KR');
    expect(port.get).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent misses into a single provider call', async () => {
    const port = {
      get: vi.fn(async (market: 'KR' | 'US') => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          market,
          session: 'REGULAR' as const,
          asOf: '2026-08-31',
          source: 'toss-calendar',
        };
      }),
    };
    const service = new MarketCalendarService(port);
    await Promise.all([
      service.get('KR'),
      service.get('KR'),
      service.get('KR'),
    ]);
    expect(port.get).toHaveBeenCalledTimes(1);
  });
});
