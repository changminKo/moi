export type Position = Readonly<Record<string, unknown>>;
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
            Available and reserved position quantities
          </caption>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Available</th>
              <th>Reserved</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position, index) => (
              <tr key={String(position.symbol ?? index)}>
                <td>{String(position.symbol ?? '')}</td>
                <td>{String(position.available ?? '0')}</td>
                <td>{String(position.reserved ?? '0')}</td>
                <td>{String(position.total ?? position.quantity ?? '0')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
