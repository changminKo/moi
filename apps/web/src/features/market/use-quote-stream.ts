import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { QuoteSnapshot } from '../../lib/api-types';
export function useQuoteStream(
  market: 'KR' | 'US' | undefined,
  symbol: string | undefined,
  apiClient: ApiClient = defaultApiClient,
) {
  const [quote, setQuote] = useState<QuoteSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    if (!market || !symbol) {
      setQuote(null);
      return;
    }
    apiClient
      .get<QuoteSnapshot>(
        `/api/v1/markets/${market}/symbols/${encodeURIComponent(symbol)}/quote`,
      )
      .then((next) => {
        if (active) setQuote(next);
      })
      .catch(() => {
        if (active) setQuote(null);
      });
    return () => {
      active = false;
    };
  }, [apiClient, market, symbol]);
  return { quote };
}
