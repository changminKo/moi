import { useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import { presentationForReason } from '../system/system-status-provider';
import { type OrderDraft, type Side, validateOrderDraft } from './order-form';
import { useOrderMutations } from './use-order-mutations';
import './order-ticket.css';

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
      setError(Object.values(errors)[0] ?? 'Invalid order');
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
          .join(' — ') || 'Order rejected',
      );
    }
  };
  return (
    <form
      className={`panel order-ticket ${side === 'SELL' ? 'is-sell' : 'is-buy'}`}
      onSubmit={submit}
      aria-labelledby="order-ticket-title"
    >
      <h2 id="order-ticket-title">Order ticket</h2>
      <fieldset className="side-toggle">
        <legend>Side</legend>
        <div className="side-toggle-options">
          <label className="is-buy">
            <input
              className="sr-only"
              type="radio"
              name="side"
              checked={side === 'BUY'}
              onChange={() => setSide('BUY')}
            />{' '}
            Buy
          </label>
          <label className="is-sell">
            <input
              className="sr-only"
              type="radio"
              name="side"
              checked={side === 'SELL'}
              onChange={() => setSide('SELL')}
            />{' '}
            Sell
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend className="sr-only">Order type</legend>
        <label htmlFor="order-kind">Type</label>
        <select
          id="order-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as OrderDraft['kind'])}
        >
          <option value="MARKET">Market</option>
          <option value="LIMIT">Limit</option>
          <option value="STOP">Stop</option>
          <option value="TAKE_PROFIT">Take profit</option>
          <option value="OCO">OCO</option>
        </select>
      </fieldset>
      <label htmlFor="order-quantity">Quantity</label>
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
            {kind === 'TAKE_PROFIT' ? 'Trigger price' : 'Price'}
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
          <label htmlFor="order-stop">Stop price</label>
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
          {presentationForReason(reason)}
        </p>
      ))}
      {error && (
        <p id="order-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        aria-label="Order ticket — Place order"
        disabled={!capability.canPlace || place.isPending}
      >
        Place order
      </button>
    </form>
  );
}
