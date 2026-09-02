import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FillHistory } from '../features/orders/fill-history';
import { OpenOrders } from '../features/orders/open-orders';
import { usePortfolioStreamValue } from '../features/portfolio/portfolio-stream-provider';
import { PositionsTable } from '../features/portfolio/positions-table';
import { realizedPnlFromOrders } from '../features/portfolio/realized-pnl';
import { RealizedPnlSummary } from '../features/portfolio/realized-pnl-summary';
import './portfolio-page.css';

export function PortfolioPage() {
  const { t } = useTranslation();
  const { snapshot, isLoading } = usePortfolioStreamValue();
  const snapshotOrders = snapshot.activeOrders as readonly Record<
    string,
    unknown
  >[];
  // Re-folded only when the stream hands over a new snapshot; every render in
  // between reuses the last answer.
  const realized = useMemo(
    () => realizedPnlFromOrders(snapshotOrders),
    [snapshotOrders],
  );
  if (isLoading)
    return <section aria-busy="true">{t('portfolio.loading')}</section>;
  const fills = snapshotOrders.flatMap((order) =>
    Array.isArray(order.fills) ? order.fills : [],
  ) as readonly Record<string, unknown>[];
  return (
    <div className="portfolio-page">
      <header>
        <p className="eyebrow">{t('portfolio.eyebrow')}</p>
        <h1>{t('portfolio.title')}</h1>
      </header>
      <RealizedPnlSummary totals={realized.totals} />
      <PositionsTable positions={snapshot.positions} realized={realized} />
      <OpenOrders orders={snapshotOrders} />
      <FillHistory fills={fills} />
    </div>
  );
}
