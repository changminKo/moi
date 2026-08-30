import { useTranslation } from 'react-i18next';
import { formatDecimal } from '../../lib/format-number';

export type Fill = Readonly<Record<string, unknown>>;
export function FillHistory({ fills = [] }: { fills?: readonly Fill[] }) {
  const { t } = useTranslation();
  return (
    <section className="panel" aria-labelledby="fill-history-title">
      <h2 id="fill-history-title">{t('fills.title')}</h2>
      {fills.length === 0 ? (
        <p>{t('fills.empty')}</p>
      ) : (
        <ul>
          {fills.map((fill, index) => (
            <li key={String(fill.id ?? index)}>
              {String(fill.symbol ?? '')}{' '}
              {formatDecimal(String(fill.quantity ?? ''))} @{' '}
              {formatDecimal(String(fill.price ?? ''))}
              {typeof fill.fee === 'string' && fill.fee !== '0' && (
                <span>
                  {' '}
                  · {t('fills.fee')} {formatDecimal(fill.fee)}
                </span>
              )}
              {fill.recoveryFill === true && (
                <span> {t('fills.recovery')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
