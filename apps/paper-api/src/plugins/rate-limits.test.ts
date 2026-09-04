import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { LayeredRateLimiter, registerRateLimits } from './rate-limits.js';

describe('layered rate limits', () => {
  it('returns Retry-After and fails closed for placement when Redis is unavailable', () => {
    const limiter = new LayeredRateLimiter({
      now: () => 1000,
      redis: { available: false },
    });
    const result = limiter.check({
      kind: 'mutation',
      sessionId: 's',
      ip: '127.0.0.1',
    });
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(
      limiter.check({ kind: 'cancel', sessionId: 's', ip: '127.0.0.1' })
        .allowed,
    ).toBe(true);
  });
});

/** A Fastify app with only the rate-limit hook and echo routes (#34). */
async function app(options: {
  trustProxy: boolean;
  now?: () => number;
  publicOrigin?: string;
  onRejected?: Parameters<typeof registerRateLimits>[2] extends
    | { onRejected?: infer F }
    | undefined
    ? F
    : never;
}) {
  const instance = Fastify({ logger: false, trustProxy: options.trustProxy });
  registerRateLimits(
    instance,
    new LayeredRateLimiter(options.now ? { now: options.now } : {}),
    {
      ...(options.publicOrigin === undefined
        ? {}
        : { publicOrigin: options.publicOrigin }),
      ...(options.onRejected === undefined
        ? {}
        : { onRejected: options.onRejected }),
    },
  );
  instance.post('/api/v1/orders', async () => ({ ok: true }));
  instance.patch('/api/v1/orders/:id', async () => ({ ok: true }));
  instance.delete('/api/v1/orders/:id', async () => ({ ok: true }));
  instance.get('/api/v1/portfolio', async () => ({ ok: true }));
  instance.post('/health/probe', async () => ({ ok: true }));
  await instance.ready();
  return instance;
}

const flood = async (
  instance: Awaited<ReturnType<typeof app>>,
  count: number,
  init: {
    method: 'POST' | 'DELETE' | 'PATCH' | 'GET';
    url: string;
    ip?: string;
  },
) => {
  const statuses: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await instance.inject({
      method: init.method,
      url: init.url,
      headers: init.ip === undefined ? {} : { 'x-forwarded-for': init.ip },
    });
    statuses.push(response.statusCode);
  }
  return statuses;
};

describe('registerRateLimits (#34)', () => {
  it('lets ten writes per second through from one client and answers the eleventh with the public 429 contract', async () => {
    const instance = await app({ trustProxy: true, now: () => 1_000 });
    const statuses = await flood(instance, 10, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });
    expect(statuses).toStrictEqual(Array(10).fill(200));

    const refused = await instance.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.json()).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many requests',
      retryable: true,
      retryAfter: 1,
    });
    expect(typeof refused.json().requestId).toBe('string');
  });

  it('keys the bucket on the client, so another client is not affected', async () => {
    const instance = await app({ trustProxy: true, now: () => 1_000 });
    await flood(instance, 10, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });

    const other = await instance.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });
    expect(other.statusCode).toBe(200);
  });

  it('gives cancels their own, larger bucket and never limits reads or health', async () => {
    const instance = await app({ trustProxy: true, now: () => 1_000 });
    await flood(instance, 10, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });

    // POST is exhausted for this client; DELETE still has its 20.
    const cancels = await flood(instance, 20, {
      method: 'DELETE',
      url: '/api/v1/orders/o-1',
      ip: '203.0.113.10',
    });
    expect(cancels).toStrictEqual(Array(20).fill(200));
    const cancelRefused = await instance.inject({
      method: 'DELETE',
      url: '/api/v1/orders/o-1',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(cancelRefused.statusCode).toBe(429);

    const reads = await flood(instance, 30, {
      method: 'GET',
      url: '/api/v1/portfolio',
      ip: '203.0.113.10',
    });
    expect(reads).toStrictEqual(Array(30).fill(200));
    const health = await flood(instance, 30, {
      method: 'POST',
      url: '/health/probe',
      ip: '203.0.113.10',
    });
    expect(health).toStrictEqual(Array(30).fill(200));
  });

  it('opens the window again once a second has passed', async () => {
    let now = 1_000;
    const instance = await app({ trustProxy: true, now: () => now });
    await flood(instance, 10, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });
    now += 1_000;

    const next = await instance.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    expect(next.statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For when the proxy is not trusted, so a spoofed header cannot buy a fresh bucket', async () => {
    const instance = await app({ trustProxy: false, now: () => 1_000 });
    await flood(instance, 10, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });

    const spoofed = await instance.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    // Every injected request shares the loopback address; the header changed
    // nothing, so the bucket is the same one and it is full.
    expect(spoofed.statusCode).toBe(429);
  });

  it('does not spend a client bucket on a request the origin check will refuse anyway', async () => {
    const instance = await app({
      trustProxy: true,
      now: () => 1_000,
      publicOrigin: 'https://app.example.test',
    });
    // A hostile page firing preflight-free POSTs from the victim's browser.
    for (let i = 0; i < 30; i += 1) {
      await instance.inject({
        method: 'POST',
        url: '/api/v1/orders',
        headers: {
          'x-forwarded-for': '203.0.113.10',
          origin: 'https://evil.example.test',
        },
      });
    }
    // The victim's own writes (right origin, or none for a non-browser client)
    // still have their full ten.
    const own = await flood(instance, 10, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });
    expect(own).toStrictEqual(Array(10).fill(200));
  });

  it('reports every refusal with its kind and path', async () => {
    const rejected: { kind: string; path: string; requestId: string }[] = [];
    const instance = await app({
      trustProxy: true,
      now: () => 1_000,
      onRejected: (info) => {
        rejected.push(info);
      },
    });
    await flood(instance, 11, {
      method: 'POST',
      url: '/api/v1/orders',
      ip: '203.0.113.10',
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      kind: 'mutation',
      path: '/api/v1/orders',
    });
    expect(typeof rejected[0]?.requestId).toBe('string');
  });
});

describe('LayeredRateLimiter keeps its memory bounded (#34)', () => {
  it('never tracks more keys than the cap, evicting expired entries first', () => {
    let now = 1_000;
    const limiter = new LayeredRateLimiter({ now: () => now, maxKeys: 100 });
    for (let i = 0; i < 1_000; i += 1)
      limiter.check({ kind: 'mutation', ip: `2001:db8::${i.toString(16)}` });
    expect(limiter.size).toBeLessThanOrEqual(100);

    // A live key survives eviction of the dead ones around it.
    now += 61_000; // every earlier window is expired
    limiter.check({ kind: 'mutation', ip: 'keep-me' });
    for (let i = 0; i < 98; i += 1)
      limiter.check({ kind: 'mutation', ip: `filler-${i}` });
    expect(limiter.size).toBeLessThanOrEqual(100);
    // keep-me is still counted: its second call within the window is the 2nd
    // of 10, not a fresh window.
    for (let i = 0; i < 9; i += 1)
      expect(limiter.check({ kind: 'mutation', ip: 'keep-me' }).allowed).toBe(
        true,
      );
    expect(limiter.check({ kind: 'mutation', ip: 'keep-me' }).allowed).toBe(
      false,
    );
  });

  it('bounds the fixed-key checks the same way', () => {
    const limiter = new LayeredRateLimiter({ now: () => 1_000, maxKeys: 50 });
    for (let i = 0; i < 500; i += 1) limiter.checkWebsocketConnection(`s-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(50);
  });
});
