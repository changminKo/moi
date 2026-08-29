import { describe, expect, it } from 'vitest';

import { assertPositiveWholeQuantity, canonicalDecimal } from './decimal.js';
import {
  DomainError,
  type DomainErrorCode,
  type DomainErrorOptions,
} from './domain-errors.js';

const errorCatalog = [
  { code: 'SYMBOL_NOT_TRADABLE', retryable: false },
  { code: 'MARKET_CLOSED', retryable: false },
  { code: 'MARKET_DATA_DEGRADED', retryable: true },
  { code: 'RECOVERY_IN_PROGRESS', retryable: true },
  { code: 'CANCEL_ONLY', retryable: false },
  { code: 'ACCOUNT_READ_ONLY', retryable: false },
  { code: 'SERVICE_UNAVAILABLE', retryable: true },
  { code: 'INSUFFICIENT_AVAILABLE_CASH', retryable: false },
  { code: 'INSUFFICIENT_AVAILABLE_POSITION', retryable: false },
  { code: 'PRICE_PROTECTION', retryable: false },
  { code: 'ORDER_STATE_CONFLICT', retryable: false },
  { code: 'IDEMPOTENCY_CONFLICT', retryable: false },
  { code: 'RATE_LIMITED', retryable: true },
  { code: 'CAPACITY_REACHED', retryable: false },
  { code: 'INVALID_QUANTITY', retryable: false },
  { code: 'INVALID_PRICE', retryable: false },
  { code: 'INVALID_ORDER', retryable: false },
  { code: 'INVARIANT_VIOLATION', retryable: false },
] as const satisfies readonly {
  code: DomainErrorCode;
  retryable: boolean;
}[];

describe('decimal primitives', () => {
  it('canonicalizes without binary floating point', () => {
    expect(canonicalDecimal('0.10', '0.20')).toBe('0.3');
  });

  it.each(['0', '-1', '1.5'])(
    'rejects invalid whole-share quantity %s',
    (value) => {
      expect(() => assertPositiveWholeQuantity(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_QUANTITY', retryable: false }),
      );
    },
  );

  it.each(['abc', ''])(
    'translates malformed quantity %s into a domain error',
    (value) => {
      expect(() => assertPositiveWholeQuantity(value)).toThrowError(
        expect.objectContaining({ code: 'INVALID_QUANTITY', retryable: false }),
      );
    },
  );

  it.each(['1', '9007199254740993'])(
    'accepts positive whole-share quantity %s',
    (value) => {
      expect(() => assertPositiveWholeQuantity(value)).not.toThrow();
    },
  );
});

describe('domain error catalog', () => {
  it.each(errorCatalog)(
    'marks $code retryable as $retryable',
    ({ code, retryable }) => {
      const error = new DomainError(code, 'test error');

      expect(error).toMatchObject({ code, retryable });
      expect(error.retryAfterSeconds).toBeUndefined();
    },
  );

  it.each(errorCatalog)(
    'allows retryAfterSeconds only for compatible $code errors',
    ({ code, retryable }) => {
      const createError = () =>
        new DomainError(code, 'test error', { retryAfterSeconds: 30 });

      if (retryable) {
        expect(createError()).toMatchObject({
          code,
          retryable: true,
          retryAfterSeconds: 30,
        });
        return;
      }

      expect(createError).toThrow(RangeError);
    },
  );

  it('never lets runtime callers override catalog retryability', () => {
    const options = { retryable: true } as unknown as DomainErrorOptions;

    expect(
      new DomainError('INVALID_QUANTITY', 'test error', options).retryable,
    ).toBe(false);
  });
});
