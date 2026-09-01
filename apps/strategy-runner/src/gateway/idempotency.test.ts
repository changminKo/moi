import { createHash } from 'node:crypto';
import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { deriveIdempotencyKey, IDEMPOTENCY_KEY_DOMAIN } from './idempotency.js';

describe('deriveIdempotencyKey', () => {
  /**
   * The restart-idempotency criterion in one assertion. The key is a pure
   * function of the recorded `decisionId`, so a runner that comes back up,
   * reads the decision out of the log and re-derives, submits under the key the
   * dead process would have used — and the ledger replays instead of placing a
   * second order.
   *
   * The expected value is written out rather than recomputed, deliberately.
   * Recomputing it here would restate the implementation and pass whatever the
   * implementation became; a literal fails the build the moment the derivation
   * changes, which is the regression this test exists to catch. (Design §6.2.)
   */
  it('derives a stable key from a decision id', () => {
    expect(deriveIdempotencyKey('9f1c0a3e-0b2d-4c6f-8a71-2d5e4f6a7b8c')).toBe(
      '180627332da4b055491e11e109e892400f937bccf3b9b36bc28468e0e01e9a71',
    );
  });

  it('is the SHA-256 of a versioned, domain-separated decision id', () => {
    // Not a second implementation: this pins the *construction*, so a reader can
    // see why the literal above is what it is, while the literal is what fails
    // if either half moves.
    expect(deriveIdempotencyKey('d-1')).toBe(
      createHash('sha256').update(`${IDEMPOTENCY_KEY_DOMAIN}d-1`).digest('hex'),
    );
    expect(IDEMPOTENCY_KEY_DOMAIN).toBe('moi-strategy-runner:idempotency:v1:');
  });

  it('gives two decisions two keys', () => {
    expect(deriveIdempotencyKey('d-1')).not.toBe(deriveIdempotencyKey('d-2'));
  });

  /**
   * The domain prefix is not decoration. A future scheme that hashes something
   * else keys the *same* decision differently on purpose, and the version in the
   * prefix is what makes that a reviewable change rather than an accident that
   * silently re-places every outstanding order under a new key.
   */
  it('separates its keys from a bare hash of the same id', () => {
    expect(deriveIdempotencyKey('d-1')).not.toBe(
      createHash('sha256').update('d-1').digest('hex'),
    );
  });

  it('refuses a decision id that is not a usable identifier', () => {
    for (const bad of ['', '   ', 'has\nnewline', 42, null, undefined]) {
      expect(() => deriveIdempotencyKey(bad as never)).toThrow(DomainError);
    }
  });
});
