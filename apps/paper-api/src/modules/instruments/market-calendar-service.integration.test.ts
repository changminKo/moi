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
});
