import {
  FakeCalendarSource,
  type MarketCalendarSource,
} from '@moi/market-data';
import { describe, expect, it, vi } from 'vitest';
import { calendarPortFromSource } from './market-calendar-port.js';

describe('calendarPortFromSource', () => {
  it('asks the provider for the market-local trading date and maps the window', async () => {
    const source = new FakeCalendarSource();
    // 20:00Z is already the next calendar day in Seoul.
    const port = calendarPortFromSource(source, {
      now: () => new Date('2026-08-31T20:00:00.000Z'),
    });
    const facts = await port.get('KR');
    expect(facts).toMatchObject({
      market: 'KR',
      tradingDate: '2026-09-01',
      isTradingDay: true,
      opensAt: '2026-09-01T00:00:00.000Z',
      closesAt: '2026-09-01T23:59:59.999Z',
    });
    expect(facts.source).toContain('calendar');
  });

  it('maps a non-trading day to a closed session with no window', async () => {
    const source = new FakeCalendarSource();
    source.seed({
      market: 'US',
      tradingDate: '2026-08-31',
      isTradingDay: false,
      regularSession: null,
    });
    const port = calendarPortFromSource(source, {
      now: () => new Date('2026-08-31T14:00:00.000Z'),
    });
    const facts = await port.get('US');
    expect(facts).toMatchObject({
      market: 'US',
      isTradingDay: false,
      opensAt: null,
      closesAt: null,
      session: 'CLOSED',
    });
  });

  it('reports REGULAR only while the provider window contains the clock', async () => {
    const source = new FakeCalendarSource();
    source.seed({
      market: 'KR',
      tradingDate: '2026-08-31',
      isTradingDay: true,
      regularSession: {
        opensAt: '2026-08-31T00:00:00.000Z',
        closesAt: '2026-08-31T06:30:00.000Z',
      },
    });
    const inside = calendarPortFromSource(source, {
      now: () => new Date('2026-08-31T03:00:00.000Z'),
    });
    const outside = calendarPortFromSource(source, {
      now: () => new Date('2026-08-31T07:00:00.000Z'),
    });
    expect((await inside.get('KR')).session).toBe('REGULAR');
    expect((await outside.get('KR')).session).toBe('CLOSED');
  });

  it('names a failed calendar read in the log and still rejects (#122)', async () => {
    // Nothing else reports this: the session route answers 503 from an empty
    // catch and the custom error handler replaces Fastify's own logging.
    const source: MarketCalendarSource = {
      getCalendarDay: async () => {
        throw new Error(
          'Invalid Toss calendar response: result must be an object',
        );
      },
    };
    const log = vi.fn();
    const port = calendarPortFromSource(source, {
      now: () => new Date('2026-08-31T20:00:00.000Z'),
      log,
    });

    await expect(port.get('KR')).rejects.toThrow(/calendar/iu);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('calendar.decode_failed', {
      market: 'KR',
      tradingDate: '2026-09-01',
      reason: 'Invalid Toss calendar response: result must be an object',
    });
    // The reason, never the provider's answer.
    const [, fields] = log.mock.calls[0] as [string, Record<string, unknown>];
    expect(Object.keys(fields).sort()).toEqual([
      'market',
      'reason',
      'tradingDate',
    ]);
  });

  it('says nothing when the provider answers', async () => {
    const log = vi.fn();
    const port = calendarPortFromSource(new FakeCalendarSource(), {
      now: () => new Date('2026-08-31T20:00:00.000Z'),
      log,
    });

    await port.get('KR');

    expect(log).not.toHaveBeenCalled();
  });
});
