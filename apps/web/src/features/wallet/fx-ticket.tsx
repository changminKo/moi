import Decimal from 'decimal.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GroupedNumberInput } from '../../components/grouped-number-input';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { FxQuote } from '../../lib/api-types';
import { formatDecimal } from '../../lib/format-number';
import { useAppLocale } from '../../lib/i18n';
import { newIdempotencyKey } from '../../lib/idempotency';
import { presentationForReason } from '../system/system-status-provider';
import './wallet.css';

/**
 * The wire rate is USD per KRW ("0.0007"): correct for the quoting math, but
 * unreadable as an exchange rate — a person thinks "about 1,430 won", and at
 * four decimal places the wire value can't even tell 1,400 from 1,430 apart.
 * This is a display-only inversion; the exact string the API returned is
 * still what quoting and conversion use.
 */
function formatRate(rate: string): string {
  const value = new Decimal(rate);
  if (!value.isFinite() || value.lte(0)) return rate;
  return `1 USD = ${formatDecimal(new Decimal(1).dividedBy(value).toFixed(2))} KRW`;
}

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
  const { t } = useTranslation();
  const locale = useAppLocale();
  const quoteFx = async () => {
    if (!/^\d+(?:\.\d+)?$/.test(amount) || new Decimal(amount || '0').lte(0)) {
      setError(t('fx.amountPositive'));
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
          ? t('fx.quoteExpired')
          : code.code === 'INSUFFICIENT_AVAILABLE_BALANCE'
            ? t('fx.insufficient')
            : t('fx.failed'),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="panel fx-ticket" aria-labelledby="fx-title">
      <h2 id="fx-title">{t('fx.title')}</h2>
      <label htmlFor="fx-amount">{t('fx.amount')}</label>
      <GroupedNumberInput
        id="fx-amount"
        inputMode="decimal"
        value={amount}
        onValueChange={setAmount}
      />
      <button type="button" onClick={quoteFx} disabled={!capability.canFx}>
        {t('fx.getQuote')}
      </button>
      {capability.reasonCodes.map((reason) => (
        <p key={reason} role="status">
          {presentationForReason(reason, locale)}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      {quote && (
        <div aria-live="polite" className="fx-quote">
          <p>
            {t('fx.rate')}: {formatRate(quote.rate)}
          </p>
          <p>
            {t('fx.fee')}: ₩{formatDecimal(quote.fee)}
          </p>
          <p>
            {t('fx.source')}: ₩{formatDecimal(quote.sourceAmount)}
          </p>
          <p>
            {t('fx.destination')}: ${formatDecimal(quote.destinationAmount)}
          </p>
          <button
            type="button"
            disabled={pending || !capability.canFx}
            onClick={convert}
          >
            {t('fx.convert')}
          </button>
        </div>
      )}
    </section>
  );
}
