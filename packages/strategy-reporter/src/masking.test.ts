import { describe, expect, it } from 'vitest';
import { containsSecret, maskOutbound, SECRET_MASK } from './masking.js';
import {
  FAKE_ADMIN_KEY,
  fakeJwt,
  fakePostgresUri,
  fakeWebhook,
} from './testing/secret-fixtures.js';

const WEBHOOK = fakeWebhook('1234567890', 'abcdefghijklmnop');

describe('maskOutbound', () => {
  it('masks a Discord webhook URL wherever it appears in the text', () => {
    expect(maskOutbound(`posting to ${WEBHOOK} now`)).toBe(
      'posting to <webhook> now',
    );
  });

  it('masks the session cookie, the CSRF token, Set-Cookie and the idempotency key', () => {
    const text = [
      'Cookie: moi_session=s%3AabcdefgHIJKL.mnop; Path=/',
      'X-CSRF-Token: 7f3c1a9e5b2d4068',
      'Set-Cookie: moi_session=abcdefghijkl; HttpOnly',
      'Idempotency-Key: 3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31',
    ].join('\n');

    const masked = maskOutbound(text);

    expect(masked).not.toContain('s%3AabcdefgHIJKL.mnop');
    expect(masked).not.toContain('7f3c1a9e5b2d4068');
    expect(masked).not.toContain('abcdefghijkl');
    expect(masked).not.toContain('3d0f1c22-0e1a-4a55-b2ad-9c5e1f0a7b31');
  });

  it('masks bearer tokens, URL credentials and KEY/TOKEN/SECRET assignments', () => {
    expect(maskOutbound(`Authorization: Bearer ${fakeJwt()}`)).toBe(
      `Authorization: Bearer ${SECRET_MASK}`,
    );
    expect(maskOutbound(fakePostgresUri('db:5432'))).toBe(
      `postgres://moi:${SECRET_MASK}@db:5432/moi`,
    );
    expect(maskOutbound(`ADMIN_API_KEY=${FAKE_ADMIN_KEY}`)).toBe(
      `ADMIN_API_KEY=${SECRET_MASK}`,
    );
  });

  /**
   * Design §7.4 asks for the same patterns on both sides, and `notify.sh`
   * masks a value that sits on the line after its marker. A wrapped log line
   * or a report field built from one puts it there, so this side must too.
   */
  it('masks a secret that sits on the line after its marker', () => {
    const masked = maskOutbound(
      [
        'Bearer',
        fakeJwt('SUPERSECRETTOKENVALUE12345'),
        'moi_session=',
        'Zm9vYmFyc2Vzc2lvbnZhbHVl',
        'X-CSRF-Token:',
        '7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
        'ADMIN_API_KEY=',
        FAKE_ADMIN_KEY,
      ].join('\n'),
    );

    for (const secret of [
      fakeJwt('SUPERSECRETTOKENVALUE12345'),
      'Zm9vYmFyc2Vzc2lvbnZhbHVl',
      '7f3c1a9e5b2d40689c0e2f1b4a6d8e07',
      FAKE_ADMIN_KEY,
    ])
      expect(masked, secret).not.toContain(secret);
  });

  it('masks an exact secret value the runner holds even when no pattern matches it', () => {
    const cookie = 'Zm9vYmFyLXNlc3Npb24tdmFsdWU';

    expect(maskOutbound(`resumed session ${cookie}`, [cookie])).toBe(
      `resumed session ${SECRET_MASK}`,
    );
  });

  it('ignores exact secrets too short to mask without shredding ordinary text', () => {
    expect(maskOutbound('buy 100 shares of KR:005930', ['KR'])).toBe(
      'buy 100 shares of KR:005930',
    );
  });

  it('leaves the values the operator actually needs intact', () => {
    const text = 'session 01J8Z0Q9 swapped for 01J8Z1AA on KR:005930 at 71,900';

    expect(maskOutbound(text, [])).toBe(text);
  });
});

describe('containsSecret', () => {
  it('is the tripwire: true while a held secret survives, false once masked', () => {
    const cookie = 'Zm9vYmFyLXNlc3Npb24tdmFsdWU';

    expect(containsSecret(`cookie ${cookie}`, [cookie])).toBe(true);
    expect(
      containsSecret(maskOutbound(`cookie ${cookie}`, [cookie]), [cookie]),
    ).toBe(false);
  });

  it('ignores empty and too-short entries so a blank secret never blocks a post', () => {
    expect(containsSecret('anything at all', ['', 'a'])).toBe(false);
  });
});
