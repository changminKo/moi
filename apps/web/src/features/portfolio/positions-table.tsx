import { formatDecimal } from '../../lib/format-number';

export type Position = Readonly<Record<string, unknown>>;
const cell = (value: unknown, fallback: string) =>
  formatDecimal(String(value ?? fallback));

export function PositionsTable({
  positions = [],
}: {
  positions?: readonly Position[];
}) {
  return (
    <section className="panel" aria-labelledby="positions-title">
      <h2 id="positions-title">Positions</h2>
      {positions.length === 0 ? (
        <p>No positions yet.</p>
      ) : (
        <table>
          <caption className="sr-only">
            Available and reserved position quantities with average cost
          </caption>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Available</th>
              <th>Reserved</th>
              <th>Total</th>
              <th>Avg cost</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position, index) => (
              <tr key={String(position.symbol ?? index)}>
                <td>{String(position.symbol ?? '')}</td>
                <td>{cell(position.available, '0')}</td>
                <td>{cell(position.reserved, '0')}</td>
                <td>{cell(position.total ?? position.quantity, '0')}</td>
                <td>{cell(position.averageCost, '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
