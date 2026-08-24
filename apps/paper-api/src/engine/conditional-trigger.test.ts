import { describe, expect, it } from 'vitest';
import { evaluateConditional } from './conditional-trigger.js';

const order = (
  type: 'STOP' | 'TAKE_PROFIT',
  side: 'BUY' | 'SELL',
  stopPrice: string,
) => ({
  id: 'leg',
  type,
  side,
  stopPrice,
});

describe('evaluateConditional', () => {
  it('triggers a stop on a loss-limiting crossing and not below it for a buy', () => {
    expect(evaluateConditional(order('STOP', 'BUY', '100'), '100')).toBe(true);
    expect(evaluateConditional(order('STOP', 'BUY', '100'), '99.99')).toBe(
      false,
    );
    expect(evaluateConditional(order('STOP', 'SELL', '100'), '99.99')).toBe(
      true,
    );
  });

  it('uses the inverse crossing for take-profit legs', () => {
    expect(
      evaluateConditional(order('TAKE_PROFIT', 'SELL', '110'), '110'),
    ).toBe(true);
    expect(
      evaluateConditional(order('TAKE_PROFIT', 'SELL', '110'), '109.99'),
    ).toBe(false);
    expect(evaluateConditional(order('TAKE_PROFIT', 'BUY', '90'), '90')).toBe(
      true,
    );
  });

  it('rejects malformed or non-positive prices instead of coercing them', () => {
    expect(() => evaluateConditional(order('STOP', 'BUY', '0'), '1')).toThrow();
    expect(() =>
      evaluateConditional(order('STOP', 'BUY', '1'), 1 as never),
    ).toThrow();
  });
});
