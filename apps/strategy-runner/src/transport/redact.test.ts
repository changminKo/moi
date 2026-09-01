import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

/**
 * Design §7.4. The masker the operations host already had covers hosts and
 * tokens but knows nothing about a session cookie or a CSRF token, so those
 * patterns are added here — the runner half. The host half lives in
 * `infra/oracle/notify.sh` and belongs with the Discord reporter that first
 * gives it something to mask, which is phase D.
 */
describe('redact', () => {
  it('masks a session cookie wherever it appears', () => {
    expect(redact('Cookie: moi_session=abc.def; Path=/')).toBe(
      'Cookie: moi_session=[redacted]; Path=/',
    );
    expect(redact('reusing moi_session=abc.def')).toBe(
      'reusing moi_session=[redacted]',
    );
  });

  it('masks a Set-Cookie header value', () => {
    expect(redact('set-cookie: moi_session=v; Max-Age=1; HttpOnly')).toBe(
      'set-cookie: [redacted]',
    );
  });

  it('masks a CSRF token header, case-insensitively', () => {
    expect(redact('X-CSRF-Token: nonce.signature')).toBe(
      'X-CSRF-Token: [redacted]',
    );
    expect(redact('x-csrf-token: nonce.signature')).toBe(
      'x-csrf-token: [redacted]',
    );
  });

  it('masks an idempotency key header', () => {
    expect(redact('Idempotency-Key: 1806273')).toBe(
      'Idempotency-Key: [redacted]',
    );
  });

  it('leaves text with no secret in it alone', () => {
    expect(redact('placed order o-1 for KR:005930')).toBe(
      'placed order o-1 for KR:005930',
    );
  });

  it('masks every occurrence, not only the first', () => {
    expect(redact('moi_session=a and moi_session=b')).toBe(
      'moi_session=[redacted] and moi_session=[redacted]',
    );
  });

  it('masks a secret embedded in a serialised object', () => {
    expect(redact(JSON.stringify({ cookie: 'moi_session=secret' }))).toBe(
      '{"cookie":"moi_session=[redacted]"}',
    );
  });
});
