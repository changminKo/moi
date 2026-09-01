import { describe, expect, it } from 'vitest';
import type { QuoteSnapshot } from '../../lib/api-types';
import { bookForEstimate, estimateOrderNotional } from './order-estimate';
import type { OrderDraft } from './order-form';

const BOOK = { bestBid: '326.31', bestAsk: '326.35', lastPrice: '326.30' };

const market = (side: 'BUY' | 'SELL', quantity: string): OrderDraft => ({
  kind: 'MARKET',
  side,
  quantity,
});

describe('estimateOrderNotional for a MARKET order', () => {
  // referencePrice() in symbol-quote-state.ts sizes the server's reservation
  // ask-first for exactly this reason: the ask is what a BUY actually pays.
  it('multiplies a BUY by the best ask', () => {
    expect(estimateOrderNotional(market('BUY', '3'), BOOK)).toEqual({
      low: '979.05',
    });
  });

  // No server rule to mirror here: a SELL reserves position quantity, never a
  // price. Bid-first is this screen's own symmetric heuristic — a seller is
  // paid the bid — and it is display-only.
  it('multiplies a SELL by the best bid', () => {
    expect(estimateOrderNotional(market('SELL', '3'), BOOK)).toEqual({
      low: '978.93',
    });
  });

  // Stated for a BUY, where the fallback chain is the server's own.
  it('falls back through the last trade to the far side, as the server does', () => {
    expect(
      estimateOrderNotional(market('BUY', '2'), {
        lastPrice: '100',
        bestBid: '99',
      }),
    ).toEqual({ low: '200' });
    expect(
      estimateOrderNotional(market('BUY', '2'), { bestBid: '99' }),
    ).toEqual({ low: '198' });
  });

  it('has nothing to say without a book or a trade', () => {
    expect(estimateOrderNotional(market('BUY', '3'), {})).toBeNull();
  });
});

describe('estimateOrderNotional for a priced order', () => {
  it("uses the reader's own limit price, not the book", () => {
    expect(
      estimateOrderNotional(
        { kind: 'LIMIT', side: 'BUY', quantity: '3', limitPrice: '300' },
        BOOK,
      ),
    ).toEqual({ low: '900' });
  });

  it('uses the stop price for a STOP order', () => {
    expect(
      estimateOrderNotional(
        { kind: 'STOP', side: 'SELL', quantity: '2', stopPrice: '310.5' },
        BOOK,
      ),
    ).toEqual({ low: '621' });
  });

  it('uses the trigger price for a TAKE_PROFIT order', () => {
    expect(
      estimateOrderNotional(
        {
          kind: 'TAKE_PROFIT',
          side: 'SELL',
          quantity: '2',
          triggerPrice: '340',
        },
        BOOK,
      ),
    ).toEqual({ low: '680' });
  });

  // Exactly one OCO leg ever fills, and the reader named both prices, so the
  // honest estimate is the range between them rather than a pick of one.
  it('spans both legs of an OCO order, low price first', () => {
    expect(
      estimateOrderNotional(
        {
          kind: 'OCO',
          side: 'SELL',
          quantity: '2',
          takeProfitPrice: '340',
          stopPrice: '300',
        },
        BOOK,
      ),
    ).toEqual({ low: '600', high: '680' });
  });
});

describe('estimateOrderNotional never throws on what a reader can type', () => {
  it.each(['', '0', '1.5', '-3', 'abc', '3e2', ' 3'])(
    'has nothing to say for the quantity %o',
    (quantity) => {
      expect(estimateOrderNotional(market('BUY', quantity), BOOK)).toBeNull();
    },
  );

  it.each(['', 'N/A', '-1', '0', 'abc'])(
    'has nothing to say for the limit price %o',
    (limitPrice) => {
      expect(
        estimateOrderNotional(
          { kind: 'LIMIT', side: 'BUY', quantity: '3', limitPrice },
          BOOK,
        ),
      ).toBeNull();
    },
  );

  it('ignores a book price the wire made unusable', () => {
    expect(
      estimateOrderNotional(market('BUY', '3'), {
        bestAsk: 'N/A',
        lastPrice: '100',
      }),
    ).toEqual({ low: '300' });
  });
});

describe('estimateOrderNotional keeps money exact', () => {
  it('does not drift the way JS numbers would', () => {
    // 0.1 * 3 is 0.30000000000000004 in binary floating point.
    expect(
      estimateOrderNotional(
        { kind: 'LIMIT', side: 'BUY', quantity: '3', limitPrice: '0.1' },
        {},
      ),
    ).toEqual({ low: '0.3' });
  });

  it('keeps a large notional in full, without exponent notation', () => {
    expect(
      estimateOrderNotional(
        {
          kind: 'LIMIT',
          side: 'BUY',
          quantity: '1000000000',
          limitPrice: '12345.6789',
        },
        {},
      ),
    ).toEqual({ low: '12345678900000' });
  });
});

describe('bookForEstimate', () => {
  const quote: QuoteSnapshot = {
    market: 'US',
    symbol: 'AAPL',
    price: '326.30',
    asOf: '2026-09-01T00:00:00Z',
    bids: [{ price: '326.31', volume: '10' }],
    asks: [{ price: '326.35', volume: '4' }],
  };

  it('reads the best level of each side and the last price', () => {
    expect(bookForEstimate(quote)).toEqual(BOOK);
  });

  it('is empty for a quote that has not arrived', () => {
    expect(bookForEstimate(null)).toEqual({});
  });

  it('omits a side the quote does not state', () => {
    const { asks: _dropped, ...noAsks } = quote;
    expect(bookForEstimate(noAsks)).toEqual({
      bestBid: '326.31',
      lastPrice: '326.30',
    });
  });
});
