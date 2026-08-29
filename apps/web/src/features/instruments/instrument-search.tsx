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
}: {
  query: string;
  onQuery: (value: string) => void;
  instruments: readonly Instrument[];
  onSelect: (instrument: Instrument) => void;
  selected?: Instrument | null;
}) {
  return (
    <section
      aria-labelledby="instrument-search-title"
      className="panel instrument-search"
    >
      <h2 id="instrument-search-title">Instrument search</h2>
      <label htmlFor="instrument-search">Search</label>
      <input
        id="instrument-search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search symbols"
      />
      <ul className="instrument-list">
        {instruments.map((instrument) => (
          <li key={`${instrument.market}-${instrument.symbol}`}>
            <button
              type="button"
              className={isSame(selected, instrument) ? 'is-selected' : ''}
              onClick={() => onSelect(instrument)}
            >
              <span className="instrument-market" aria-hidden="true">
                {instrument.market}
              </span>
              <span className="instrument-name">{instrument.name}</span>{' '}
              <span className="instrument-symbol">({instrument.symbol})</span>
            </button>
            {!instrument.tradable && (
              <span className="status-badge"> non-tradable</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
