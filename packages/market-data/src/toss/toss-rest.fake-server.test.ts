import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTossRestServer } from '../testing/fake-toss/fake-toss-rest-server.js';
import { OAuthTokenProvider } from './oauth-token-provider.js';
import { TossRestClient } from './toss-rest.js';

let server: FakeTossRestServer;
beforeEach(async () => {
  server = new FakeTossRestServer();
  await server.start();
  server.seedSnapshot('US', 'AAPL', '185.70', {
    asks: [{ price: '185.75', volume: '250' }],
    bids: [{ price: '185.65', volume: '180' }],
  });
});
afterEach(async () => {
  await server.stop();
});

describe('TossRestClient against the loopback fake (B6)', () => {
  it('waits Retry-After on 429 and retries at most twice', async () => {
    const sleeps: number[] = [];
    const client = new TossRestClient({
      baseUrl: server.baseUrl,
      tokenProvider: new OAuthTokenProvider({
        baseUrl: server.baseUrl,
        ...server.issueCredentials(),
      }),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    server.setRetryAfter(2);
    server.failNext('/api/v1/prices', 429, 2);
    const price = await client.getPrice(
      'US',
      'AAPL',
      new AbortController().signal,
    );
    expect(price.price).toBe('185.70');
    expect(sleeps).toEqual([2_000, 2_000]);
    server.failNext('/api/v1/prices', 429, 3);
    await expect(
      client.getPrice('US', 'AAPL', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2_000 });
  });

  it('reads the calendar the fake serves: an open day, a seeded holiday, a weekend (#122)', async () => {
    const client = new TossRestClient({
      baseUrl: server.baseUrl,
      tokenProvider: new OAuthTokenProvider({
        baseUrl: server.baseUrl,
        ...server.issueCredentials(),
      }),
      sleep: async () => undefined,
    });
    const day = (market: 'KR' | 'US', date: string) =>
      client.getCalendarDay(market, date, new AbortController().signal);

    await expect(day('KR', '2026-03-25')).resolves.toEqual({
      market: 'KR',
      tradingDate: '2026-03-25',
      isTradingDay: true,
      regularSession: {
        opensAt: '2026-03-25T09:00:00+09:00',
        closesAt: '2026-03-25T15:30:00+09:00',
      },
    });
    await expect(day('US', '2026-03-25')).resolves.toMatchObject({
      isTradingDay: true,
      regularSession: {
        opensAt: '2026-03-25T22:30:00+09:00',
        closesAt: '2026-03-26T05:00:00+09:00',
      },
    });

    server.seedCalendarDay('KR', '2026-03-25', null);
    await expect(day('KR', '2026-03-25')).resolves.toEqual({
      market: 'KR',
      tradingDate: '2026-03-25',
      isTradingDay: false,
      regularSession: null,
    });
    await expect(day('KR', '2026-03-28')).resolves.toMatchObject({
      isTradingDay: false,
      regularSession: null,
    });
  });

  it('refreshes the token once after a 401 and then surfaces AUTH_FAILED', async () => {
    const credentials = server.issueCredentials();
    let now = Date.now();
    const provider = new OAuthTokenProvider({
      baseUrl: server.baseUrl,
      ...credentials,
      now: () => now,
    });
    const invalidate = vi.spyOn(provider, 'invalidate');
    const client = new TossRestClient({
      baseUrl: server.baseUrl,
      tokenProvider: provider,
      sleep: async () => undefined,
    });
    await client.getPrice('US', 'AAPL', new AbortController().signal);
    server.invalidateAllTokens();
    now += 10_000;
    const price = await client.getPrice(
      'US',
      'AAPL',
      new AbortController().signal,
    );
    expect(price.symbol).toBe('AAPL');
    expect(invalidate).toHaveBeenCalledTimes(1);
    server.setIpAllowed(false);
    server.invalidateAllTokens();
    now += 10_000;
    await expect(
      client.getPrice('US', 'AAPL', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
