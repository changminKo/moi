import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GroupedNumberInput } from '../../components/grouped-number-input';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { QuoteSnapshot } from '../../lib/api-types';
import { type Currency, withCurrency } from '../../lib/currency';
import { capFractionDigits, formatDecimal } from '../../lib/format-number';
import { type MessageKey, useAppLocale } from '../../lib/i18n';
import { presentationForReason } from '../system/system-status-provider';
import {
  bookForEstimate,
  estimateOrderNotional,
  type OrderEstimate,
} from './order-estimate';
import { type OrderDraft, type Side, validateOrderDraft } from './order-form';
import { describePlacementFailure, placementMessageKey } from './order-outcome';
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

// The estimate is a display value, so it is capped the way every other amount
// on this screen is (wallet-summary.tsx, fx-ticket.tsx) — never padded, and
// never applied to anything that gets submitted.
const MAX_DISPLAYED_FRACTION_DIGITS = 2;

const displayAmount = (currency: Currency | undefined, value: string) =>
  withCurrency(
    currency,
    formatDecimal(capFractionDigits(value, MAX_DISPLAYED_FRACTION_DIGITS)),
  );

/**
 * What the last submit did. One piece of state, not two, so a success can
 * never sit under a rejection or the other way round.
 *
 * A rejection stays an `alert` — the ticket already spoke that way for
 * validation, and an e2e journey asserts it — while an acceptance is a
 * `status` (polite): it is news, not a problem, and it must not interrupt a
 * reader who has already moved on to the next field. This is deliberately not
 * a toast: the app has no toast infrastructure, and inventing a portal,
 * timers and a dismissal contract for one sentence that belongs beside the
 * button that produced it would be a notification system, not a fix.
 */
type Outcome =
  | Readonly<{ kind: 'error'; text: string; requestId?: string }>
  | Readonly<{ kind: 'success'; text: string }>;

/**
 * How long the estimate must hold still before it is spoken. Long enough to
 * cover the gap between two keystrokes, short enough that a reader who has
 * stopped typing does not wait on it.
 */
const ANNOUNCE_DELAY_MS = 500;

/** The value once it has stopped changing for `delayMs`. */
function useSettled(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

export function OrderTicket({
  market = 'US',
  symbol = '',
  apiClient = defaultApiClient,
  capability = { canPlace: true, reasonCodes: [] },
  quote = null,
  currency,
}: {
  market?: 'KR' | 'US';
  symbol?: string;
  apiClient?: ApiClient;
  capability?: { canPlace: boolean; reasonCodes: readonly string[] };
  /**
   * The quote the estimate is multiplied against. Trusted only when it names
   * this ticket's own market and symbol — the same rule the quote panel's
   * display name uses, since a deep link or a pending selection can leave the
   * previous instrument's book beside a freshly mounted ticket.
   */
  quote?: QuoteSnapshot | null;
  /** Resolved by `resolveQuoteCurrency`; the estimate stays bare without it. */
  currency?: Currency | undefined;
}) {
  const [kind, setKind] = useState<OrderDraft['kind']>('MARKET');
  const [side, setSide] = useState<Side>('BUY');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [stop, setStop] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
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
  const priced = quote && quote.market === market && quote.symbol === symbol;
  // Recomputed as the reader types. It is an estimate, and the wording says
  // so: a MARKET order fills at whatever the book gives it, which is why this
  // reads "≈" the way the FX ticket's rate line does.
  const estimate: OrderEstimate | null = estimateOrderNotional(
    draft(),
    bookForEstimate(priced ? quote : null),
  );
  const estimateText = (): string => {
    // Still typing the quantity: an estimate of nothing is not worth a line.
    if (!/^\d+$/.test(quantity) || quantity === '0') return '';
    if (estimate === null) return t('ticket.estimateUnavailable');
    return estimate.high === undefined
      ? t('ticket.estimate', {
          amount: displayAmount(currency, estimate.low),
        })
      : t('ticket.estimateRange', {
          low: displayAmount(currency, estimate.low),
          high: displayAmount(currency, estimate.high),
        });
  };
  const estimateShown = estimateText();
  const estimateAnnounced = useSettled(estimateShown, ANNOUNCE_DELAY_MS);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = draft();
    const errors = validateOrderDraft(value);
    if (Object.keys(errors).length) {
      const raw = Object.values(errors)[0];
      const key = raw ? VALIDATION_KEYS[raw] : undefined;
      setOutcome({
        kind: 'error',
        text: key ? t(key) : (raw ?? t('ticket.invalidOrder')),
      });
      return;
    }
    setOutcome(null);
    try {
      const response = await place.mutateAsync({
        draft: value,
        instrument: { market, symbol },
      });
      // Only the quantity is cleared. The prices are usually the reason the
      // reader is placing several orders in a row, and re-typing them would
      // be the annoyance this change is supposed to remove.
      setQuantity('');
      setOutcome({ kind: 'success', text: t(placementMessageKey(response)) });
    } catch (e) {
      // Never the error object, and never the server's own prose: the public
      // code is mapped to a sentence in the reader's language, with the
      // request id kept beside it as the support handle.
      const failure = describePlacementFailure(e);
      setOutcome({
        kind: 'error',
        text: t(failure.key, { code: failure.code ?? '' }),
        ...(failure.requestId === undefined
          ? {}
          : { requestId: failure.requestId }),
      });
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
      <GroupedNumberInput
        id="order-quantity"
        inputMode="numeric"
        value={quantity}
        onValueChange={setQuantity}
        aria-describedby={outcome?.kind === 'error' ? 'order-error' : undefined}
      />
      {kind !== 'MARKET' && (
        <>
          <label htmlFor="order-price">
            {kind === 'TAKE_PROFIT'
              ? t('ticket.triggerPrice')
              : t('ticket.price')}
          </label>
          <GroupedNumberInput
            id="order-price"
            inputMode="decimal"
            value={price}
            onValueChange={setPrice}
          />
        </>
      )}
      {kind === 'OCO' && (
        <>
          <label htmlFor="order-stop">{t('ticket.stopPrice')}</label>
          <GroupedNumberInput
            id="order-stop"
            inputMode="decimal"
            value={stop}
            onValueChange={setStop}
          />
        </>
      )}
      {/* The visible estimate follows every keystroke — that is what a reader
          watching it wants. The live region beside it is a separate, settled
          copy: a polite region updated per keystroke queues an announcement
          for each intermediate value ("$326.35", "$3,263.5") on the way to a
          quantity of 100, none of which the reader meant. Both stay mounted,
          the live one so there is a region to announce into; the stylesheet
          collapses the visible one while it has nothing to say. */}
      <p className="order-estimate">{estimateShown}</p>
      <span className="sr-only order-estimate-live" aria-live="polite">
        {estimateAnnounced}
      </span>
      {capability.reasonCodes.map((reason) => (
        <p key={reason} role="status">
          {presentationForReason(reason, locale)}
        </p>
      ))}
      {outcome?.kind === 'error' && (
        <>
          <p id="order-error" role="alert">
            {outcome.text}
          </p>
          {outcome.requestId !== undefined && (
            <p className="order-request-id">
              {t('ticket.requestId', { requestId: outcome.requestId })}
            </p>
          )}
        </>
      )}
      {outcome?.kind === 'success' && (
        <p id="order-outcome" role="status">
          {outcome.text}
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
