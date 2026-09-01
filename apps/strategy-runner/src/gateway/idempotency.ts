import { createHash } from 'node:crypto';
import { DomainError } from '@moi/trading-core';

/**
 * Design §6.2 fixes the order: append the decision, derive the idempotency key
 * *from* the recorded decision, promote the intent to a command, submit. A
 * crash anywhere in that sequence must recompute the same key on restart.
 *
 * The mechanism is that this function is pure and its only input is the
 * `decisionId` that the decision log already holds durably. The runner therefore
 * never has to remember a key: it remembers a decision, and the key follows.
 *
 * A hash rather than the id itself, for two reasons. It is domain-separated and
 * versioned, so a future derivation keys the same decision differently *on
 * purpose* — a reviewable prefix change rather than an accident that re-places
 * every outstanding order. And it means the ledger's idempotency table is not
 * also an index of the runner's internal identifiers.
 */
export const IDEMPOTENCY_KEY_DOMAIN = 'moi-strategy-runner:idempotency:v1:';

export function deriveIdempotencyKey(decisionId: string): string {
  if (
    typeof decisionId !== 'string' ||
    decisionId.trim().length === 0 ||
    /\p{Cc}/u.test(decisionId)
  ) {
    throw new DomainError(
      'INVARIANT_VIOLATION',
      'a decision id must be a non-empty identifier with no control characters',
    );
  }

  return createHash('sha256')
    .update(`${IDEMPOTENCY_KEY_DOMAIN}${decisionId}`)
    .digest('hex');
}
