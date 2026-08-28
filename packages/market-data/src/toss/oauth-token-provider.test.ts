import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketDataError } from '../types.js';
import {
  OAuthTokenProvider,
  TOKEN_MIN_REISSUE_INTERVAL_MS,
  TOKEN_REFRESH_LEAD_MS,
} from './oauth-token-provider.js';

interface Issued {
  token: string;
  expiresIn: number;
}

function harness(options: { expiresIn?: number; statuses?: number[] } = {}) {
  const requests: { body: string; headers: Record<string, string> }[] = [];
  const statuses = [...(options.statuses ?? [])];
  let issued = 0;
  let now = 1_700_000_000_000;
  const fetcher = vi.fn(async (_input: URL | string, init?: RequestInit) => {
    requests.push({
      body: String(init?.body ?? ''),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const status = statuses.shift() ?? 200;
    if (status !== 200) {
      const body =
        status === 401
          ? {
              error: 'invalid_client',
              error_description: 'Client authentication failed.',
            }
          : status === 403
            ? {
                error: 'access_denied',
                error_description: 'IP address not allowed',
              }
            : { error: 'rate_limited' };
      return new Response(JSON.stringify(body), {
        status,
        headers: status === 429 ? { 'Retry-After': '2' } : {},
      });
    }
    issued += 1;
    const payload: Issued = {
      token: `tok-${issued}`,
      expiresIn: options.expiresIn ?? 86_400,
    };
    return new Response(
      JSON.stringify({
        access_token: payload.token,
        token_type: 'Bearer',
        expires_in: payload.expiresIn,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  const provider = new OAuthTokenProvider({
    baseUrl: 'http://127.0.0.1:1/',
    clientId: 'c_testclient01',
    clientSecret: `s_${'x'.repeat(30)}`,
    fetch: fetcher as never,
    now: () => now,
  });
  return {
    provider,
    fetcher,
    requests,
    advance: (ms: number) => {
      now += ms;
    },
    issuedCount: () => issued,
  };
}

const signal = () => new AbortController().signal;

describe('OAuthTokenProvider (B5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('posts client credentials as a form body and never puts the secret in a header or URL', async () => {
    const { provider, requests, fetcher } = harness();
    expect(await provider.getAccessToken(signal())).toBe('tok-1');
    const [request] = requests;
    expect(request?.headers['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const form = new URLSearchParams(request?.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('c_testclient01');
    expect(form.get('client_secret')).toBe(`s_${'x'.repeat(30)}`);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:1/oauth2/token',
    );
    expect(JSON.stringify(request?.headers)).not.toContain('xxxxxxxx');
  });

  it('serves the cached token until five minutes before expiry, then reissues', async () => {
    const { provider, advance, issuedCount } = harness({ expiresIn: 3600 });
    await provider.getAccessToken(signal());
    advance(3600_000 - TOKEN_REFRESH_LEAD_MS - 1);
    expect(await provider.getAccessToken(signal())).toBe('tok-1');
    expect(issuedCount()).toBe(1);
    advance(2);
    expect(await provider.getAccessToken(signal())).toBe('tok-2');
    expect(issuedCount()).toBe(2);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const { provider, issuedCount } = harness();
    const [a, b, c] = await Promise.all([
      provider.getAccessToken(signal()),
      provider.getAccessToken(signal()),
      provider.getAccessToken(signal()),
    ]);
    expect([a, b, c]).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(issuedCount()).toBe(1);
  });

  it('invalidate() forces one reissue, but reissues are throttled to one per 10 s', async () => {
    const { provider, advance, issuedCount } = harness();
    await provider.getAccessToken(signal());
    provider.invalidate();
    await expect(provider.getAccessToken(signal())).rejects.toMatchObject({
      code: 'AUTH_THROTTLED',
    });
    advance(TOKEN_MIN_REISSUE_INTERVAL_MS);
    expect(await provider.getAccessToken(signal())).toBe('tok-2');
    expect(issuedCount()).toBe(2);
  });

  it('maps 401 to AUTH_FAILED and 403 to AUTH_FAILED with the IP-not-allowed status', async () => {
    const unauthorized = harness({ statuses: [401] });
    await expect(
      unauthorized.provider.getAccessToken(signal()),
    ).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      statusCode: 401,
    });
    const forbidden = harness({ statuses: [403] });
    const error = await forbidden.provider
      .getAccessToken(signal())
      .catch((e) => e);
    expect(error).toBeInstanceOf(MarketDataError);
    expect(error).toMatchObject({ code: 'AUTH_FAILED', statusCode: 403 });
  });

  it('maps 429 to RATE_LIMITED carrying Retry-After', async () => {
    const { provider } = harness({ statuses: [429] });
    await expect(provider.getAccessToken(signal())).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
      retryAfterMs: 2_000,
    });
  });

  it('records refresh outcomes on the metrics hook without the token value', async () => {
    const outcomes: string[] = [];
    const { fetcher } = harness();
    const provider = new OAuthTokenProvider({
      baseUrl: 'http://127.0.0.1:1',
      clientId: 'c_testclient01',
      clientSecret: `s_${'x'.repeat(30)}`,
      fetch: fetcher as never,
      onRefresh: (result) => outcomes.push(result),
    });
    await provider.getAccessToken(signal());
    expect(outcomes).toEqual(['ok']);
  });
});

describe('OAuthTokenProvider.invalidate guard', () => {
  it('ignores an invalidate for a token that is no longer the cached one', async () => {
    const { provider, advance, issuedCount } = harness();
    const first = await provider.getAccessToken(signal());
    provider.invalidate(first);
    advance(TOKEN_MIN_REISSUE_INTERVAL_MS);
    const second = await provider.getAccessToken(signal());
    expect(second).toBe('tok-2');
    // A late 401 for the *old* token must not drop the fresh one.
    provider.invalidate(first);
    expect(await provider.getAccessToken(signal())).toBe('tok-2');
    expect(issuedCount()).toBe(2);
    // Untargeted invalidate keeps the old behaviour.
    provider.invalidate();
    advance(TOKEN_MIN_REISSUE_INTERVAL_MS);
    expect(await provider.getAccessToken(signal())).toBe('tok-3');
  });
});
