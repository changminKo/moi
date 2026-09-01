import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  PaperApiClient,
  type SessionCredentials,
} from './paper-api-client.js';

const ORIGIN = 'http://127.0.0.1:3001';

const SESSION: SessionCredentials = {
  sessionId: 's-1',
  cookie: 'moi_session=token-value',
  csrfToken: 'nonce.signature',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function recording(
  status = 200,
  payload: unknown = { ok: true },
  setCookie: string | null = null,
): { readonly calls: Call[]; readonly fetch: FetchLike } {
  const calls: Call[] = [];

  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });

      return {
        status,
        headers: { get: (name) => (name === 'set-cookie' ? setCookie : null) },
        text: async () =>
          payload === undefined ? '' : JSON.stringify(payload),
      };
    },
  };
}

const client = (fetch: FetchLike, credentials = SESSION): PaperApiClient =>
  new PaperApiClient({ origin: ORIGIN, credentials: () => credentials, fetch });

describe('PaperApiClient origin pinning', () => {
  it('refuses to construct against a host that is not on the allow-list', () => {
    expect(
      () =>
        new PaperApiClient({
          origin: 'https://api.live-venue.example',
          credentials: () => SESSION,
        }),
    ).toThrow(DomainError);
  });

  /**
   * The hole a path union alone does not close: `new URL` with an absolute
   * input discards the base entirely. A `PaperBrokerTransport` is called by
   * compiled TypeScript *and* by whatever else holds the interface, so this is
   * a runtime check rather than a type.
   */
  it('refuses a path that would leave the pinned origin', async () => {
    const { fetch, calls } = recording();

    for (const path of [
      // An absolute URL discards the base entirely; a protocol-relative one
      // reaches a different host just as surely.
      'http://api.live-venue.example/api/v1/orders',
      '//api.live-venue.example/api/v1/orders',
      'api/v1/orders',
      '',
    ]) {
      await expect(client(fetch).send({ method: 'GET', path })).rejects.toThrow(
        DomainError,
      );
    }

    expect(calls).toStrictEqual([]);
  });

  it('sends to the configured origin and nowhere else', async () => {
    const { fetch, calls } = recording();

    await client(fetch).send({ method: 'GET', path: '/api/v1/portfolio' });

    expect(calls[0]?.url).toBe(`${ORIGIN}/api/v1/portfolio`);
  });
});

