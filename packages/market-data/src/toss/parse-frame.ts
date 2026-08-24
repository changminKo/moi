/**
 * Parses one inbound Toss WebSocket frame into a provider-shaped value, and —
 * as a separate, refusable step — narrows a data frame into a normalized
 * `MarketEvent`.
 *
 * The split is the point. `parseTossFrame` is permissive about *values* the
 * contract itself says may grow (currency, rejection code, error code): those
 * stay opaque strings on `TossInboundFrame`, so a currency this build has
 * never seen does not stop the feed from being read. `toMarketEvent` is the
 * strict step, and it refuses rather than guesses — an unknown currency or
 * market becomes an `UNSUPPORTED_DATA` `MarketDataError` the engine turns into
 * a safety incident, never a normalized event with an invented field.
 *
 * `parseTossFrame` is strict about *shape*: a missing required field, a JSON
 * number where the contract says decimal string, or a frame type this package
 * cannot route is a rejected frame. Nothing is coerced and nothing is
 * defaulted.
 *
 * There is no sequence number anywhere in here. The feed publishes none, so a
 * parsed frame has no sequence to expose and no gap to detect.
 */
import type {
  Currency,
  Market,
  OrderBookLevel,
  OrderBookSnapshot,
} from '@skipjack/trading-core';
import type { z } from 'zod';
import {
  MarketDataError,
  type MarketEvent,
  readDecimalString,
} from '../types.js';
import {
  parseTossTopic,
  tossErrorFrameSchema,
  tossFrameEnvelopeSchema,
  tossOrderBookFrameSchema,
  tossPongFrameSchema,
  tossSubscriptionAckFrameSchema,
  tossTradeFrameSchema,
} from './schemas.js';

/** The fields the contract defines for a frame's `data` object, per channel. */
const KNOWN_TRADE_DATA_FIELDS = new Set([
  'price',
  'volume',
  'timestamp',
  'currency',
]);
const KNOWN_ORDER_BOOK_DATA_FIELDS = new Set([
  'timestamp',
  'currency',
  'asks',
  'bids',
]);

/** Provider market code (`us`, `kr`) to the normalized `Market`. */
const PROVIDER_MARKETS: Readonly<Record<string, Market>> = {
  us: 'US',
  kr: 'KR',
};

/** The currency each market is allowed to quote in. */
const MARKET_CURRENCIES: Readonly<Record<Market, Currency>> = {
  KR: 'KRW',
  US: 'USD',
};

export interface TossSubscriptionRejection {
  readonly target: string;
  /** Opaque: an unrecognized code is reported, not rejected. */
  readonly code: string;
  readonly message: string;
}

export interface TossSubscriptionAckFrame {
  readonly kind: 'subscriptionAck';
  /** Null when the declaration carried no `id` to echo. */
  readonly requestId: string | null;
  readonly subscribed: readonly string[];
  readonly rejected: readonly TossSubscriptionRejection[];
  readonly receivedAt: string;
}

export interface TossTradeFrame {
  readonly kind: 'trade';
  readonly topic: string;
  /** The provider's own market code, lowercase and unnarrowed. */
  readonly providerMarket: string;
  readonly symbol: string;
  readonly price: string;
  readonly volume: string;
  readonly sourceTimestamp: string;
  /** Opaque by contract instruction; narrowed only by `toMarketEvent`. */
  readonly currency: string;
  readonly receivedAt: string;
  /**
   * Fields the pinned contract does not define, kept verbatim so a provider
   * addition is visible to an operator without being trusted by the price
   * path. Nothing here reaches a normalized event.
   */
  readonly unknownFields: Readonly<Record<string, unknown>>;
}

export interface TossOrderBookFrame {
  readonly kind: 'orderBook';
  readonly topic: string;
  readonly providerMarket: string;
  readonly symbol: string;
  /** Null when the provider omits or nulls the field. */
  readonly sourceTimestamp: string | null;
  readonly currency: string;
  readonly bids: readonly OrderBookLevel[];
  readonly asks: readonly OrderBookLevel[];
  readonly receivedAt: string;
  readonly unknownFields: Readonly<Record<string, unknown>>;
}

export interface TossErrorFrame {
  readonly kind: 'error';
  /** Opaque: `server-shutdown`, `rate-limit-exceeded`, or something newer. */
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
  readonly receivedAt: string;
}

export interface TossPongFrame {
  readonly kind: 'pong';
  readonly receivedAt: string;
}

export type TossInboundFrame =
  | TossSubscriptionAckFrame
  | TossTradeFrame
  | TossOrderBookFrame
  | TossErrorFrame
  | TossPongFrame;

const reject = (message: string): never => {
  throw new MarketDataError('UNSUPPORTED_DATA', message);
};

const rejectDecimal = (message: string): never => {
  throw new MarketDataError('INVALID_DECIMAL', message);
};

/**
 * A decimal failure is reported as `INVALID_DECIMAL` while every other shape
 * failure is `UNSUPPORTED_DATA`, so an operator reading an incident can tell a
 * provider that started sending JSON numbers from one that changed a frame.
 */
const isDecimalIssue = (path: readonly PropertyKey[]): boolean => {
  const leaf = path.at(-1);
  return leaf === 'price' || leaf === 'volume';
};

const decodeText = (raw: unknown): unknown => {
  if (typeof raw !== 'string') {
    return raw;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return reject('frame is not valid JSON');
  }
};

const collectUnknownFields = (
  data: Readonly<Record<string, unknown>>,
  knownFields: ReadonlySet<string>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(data).filter(([key]) => !knownFields.has(key)),
  );

