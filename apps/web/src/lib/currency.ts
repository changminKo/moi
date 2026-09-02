import type { Instrument, QuoteSnapshot } from './api-types';

export type Currency = 'KRW' | 'USD';

/**
 * The two symbols the product already shows. `wallet-summary.tsx` picked them
 * from `wallet.currency` and the FX ticket keeps its own pair on
 * `FX_DIRECTION`; this is the same convention in one place so a third surface
 * (the quote panel's price, the order ticket's estimate) cannot invent a
 * different one.
 */
const SYMBOLS: Readonly<Record<Currency, string>> = { KRW: '₩', USD: '$' };

/**
 * Narrows a currency off the wire. The fill rows carry one now, but they are
 * `Record<string, unknown>` at this boundary and anything unrecognised must
 * leave the amount bare rather than pick a symbol — the same rule
 * `withCurrency` already follows for an absent one.
 */
export function asCurrency(value: unknown): Currency | undefined {
  return value === 'KRW' || value === 'USD' ? value : undefined;
}

export function currencySymbol(currency: Currency): string {
  return SYMBOLS[currency];
}

/**
 * Tags an *already formatted* amount with its currency. A render-boundary
 * helper: it never parses, rounds or arithmetics the value it is handed, so
 * the exact decimal string stays whatever the caller computed. An unknown
 * currency yields the amount unchanged rather than a guessed symbol.
 */
export function withCurrency(
  currency: Currency | undefined,
  formatted: string,
): string {
  return currency === undefined
    ? formatted
    : `${currencySymbol(currency)}${formatted}`;
}

/**
 * Which currency the quote panel and the order ticket should show for the
 * selected instrument.
 *
 * The instrument comes first. Its currency is a property of the instrument
 * itself — `ProductionRuntime.#instrumentCatalog` states it for every symbol
 * it serves — whereas the quote's `currency` is *book-derived* and, per
 * `docs/api/quote-contract.md`, omitted entirely when the symbol's slot holds
 * no book. A price can exist without a book (it falls back to the last
 * trade), so relying on the quote alone would leave exactly that case bare.
 *
 * The quote is the fallback, and the instrument is only trusted when it names
 * the same market and symbol as the quote — the same rule the panel's display
 * name uses, because a deep link or a pending selection can race ahead of the
 * stream. Neither source knowing means no symbol is shown: deriving one from
 * `market` would restate an invariant that lives on the server
 * (`MARKET_CURRENCIES` in `@moi/market-data`), and a currency this client
 * guessed is worse than a bare number.
 */
export function resolveQuoteCurrency(
  instrument: Instrument | null | undefined,
  quote:
    | Pick<QuoteSnapshot, 'market' | 'symbol' | 'currency'>
    | null
    | undefined,
): Currency | undefined {
  if (!quote) return instrument?.currency;
  const matches =
    instrument !== null &&
    instrument !== undefined &&
    instrument.market === quote.market &&
    instrument.symbol === quote.symbol;
  return (matches ? instrument.currency : undefined) ?? quote.currency;
}
