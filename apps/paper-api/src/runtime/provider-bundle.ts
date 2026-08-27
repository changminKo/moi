import {
  FakeConnectionLedger,
  FakeMarketData,
  FakeSnapshotSource,
  type MarketDataStream,
  type MarketSnapshotSource,
  type TokenProvider,
} from '@skipjack/market-data';
import type { Market } from '@skipjack/trading-core';
import { type AppConfig, ConfigError } from '../config.js';

export interface ProviderBundle {
  readonly kind: 'fake' | 'toss';
  streamFor(market: Market): MarketDataStream;
  readonly snapshots: MarketSnapshotSource;
  readonly tokenProvider?: TokenProvider;
  /** Provider connections currently open across all markets (§12.2). */
  connectionsOpen(): number;
  close(): Promise<void>;
}

export interface FakeProviderBundle extends ProviderBundle {
  readonly kind: 'fake';
  streamFor(market: Market): FakeMarketData;
  readonly snapshots: FakeSnapshotSource;
  readonly ledger: FakeConnectionLedger;
  connectCalls(): number;
  snapshotCalls(): number;
}

/** Default deterministic symbols the fake bundle seeds (one per market). */
export const FAKE_SYMBOLS: Readonly<Record<Market, readonly string[]>> = {
  KR: ['005930'],
  US: ['AAPL'],
};

export function createFakeProviderBundle(
  options: { readonly ledger?: FakeConnectionLedger } = {},
): FakeProviderBundle {
  const ledger = options.ledger ?? new FakeConnectionLedger();
  const streams = new Map<Market, FakeMarketData>();
  const snapshots = new FakeSnapshotSource();
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
    streamFor: (market) => streams.get(market) as FakeMarketData,
    connectionsOpen: () => ledger.open,
    connectCalls: () => connectCalls,
    snapshotCalls: () => snapshots.calls,
    close: async () => {
      for (const stream of streams.values()) await stream.close();
    },
  };
}

/**
 * Selects the provider implementation by `MARKET_DATA_ADAPTER` (§5.1).
 * Stage A ships only the fake bundle; asking for `toss` fails closed.
 */
export function createProviderBundle(config: AppConfig): ProviderBundle {
  if (config.marketDataAdapter === 'fake') return createFakeProviderBundle();
  throw new ConfigError('toss adapter is not available in this build');
}