const parseWith = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  description: string,
): T => {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  if (issue === undefined) {
    return reject(`${description} does not match the pinned Toss contract`);
  }

  const at =
    issue.path.length === 0
      ? description
      : `${description}.${issue.path.join('.')}`;
  const message = `${at}: ${issue.message}`;

  return isDecimalIssue(issue.path) ? rejectDecimal(message) : reject(message);
};

const readLevels = (
  levels: readonly { price: string; volume: string }[],
  side: string,
): readonly OrderBookLevel[] =>
  levels.map((level, index) => ({
    price: readDecimalString(level.price, `${side}[${index}] price`),
    volume: readDecimalString(level.volume, `${side}[${index}] volume`),
  }));

const parseDataFrame = (
  raw: unknown,
  topic: string,
  receivedAt: string,
): TossTradeFrame | TossOrderBookFrame => {
  const parts = parseTossTopic(topic);
  if (parts === null) {
    return reject(`unroutable data-frame topic '${topic}'`);
  }

  if (parts.channel === 'trade') {
    const frame = parseWith(tossTradeFrameSchema, raw, 'trade frame');

    return {
      kind: 'trade',
      topic,
      providerMarket: parts.providerMarket,
      symbol: parts.symbol,
      price: frame.data.price,
      volume: frame.data.volume,
      sourceTimestamp: frame.data.timestamp,
      currency: frame.data.currency,
      receivedAt,
      unknownFields: collectUnknownFields(frame.data, KNOWN_TRADE_DATA_FIELDS),
    };
  }

  const frame = parseWith(tossOrderBookFrameSchema, raw, 'orderbook frame');

  return {
    kind: 'orderBook',
    topic,
    providerMarket: parts.providerMarket,
    symbol: parts.symbol,
    sourceTimestamp: frame.data.timestamp ?? null,
    currency: frame.data.currency,
    bids: readLevels(frame.data.bids, 'bid'),
    asks: readLevels(frame.data.asks, 'ask'),
    receivedAt,
    unknownFields: collectUnknownFields(
      frame.data,
      KNOWN_ORDER_BOOK_DATA_FIELDS,
    ),
  };
};

/**
 * Parses one inbound frame. `raw` is either a decoded value or the raw text
 * frame; the keepalive `PING` this client *sends* is plain text, so a text
 * frame that is not JSON is rejected rather than guessed at.
 *
 * Throws `MarketDataError` — never a `DomainError`: a malformed frame is a
 * feed fault, and only the engine may turn one into a trading outcome.
 */
export function parseTossFrame(
  raw: unknown,
  receivedAt: string,
): TossInboundFrame {
  const decoded = decodeText(raw);
  const envelope = parseWith(tossFrameEnvelopeSchema, decoded, 'frame');

  switch (envelope.type) {
    case 'message': {
      const topic = envelope.topic;
      if (typeof topic !== 'string' || topic.length === 0) {
        return reject('data frame carries no topic');
      }

      return parseDataFrame(decoded, topic, receivedAt);
    }

    case 'subscriptions': {
      const frame = parseWith(
        tossSubscriptionAckFrameSchema,
        decoded,
        'subscriptions frame',
      );

      return {
        kind: 'subscriptionAck',
        requestId: frame.id ?? null,
        subscribed: frame.subscribed,
        rejected: frame.rejected,
        receivedAt,
      };
    }

    case 'error': {
      const frame = parseWith(tossErrorFrameSchema, decoded, 'error frame');

      return {
        kind: 'error',
        code: frame.error.code,
        message: frame.error.message,
        requestId: frame.id ?? null,
        receivedAt,
      };
    }

    case 'pong': {
      parseWith(tossPongFrameSchema, decoded, 'pong frame');

      return { kind: 'pong', receivedAt };
    }

    default:
      return reject(`unknown frame type '${envelope.type}'`);
  }
}

/**
 * Narrows a parsed data frame into a normalized `MarketEvent`.
 *
 * This is the only place an opaque provider enum is allowed to become a
 * domain type, and it refuses instead of guessing: an unknown currency, an
 * unknown market, or a currency that contradicts its market raises
 * `UNSUPPORTED_DATA` so the engine records an unsupported-data incident and
 * degrades the market. Unknown provider fields are dropped here — a
 * normalized event carries only the fields `MARKET_EVENT_FIELDS` names.
 */
export function toMarketEvent(frame: TossInboundFrame): MarketEvent {
  if (frame.kind !== 'trade' && frame.kind !== 'orderBook') {
    return reject(`${frame.kind} is a control frame, not market data`);
  }

  const market = PROVIDER_MARKETS[frame.providerMarket];
  if (market === undefined) {
    return reject(`unsupported provider market '${frame.providerMarket}'`);
  }

  const currency = MARKET_CURRENCIES[market];
  if (frame.currency !== currency) {
    return reject(
      `unsupported currency '${frame.currency}' for market ${market}`,
    );
  }

  if (frame.kind === 'trade') {
    return {
      kind: 'trade',
      market,
      symbol: frame.symbol,
      price: readDecimalString(frame.price, 'trade price'),
      volume: readDecimalString(frame.volume, 'trade volume'),
      sourceTimestamp: frame.sourceTimestamp,
      receivedAt: frame.receivedAt,
    };
  }

  const book: OrderBookSnapshot = {
    symbol: frame.symbol,
    market,
    currency,
    bids: frame.bids,
    asks: frame.asks,
  };

  return {
    kind: 'orderBook',
    market,
    symbol: frame.symbol,
    book,
    sourceTimestamp: frame.sourceTimestamp,
    receivedAt: frame.receivedAt,
  };
}
