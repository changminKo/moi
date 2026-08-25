import type { Instrument } from '../../lib/api-types';
export function InstrumentSearch({
  query,
  onQuery,
  instruments,
  onSelect,
}: {
  query: string;
  onQuery: (value: string) => void;
  instruments: readonly Instrument[];
  onSelect: (instrument: Instrument) => void;
}) {
  return (
    <section aria-labelledby="instrument-search-title" className="panel">
      <h2 id="instrument-search-title">Instrument search</h2>
      <label htmlFor="instrument-search">Search</label>
      <input
        id="instrument-search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search symbols"
      />
      <ul>
        {instruments.map((instrument) => (
          <li key={`${instrument.market}-${instrument.symbol}`}>
            <button type="button" onClick={() => onSelect(instrument)}>
              {instrument.name} ({instrument.symbol})
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
