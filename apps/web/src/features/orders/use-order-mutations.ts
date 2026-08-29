import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import { newIdempotencyKey } from '../../lib/idempotency';
import { PORTFOLIO_QUERY_KEY } from '../portfolio/use-portfolio-stream';
import { mapOrderDraft, type OrderDraft } from './order-form';

export function useOrderMutations(apiClient: ApiClient = defaultApiClient) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: PORTFOLIO_QUERY_KEY });
  };
  const place = useMutation({
    mutationFn: ({
      draft,
      instrument,
    }: {
      draft: OrderDraft;
      instrument?: { market: 'KR' | 'US'; symbol: string };
    }) =>
      apiClient.post('/api/v1/orders', mapOrderDraft(draft, instrument), {
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: refresh,
  });
  const amend = useMutation({
    mutationFn: ({
      orderId,
      changes,
    }: {
      orderId: string;
      changes: Record<string, string>;
    }) =>
      apiClient.request(
        `/api/v1/orders/${encodeURIComponent(orderId)}`,
        { method: 'PATCH', body: JSON.stringify(changes) },
        { idempotencyKey: newIdempotencyKey() },
      ),
    onSuccess: refresh,
  });
  const cancel = useMutation({
    mutationFn: (orderId: string) =>
      apiClient.delete(`/api/v1/orders/${encodeURIComponent(orderId)}`, {
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: refresh,
  });
  return { place, amend, cancel };
}
