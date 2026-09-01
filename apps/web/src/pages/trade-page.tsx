import { QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import './trade-page.css';

export function TradePage({
  apiClient = defaultApiClient,
}: {
  apiClient?: ApiClient;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Instrument | null>(null);
  const { data } = useInstruments(query, apiClient);
  const { quote } = useQuoteStream(
    selected?.tradable ? selected.market : undefined,
    selected?.tradable ? selected.symbol : undefined,
    apiClient,
  );
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const { availability } = useTradingStatus();
  // The symbol the page was opened with, if any: it is revealed and focused in
  // the list once, then forgotten. Captured at mount so later URL writes — the
  // toggle, back/forward — cannot re-trigger it.
  const [focusSymbol, setFocusSymbol] = useState<string | null>(() =>
    params.get('symbol'),
  );
  const forgetDeepLink = useCallback(() => setFocusSymbol(null), []);
  // `?symbol=` is the source of truth for the selection: the effect reconciles
  // state with the URL on every change, so deep links, the toggle and browser
  // back/forward all land on the same code path.
  const instruments = useMemo(() => data, [data]);
  const symbolParam = params.get('symbol');
  useEffect(() => {
    let active = true;
    // Only an empty URL clears the selection. A lookup that fails or comes
    // back empty leaves it alone: dropping it would unmount the order ticket
    // under the user's hands, losing a half-typed order.
    if (!symbolParam) {
      setSelected(null);
      return;
    }
    if (selected?.symbol === symbolParam) return;
    const known = instruments.find((item) => item.symbol === symbolParam);
    if (known) {
      setSelected(known);
      return;
    }
    apiClient
      .get<Instrument[]>(
        `/api/v1/instruments?q=${encodeURIComponent(symbolParam)}`,
      )
      .then((items) => {
        const found = items.find((item) => item.symbol === symbolParam);
        if (active && found) setSelected(found);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [apiClient, instruments, symbolParam, selected]);
  useEffect(() => {
    apiClient
      .get<{ wallets: readonly Wallet[] }>('/api/v1/portfolio')
      .then((x) => setWallets(x.wallets ?? []))
      .catch(() => setWallets([]));
  }, [apiClient]);
  // Only the URL is written here. `selected` is derived from it by the effect
  // above, so there is no window in which local state and the query string
  // disagree — writing both raced when React committed them separately and
  // unmounted the order ticket mid-interaction.
  const deselect = () =>
    setParams((current) => {
      current.delete('symbol');
      return current;
    });
  // Any deliberate action retires the pending deep link: from here on the user
  // is driving, and focus belongs wherever they put it.
  const select = (instrument: Instrument) => {
    forgetDeepLink();
    const isToggleOff =
      selected?.market === instrument.market &&
      selected.symbol === instrument.symbol;
    if (isToggleOff) {
      deselect();
      return;
    }
    setParams((current) => {
      current.set('symbol', instrument.symbol);
      return current;
    });
  };
  const reset = () => {
    forgetDeepLink();
    setQuery('');
    deselect();
  };
  const search = (value: string) => {
    forgetDeepLink();
    setQuery(value);
  };
  return (
    <QueryClientProvider client={queryClient}>
      <div className="trade-page">
        <div className="trade-col trade-col-side">
          <InstrumentSearch
            query={query}
            onQuery={search}
            instruments={instruments}
            onSelect={select}
            selected={selected}
            onReset={reset}
            canReset={Boolean(selected) || query !== ''}
            focusSymbol={focusSymbol}
            onFocusHandled={forgetDeepLink}
          />
        </div>
        <div className="trade-col trade-col-main">
          {selected && !selected.tradable && (
            <p role="alert">{t('reason.SYMBOL_NOT_TRADABLE')}</p>
          )}
          <QuotePanel quote={quote} instrument={selected} />
        </div>
        <div className="trade-col trade-col-ticket">
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
      </div>
    </QueryClientProvider>
  );
}
