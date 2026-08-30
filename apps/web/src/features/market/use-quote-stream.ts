import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { QuoteSnapshot } from '../../lib/api-types';

const DEFAULT_POLL_MS = 5000;

export function useQuoteStream(
  market: 'KR' | 'US' | undefined,
  symbol: string | undefined,
  apiClient: ApiClient = defaultApiClient,
  pollMs: number = DEFAULT_POLL_MS,
) {
  const [quote, setQuote] = useState<QuoteSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    if (!market || !symbol) {
      setQuote(null);
      return;
    }
    const load = () => {
      apiClient
        .get<QuoteSnapshot>(
          `/api/v1/markets/${market}/symbols/${encodeURIComponent(symbol)}/quote`,
        )
        .then((next) => {
          if (active) setQuote(next);
        })
        .catch(() => {
          // Keep the last snapshot on a transient poll failure; the initial
          // load simply leaves the quote empty.
          if (active) setQuote((current) => current);
        });
    };
    load();
    const timer = window.setInterval(load, pollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [apiClient, market, symbol, pollMs]);
  return { quote };
}
