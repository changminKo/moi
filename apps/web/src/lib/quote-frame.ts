import type { BookLevel, QuoteSnapshot } from './api-types';

/**
 * The `quote` frame as `parseUserStreamMessage` hands it over: the envelope
 * fields are already narrowed, the payload is still `unknown`.
 */
export type QuoteFrame = Readonly<{
  market: 'KR' | 'US';
  symbol: string;
  recoveryEpoch: string;
  marketDataVersion: string;
  payload: unknown;
}>;

const HEALTH = ['HEALTHY', 'DEGRADED', 'RECOVERING'] as const;
type Health = (typeof HEALTH)[number];

const isHealth = (value: unknown): value is Health =>
  typeof value === 'string' && HEALTH.includes(value as Health);

const CURRENCIES = ['KRW', 'USD'] as const;
type FrameCurrency = (typeof CURRENCIES)[number];

/**
 * The frame's `currency` is book-derived and, like the book, absent whenever
 * the slot holds none. It is narrowed rather than trusted: a value outside the
 * two currencies this product prices in becomes "unknown", which the panel
 * renders as a bare number, instead of a symbol nobody can read.
 */
const isCurrency = (value: unknown): value is FrameCurrency =>
  typeof value === 'string' && CURRENCIES.includes(value as FrameCurrency);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A level is a price and a volume, both decimal strings; anything else is dropped. */
function parseLevels(value: unknown): readonly BookLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels: BookLevel[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { price, volume } = entry;
    if (typeof price !== 'string' || typeof volume !== 'string') continue;
    levels.push({ price, volume });
  }
  return levels;
}

/**
 * Narrows a `quote` frame onto the quote the panel is already showing.
 *
 * This exists because the frame and the REST snapshot are **not the same
 * shape**: `GET …/quote` states `price`, `asOf` and `health` and carries no
 * book, while the stream's payload is the market state store's
 * `OrderBookSnapshot`. The hook used to bridge the two with
 * `payload as unknown as QuoteSnapshot`, which asserted a shape the server
 * never sends — so `level.size` read `undefined` off every real frame and
 * `Decimal.max` threw during render, unmounting the app. A cast cannot fail;
 * this can, and a frame it cannot narrow is ignored (`null`) rather than
 * applied, so the last good quote stays on screen.
 *
 * Merging, not replacing, is what keeps the two halves: a book frame that
 * restates no price must not blank the price the snapshot established.
 */
export function applyQuoteFrame(
  current: QuoteSnapshot | null,
  frame: QuoteFrame,
): QuoteSnapshot | null {
  if (!isRecord(frame.payload)) return null;
  const payload = frame.payload;
  // A quote for one instrument can never inherit another's price or instant.
  const base =
    current &&
    current.market === frame.market &&
    current.symbol === frame.symbol
      ? current
      : null;

  const price =
    typeof payload.price === 'string'
      ? payload.price
      : payload.price === null
        ? null
        : (base?.price ?? null);
  const asOf =
    typeof payload.asOf === 'string' && payload.asOf.length > 0
      ? payload.asOf
      : base?.asOf;
  // Without an instant there is no coherent snapshot to render.
  if (asOf === undefined) return null;

  const health = isHealth(payload.health) ? payload.health : base?.health;
  const currency = isCurrency(payload.currency)
    ? payload.currency
    : base?.currency;
  const bids = parseLevels(payload.bids) ?? base?.bids;
  const asks = parseLevels(payload.asks) ?? base?.asks;

  return {
    market: frame.market,
    symbol: frame.symbol,
    price,
    asOf,
    recoveryEpoch: frame.recoveryEpoch,
    marketDataVersion: frame.marketDataVersion,
    ...(health === undefined ? {} : { health }),
    ...(currency === undefined ? {} : { currency }),
    ...(bids === undefined ? {} : { bids }),
    ...(asks === undefined ? {} : { asks }),
  };
}
