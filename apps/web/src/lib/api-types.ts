export type ApiErrorBody = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  requestId: string;
}>;

export type SessionSnapshot = Readonly<{
  sessionId: string;
  expiresAt: string;
  csrfToken: string;
}>;

export type CapabilitySnapshot = Readonly<{
  mode: 'NORMAL' | 'CANCEL_ONLY' | 'READ_ONLY' | 'UNAVAILABLE';
  canPlace: boolean;
  canCancel: boolean;
  reasonCodes: readonly string[];
}>;

export type Instrument = Readonly<{
  market: 'KR' | 'US';
  symbol: string;
  name: string;
  tradable: boolean;
  /**
   * The currency the instrument is quoted and settled in. Optional because
   * `InstrumentService` omits the field when its catalog row has none; every
   * catalog `ProductionRuntime` builds states it.
   */
  currency?: 'KRW' | 'USD';
}>;
export type Wallet = Readonly<{
  currency: 'KRW' | 'USD';
  available: string;
  reserved: string;
  total: string;
}>;
/**
 * One order-book level. `volume` is the word the whole system uses — the
 * ledger column `book_level_volume`, `OrderBookLevel` in `@moi/trading-core`,
 * the engine, and the stream frame on the wire. This type used to say `size`,
 * which existed nowhere else and so read `undefined` off every real frame.
 */
export type BookLevel = Readonly<{ price: string; volume: string }>;
export type QuoteSnapshot = Readonly<{
  market: 'KR' | 'US';
  symbol: string;
  price: string | null;
  asOf: string;
  health?: 'HEALTHY' | 'DEGRADED' | 'RECOVERING';
  recoveryEpoch?: string;
  marketDataVersion?: string;
  /**
   * Book-derived, so absent whenever the symbol's slot holds no book — see
   * `docs/api/quote-contract.md`. `resolveQuoteCurrency` in `lib/currency.ts`
   * is what decides between this and the instrument's own currency.
   */
  currency?: 'KRW' | 'USD';
  bids?: readonly BookLevel[];
  asks?: readonly BookLevel[];
}>;
export type FxQuote = Readonly<{
  quoteId: string;
  rate: string;
  fee: string;
  sourceAmount: string;
  destinationAmount: string;
  expiresAt: string;
}>;
