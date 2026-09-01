import { describe, expect, it } from 'vitest';
import {
  quotePrice,
  referencePrice,
  type SymbolQuoteState,
  withBook,
  withTrade,
} from './symbol-quote-state.js';

const BOOK = {
  market: 'US' as const,
  symbol: 'AAPL',
  currency: 'USD' as const,
  bids: [{ price: '100', volume: '10' }],
  asks: [{ price: '101', volume: '10' }],
};

const TRADE = { price: '100.25', sourceTimestamp: null };

describe('symbol quote state', () => {
  it('keeps the book when a trade lands after it', () => {
    const state = withTrade(withBook(undefined, BOOK), TRADE);
    expect(state.book).toEqual(BOOK);
    expect(state.lastTrade?.price).toBe('100.25');
  });

  it('keeps the last trade when a book lands after it', () => {
    const state = withBook(withTrade(undefined, TRADE), BOOK);
    expect(state.book).toEqual(BOOK);
    expect(state.lastTrade?.price).toBe('100.25');
  });

  it('reports the last trade as the quote price whatever the frame order', () => {
    const bookFirst = withTrade(withBook(undefined, BOOK), TRADE);
    const tradeFirst = withBook(withTrade(undefined, TRADE), BOOK);
    expect(quotePrice(bookFirst)).toBe('100.25');
    expect(quotePrice(tradeFirst)).toBe('100.25');
  });

  it('falls back to the best ask, then the best bid, when no trade has been seen', () => {
    expect(quotePrice(withBook(undefined, BOOK))).toBe('101');
    expect(quotePrice(withBook(undefined, { ...BOOK, asks: [] }))).toBe('100');
  });

  // MARKET BUY reservations are sized from the ask (§ledger price protection),
  // so a later trade must never displace it — that would under-reserve cash.
  it('sizes reservations from the ask and never loses it to a later trade', () => {
    const bookFirst = withTrade(withBook(undefined, BOOK), TRADE);
    expect(referencePrice(bookFirst)).toBe('101');
    expect(referencePrice(withBook(withTrade(undefined, TRADE), BOOK))).toBe(
      '101',
    );
  });

  it('falls back to the last trade for the reference price when there is no book', () => {
    expect(referencePrice(withTrade(undefined, TRADE))).toBe('100.25');
  });

  // The baseline is stored as the whole `RecoverySnapshot`; both readers take
  // it through its `book`, so a later live book replaces it rather than losing
  // to the snapshot price it was taken with.
  it('reads a REST recovery baseline through its book', () => {
    const baseline = {
      market: 'US',
      symbol: 'AAPL',
      price: '100.5',
      book: BOOK,
      fetchedAt: '2026-09-01T00:00:00.000Z',
    } as SymbolQuoteState;
    expect(quotePrice(baseline)).toBe('101');
    expect(referencePrice(baseline)).toBe('101');
    const live = withBook(baseline, {
      ...BOOK,
      asks: [{ price: '102', volume: '1' }],
    });
    expect(quotePrice(live)).toBe('102');
  });

  it('has no price before any frame has arrived', () => {
    expect(quotePrice(undefined)).toBeUndefined();
    expect(referencePrice(undefined)).toBeUndefined();
  });
});
