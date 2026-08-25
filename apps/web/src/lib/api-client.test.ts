import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api-client';

const response = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('api client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('includes credentials, csrf, and caller idempotency key for a trade mutation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ price: '12.3400' }));
    const client = createApiClient({
      origin: 'https://api.test',
      fetchImpl: fetchMock,
      getCsrfToken: () => 'csrf-token',
    });

    const result = await client.post<{ price: string }>(
      '/api/v1/orders',
      { quantity: '0.1000' },
      { idempotencyKey: 'order-1' },
    );

    expect(result.price).toBe('12.3400');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.test/api/v1/orders',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          'X-CSRF-Token': 'csrf-token',
          'Idempotency-Key': 'order-1',
        }),
      }),
    );
  });

  it('maps the stable error envelope while retaining retry metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: 'try later',
          retryable: true,
          retryAfter: 2.5,
          requestId: 'req-7',
        },
        { status: 503 },
      ),
    );
    const client = createApiClient({
      origin: 'https://api.test',
      fetchImpl: fetchMock,
    });

    await expect(client.get('/api/v1/markets')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      requestId: 'req-7',
      retryable: true,
      retryAfter: 2.5,
    });
    expect(ApiError).toBeDefined();
  });
});
