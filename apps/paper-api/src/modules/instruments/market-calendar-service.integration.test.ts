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

  it('remembers a failure for the failure ttl and re-throws it (#122)', async () => {
    // Otherwise a provider whose answer the decoder rejects draws one call per
    // session request and per MARKET order, into the MARKET_INFO rate limit.
    const failure = new Error('Invalid Toss calendar response: result');
    const port = {
      get: vi.fn(async () => {
        throw failure;
      }),
    };
    let now = new Date('2026-08-31T00:00:00.000Z');
    const service = new MarketCalendarService(port, {
      now: () => now,
      failureTtlMs: 15_000,
    });

    await expect(service.get('KR')).rejects.toBe(failure);
    now = new Date('2026-08-31T00:00:10.000Z');
    await expect(service.get('KR')).rejects.toBe(failure);
    expect(port.get).toHaveBeenCalledTimes(1);

    now = new Date('2026-08-31T00:00:20.000Z');
    await expect(service.get('KR')).rejects.toBe(failure);
    expect(port.get).toHaveBeenCalledTimes(2);
    // The window is per market, and `clear` drops it with the day.
    await expect(service.get('US')).rejects.toBe(failure);
    expect(port.get).toHaveBeenCalledTimes(3);
    service.clear('KR');
    await expect(service.get('KR')).rejects.toBe(failure);
    expect(port.get).toHaveBeenCalledTimes(4);
  });

  it('drops a remembered failure as soon as the port answers', async () => {
    let fail = true;
    const port = {
      get: vi.fn(async (market: 'KR' | 'US') => {
        if (fail) throw new Error('provider is down');
        return {
          market,
          session: 'REGULAR' as const,
          asOf: '2026-08-31',
          source: 'toss-calendar',
        };
      }),
    };
    let now = new Date('2026-08-31T00:00:00.000Z');
    const service = new MarketCalendarService(port, {
      now: () => now,
      failureTtlMs: 15_000,
      ttlMs: 60_000,
    });

    await expect(service.get('KR')).rejects.toThrow('provider is down');
    fail = false;
    now = new Date('2026-08-31T00:00:20.000Z');
    expect((await service.get('KR')).session).toBe('REGULAR');
    now = new Date('2026-08-31T00:00:25.000Z');
    expect((await service.get('KR')).session).toBe('REGULAR');
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
