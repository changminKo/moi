/**
 * Provider-neutral market-data contracts.
 *
 * Nothing here names a provider, and nothing here carries a provider sequence:
 * the feeds this package normalizes are LOSSY, publish no sequence number, and
 * send no initial snapshot, so a normalized event may only report what actually
 * arrived. Provider-shaped fields stay behind the adapters in `src/toss`.
 */
import type {
  DecimalString,
  Market,
  OrderBookSnapshot,
  Quantity,
} from '@skipjack/trading-core';

export type MarketDataChannel = 'trade' | 'orderBook';

/** One observed trade print. `sourceTimestamp` is null when the feed omits it. */
export interface MarketTrade {
  readonly market: Market;
  readonly symbol: string;
  readonly price: DecimalString;
  readonly volume: Quantity;
  readonly sourceTimestamp: string | null;
  readonly receivedAt: string;
}

/** One observed order-book state. It is a state, never a delta over a sequence. */
export interface MarketOrderBook {
  readonly market: Market;
  readonly symbol: string;
  readonly book: OrderBookSnapshot;
  readonly sourceTimestamp: string | null;
  readonly receivedAt: string;
}

/** The transport went away. Consumers degrade the market; they never backfill. */
export interface MarketTransportClosed {
  readonly market: Market;
  readonly reason: string;
  readonly receivedAt: string;
}

export type MarketTradeEvent = { readonly kind: 'trade' } & MarketTrade;
export type MarketOrderBookEvent = {
  readonly kind: 'orderBook';
} & MarketOrderBook;
export type MarketTransportClosedEvent = {
  readonly kind: 'transportClosed';
} & MarketTransportClosed;

export type MarketEvent =
  | MarketTradeEvent
  | MarketOrderBookEvent
  | MarketTransportClosedEvent;

/**
 * A declaration is the full desired subscription set for one channel and
 * market: adapters replace the whole set rather than appending to it.
 */
export interface SubscriptionDeclaration {
  readonly channel: MarketDataChannel;
  readonly market: Market;
  readonly symbols: readonly string[];
}

export interface SubscriptionRejection {
  readonly topic: string;
  readonly reason: string;
}

export interface SubscriptionAck {
  readonly accepted: readonly string[];
  readonly rejected: readonly SubscriptionRejection[];
}

/** The internal topic key. It is this package's identity, not a provider's. */
export const subscriptionTopicKey = (
  channel: MarketDataChannel,
  market: Market,
  symbol: string,
): string => `${channel}:${market}:${symbol}`;

export const declaredTopicKeys = (
  declarations: readonly SubscriptionDeclaration[],
): readonly string[] =>
  declarations.flatMap((declaration) =>
    declaration.symbols.map((symbol) =>
      subscriptionTopicKey(declaration.channel, declaration.market, symbol),
    ),
  );

/**
 * Keyed by the event interfaces rather than listed, so a field added to a
 * normalized event is a compile error until it is named here — which is what
 * lets the conformance suite assert the public shape instead of a list someone
 * remembered to extend.
 */
type FieldSet<T> = Readonly<Record<keyof T, true>>;

const TRADE_EVENT_FIELDS: FieldSet<MarketTradeEvent> = {
  kind: true,
  market: true,
  symbol: true,
  price: true,
  volume: true,
  sourceTimestamp: true,
  receivedAt: true,
};

const ORDER_BOOK_EVENT_FIELDS: FieldSet<MarketOrderBookEvent> = {
  kind: true,
  market: true,
  symbol: true,
  book: true,
  sourceTimestamp: true,
  receivedAt: true,
};

const TRANSPORT_CLOSED_EVENT_FIELDS: FieldSet<MarketTransportClosedEvent> = {
  kind: true,
  market: true,
  reason: true,
  receivedAt: true,
};

export const MARKET_EVENT_FIELDS: Readonly<
  Record<MarketEvent['kind'], readonly string[]>
> = {
  trade: Object.keys(TRADE_EVENT_FIELDS),
  orderBook: Object.keys(ORDER_BOOK_EVENT_FIELDS),
  transportClosed: Object.keys(TRANSPORT_CLOSED_EVENT_FIELDS),
};

export type MarketDataErrorCode =
  | 'NOT_CONNECTED'
  | 'TRANSPORT_CLOSED'
  | 'UNDECLARED_TOPIC'
  | 'SUBSCRIPTION_REJECTED'
  | 'PONG_FAILED'
  | 'INVALID_DECIMAL'
  | 'UNSUPPORTED_DATA'
  | 'AUTH_FAILED'
  | 'AUTH_THROTTLED'
  | 'RATE_LIMITED';

/**
 * Transport-level failures. They are deliberately *not* `DomainError`s: a feed
 * fault is not a trading decision, and only the engine may translate one into
 * a `MARKET_DATA_DEGRADED` domain outcome or a safety incident.
 */
export interface MarketDataErrorDetails {
  /** Provider HTTP status when the failure came from a handshake or REST call. */
  readonly statusCode?: number;
  /** Parsed `Retry-After` in milliseconds for RATE_LIMITED. */
  readonly retryAfterMs?: number;
}

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  readonly statusCode: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: MarketDataErrorCode,
    message: string,
    details: MarketDataErrorDetails = {},
  ) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    this.statusCode = details.statusCode;
    this.retryAfterMs = details.retryAfterMs;
  }
}

// A plain base-10 literal. A provider that sends `210.1` as a JSON number is
// rejected rather than coerced: binary floats never enter the price path.
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

export function readDecimalString(
  value: unknown,
  description: string,
): DecimalString {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new MarketDataError(
      'INVALID_DECIMAL',
      `${description} must be a plain decimal string`,
    );
  }

  return value;
}

export function readOptionalTimestamp(
  value: unknown,
  description: string,
): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new MarketDataError(
      'UNSUPPORTED_DATA',
      `${description} must be an ISO timestamp or null`,
    );
  }

  return value;
}

export function readOrderBookSnapshot(
  value: OrderBookSnapshot,
  description: string,
): OrderBookSnapshot {
  const readLevels = (
    levels: OrderBookSnapshot['bids'],
    side: string,
  ): OrderBookSnapshot['bids'] =>
    levels.map((level, index) => ({
      price: readDecimalString(
        level.price,
        `${description} ${side}[${index}] price`,
      ),
      volume: readDecimalString(
        level.volume,
        `${description} ${side}[${index}] volume`,
      ),
    }));

  return {
    symbol: value.symbol,
    market: value.market,
    currency: value.currency,
    bids: readLevels(value.bids, 'bid'),
    asks: readLevels(value.asks, 'ask'),
  };
}
