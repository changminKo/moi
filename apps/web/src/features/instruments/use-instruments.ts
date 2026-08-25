import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { Instrument } from '../../lib/api-types';

export function useInstruments(
  query: string,
  apiClient: ApiClient = defaultApiClient,
) {
  const [data, setData] = useState<readonly Instrument[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLoading(true);
      apiClient
        .get<readonly Instrument[]>(
          `/api/v1/instruments?q=${encodeURIComponent(query)}`,
        )
        .then(setData)
        .catch(() => setData([]))
        .finally(() => setLoading(false));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [apiClient, query]);
  return { data, loading };
}
