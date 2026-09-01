import Decimal from 'decimal.js';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GroupedNumberInput } from '../../components/grouped-number-input';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { FxQuote } from '../../lib/api-types';
import {
  capFractionDigits,
  formatDecimal,
  isDecimal,
} from '../../lib/format-number';
import { useAppLocale } from '../../lib/i18n';
import { newIdempotencyKey } from '../../lib/idempotency';
import { presentationForReason } from '../system/system-status-provider';
import './wallet.css';

/**
 * The ticket only ever quotes one direction — KRW leaves the wallet, USD
 * arrives — hardcoded here and in `quoteFx`'s request body below. Every
 * currency symbol, and the rate line's "1 {to} ≈ … {from}" wording, reads
 * from this one place, so adding a direction picker later means changing
 * this constant (and how it gets chosen), not hunting down every ₩/$
 * literal and risking one that silently stays on the old direction.
 */
const FX_DIRECTION = {
  from: 'KRW',
  to: 'USD',
  fromSymbol: '₩',
  toSymbol: '$',
} as const;

// Past this, an inverted rate no longer reads as an exchange rate — it reads
// as a wall of digits (a wire rate of "0.000...001" inverts to a 31-digit
// number) — so above it the raw wire value is the honest thing to show.
const MAX_DISPLAYABLE_KRW_PER_USD = 1e15;

/**
 * The wire rate is USD per KRW ("0.0007"): correct for the quoting math, but
 * unreadable as an exchange rate — a person thinks "about 1,430 won", and at
 * four decimal places the wire value can't even tell 1,400 from 1,430 apart.
 * This inverts *for display only* — quoting and conversion still use the
 * exact wire string — and commits to one direction, KRW per USD, matching
 * `FX_DIRECTION` above. The name says so: a future caller quoting the
 * opposite pair would otherwise get a silently wrong inversion instead of a
 * type error.
 *
 * `quote.rate` arrives from the API with no schema validation, so this must
 * never throw: anything that isn't a plain positive decimal, or whose
 * inverse is too large to mean anything as a rate, reports "not displayable"
 * (null) rather than guessing — the same contract `formatDecimal` already
 * uses for values it can't format.
 */
export function formatKrwPerUsd(rate: string): string | null {
  if (!isDecimal(rate)) return null;
  const value = new Decimal(rate);
  if (value.lte(0)) return null;
  const inverse = new Decimal(1).dividedBy(value);
  if (!inverse.isFinite() || inverse.gte(MAX_DISPLAYABLE_KRW_PER_USD))
    return null;
  return formatDecimal(inverse.toFixed(2));
}

// However many fraction digits the wire value carries, the quote block shows
// at most this many — but never pads a shorter fraction out to it.
const MAX_DISPLAYED_FRACTION_DIGITS = 2;

/** Fee/source/destination amounts: capped fraction, grouped, currency-tagged. */
function displayAmount(symbol: string, value: string): string {
  return `${symbol}${formatDecimal(capFractionDigits(value, MAX_DISPLAYED_FRACTION_DIGITS))}`;
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
        from: FX_DIRECTION.from,
        to: FX_DIRECTION.to,
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
  const krw = quote ? formatKrwPerUsd(quote.rate) : null;
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
            {t('fx.rate')}:{' '}
            {krw === null
              ? quote.rate
              : t('fx.rateValue', {
                  to: FX_DIRECTION.to,
                  from: FX_DIRECTION.from,
                  krw,
                })}
          </p>
          <p>
            {t('fx.fee')}: {displayAmount(FX_DIRECTION.fromSymbol, quote.fee)}
          </p>
          <p>
            {t('fx.source')}:{' '}
            {displayAmount(FX_DIRECTION.fromSymbol, quote.sourceAmount)}
          </p>
          <p>
            {t('fx.destination')}:{' '}
            {displayAmount(FX_DIRECTION.toSymbol, quote.destinationAmount)}
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
