import type { InstrumentCatalog } from '@moi/market-data';
import type { Market } from '@moi/trading-core';
import snapshotRows from './instrument-names.snapshot.json' with {
  type: 'json',
};

export const INSTRUMENT_NAMES_TIMEOUT_MS = 5_000;

export interface InstrumentNameSnapshot {
  readonly market: Market;
  readonly symbol: string;
  readonly name: string;
}

export const INSTRUMENT_NAME_SNAPSHOT =
  snapshotRows as readonly InstrumentNameSnapshot[];

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface LoadInstrumentNamesOptions {
  readonly source: Pick<InstrumentCatalog, 'searchInstruments'>;
  readonly symbols: Readonly<Record<Market, readonly string[]>>;
  readonly snapshot?: readonly InstrumentNameSnapshot[];
  readonly signal: AbortSignal;
  readonly log: LogFn;
}

const key = (market: Market, symbol: string) => `${market}:${symbol}` as const;

function indexSnapshot(
  rows: readonly InstrumentNameSnapshot[],
): ReadonlyMap<string, string> {
  return new Map(
    rows
      .filter((row) => row.name.trim().length > 0)
      .map((row) => [key(row.market, row.symbol), row.name.trim()]),
  );
}

export async function loadInstrumentNames({
  source,
  symbols,
  snapshot = INSTRUMENT_NAME_SNAPSHOT,
  signal,
  log,
}: LoadInstrumentNamesOptions): Promise<ReadonlyMap<`${Market}:${string}`, string>> {
  const timeout = new AbortController();
  const timer = setTimeout(
    () =>
      timeout.abort(
        new DOMException('Instrument name lookup timed out', 'TimeoutError'),
      ),
    INSTRUMENT_NAMES_TIMEOUT_MS,
  );
  let provider = new Map<string, string>();
  try {
    const rows = await source.searchInstruments(
      '',
      AbortSignal.any([signal, timeout.signal]),
    );
    provider = new Map(
      rows
        .filter((row) => row.name.trim().length > 0)
        .map((row) => [key(row.market, row.symbol), row.name.trim()]),
    );
  } catch (error) {
    log('instrument_names.provider_fallback', {
      reason: error instanceof Error ? error.name : 'UnknownError',
    });
  } finally {
    clearTimeout(timer);
  }

  const fallback = indexSnapshot(snapshot);
  return new Map(
    (['KR', 'US'] as const).flatMap((market) =>
      symbols[market].map((symbol) => {
        const instrumentKey = key(market, symbol);
        return [
          instrumentKey,
          provider.get(instrumentKey) ?? fallback.get(instrumentKey) ?? symbol,
        ] as const;
      }),
    ),
  );
}
