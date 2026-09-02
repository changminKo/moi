import { useTranslation } from 'react-i18next';
import type { RealizedPnlTotal } from './realized-pnl';
import { formatRealizedPnl } from './realized-pnl-format';

/**
 * The session's realized total, one figure per settlement currency. KRW and
 * USD are never added together — there is no rate to add them at — so the
 * strip is a list of currencies, not a sum. Absent entirely until something
 * has settled, rather than announcing `₩0 · $0` on a fresh session.
 */
export function RealizedPnlSummary({
  totals,
}: {
  totals: readonly RealizedPnlTotal[];
}) {
  const { t } = useTranslation();
  if (totals.length === 0) return null;
  return (
    <section className="realized-summary" aria-labelledby="realized-pnl-title">
      <p id="realized-pnl-title" className="eyebrow">
        {t('positions.realized')}
      </p>
      <ul aria-label={t('positions.realizedCaption')}>
        {totals.map((total) => {
          const { text, tone } = formatRealizedPnl(total);
          return (
            <li key={total.currency}>
              <span className={tone}>{text}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
