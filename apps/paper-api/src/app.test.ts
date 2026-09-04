import { describe, expect, it } from 'vitest';
import { type AppDependencies, buildApp } from './app.js';
import type { AppConfig } from './config.js';
import { ZERO_FEE_SCHEDULES } from './config.js';

const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 0,
  publicOrigin: 'https://paper.example.test',
  databaseUrl: 'postgres://test/test',
  redisUrl: 'redis://127.0.0.1:6379',
  sessionHashKeys: ['test-session-hash-key'],
  csrfSecret: 'test-csrf-secret',
  marketDataAdapter: 'fake',
  shutdownDrainDeadlineMs: 30_000,
  trustProxy: false,
  rateLimitsEnabled: false,
  recoveryStabilityMs: 0,
  fees: ZERO_FEE_SCHEDULES,
  ...overrides,
});

const fakeDependencies = (): AppDependencies => ({
  clock: { now: () => 1_700_000_000_000 },
  requestId: () => 'test-request-id',
  registerRoutes: async (app) => {
    app.post<{ Body: { known: string } }>('/test/validation', {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['known'],
          properties: { known: { type: 'string' } },
        },
      },
      handler: async () => ({ ok: true }),
    });
  },
});

describe('paper API application', () => {
  it('returns a request id and stable not-found envelope', async () => {
    const app = await buildApp(testConfig(), fakeDependencies());
    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'NOT_FOUND',
      message: 'Route not found',
      retryable: false,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('rejects an origin outside the configured allowlist with a stable error', async () => {
    const app = await buildApp(testConfig(), fakeDependencies());
    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { origin: 'https://evil.example.test' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      retryable: false,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('rejects request bodies larger than 64 KiB with a stable non-retryable error', async () => {
    const app = await buildApp(testConfig(), fakeDependencies());
    const response = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ known: 'x'.repeat(70_000) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      retryable: false,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('rejects unknown request fields with a stable validation error', async () => {
    const app = await buildApp(testConfig(), fakeDependencies());
    const response = await app.inject({
      method: 'POST',
      url: '/test/validation',
      headers: { 'content-type': 'application/json' },
      payload: { known: 'ok', unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
      requestId: expect.any(String),
    });
    await app.close();
  });

  it('redacts authentication, cookie, csrf, and session token fields from logs', async () => {
    const app = await buildApp(testConfig(), fakeDependencies());
    expect(app.redactedLogPaths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-csrf-token',
        'req.headers.x-session-token',
      ]),
    );
    await app.close();
  });

  // #34: only the nearest hop is trusted. A client that writes its own
  // X-Forwarded-For before the proxy appends the real address must not be able
  // to choose `request.ip` (and with it, its rate-limit bucket).
  it('takes the address the proxy appended, not the one the client wrote', async () => {
    const seen: string[] = [];
    const app = await buildApp(testConfig({ trustProxy: true }), {
      ...fakeDependencies(),
      registerIngress: (instance) => {
        instance.addHook('onRequest', async (request) => {
          seen.push(request.ip);
        });
      },
    });
    await app.inject({
      method: 'GET',
      url: '/missing',
      // client-forged value, then the proxy's own observation
      headers: { 'x-forwarded-for': '198.51.100.99, 203.0.113.10' },
    });
    expect(seen).toStrictEqual(['203.0.113.10']);
  });

  // #34: the rate limiter keys on `request.ip`. Behind the deployment's own
  // proxy that has to be the client, and nowhere else may a header decide it.
  it.each([
    [true, '203.0.113.10'],
    [false, '127.0.0.1'],
  ])(
    'with trustProxy=%s, request.ip behind X-Forwarded-For is %s',
    async (trustProxy, expected) => {
      const seen: string[] = [];
      const app = await buildApp(testConfig({ trustProxy }), {
        ...fakeDependencies(),
        registerIngress: (instance) => {
          instance.addHook('onRequest', async (request) => {
            seen.push(request.ip);
          });
        },
      });
      await app.inject({
        method: 'GET',
        url: '/missing',
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      expect(seen).toStrictEqual([expected]);
    },
  );
});
