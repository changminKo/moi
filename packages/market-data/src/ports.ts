/**
 * The ports the paper engine depends on. Every method takes an `AbortSignal`
 * because the engine cancels market-data work on shutdown, on a leader-lease
 * loss, and on a recovery epoch change; no port owns a timer of its own.
 */
import type {
  Currency,
  DecimalString,
  Market,
  OrderBookSnapshot,
} from '@moi/trading-core';
import type {
  MarketEvent,
  SubscriptionAck,
  SubscriptionDeclaration,
} from './types.js';

export interface MarketDataStream {
  connect(signal: AbortSignal): Promise<void>;
  /** Replaces the whole subscription set and reports the exact topic verdicts. */
  declare(
    subscriptions: readonly SubscriptionDeclaration[],
  ): Promise<SubscriptionAck>;
  events(signal: AbortSignal): AsyncIterable<MarketEvent>;
  /** Resolves with the observed round-trip in milliseconds, or rejects. */
  ping(): Promise<number>;
  close(): Promise<void>;
}

export interface MarketPrice {
  readonly market: Market;
  readonly symbol: string;
  readonly price: DecimalString;
  readonly sourceTimestamp: string | null;
  readonly fetchedAt: string;
}

export interface MarketOrderBookSnapshot {
  readonly market: Market;
  readonly symbol: string;
  readonly book: OrderBookSnapshot;
  readonly sourceTimestamp: string | null;
  readonly fetchedAt: string;
}

/**
 * A recovery snapshot is the *current* price and the *current* book. It is
 * never a reconstruction of what happened during the outage.
 */
export interface RecoverySnapshot {
  readonly market: Market;
  readonly symbol: string;
  readonly price: DecimalString;
  readonly book: OrderBookSnapshot;
  readonly fetchedAt: string;
}

export interface MarketSnapshotSource {
  getPrice(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<MarketPrice>;
  getOrderBook(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<MarketOrderBookSnapshot>;
  getRecoverySnapshot(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<RecoverySnapshot>;
}

export interface Instrument {
  readonly market: Market;
  readonly symbol: string;
  readonly name: string;
  readonly currency: Currency;
  readonly tradable: boolean;
}

export interface InstrumentCatalog {
  searchInstruments(
    query: string,
    signal: AbortSignal,
  ): Promise<readonly Instrument[]>;
  getInstrument(
    market: Market,
    symbol: string,
    signal: AbortSignal,
  ): Promise<Instrument | null>;
}

export interface MarketSession {
  readonly opensAt: string;
  readonly closesAt: string;
}

/**
 * One calendar day for one market. `regularSession` is null on a non-trading
 * day; the engine matches only inside a regular session it has cached.
 */
export interface MarketCalendarDay {
  readonly market: Market;
  readonly tradingDate: string;
  readonly isTradingDay: boolean;
  readonly regularSession: MarketSession | null;
}

export interface MarketCalendarSource {
  getCalendarDay(
    market: Market,
    tradingDate: string,
    signal: AbortSignal,
  ): Promise<MarketCalendarDay>;
}

export interface FxRate {
  readonly base: Currency;
  readonly quote: Currency;
  readonly rate: DecimalString;
  readonly asOf: string;
}

export interface FxRateSource {
  getFxRate(
    base: Currency,
    quote: Currency,
    signal: AbortSignal,
  ): Promise<FxRate>;
}

/**
 * Supplies the credential an adapter sends during its handshake. It is a port
 * so a token never reaches a log, an event, or a test assertion.
 */
export interface TokenProvider {
  getAccessToken(signal: AbortSignal): Promise<string>;
  /** Drops a cached token after the provider rejected it (401); pass the rejected token when known. */
  invalidate?(rejectedToken?: string): void;
}
