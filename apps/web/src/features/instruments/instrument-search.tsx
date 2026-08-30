import { useTranslation } from 'react-i18next';
import type { Instrument } from '../../lib/api-types';
import './instrument-search.css';

const isSame = (a: Instrument | null | undefined, b: Instrument) =>
  a?.market === b.market && a.symbol === b.symbol;

export function InstrumentSearch({
  query,
  onQuery,
  instruments,
  onSelect,
  selected = null,
  onReset,
  canReset = false,
}: {
  query: string;
  onQuery: (value: string) => void;
  instruments: readonly Instrument[];
  onSelect: (instrument: Instrument) => void;
  selected?: Instrument | null;
  onReset?: () => void;
  canReset?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="instrument-search-title"
      className="panel instrument-search"
    >
      <h2 id="instrument-search-title">{t('instruments.title')}</h2>
      <label htmlFor="instrument-search">{t('instruments.searchLabel')}</label>
      <input
        id="instrument-search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={t('instruments.searchPlaceholder')}
      />
      <ul className="instrument-list">
        {instruments.map((instrument) => (
          <li key={`${instrument.market}-${instrument.symbol}`}>
            <button
              type="button"
              className={isSame(selected, instrument) ? 'is-selected' : ''}
              // Pressed conveys "selected, activate again to deselect" to
              // assistive tech, which the CSS class alone cannot.
              aria-pressed={isSame(selected, instrument)}
              onClick={() => onSelect(instrument)}
            >
              <span className="instrument-market" aria-hidden="true">
                {instrument.market}
              </span>
              <span className="instrument-name">{instrument.name}</span>{' '}
              <span className="instrument-symbol">({instrument.symbol})</span>
            </button>
            {!instrument.tradable && (
              <span className="status-badge">
                {' '}
                {t('instruments.nonTradable')}
              </span>
            )}
          </li>
        ))}
      </ul>
      {/*
        The reset sits after the list on purpose: a keyboard user tabbing out
        of the search box lands on the first result — the trading fast path —
        instead of an intercepting control, and the DOM order matches the
        visual one (WCAG 1.3.2). It is disabled, hence not a tab stop, while
        there is nothing to clear.
      */}
      {onReset && (
        <button
          type="button"
          className="instrument-reset"
          onClick={onReset}
          disabled={!canReset}
        >
          {t('instruments.showAll')}
        </button>
      )}
    </section>
  );
}