describe('PaperApiClient headers', () => {
  /**
   * §4.2, and the case a loopback development stack hides: the bot connects to
   * one host and echoes another as `Origin`, because the API compares the header
   * against the *browser app's* origin.
   */
  it('sends the public origin as the Origin header, not the connect target', async () => {
    const { fetch, calls } = recording();
    const behindCompose = new PaperApiClient({
      origin: 'http://paper-api:3000',
      publicOrigin: 'https://app.moi.example',
      credentials: () => SESSION,
      fetch,
    });

    await behindCompose.send({ method: 'GET', path: '/api/v1/portfolio' });

    expect(calls[0]?.url).toBe('http://paper-api:3000/api/v1/portfolio');
    expect(calls[0]?.headers.origin).toBe('https://app.moi.example');
  });

  it('falls back to the connect origin when the two are the same', async () => {
    const { fetch, calls } = recording();

    await client(fetch).send({ method: 'GET', path: '/api/v1/portfolio' });

    expect(calls[0]?.headers.origin).toBe(ORIGIN);
  });

  /** Design §4.2: every mutation carries all four. */
  it('carries origin, cookie, CSRF token and idempotency key on a mutation', async () => {
    const { fetch, calls } = recording();

    await client(fetch).send({
      method: 'POST',
      path: '/api/v1/orders',
      idempotencyKey: 'k-1',
      body: { type: 'MARKET' },
    });

    expect(calls[0]?.headers).toStrictEqual({
      origin: ORIGIN,
      cookie: 'moi_session=token-value',
      'x-csrf-token': 'nonce.signature',
      'idempotency-key': 'k-1',
      'content-type': 'application/json',
    });
    expect(calls[0]?.body).toBe('{"type":"MARKET"}');
  });

  it('carries the cookie but no CSRF token on a read', async () => {
    const { fetch, calls } = recording();

    await client(fetch).send({ method: 'GET', path: '/api/v1/portfolio' });

    expect(calls[0]?.headers).toStrictEqual({
      origin: ORIGIN,
      cookie: 'moi_session=token-value',
    });
  });

  it('sends no session and no key on the unauthenticated bootstrap', async () => {
    const { fetch, calls } = recording();

    await client(fetch).send({
      method: 'POST',
      path: '/api/v1/sessions/anonymous',
      authenticated: false,
    });

    expect(calls[0]?.headers).toStrictEqual({ origin: ORIGIN });
  });

  /**
   * The ledger scopes idempotency by `(session_id, key)`, so a key on a request
   * that carries no session has nothing to be unique within. Sending one would
   * read as a guarantee that is not there.
   */
  it('refuses an idempotency key on an unauthenticated mutation', async () => {
    const { fetch, calls } = recording();

    await expect(
      client(fetch).send({
        method: 'POST',
        path: '/api/v1/sessions/anonymous',
        idempotencyKey: 'k-1',
        authenticated: false,
      }),
    ).rejects.toThrow(/nothing to be unique within/u);
    expect(calls).toStrictEqual([]);
  });

  /**
   * A write with no key is a write that cannot be replayed after a crash, which
   * is the property the whole restart story rests on. Refused here rather than
   * left to the API's own 400, so the runner never gets into a state where a
   * retry would place a second order.
   */
  it('refuses a mutation with no idempotency key', async () => {
    const { fetch, calls } = recording();

    await expect(
      client(fetch).send({ method: 'POST', path: '/api/v1/orders', body: {} }),
    ).rejects.toThrow(/needs an idempotency key/u);
    expect(calls).toStrictEqual([]);
  });

  it('refuses an authenticated request with no session', async () => {
    const { fetch } = recording();
    const anonymous = new PaperApiClient({
      origin: ORIGIN,
      credentials: () => null,
      fetch,
    });

    await expect(
      anonymous.send({ method: 'GET', path: '/api/v1/portfolio' }),
    ).rejects.toThrow(/needs a session/u);
  });

  /**
   * The credentials are read per request, not captured. A session swap replaces
   * them mid-run, and a transport holding the old pair would keep writing under
   * a session the ledger has forgotten.
   */
  it('reads the credentials afresh on every request', async () => {
    const { fetch, calls } = recording();
    let current: SessionCredentials = SESSION;
    const live = new PaperApiClient({
      origin: ORIGIN,
      credentials: () => current,
      fetch,
    });

    await live.send({ method: 'GET', path: '/api/v1/portfolio' });
    current = { sessionId: 's-2', cookie: 'moi_session=b', csrfToken: 'c2' };
    await live.send({ method: 'GET', path: '/api/v1/portfolio' });

    expect(calls.map((call) => call.headers.cookie)).toStrictEqual([
      'moi_session=token-value',
      'moi_session=b',
    ]);
  });
});

describe('PaperApiClient responses', () => {
  it('reports the status, the decoded body and any Set-Cookie', async () => {
    const { fetch } = recording(201, { id: 'o-1' }, 'moi_session=x; HttpOnly');

    await expect(
      client(fetch).send({ method: 'GET', path: '/api/v1/portfolio' }),
    ).resolves.toStrictEqual({
      status: 201,
      body: { id: 'o-1' },
      setCookie: 'moi_session=x; HttpOnly',
    });
  });

  it('reports an empty or non-JSON body as undefined rather than failing', async () => {
    const empty: FetchLike = async () => ({
      status: 204,
      headers: { get: () => null },
      text: async () => '',
    });

    await expect(
      client(empty).send({ method: 'GET', path: '/api/v1/portfolio' }),
    ).resolves.toMatchObject({ status: 204, body: undefined });

    const html: FetchLike = async () => ({
      status: 502,
      headers: { get: () => null },
      text: async () => '<html>bad gateway</html>',
    });

    await expect(
      client(html).send({ method: 'GET', path: '/api/v1/portfolio' }),
    ).resolves.toMatchObject({ status: 502, body: undefined });
  });

  it('passes an error status straight through for the caller to classify', async () => {
    const { fetch } = recording(401, { code: 'SESSION_EXPIRED' });

    await expect(
      client(fetch).send({ method: 'GET', path: '/api/v1/portfolio' }),
    ).resolves.toMatchObject({ status: 401 });
  });
});

describe('PaperApiClient.brokerTransport', () => {
  it('answers PaperBroker with the status and body it expects', async () => {
    const { fetch, calls } = recording(200, { id: 'o-1', status: 'OPEN' });

    await expect(
      client(fetch)
        .brokerTransport()
        .request({
          method: 'POST',
          path: '/api/v1/orders',
          idempotencyKey: 'k-1',
          body: { type: 'MARKET' },
        }),
    ).resolves.toStrictEqual({
      status: 200,
      body: { id: 'o-1', status: 'OPEN' },
    });
    expect(calls[0]?.headers['idempotency-key']).toBe('k-1');
  });
});
