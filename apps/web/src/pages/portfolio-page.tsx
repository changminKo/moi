import { useTranslation } from 'react-i18next';
import { FillHistory } from '../features/orders/fill-history';
import { OpenOrders } from '../features/orders/open-orders';
import { PositionsTable } from '../features/portfolio/positions-table';
import { usePortfolioStream } from '../features/portfolio/use-portfolio-stream';
import './portfolio-page.css';

export function PortfolioPage() {
  const { t } = useTranslation();
  const { snapshot, isLoading } = usePortfolioStream();
  if (isLoading)
    return <section aria-busy="true">{t('portfolio.loading')}</section>;
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
        <h1>{t('portfolio.title')}</h1>
      </header>
      <PositionsTable positions={snapshot.positions} />
      <OpenOrders orders={snapshotOrders} />
      <FillHistory fills={fills} />
    </div>
  );
}
