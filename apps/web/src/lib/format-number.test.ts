import { describe, expect, it } from 'vitest';
import { formatDecimal } from './format-number';

describe('formatDecimal', () => {
  it('groups the integer part with thousands separators', () => {
    expect(formatDecimal('10000000')).toBe('10,000,000');
    expect(formatDecimal('71200')).toBe('71,200');
    expect(formatDecimal('999')).toBe('999');
    expect(formatDecimal('1000')).toBe('1,000');
  });

  it('keeps the fraction verbatim', () => {
    expect(formatDecimal('1234.5678')).toBe('1,234.5678');
    expect(formatDecimal('189.10')).toBe('189.10');
    expect(formatDecimal('0.000001')).toBe('0.000001');
  });

  it('preserves a negative sign', () => {
    expect(formatDecimal('-1234567.89')).toBe('-1,234,567.89');
    expect(formatDecimal('-5')).toBe('-5');
  });

  it('passes through empty and placeholder values unchanged', () => {
    expect(formatDecimal('')).toBe('');
    expect(formatDecimal('—')).toBe('—');
    expect(formatDecimal('n/a')).toBe('n/a');
  });
});
