import { formatDecimal } from '../../lib/format-number';

export type Fill = Readonly<Record<string, unknown>>;
export function FillHistory({ fills = [] }: { fills?: readonly Fill[] }) {
  return (
    <section className="panel" aria-labelledby="fill-history-title">
      <h2 id="fill-history-title">Fill history</h2>
      {fills.length === 0 ? (
        <p>No fills yet.</p>
      ) : (
        <ul>
          {fills.map((fill, index) => (
            <li key={String(fill.id ?? index)}>
              {String(fill.symbol ?? '')}{' '}
              {formatDecimal(String(fill.quantity ?? ''))} @{' '}
              {formatDecimal(String(fill.price ?? ''))}
              {typeof fill.fee === 'string' && fill.fee !== '0' && (
                <span> · fee {formatDecimal(fill.fee)}</span>
              )}
              {fill.recoveryFill === true && <span> Recovery fill</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
