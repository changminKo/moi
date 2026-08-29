import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ERROR_CODES, registerErrorHandler } from './error-handler.js';

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
    app.get('/unlisted-upper', async () => {
      throw Object.assign(new Error('pg detail'), {
        code: 'FST_ERR_SOMETHING',
        statusCode: 422,
      });
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
    const unlisted = await app.inject({
      method: 'GET',
      url: '/unlisted-upper',
    });
    expect(unlisted.json().code).toBe('INTERNAL_ERROR');
    expect(unlisted.json().message).not.toContain('pg');
    const lowercase = await app.inject({ method: 'GET', url: '/lowercase' });
    expect(lowercase.json().code).toBe('INTERNAL_ERROR');
    expect(lowercase.json().message).not.toContain('driver');
    await app.close();
  });

  it('whitelists exactly the codes documented in docs/api/error-contract.md', () => {
    const contract = readFileSync(
      resolve(import.meta.dirname, '../../../../docs/api/error-contract.md'),
      'utf8',
    );
    const documented = new Set(
      [...contract.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1] as string),
    );
    expect([...PUBLIC_ERROR_CODES].sort()).toEqual([...documented].sort());
  });
});
