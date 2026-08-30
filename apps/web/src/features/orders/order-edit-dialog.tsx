import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import { useOrderMutations } from './use-order-mutations';
export function OrderEditDialog({
  order,
  open = false,
  onClose = () => undefined,
  apiClient = defaultApiClient,
  capability = { canAmend: true },
}: {
  order: Record<string, unknown>;
  open?: boolean;
  onClose?: () => void;
  apiClient?: ApiClient;
  capability?: { canAmend: boolean };
}) {
  const [quantity, setQuantity] = useState(String(order.quantity ?? ''));
  const [price, setPrice] = useState(
    String(order.limitPrice ?? order.stopPrice ?? ''),
  );
  const { t } = useTranslation();
  const { amend } = useOrderMutations(apiClient);
  const eligible =
    order.status === 'OPEN' &&
    order.timeInForce === 'GTC' &&
    capability.canAmend;
  if (!open) return null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await amend.mutateAsync({
      orderId: String(order.id),
      changes: {
        ...(quantity ? { quantity } : {}),
        ...(price ? { limitPrice: price } : {}),
      },
    });
    onClose();
  };
  return (
    <dialog open aria-labelledby="edit-order-title">
      <form onSubmit={submit}>
        <h2 id="edit-order-title">{t('amend.title')}</h2>
        {eligible ? (
          <>
            <label htmlFor="amend-quantity">{t('ticket.quantity')}</label>
            <input
              id="amend-quantity"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
            <label htmlFor="amend-price">{t('ticket.price')}</label>
            <input
              id="amend-price"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <button type="submit" disabled={amend.isPending}>
              {t('amend.save')}
            </button>
          </>
        ) : (
          <p>{t('amend.unavailable')}</p>
        )}
        <button type="button" onClick={onClose}>
          {t('common.close')}
        </button>
      </form>
    </dialog>
  );
}
