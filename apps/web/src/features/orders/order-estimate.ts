import Decimal from 'decimal.js';
import type { QuoteSnapshot } from '../../lib/api-types';
import { isDecimal } from '../../lib/format-number';
import type { OrderDraft } from './order-form';

/**
 * The prices an estimate may be multiplied by. Every one is optional: a quote
 * arrives before its book, a book can be one-sided, and nothing here is
 * validated on the wire — so each is checked before it is used.
 */
export type EstimateBook = Readonly<{
  bestBid?: string | undefined;
  bestAsk?: string | undefined;
  lastPrice?: string | null | undefined;
}>;

/**
 * A display-only notional estimate, as exact decimal strings. `high` is
 * present only for an OCO order, whose two legs bracket the outcome.
 */
export type OrderEstimate = Readonly<{ low: string; high?: string }>;

export function bookForEstimate(
  quote: QuoteSnapshot | null | undefined,
): EstimateBook {
  if (!quote) return {};
  const bestBid = quote.bids?.[0]?.price;
  const bestAsk = quote.asks?.[0]?.price;
  return {
    ...(bestBid === undefined ? {} : { bestBid }),
    ...(bestAsk === undefined ? {} : { bestAsk }),
    ...(quote.price === null || quote.price === undefined
      ? {}
      : { lastPrice: quote.price }),
  };
}

const positive = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined || !isDecimal(value))
    return undefined;
  return new Decimal(value).gt(0) ? value : undefined;
};

/** A whole positive quantity, the same shape `validateOrderDraft` demands. */
const wholeQuantity = (value: string): string | undefined =>
  /^\d+$/.test(value) && new Decimal(value).gt(0) ? value : undefined;

/**
 * What a MARKET order would actually transact at: the side of the book it
 * takes from, then the last trade, then the far side.
 *
 * **BUY follows the server.** It is `referencePrice` in
 * `apps/paper-api/src/market-data/symbol-quote-state.ts` — ask, then last
 * trade, then bid — reproduced here rather than invented, so the estimate and
 * the cash the ledger sets aside are reasoning about the same number. Keep the
 * two in step if that function's order ever changes.
 *
 * **SELL has no server counterpart to follow.** There is no sell-side
 * reference price anywhere in the ledger: `planReservation`
 * (`packages/trading-core/src/reservation.ts:461-464`) reserves *cash* for a
 * BUY and the *position quantity* for a SELL, so a SELL reservation never
 * consults a price at all — as `#planSingleReservation`'s own docblock in
 * `order-placement-service.ts` says. Taking the bid first is therefore this
 * screen's own symmetric heuristic, chosen because a seller is paid the bid,
 * and it is display-only: nothing on the server has to agree with it, and
 * changing it cannot put the estimate out of step with a reservation.
 */
function marketPrice(
  side: 'BUY' | 'SELL',
  book: EstimateBook,
): string | undefined {
  const near = side === 'BUY' ? book.bestAsk : book.bestBid;
  const far = side === 'BUY' ? book.bestBid : book.bestAsk;
  return positive(near) ?? positive(book.lastPrice) ?? positive(far);
}

/**
 * The prices this draft would transact at — one for every kind but OCO, whose
 * two legs each name their own and of which exactly one ever fills.
 *
 * A LIMIT order is estimated at the reader's own limit price, and a STOP or
 * TAKE_PROFIT at its trigger: those are the prices the order is *about*, and
 * the book it will eventually meet is not this book.
 */
function draftPrices(
  draft: OrderDraft,
  book: EstimateBook,
): readonly string[] | undefined {
  const only = (price: string | undefined) =>
    price === undefined ? undefined : [price];
  switch (draft.kind) {
    case 'MARKET':
      return only(marketPrice(draft.side, book));
    case 'LIMIT':
      return only(positive(draft.limitPrice));
    case 'STOP':
      return only(positive(draft.stopPrice));
    case 'TAKE_PROFIT':
      return only(positive(draft.triggerPrice));
    case 'OCO': {
      const takeProfit = positive(draft.takeProfitPrice);
      const stop = positive(draft.stopPrice);
      return takeProfit === undefined || stop === undefined
        ? undefined
        : [takeProfit, stop];
    }
  }
}

/**
 * An estimate of what the order is worth, or `null` when there is nothing
 * honest to say — the quantity is still being typed, a price is missing, or
 * the book has not arrived. It is only ever an estimate: a MARKET order fills
 * at whatever the book gives it, which is why the ticket renders this behind
 * "≈" the way the FX ticket renders its rate.
 *
 * Nothing here becomes a JS number. Quantities and prices are validated as
 * plain decimals first and multiplied in `Decimal`, and the result is returned
 * at full precision — the render boundary, not this function, decides how many
 * fraction digits to show. A `Decimal` constructor throwing on unvalidated
 * input is what took the quote panel down once; every value below is checked
 * with `isDecimal` before it reaches one.
 */
export function estimateOrderNotional(
  draft: OrderDraft,
  book: EstimateBook,
): OrderEstimate | null {
  const quantity = wholeQuantity(draft.quantity);
  if (quantity === undefined) return null;
  const prices = draftPrices(draft, book);
  if (prices === undefined || prices.length === 0) return null;
  const amounts = prices
    .map((price) => new Decimal(quantity).mul(price))
    .sort((a, b) => a.comparedTo(b))
    .map((amount) => amount.toFixed());
  const low = amounts[0];
  const high = amounts[amounts.length - 1];
  if (low === undefined || high === undefined) return null;
  return low === high ? { low } : { low, high };
}
