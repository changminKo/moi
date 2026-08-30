import { useTranslation } from 'react-i18next';
import { formatDecimal } from '../../lib/format-number';

export type Position = Readonly<Record<string, unknown>>;
const cell = (value: unknown, fallback: string) =>
  formatDecimal(String(value ?? fallback));

export function PositionsTable({
  positions = [],
}: {
  positions?: readonly Position[];
}) {
  const { t } = useTranslation();
  return (
    <section className="panel" aria-labelledby="positions-title">
      <h2 id="positions-title">{t('positions.title')}</h2>
      {positions.length === 0 ? (
        <p>{t('positions.empty')}</p>
      ) : (
        <table>
          <caption className="sr-only">{t('positions.caption')}</caption>
          <thead>
            <tr>
              <th>{t('positions.symbol')}</th>
              <th>{t('positions.available')}</th>
              <th>{t('positions.reserved')}</th>
              <th>{t('positions.total')}</th>
              <th>{t('positions.avgCost')}</th>
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
