import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import { type MessageKey, useAppLocale } from '../../lib/i18n';
import { presentationForReason } from '../system/system-status-provider';
import { type OrderDraft, type Side, validateOrderDraft } from './order-form';
import { useOrderMutations } from './use-order-mutations';
import './order-ticket.css';

// validateOrderDraft speaks English (its messages are part of the pure
// order-form contract); the ticket maps them onto catalogue keys for display.
const VALIDATION_KEYS: Record<string, MessageKey> = {
  'Quantity must be a positive whole number': 'validation.quantity',
  'Limit price is required': 'validation.limitPrice',
  'Stop price is required': 'validation.stopPrice',
  'Trigger price is required': 'validation.triggerPrice',
  'Take-profit price is required': 'validation.takeProfitPrice',
  'OCO triggers must differ': 'validation.ocoTriggersDiffer',
};

export function OrderTicket({
  market = 'US',
  symbol = '',
  apiClient = defaultApiClient,
  capability = { canPlace: true, reasonCodes: [] },
}: {
  market?: 'KR' | 'US';
  symbol?: string;
  apiClient?: ApiClient;
  capability?: { canPlace: boolean; reasonCodes: readonly string[] };
}) {
  const [kind, setKind] = useState<OrderDraft['kind']>('MARKET');
  const [side, setSide] = useState<Side>('BUY');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [stop, setStop] = useState('');
  const [error, setError] = useState('');
  const { t } = useTranslation();
  const locale = useAppLocale();
  const { place } = useOrderMutations(apiClient);
  const draft = (): OrderDraft =>
    kind === 'MARKET'
      ? { kind, side, quantity }
      : kind === 'LIMIT'
        ? { kind, side, quantity, limitPrice: price }
        : kind === 'STOP'
          ? { kind, side, quantity, stopPrice: price }
          : kind === 'TAKE_PROFIT'
            ? { kind, side, quantity, triggerPrice: price }
            : { kind, side, quantity, takeProfitPrice: price, stopPrice: stop };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = draft();
    const errors = validateOrderDraft(value);
    if (Object.keys(errors).length) {
      const raw = Object.values(errors)[0];
      const key = raw ? VALIDATION_KEYS[raw] : undefined;
      setError(key ? t(key) : (raw ?? t('ticket.invalidOrder')));
      return;
    }
    setError('');
    try {
      await place.mutateAsync({ draft: value, instrument: { market, symbol } });
    } catch (e) {
      const failure = e as {
        code?: string;
        requestId?: string;
        message?: string;
      };
      setError(
        [failure.code, failure.requestId, failure.message]
          .filter(Boolean)
          .join(' — ') || t('ticket.rejected'),
      );
    }
  };
  return (
    <form
      className={`panel order-ticket ${side === 'SELL' ? 'is-sell' : 'is-buy'}`}
      onSubmit={submit}
      aria-labelledby="order-ticket-title"
    >
      <h2 id="order-ticket-title">{t('ticket.title')}</h2>
      <fieldset className="side-toggle">
        <legend>{t('ticket.side')}</legend>
        <div className="side-toggle-options">
          <label className="is-buy">
            <input
              className="side-toggle-radio"
              type="radio"
              name="side"
              checked={side === 'BUY'}
              onChange={() => setSide('BUY')}
            />{' '}
            {t('ticket.buy')}
          </label>
          <label className="is-sell">
            <input
              className="side-toggle-radio"
              type="radio"
              name="side"
              checked={side === 'SELL'}
              onChange={() => setSide('SELL')}
            />{' '}
            {t('ticket.sell')}
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="sr-only">{t('ticket.orderType')}</legend>
        <label htmlFor="order-kind">{t('ticket.type')}</label>
        <select
          id="order-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as OrderDraft['kind'])}
        >
          <option value="MARKET">{t('ticket.typeMarket')}</option>
          <option value="LIMIT">{t('ticket.typeLimit')}</option>
          <option value="STOP">{t('ticket.typeStop')}</option>
          <option value="TAKE_PROFIT">{t('ticket.typeTakeProfit')}</option>
          <option value="OCO">{t('ticket.typeOco')}</option>
        </select>
      </fieldset>
      <label htmlFor="order-quantity">{t('ticket.quantity')}</label>
      <input
        id="order-quantity"
        inputMode="numeric"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        aria-describedby={error ? 'order-error' : undefined}
      />
      {kind !== 'MARKET' && (
        <>
          <label htmlFor="order-price">
            {kind === 'TAKE_PROFIT'
              ? t('ticket.triggerPrice')
              : t('ticket.price')}
          </label>
          <input
            id="order-price"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
        </>
      )}
      {kind === 'OCO' && (
        <>
          <label htmlFor="order-stop">{t('ticket.stopPrice')}</label>
          <input
            id="order-stop"
            inputMode="decimal"
            value={stop}
            onChange={(e) => setStop(e.target.value)}
          />
        </>
      )}
      {capability.reasonCodes.map((reason) => (
        <p key={reason} role="status">
          {presentationForReason(reason, locale)}
        </p>
      ))}
      {error && (
        <p id="order-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        aria-label={t('ticket.placeAria')}
        disabled={!capability.canPlace || place.isPending}
      >
        {t('ticket.place')}
      </button>
    </form>
  );
}
