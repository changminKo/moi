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

describe('provider secret redaction (§12.1)', () => {
  it('redacts token and client-secret keys and Bearer values inside strings', () => {
    expect(
      safeAuditLog({
        access_token: 'abc',
        client_secret: 'def',
        TOSS_CLIENT_SECRET: 'ghi',
        Authorization: 'Bearer xyz',
        note: 'header was Bearer tok3n.value and more',
        nested: { authorization: 'Bearer deep', keep: 1 },
      }),
    ).toEqual({
      access_token: '[REDACTED]',
      client_secret: '[REDACTED]',
      TOSS_CLIENT_SECRET: '[REDACTED]',
      Authorization: '[REDACTED]',
      note: 'header was Bearer [REDACTED] and more',
      nested: { authorization: '[REDACTED]', keep: 1 },
    });
  });
});
