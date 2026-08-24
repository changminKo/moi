import { describe, expect, it } from 'vitest';
import { safeAuditLog } from './logger.js';

describe('safe audit logging', () => {
  it('redacts credentials and preserves correlation fields', () => {
    expect(
      safeAuditLog({
        requestId: 'r1',
        authorization: 'secret',
        cookie: 'token',
        market: 'US',
      }),
    ).toEqual({
      requestId: 'r1',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      market: 'US',
    });
  });
});
