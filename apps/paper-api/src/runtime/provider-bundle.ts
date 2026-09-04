import {
  FakeCalendarSource,
  FakeConnectionLedger,
  FakeMarketData,
  FakeSnapshotSource,
  type InstrumentCatalog,
  type MarketCalendarSource,
  type MarketDataStream,
  type MarketSnapshotSource,
  OAuthTokenProvider,
  TOSS_SYMBOL_WHITELIST,
  type TokenProvider,
  TossRestClient,
  TossWebSocketMarketData,
} from '@moi/market-data';
import type { Market } from '@moi/trading-core';
import { type AppConfig, ConfigError } from '../config.js';

export interface ProviderBundle {
  readonly kind: 'fake' | 'toss';
  streamFor(market: Market): MarketDataStream;
  readonly snapshots: MarketSnapshotSource;
  /** Display-name catalog used once while the HTTP instrument routes boot. */
  readonly instruments: InstrumentCatalog;
  /** Trading calendar behind `GET /api/v1/markets/:market/session` (§16.31). */
  readonly calendar: MarketCalendarSource;
  readonly tokenProvider?: TokenProvider;
  /** Symbols each market subscribes to and snapshots on recovery. */
  readonly symbols: Readonly<Record<Market, readonly string[]>>;
  /** Provider connections currently open across all markets (§12.2). */
  connectionsOpen(): number;
  close(): Promise<void>;
}

export interface FakeProviderBundle extends ProviderBundle {
  readonly kind: 'fake';
  streamFor(market: Market): FakeMarketData;
  readonly snapshots: FakeSnapshotSource;
  readonly calendar: FakeCalendarSource;
  readonly ledger: FakeConnectionLedger;
  connectCalls(): number;
  snapshotCalls(): number;
}

export interface TossProviderBundle extends ProviderBundle {
  readonly kind: 'toss';
  streamFor(market: Market): TossWebSocketMarketData;
  readonly tokenProvider: OAuthTokenProvider;
}

/** Default deterministic symbols the fake bundle seeds (one per market). */
export const FAKE_SYMBOLS: Readonly<Record<Market, readonly string[]>> = {
  KR: ['005930'],
  US: ['AAPL'],
};

/**
 * The production subscription universe: the pinned US whitelist plus the one
 * KR symbol the fake also serves. Each market stays far below the 40-symbol /
 * 80-topic connection budget (§1.1-6).
 */
export const TOSS_SYMBOLS: Readonly<Record<Market, readonly string[]>> = {
  KR: ['005930'],
  US: [...TOSS_SYMBOL_WHITELIST],
};

export function createFakeProviderBundle(
  options: { readonly ledger?: FakeConnectionLedger } = {},
): FakeProviderBundle {
  const ledger = options.ledger ?? new FakeConnectionLedger();
  const streams = new Map<Market, FakeMarketData>();
  const snapshots = new FakeSnapshotSource();
  const catalog = [
    {
      market: 'KR' as const,
      symbol: '005930',
      name: '삼성전자',
      currency: 'KRW' as const,
      tradable: true,
    },
    {
      market: 'US' as const,
      symbol: 'AAPL',
      name: '애플',
      currency: 'USD' as const,
      tradable: true,
    },
  ];
  const instruments: InstrumentCatalog = {
    searchInstruments: async (query) => {
      const normalized = query.trim().toLowerCase();
      return catalog.filter(
        (instrument) =>
          !normalized ||
          instrument.symbol.toLowerCase().includes(normalized) ||
          instrument.name.toLowerCase().includes(normalized),
      );
    },
    getInstrument: async (market, symbol) =>
      catalog.find(
        (instrument) =>
          instrument.market === market && instrument.symbol === symbol,
      ) ?? null,
  };
  const calendar = new FakeCalendarSource();
  snapshots.seedDefault('KR', '005930', '70000');
  snapshots.seedDefault('US', 'AAPL', '190.25');
  let connectCalls = 0;
  for (const market of ['KR', 'US'] as const) {
    const stream = new FakeMarketData({ ledger });
    const original = stream.connect.bind(stream);
    stream.connect = async (signal) => {
      connectCalls += 1;
      await original(signal);
    };
    streams.set(market, stream);
  }
  return {
    kind: 'fake',
    ledger,
    snapshots,
    instruments,
    calendar,
    symbols: FAKE_SYMBOLS,
    streamFor: (market) => streams.get(market) as FakeMarketData,
    connectionsOpen: () => ledger.open,
    connectCalls: () => connectCalls,
    snapshotCalls: () => snapshots.calls,
    close: async () => {
      for (const stream of streams.values()) await stream.close();
    },
  };
}

export interface TossBundleOptions {
  readonly onTokenRefresh?: (
    result: 'ok' | 'auth_failed' | 'throttled' | 'error',
  ) => void;
  readonly symbols?: Readonly<Record<Market, readonly string[]>>;
  /**
   * Receives the REST client's decode events (`calendar.decode_lenient`).
   * The runtime logs its own calendar failures; this is the one signal that
   * originates inside the adapter and would otherwise be silent (#122).
   */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Real provider wiring (§4 ProviderBundle): one OAuth token provider shared by
 * the REST client and both per-market WebSocket adapters. Nothing here opens a
 * connection or requests a token — `MarketRuntime.connect()` does that only
 * after the KR+US lease bundle is held (§5.5).
 */
export function createTossProviderBundle(
  config: AppConfig,
  options: TossBundleOptions = {},
): TossProviderBundle {
  const toss = config.toss;
  if (toss === undefined)
    throw new ConfigError(
      'toss adapter requires TOSS_CLIENT_ID and TOSS_CLIENT_SECRET',
    );
  const tokenProvider = new OAuthTokenProvider({
    baseUrl: toss.restBaseUrl,
    clientId: toss.clientId,
    clientSecret: toss.clientSecret,
    ...(options.onTokenRefresh ? { onRefresh: options.onTokenRefresh } : {}),
  });
  const snapshots = new TossRestClient({
    baseUrl: toss.restBaseUrl,
    tokenProvider,
    ...(options.log ? { log: options.log } : {}),
  });
  const streams = new Map<Market, TossWebSocketMarketData>();
  for (const market of ['KR', 'US'] as const)
    streams.set(
      market,
      new TossWebSocketMarketData({
        url: new URL(toss.wsUrl),
        market,
        tokenProvider,
      }),
    );
  return {
    kind: 'toss',
    tokenProvider,
    snapshots,
    instruments: snapshots,
    calendar: snapshots,
    symbols: options.symbols ?? TOSS_SYMBOLS,
    streamFor: (market) => streams.get(market) as TossWebSocketMarketData,
    connectionsOpen: () =>
      [...streams.values()].filter((s) => s.isConnected).length,
    close: async () => {
      for (const stream of streams.values()) await stream.close();
    },
  };
}

/** Selects the provider implementation by `MARKET_DATA_ADAPTER` (§5.1). */
export function createProviderBundle(
  config: AppConfig,
  options: TossBundleOptions = {},
): ProviderBundle {
  if (config.marketDataAdapter === 'fake') return createFakeProviderBundle();
  return createTossProviderBundle(config, options);
}
