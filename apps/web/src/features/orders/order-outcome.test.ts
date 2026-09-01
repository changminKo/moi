import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api-client';
import { describePlacementFailure, placementMessageKey } from './order-outcome';

const apiError = (code: string, status = 409) =>
  new ApiError(
    { code, message: 'server prose', retryable: false, requestId: 'req-1' },
    status,
  );

describe('placementMessageKey', () => {
  // The endpoint answers {"status":"OPEN","filledQuantity":"0"} and the fill
  // arrives moments later over the stream, so "filled" would be a lie here.
  it('says accepted, not filled, for an order the book has not touched', () => {
    expect(placementMessageKey({ status: 'OPEN', filledQuantity: '0' })).toBe(
      'ticket.placedOpen',
    );
  });

  it('says waiting for its trigger for a conditional order', () => {
    expect(
      placementMessageKey({ status: 'PENDING_TRIGGER', filledQuantity: '0' }),
    ).toBe('ticket.placedPendingTrigger');
  });

  it.each([undefined, null, 'nonsense', {}, { status: 42 }])(
    'falls back to plain acceptance for the answer %o',
    (response) => {
      expect(placementMessageKey(response)).toBe('ticket.placedOpen');
    },
  );
});

describe('describePlacementFailure', () => {
  it('maps a public error code onto its own message', () => {
    expect(
      describePlacementFailure(apiError('INSUFFICIENT_AVAILABLE_CASH')),
    ).toEqual({
      key: 'orderError.INSUFFICIENT_AVAILABLE_CASH',
      requestId: 'req-1',
    });
  });

  it('maps every code the orders endpoint can answer with', () => {
    for (const code of [
      'SYMBOL_NOT_TRADABLE',
      'MARKET_CLOSED',
      'MARKET_DATA_DEGRADED',
      'RECOVERY_IN_PROGRESS',
      'CANCEL_ONLY',
      'ACCOUNT_READ_ONLY',
      'SERVICE_UNAVAILABLE',
      'INSUFFICIENT_AVAILABLE_CASH',
      'INSUFFICIENT_AVAILABLE_POSITION',
      'PRICE_PROTECTION',
      'IDEMPOTENCY_CONFLICT',
      'RATE_LIMITED',
      'CAPACITY_REACHED',
      'INVALID_QUANTITY',
      'INVALID_PRICE',
      'INVALID_ORDER',
      'VALIDATION_ERROR',
      'SESSION_EXPIRED',
      'FORBIDDEN',
      'PAYLOAD_TOO_LARGE',
      'INVARIANT_VIOLATION',
      'INTERNAL_ERROR',
    ]) {
      expect(describePlacementFailure(apiError(code)).key).toBe(
        `orderError.${code}`,
      );
    }
  });

  // A code this build has never heard of must still read as a sentence, with
  // the code kept so it can be reported — never the raw error object.
  it('keeps an unrecognised code in a legible fallback', () => {
    expect(describePlacementFailure(apiError('SOMETHING_NEW'))).toEqual({
      key: 'ticket.rejectedWithCode',
      code: 'SOMETHING_NEW',
      requestId: 'req-1',
    });
  });

  it.each([
    new TypeError('Failed to fetch'),
    new Error('boom'),
    'a string',
    undefined,
    { code: 42 },
  ])('falls back to a plain rejection for %o', (thrown) => {
    expect(describePlacementFailure(thrown)).toEqual({
      key: 'ticket.rejected',
    });
  });

  it('omits an unknown request id rather than showing the placeholder', () => {
    const error = new ApiError(
      {
        code: 'RATE_LIMITED',
        message: 'slow down',
        retryable: true,
        requestId: 'unknown',
      },
      429,
    );
    expect(describePlacementFailure(error)).toEqual({
      key: 'orderError.RATE_LIMITED',
    });
  });
});
