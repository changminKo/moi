import { describe, expect, it } from 'vitest';
import type { Instrument, QuoteSnapshot } from './api-types';
import { currencySymbol, resolveQuoteCurrency, withCurrency } from './currency';

const quote: QuoteSnapshot = {
  market: 'US',
  symbol: 'AAPL',
  price: '326.30',
  asOf: '2026-09-01T00:00:00Z',
  currency: 'USD',
};
const apple: Instrument = {
  market: 'US',
  symbol: 'AAPL',
  name: '애플',
  tradable: true,
  currency: 'USD',
};

describe('currencySymbol', () => {
  it('uses the same two symbols the wallet and FX panels already use', () => {
    expect(currencySymbol('KRW')).toBe('₩');
    expect(currencySymbol('USD')).toBe('$');
  });
});

describe('withCurrency', () => {
  it('prefixes the symbol in front of an already formatted amount', () => {
    expect(withCurrency('USD', '326.30')).toBe('$326.30');
    expect(withCurrency('KRW', '69,900')).toBe('₩69,900');
  });

  it('returns the amount untouched when the currency is unknown', () => {
    expect(withCurrency(undefined, '326.30')).toBe('326.30');
  });
});

describe('resolveQuoteCurrency', () => {
  it("prefers the instrument's currency, which no book has to exist for", () => {
    const { currency: _omitted, ...bookless } = quote;
    expect(resolveQuoteCurrency(apple, bookless)).toBe('USD');
  });

  it("falls back to the quote's book-derived currency with no instrument", () => {
    expect(resolveQuoteCurrency(null, quote)).toBe('USD');
  });

  it('ignores an instrument that names a different market or symbol', () => {
    const samsung: Instrument = {
      market: 'KR',
      symbol: '005930',
      name: '삼성전자',
      tradable: true,
      currency: 'KRW',
    };
    expect(resolveQuoteCurrency(samsung, quote)).toBe('USD');
  });

  it('reads the instrument alone when no quote has arrived yet', () => {
    expect(resolveQuoteCurrency(apple, null)).toBe('USD');
  });

  it('reports nothing rather than guessing from the market', () => {
    const { currency: _dropped, ...bookless } = quote;
    const unpriced: Instrument = { ...apple };
    delete (unpriced as { currency?: unknown }).currency;
    expect(resolveQuoteCurrency(unpriced, bookless)).toBeUndefined();
    expect(resolveQuoteCurrency(null, null)).toBeUndefined();
  });
});
