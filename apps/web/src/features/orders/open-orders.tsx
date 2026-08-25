import Decimal from 'decimal.js';
import { useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import { presentationForReason } from '../system/system-status-provider';
import { useOrderMutations } from './use-order-mutations';

export type OpenOrder = Readonly<Record<string, unknown>>;
const text = (order: OpenOrder, key: string) => String(order[key] ?? '');
const terminal = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
export function OpenOrders({
  orders = [],
  apiClient = defaultApiClient,
  capability = { canCancel: true, reasonCodes: [] },
}: {
  orders?: readonly OpenOrder[];
  apiClient?: ApiClient;
  capability?: { canCancel: boolean; reasonCodes: readonly string[] };
}) {
  const { cancel } = useOrderMutations(apiClient);
  const pending = useRef(new Map<string, Promise<unknown>>());
  const [error, setError] = useState('');
  const cancelOnce = (id: string) => {
    const active = pending.current.get(id);
    if (active) return active;
    const request = cancel
      .mutateAsync(id)
      .catch((failure: unknown) => {
        setError(
          failure instanceof Error ? failure.message : 'Cancellation failed',
        );
        throw failure;
      })
      .finally(() => pending.current.delete(id));
    pending.current.set(id, request);
    return request;
  };
  return (
    <section className="panel" aria-labelledby="open-orders-title">
      <h2 id="open-orders-title">Open orders</h2>
      {capability.reasonCodes.map((reason) => (
        <p key={reason} role="status">
          {presentationForReason(reason)}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      {orders.length === 0 ? (
        <p>No open orders.</p>
      ) : (
        <ul>
          {orders.map((order) => {
            const id = text(order, 'id');
            const status = text(order, 'status');
            const isTerminal = terminal.has(status);
            const filled = text(order, 'filledQuantity') || '0';
            const quantity = text(order, 'quantity');
            const siblings = order.siblingOrderIds as
              | readonly string[]
              | undefined;
            return (
              <li key={id}>
                <span>
                  {text(order, 'symbol')} {status}
                </span>
                <span>
                  Filled {filled} / Remaining{' '}
                  {quantity && filled !== quantity
                    ? new Decimal(quantity).sub(filled).toString()
                    : '0'}
                </span>
                {siblings?.length ? (
                  <span> OCO sibling: {siblings.join(', ')}</span>
                ) : null}
                {!isTerminal && capability.canCancel && (
                  <button
                    type="button"
                    onClick={() => void cancelOnce(id)}
                    disabled={cancel.isPending && cancel.variables === id}
                  >
                    Cancel
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
