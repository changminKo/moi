import Decimal from 'decimal.js';
import { useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { FxQuote } from '../../lib/api-types';
import { newIdempotencyKey } from '../../lib/idempotency';
import { presentationForReason } from '../system/system-status-provider';
export function FxTicket({
  apiClient = defaultApiClient,
  invalidateQueries = () => undefined,
  capability = { canFx: true, reasonCodes: [] as readonly string[] },
}: {
  apiClient?: ApiClient;
  invalidateQueries?: () => void;
  capability?: { canFx: boolean; reasonCodes: readonly string[] };
}) {
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<FxQuote | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const quoteFx = async () => {
    if (!/^\d+(?:\.\d+)?$/.test(amount) || new Decimal(amount || '0').lte(0)) {
      setError('Amount must be positive');
      return;
    }
    setError('');
    setQuote(
      await apiClient.post<FxQuote>('/api/v1/fx/quotes', {
        from: 'KRW',
        to: 'USD',
        amount,
      }),
    );
  };
  const convert = async () => {
    if (!quote || pending) return;
    setPending(true);
    setError('');
    try {
      await apiClient.post(
        '/api/v1/fx/conversions',
        { quoteId: quote.quoteId },
        { idempotencyKey: newIdempotencyKey() },
      );
      setQuote(null);
      invalidateQueries();
    } catch (e) {
      const code = e as { code?: string };
      setError(
        code.code === 'QUOTE_EXPIRED'
          ? 'Quote expired. Refresh explicitly.'
          : code.code === 'INSUFFICIENT_AVAILABLE_BALANCE'
            ? 'Insufficient available balance'
            : 'Conversion failed',
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="panel" aria-labelledby="fx-title">
      <h2 id="fx-title">Virtual FX</h2>
      <label htmlFor="fx-amount">Amount</label>
      <input
        id="fx-amount"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button type="button" onClick={quoteFx} disabled={!capability.canFx}>
        Get quote
      </button>
      {capability.reasonCodes.map((reason) => (
        <p key={reason} role="status">
          {presentationForReason(reason)}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      {quote && (
        <div aria-live="polite">
          <p>Rate: {quote.rate}</p>
          <p>Fee: {quote.fee}</p>
          <p>Source: {quote.sourceAmount}</p>
          <p>Destination: {quote.destinationAmount}</p>
          <button
            type="button"
            disabled={pending || !capability.canFx}
            onClick={convert}
          >
            Convert
          </button>
        </div>
      )}
    </section>
  );
}
