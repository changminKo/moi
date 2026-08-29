import { describe, expect, it } from 'vitest';
import { LayeredRateLimiter } from './rate-limits.js';

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
