import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { InstrumentSearch } from '../features/instruments/instrument-search';
import { useInstruments } from '../features/instruments/use-instruments';
import { QuotePanel } from '../features/market/quote-panel';
import { useQuoteStream } from '../features/market/use-quote-stream';
import { OrderTicket } from '../features/orders/order-ticket';
import { useTradingStatus } from '../features/system/system-status-provider';
import { FxTicket } from '../features/wallet/fx-ticket';
import { WalletSummary } from '../features/wallet/wallet-summary';
import type { ApiClient } from '../lib/api-client';
import { apiClient as defaultApiClient } from '../lib/api-client';
import type { Instrument, Wallet } from '../lib/api-types';
import { queryClient } from '../lib/query-client';
export function TradePage({
  apiClient = defaultApiClient,
}: {
  apiClient?: ApiClient;
}) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Instrument | null>(null);
  const { data } = useInstruments(
    query || params.get('symbol') || '',
    apiClient,
  );
  const { quote } = useQuoteStream(
    selected?.tradable ? selected.market : undefined,
    selected?.tradable ? selected.symbol : undefined,
    apiClient,
  );
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const { availability } = useTradingStatus();
  useEffect(() => {
    const symbol = params.get('symbol');
    if (symbol && !selected) {
      apiClient
        .get<Instrument[]>(
          `/api/v1/instruments?q=${encodeURIComponent(symbol)}`,
        )
        .then((items) => {
          const found = items.find((item) => item.symbol === symbol);
          if (found) setSelected(found);
        });
    }
  }, [apiClient, params, selected]);
  useEffect(() => {
    apiClient
      .get<{ wallets: readonly Wallet[] }>('/api/v1/portfolio')
      .then((x) => setWallets(x.wallets ?? []))
      .catch(() => setWallets([]));
  }, [apiClient]);
  const instruments = useMemo(() => data, [data]);
  const select = (instrument: Instrument) => {
    setSelected(instrument);
    setParams((current) => {
      current.set('symbol', instrument.symbol);
      return current;
    });
  };
  return (
    <QueryClientProvider client={queryClient}>
      <div className="trade-page">
        <InstrumentSearch
          query={query}
          onQuery={setQuery}
          instruments={instruments}
          onSelect={select}
        />
        {selected && !selected.tradable && (
          <p role="alert">SYMBOL_NOT_TRADABLE</p>
        )}
        <QuotePanel quote={quote} />
        {selected && (
          <OrderTicket
            market={selected.market}
            symbol={selected.symbol}
            apiClient={apiClient}
            capability={{
              canPlace: selected.tradable && availability.place.enabled,
              reasonCodes: availability.place.reasons,
            }}
          />
        )}
        <WalletSummary wallets={wallets} />
        <FxTicket
          apiClient={apiClient}
          invalidateQueries={() => {
            void apiClient.get('/api/v1/portfolio');
          }}
          capability={{
            canFx: availability.fx.enabled,
            reasonCodes: availability.fx.reasons,
          }}
        />
      </div>
    </QueryClientProvider>
  );
}
