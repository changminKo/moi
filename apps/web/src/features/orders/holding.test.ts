import { describe, expect, it } from 'vitest';
import { describeHolding, findPosition } from './holding';

const position = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  market: 'US',
  symbol: 'AAPL',
  total: '3',
  available: '3',
  reserved: '0',
  averageCost: '325.26',
  ...overrides,
});

describe('findPosition', () => {
  it('matches on market and symbol together', () => {
    const rows = [
      position({ market: 'KR', symbol: 'AAPL', available: '9' }),
      position({ symbol: 'MSFT', available: '7' }),
      position(),
    ];
    expect(findPosition(rows, 'US', 'AAPL')).toMatchObject({ available: '3' });
  });

  it('answers nothing for an instrument the reader does not hold', () => {
    expect(findPosition([position()], 'US', 'TSLA')).toBeUndefined();
    expect(findPosition(undefined, 'US', 'AAPL')).toBeUndefined();
    expect(findPosition([null, 'nope'] as unknown[], 'US', 'AAPL')).toBe(
      undefined,
    );
  });
});

describe('describeHolding', () => {
  it('says how much can be sold, grouped for display', () => {
    expect(
      describeHolding(position({ available: '1200', total: '1200' })),
    ).toEqual({ key: 'holding.available', values: { available: '1,200' } });
  });

  it('names the reserved remainder, since that is why the rest cannot be sold', () => {
    expect(
      describeHolding(position({ total: '3', available: '1', reserved: '2' })),
    ).toEqual({
      key: 'holding.availableReserved',
      values: { available: '1', reserved: '2' },
    });
  });

  it('still explains a holding that is entirely reserved', () => {
    // "No holding" would be a lie: the shares exist, an open order holds them.
    expect(
      describeHolding(position({ total: '2', available: '0', reserved: '2' })),
    ).toEqual({
      key: 'holding.availableReserved',
      values: { available: '0', reserved: '2' },
    });
  });

  it.each([
    ['nothing held', undefined],
    ['a flat zero', position({ total: '0', available: '0', reserved: '0' })],
    ['a padded zero', position({ available: '0.000000', reserved: '0.00' })],
    ['a row with no quantities', { market: 'US', symbol: 'AAPL' }],
  ])('says the reader holds none of it for %s', (_name, row) => {
    expect(describeHolding(row)).toEqual({ key: 'holding.none' });
  });

  it('never throws on a value that is not a decimal', () => {
    expect(() =>
      describeHolding(position({ available: 'n/a', reserved: {} })),
    ).not.toThrow();
    expect(
      describeHolding(position({ available: 'n/a', reserved: {} })),
    ).toEqual({ key: 'holding.available', values: { available: 'n/a' } });
  });
});
