import type { OrderBookSnapshot } from '@moi/trading-core';

export interface SymbolTrade {
  readonly price: string;
  readonly sourceTimestamp: string | null;
}

/**
 * What one symbol's slot in `MarketStateStore` holds.
 *
 * Trades and order books used to be written to the slot as-is, so whichever
 * frame arrived last erased the other: a trade left no `asks` to read and a
 * book left no trade price. Both live producers now merge into this one
 * shape. The recovery baseline still stores the whole REST `RecoverySnapshot`,
 * which carries a `book` of its own — so the readers below cover it too, and
 * a later live book simply replaces it.
 */
export interface SymbolQuoteState {
  readonly book?: OrderBookSnapshot;
  readonly lastTrade?: SymbolTrade;
}

export function withBook(
  previous: SymbolQuoteState | undefined,
  book: OrderBookSnapshot,
): SymbolQuoteState {
  return { ...previous, book };
}

export function withTrade(
  previous: SymbolQuoteState | undefined,
  trade: SymbolTrade,
): SymbolQuoteState {
  return { ...previous, lastTrade: trade };
}

const bestAsk = (state: SymbolQuoteState | undefined): string | undefined =>
  state?.book?.asks?.[0]?.price;

const bestBid = (state: SymbolQuoteState | undefined): string | undefined =>
  state?.book?.bids?.[0]?.price;

/**
 * The price a client is shown: the last trade — "현재가", what actually
 * traded — falling back to the book when nothing has traded yet. The REST
 * recovery baseline is read through its own `book`, so a live book always
 * wins over the snapshot the baseline was taken from.
 */
export function quotePrice(
  state: SymbolQuoteState | undefined,
): string | undefined {
  return state?.lastTrade?.price ?? bestAsk(state) ?? bestBid(state);
}

/**
 * The price a MARKET BUY reservation is sized from. The ask comes first on
 * purpose: it is what the order would actually pay, so reserving against it
 * (with the core's protection multiplier) cannot under-reserve the way the
 * last trade could when the book has moved away from it.
 */
export function referencePrice(
  state: SymbolQuoteState | undefined,
): string | undefined {
  return bestAsk(state) ?? state?.lastTrade?.price ?? bestBid(state);
}
