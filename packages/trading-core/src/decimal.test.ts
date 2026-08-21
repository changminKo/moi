import { describe, expect, it } from 'vitest';

import { assertPositiveWholeQuantity, canonicalDecimal } from './decimal.js';

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
});
