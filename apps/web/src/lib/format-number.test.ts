import { describe, expect, it } from 'vitest';
import {
  caretForSignificant,
  formatDecimal,
  formatDecimalInput,
  significantBefore,
  stripGrouping,
} from './format-number';

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

describe('stripGrouping', () => {
  it('removes only the separators', () => {
    expect(stripGrouping('1,000,000')).toBe('1000000');
    expect(stripGrouping('1,234.56')).toBe('1234.56');
    expect(stripGrouping('')).toBe('');
    expect(stripGrouping('abc')).toBe('abc');
  });
});

describe('formatDecimalInput', () => {
  it('groups a completed number like the display formatter', () => {
    expect(formatDecimalInput('1000000')).toBe('1,000,000');
    expect(formatDecimalInput('1234.5678')).toBe('1,234.5678');
    expect(formatDecimalInput('-1234567')).toBe('-1,234,567');
  });

  it('survives a half-typed decimal point', () => {
    // formatDecimal cannot: its pattern needs digits after the dot.
    expect(formatDecimalInput('1234.')).toBe('1,234.');
    expect(formatDecimalInput('1234.0')).toBe('1,234.0');
    expect(formatDecimalInput('.5')).toBe('.5');
  });

  it('leaves an in-progress sign and an empty value alone', () => {
    expect(formatDecimalInput('')).toBe('');
    expect(formatDecimalInput('-')).toBe('-');
  });

  it('never groups the fraction', () => {
    expect(formatDecimalInput('1.123456789')).toBe('1.123456789');
  });

  it('passes through anything it cannot read as a number', () => {
    // Garbage must reach validation verbatim instead of being silently eaten.
    expect(formatDecimalInput('12a34')).toBe('12a34');
    expect(formatDecimalInput('1.2.3')).toBe('1.2.3');
    expect(formatDecimalInput('abc')).toBe('abc');
  });
});

describe('caret mapping', () => {
  it('counts the characters that are not separators', () => {
    expect(significantBefore('1,234', 0)).toBe(0);
    expect(significantBefore('1,234', 1)).toBe(1);
    // Directly after the separator: still one significant character seen.
    expect(significantBefore('1,234', 2)).toBe(1);
    expect(significantBefore('1,234', 5)).toBe(4);
  });

  it('finds the position holding that many significant characters', () => {
    expect(caretForSignificant('1,234', 0)).toBe(0);
    expect(caretForSignificant('1,234', 1)).toBe(1);
    expect(caretForSignificant('1,234', 2)).toBe(3);
    expect(caretForSignificant('1,234', 4)).toBe(5);
    // More than the string holds: clamp to the end.
    expect(caretForSignificant('1,234', 9)).toBe(5);
  });

  it('keeps the caret over the same digit when a separator appears', () => {
    // Typing "0" at the end of "999" makes "9,990": the caret must stay after
    // the typed digit, not jump because a comma was inserted before it.
    const typed = '9990';
    const formatted = formatDecimalInput(typed);
    expect(formatted).toBe('9,990');
    expect(caretForSignificant(formatted, significantBefore(typed, 4))).toBe(5);
  });

  it('keeps the caret in place when editing mid-number', () => {
    // "1,234,567" with the caret after "4"; the raw value is 1234567.
    const display = '1,234,567';
    const before = significantBefore(display, 5);
    expect(before).toBe(4);
    expect(caretForSignificant(display, before)).toBe(5);
  });
});
