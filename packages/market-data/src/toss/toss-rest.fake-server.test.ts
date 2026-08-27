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
