import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTossRestServer } from './fake-toss-rest-server.js';

let server: FakeTossRestServer;
let base: string;
const credentials = { clientId: '', clientSecret: '' };

beforeEach(async () => {
  server = new FakeTossRestServer();
  await server.start();
  base = server.baseUrl;
  Object.assign(credentials, server.issueCredentials());
});
afterEach(async () => {
  await server.stop();
});

async function token(): Promise<string> {
  const response = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      ...{
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe('FakeTossRestServer (§9.2)', () => {
  it('binds to loopback only', () => {
    expect(new URL(base).hostname).toBe('127.0.0.1');
  });

  it('issues OAuth2 tokens per the contract and invalidates the previous one on reissue', async () => {
    server.seedSnapshot('US', 'AAPL', '185.70', {
      asks: [{ price: '185.75', volume: '250' }],
      bids: [{ price: '185.65', volume: '180' }],
    });
    const first = await token();
    expect(first).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const withFirst = await fetch(
      `${base}/api/v1/prices?market=US&symbols=AAPL`,
      { headers: { Authorization: `Bearer ${first}` } },
    );
    expect(withFirst.status).toBe(200);
    const second = await token();
    expect(second).not.toBe(first);
    const stale = await fetch(`${base}/api/v1/prices?market=US&symbols=AAPL`, {
      headers: { Authorization: `Bearer ${first}` },
    });
    expect(stale.status).toBe(401);
  });

  it('answers the contract error examples for bad grants, bad clients, denied IPs, and rate limits', async () => {
    const badGrant = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=password',
    });
    expect(badGrant.status).toBe(400);
    expect(await badGrant.json()).toMatchObject({
      error: 'unsupported_grant_type',
    });
    const missing = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid_request' });
    const badClient = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: 'wrong',
      }),
    });
    expect(badClient.status).toBe(401);
    expect(badClient.headers.get('www-authenticate')).toBe(
      'Basic realm="openapi"',
    );
    expect(await badClient.json()).toMatchObject({ error: 'invalid_client' });
    server.setIpAllowed(false);
    const denied = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'access_denied' });
    server.setIpAllowed(true);
    server.failNext('/oauth2/token', 429, 1);
    server.setRetryAfter(2);
    const limited = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
  });

  it('serves seeded prices and orderbooks in the BFF envelope and rejects missing/invalid bearer tokens', async () => {
    server.seedSnapshot('US', 'AAPL', '185.70', {
      asks: [{ price: '185.75', volume: '250' }],
      bids: [{ price: '185.65', volume: '180' }],
    });
    const access = await token();
    const anonymous = await fetch(
      `${base}/api/v1/prices?market=US&symbols=AAPL`,
    );
    expect(anonymous.status).toBe(401);
    const price = await fetch(`${base}/api/v1/prices?market=US&symbols=AAPL`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(await price.json()).toMatchObject({
      success: true,
      result: [{ symbol: 'AAPL', lastPrice: '185.70', currency: 'USD' }],
    });
    const book = await fetch(`${base}/api/v1/orderbook?market=US&symbol=AAPL`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(await book.json()).toMatchObject({
      success: true,
      result: {
        currency: 'USD',
        asks: [{ price: '185.75', volume: '250' }],
        bids: [{ price: '185.65', volume: '180' }],
      },
    });
    const unknown = await fetch(`${base}/api/v1/orders`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(unknown.status).toBe(404);
    const unseeded = await fetch(
      `${base}/api/v1/prices?market=KR&symbols=005930`,
      { headers: { Authorization: `Bearer ${access}` } },
    );
    expect(unseeded.status).toBe(404);
  });

  it('serves seeded instrument names in the stocks/all contract shape', async () => {
    server.seedInstrument('KR', '005930', '삼성전자');
    server.seedInstrument('US', 'AAPL', '애플');
    const access = await token();

    const response = await fetch(`${base}/api/v1/stocks/all`, {
      headers: { Authorization: `Bearer ${access}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      result: [
        {
          symbol: '005930',
          name: '삼성전자',
          securityType: 'STOCK',
          isCommonShare: true,
        },
        {
          symbol: 'AAPL',
          name: '애플',
          securityType: 'FOREIGN_STOCK',
          isCommonShare: true,
        },
      ],
    });
  });

  it('records requests without token values and honours failNext/invalidateAllTokens', async () => {
    server.seedSnapshot('KR', '005930', '72000', {
      asks: [{ price: '72100', volume: '1' }],
      bids: [{ price: '72000', volume: '1' }],
    });
    const access = await token();
    server.failNext('/api/v1/prices', 500, 1);
    const failed = await fetch(
      `${base}/api/v1/prices?market=KR&symbols=005930`,
      { headers: { Authorization: `Bearer ${access}` } },
    );
    expect(failed.status).toBe(500);
    const ok = await fetch(`${base}/api/v1/prices?market=KR&symbols=005930`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(ok.status).toBe(200);
    server.invalidateAllTokens();
    const invalidated = await fetch(
      `${base}/api/v1/prices?market=KR&symbols=005930`,
      { headers: { Authorization: `Bearer ${access}` } },
    );
    expect(invalidated.status).toBe(401);
    const log = server.requests();
    expect(
      log.map((r) => `${r.method} ${r.path} ${r.status} ${r.authorized}`),
    ).toEqual([
      'POST /oauth2/token 200 false',
      'GET /api/v1/prices 500 true',
      'GET /api/v1/prices 200 true',
      'GET /api/v1/prices 401 true',
    ]);
    expect(JSON.stringify(log)).not.toContain(access);
    expect(server.tokenRequests()).toBe(1);
  });

  it('exposes expires_in control', async () => {
    server.setTokenTtl(60);
    const response = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    });
    expect(await response.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 60,
    });
  });
});
