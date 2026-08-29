import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTossRestServer } from '../testing/fake-toss/fake-toss-rest-server.js';
import { OAuthTokenProvider } from './oauth-token-provider.js';

let server: FakeTossRestServer;
beforeEach(async () => {
  server = new FakeTossRestServer();
  await server.start();
});
afterEach(async () => {
  await server.stop();
});

describe('OAuthTokenProvider against the loopback fake (B5 integration)', () => {
  it('issues, caches, and re-issues after invalidate with the previous token revoked', async () => {
    const credentials = server.issueCredentials();
    let now = Date.now();
    const provider = new OAuthTokenProvider({
      baseUrl: server.baseUrl,
      ...credentials,
      now: () => now,
    });
    const signal = new AbortController().signal;
    const first = await provider.getAccessToken(signal);
    expect(await provider.getAccessToken(signal)).toBe(first);
    expect(server.tokenRequests()).toBe(1);
    provider.invalidate();
    now += 10_000;
    const second = await provider.getAccessToken(signal);
    expect(second).not.toBe(first);
    expect(server.activeTokenCount()).toBe(1);
    expect(JSON.stringify(server.requests())).not.toContain(first);
    expect(JSON.stringify(server.requests())).not.toContain(
      credentials.clientSecret,
    );
  });

  it('surfaces the contract 401/403 as AUTH_FAILED with the status', async () => {
    const wrong = new OAuthTokenProvider({
      baseUrl: server.baseUrl,
      clientId: 'c_unknownclient',
      clientSecret: 'nope-nope-nope-nope',
    });
    await expect(
      wrong.getAccessToken(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', statusCode: 401 });
    server.setIpAllowed(false);
    const denied = new OAuthTokenProvider({
      baseUrl: server.baseUrl,
      ...server.issueCredentials(),
    });
    await expect(
      denied.getAccessToken(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', statusCode: 403 });
  });
});
