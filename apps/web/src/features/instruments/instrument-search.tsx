import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Instrument } from '../../lib/api-types';
import './instrument-search.css';

const isSame = (a: Instrument | null | undefined, b: Instrument) =>
  a?.market === b.market && a.symbol === b.symbol;

const key = (instrument: Instrument) =>
  `${instrument.market}-${instrument.symbol}`;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function InstrumentSearch({
  query,
  onQuery,
  instruments,
  onSelect,
  selected = null,
  onReset,
  canReset = false,
  focusSymbol = null,
  onFocusHandled,
}: {
  query: string;
  onQuery: (value: string) => void;
  instruments: readonly Instrument[];
  onSelect: (instrument: Instrument) => void;
  selected?: Instrument | null;
  onReset?: () => void;
  canReset?: boolean;
  /** Symbol arriving from the URL that should be revealed and focused once. */
  focusSymbol?: string | null;
  onFocusHandled?: () => void;
}) {
  const { t } = useTranslation();
  const rows = useRef(new Map<string, HTMLButtonElement>());
  // A deep link behaves like an anchor: the row it names is brought into view
  // and takes focus, exactly once. Nothing else moves focus — an in-app click
  // is already focused by the browser, and stealing it later would interrupt
  // whatever the user is typing.
  useEffect(() => {
    if (!focusSymbol) return;
    const target = instruments.find((item) => item.symbol === focusSymbol);
    // Not in this list (a filtered query, or still loading): leave focus be.
    if (!target) return;
    const row = rows.current.get(key(target));
    if (!row) return;
    row.focus();
    row.scrollIntoView?.({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    onFocusHandled?.();
  }, [focusSymbol, instruments, onFocusHandled]);
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
          <li key={key(instrument)}>
            <button
              type="button"
              ref={(element) => {
                if (element) rows.current.set(key(instrument), element);
                else rows.current.delete(key(instrument));
              }}
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
