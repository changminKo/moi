import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from './error-handler.js';

describe('error handler', () => {
  it('keeps a stable public code on 4xx route errors and hides everything else', async () => {
    const app = Fastify({ logger: false });
    await registerErrorHandler(app);
    app.get('/cancel-only', async () => {
      throw Object.assign(new Error('FX is disabled'), {
        code: 'CANCEL_ONLY',
        statusCode: 409,
      });
    });
    app.get('/internal', async () => {
      throw Object.assign(new Error('db exploded'), { code: 'ECONNREFUSED' });
    });
    app.get('/lowercase', async () => {
      throw Object.assign(new Error('driver detail'), {
        code: 'fst_something',
        statusCode: 422,
      });
    });
    await app.ready();
    const cancelOnly = await app.inject({ method: 'GET', url: '/cancel-only' });
    expect(cancelOnly.statusCode).toBe(409);
    expect(cancelOnly.json()).toMatchObject({
      code: 'CANCEL_ONLY',
      message: 'FX is disabled',
      retryable: false,
    });
    const internal = await app.inject({ method: 'GET', url: '/internal' });
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    const lowercase = await app.inject({ method: 'GET', url: '/lowercase' });
    expect(lowercase.json().code).toBe('INTERNAL_ERROR');
    expect(lowercase.json().message).not.toContain('driver');
    await app.close();
  });
});
