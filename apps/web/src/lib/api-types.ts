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
}>;
export type Wallet = Readonly<{
  currency: 'KRW' | 'USD';
  available: string;
  reserved: string;
  total: string;
}>;
export type BookLevel = Readonly<{ price: string; size: string }>;
export type QuoteSnapshot = Readonly<{
  market: 'KR' | 'US';
  symbol: string;
  price: string | null;
  asOf: string;
  health?: 'HEALTHY' | 'DEGRADED' | 'RECOVERING';
  recoveryEpoch?: string;
  marketDataVersion?: string;
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
