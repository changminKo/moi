import { FillHistory } from '../features/orders/fill-history';
import { OpenOrders } from '../features/orders/open-orders';
import { PositionsTable } from '../features/portfolio/positions-table';
import { usePortfolioStream } from '../features/portfolio/use-portfolio-stream';
export function PortfolioPage() {
  const { snapshot, isLoading } = usePortfolioStream();
  if (isLoading) return <section aria-busy="true">Loading portfolio…</section>;
  const snapshotOrders = snapshot.activeOrders as readonly Record<
    string,
    unknown
  >[];
  const fills = snapshotOrders.flatMap((order) =>
    Array.isArray(order.fills) ? order.fills : [],
  ) as readonly Record<string, unknown>[];
  return (
    <div className="portfolio-page">
      <header>
        <p className="eyebrow">ACCOUNT / 02</p>
        <h1>Portfolio</h1>
      </header>
      <PositionsTable positions={snapshot.positions} />
      <OpenOrders orders={snapshotOrders} />
      <FillHistory fills={fills} />
    </div>
  );
}
