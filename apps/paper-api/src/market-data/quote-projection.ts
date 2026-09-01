import type { Market } from '@moi/trading-core';
import type { HealthState } from './health-machine.js';
import { quotePrice, type SymbolQuoteState } from './symbol-quote-state.js';

/**
 * Every field the quote projection states, documented in
 * `docs/api/quote-contract.md` and kept equal to it by test.
 *
 * `currency`, `bids` and `asks` are present only when the symbol's slot holds
 * a book — see `projectQuote`.
 */
export const QUOTE_PROJECTION_FIELDS = [
  'market',
  'symbol',
  'price',
  'asOf',
  'health',
  'recoveryEpoch',
  'marketDataVersion',
  'currency',
  'bids',
  'asks',
] as const;

export interface QuoteProjectionInput {
  readonly market: Market;
  readonly symbol: string;
  readonly state: SymbolQuoteState | undefined;
  readonly health: HealthState;
  readonly recoveryEpoch: bigint | string;
  readonly marketDataVersion: bigint | string;
  /** Injectable for tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

/**
 * The one shape a quote takes, whether it is answered by
 * `GET /api/v1/markets/:market/symbols/:symbol/quote` or pushed as the
 * payload of a stream `quote` frame.
 *
 * There is exactly one builder on purpose. The two used to be separate object
 * literals that drifted: REST stated the price and no book, the frame carried
 * the bare `OrderBookSnapshot` and no price, and the browser cast the payload
 * onto a type that was the union of the two with the quantity field
 * misspelled — so `Decimal.max` read `undefined` during render and unmounted
 * the app (spec §16.36). A snapshot and a patch of the same thing must not be
 * two different shapes; `#enrichPayload` states the same rule for portfolio
 * after the SDK drifted from this API the same way (§16.32).
 *
 * Nothing is invented. The price is `quotePrice` over the merged slot — last
 * trade, then best ask, then best bid (§16.33) — and `null` when the slot is
 * empty. The book is whatever the slot holds, and the three book-derived
 * fields are omitted entirely rather than emptied when it holds none, so a
 * trade arriving before the first book cannot blank the depth a client is
 * already showing. `asOf` is the instant of the projection, not of the market
 * event, as it has always been for the REST answer.
 */
export function projectQuote(
  input: QuoteProjectionInput,
): Record<string, unknown> {
  const book = input.state?.book;
  const clock = input.now ?? (() => new Date());
  return {
    market: input.market,
    symbol: input.symbol,
    price: quotePrice(input.state) ?? null,
    asOf: clock().toISOString(),
    health: input.health,
    recoveryEpoch: String(input.recoveryEpoch),
    marketDataVersion: String(input.marketDataVersion),
    ...(book === undefined
      ? {}
      : { currency: book.currency, bids: book.bids, asks: book.asks }),
  };
}
