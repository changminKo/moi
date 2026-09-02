import { useTranslation } from 'react-i18next';
import { capFractionDigits, formatDecimal } from '../../lib/format-number';
import type { RealizedPnlSummary } from './realized-pnl';
import { formatRealizedPnl } from './realized-pnl-format';

export type Position = Readonly<Record<string, unknown>>;

// Same cap as the wallet and the FX ticket, and for the same reason: the
// ledger's average cost is an exact ten-place quotient
// (`calculateAverageCost`), and only this rendering is shortened. Quantities
// are whole, so the cap is applied to the money column alone.
const MAX_DISPLAYED_FRACTION_DIGITS = 2;

const cell = (value: unknown, fallback: string) =>
  formatDecimal(String(value ?? fallback));
const money = (value: unknown) =>
  formatDecimal(
    capFractionDigits(String(value ?? '—'), MAX_DISPLAYED_FRACTION_DIGITS),
  );

const quantity = (position: Position): string =>
  String(position.total ?? position.quantity ?? '0');

/**
 * Selling a position in full does not delete its ledger row: the quantities
 * fall to zero and `average_cost` keeps the history of what was paid. Only a
 * row with quantity left is a holding, so the zero rows are reported below the
 * table as closed positions rather than sitting in the holdings table as three
 * zeros — dropping them silently would hide that the symbol was held at all.
 * Matched textually, like every other decimal here: anything unrecognisable
 * stays a holding, because showing a row that should not be there is the
 * kinder failure.
 */
const ZERO = /^-?0+(?:\.0+)?$/;
const isClosed = (position: Position): boolean => ZERO.test(quantity(position));

const positionKey = (position: Position, index: number): string =>
  String(position.symbol ?? index);

/**
 * The realized column. Gains and losses take the quote panel's up/down
 * colours; zero is left plain. A symbol the fold could not account for
 * (`realized.unavailable`) shows a dash and says why to assistive tech —
 * silently showing `0` for it would read as "nothing sold".
 */
function RealizedCell({
  symbol,
  realized,
}: {
  symbol: string;
  realized: RealizedPnlSummary | undefined;
}) {
  const { t } = useTranslation();
  const entry = realized?.bySymbol.get(symbol);
  if (entry === undefined)
    return <td aria-label={t('positions.realizedUnavailable')}>—</td>;
  const { text, tone } = formatRealizedPnl(entry);
  return (
    <td>
      <span className={tone}>{text}</span>
    </td>
  );
}

export function PositionsTable({
  positions = [],
  realized,
}: {
  positions?: readonly Position[];
  realized?: RealizedPnlSummary;
}) {
  const { t } = useTranslation();
  const held = positions.filter((position) => !isClosed(position));
  const closed = positions.filter(isClosed);
  return (
    <>
      <section className="panel panel-wide" aria-labelledby="positions-title">
        <h2 id="positions-title">{t('positions.title')}</h2>
        {held.length === 0 ? (
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
                <th>{t('positions.realized')}</th>
              </tr>
            </thead>
            <tbody>
              {held.map((position, index) => (
                <tr key={positionKey(position, index)}>
                  <td>{String(position.symbol ?? '')}</td>
                  <td>{cell(position.available, '0')}</td>
                  <td>{cell(position.reserved, '0')}</td>
                  <td>{cell(position.total ?? position.quantity, '0')}</td>
                  <td>{money(position.averageCost)}</td>
                  <RealizedCell
                    symbol={String(position.symbol ?? '')}
                    realized={realized}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {closed.length > 0 && (
        <section
          className="panel panel-wide"
          aria-labelledby="closed-positions-title"
        >
          <h2 id="closed-positions-title">{t('positions.closedTitle')}</h2>
          <table>
            <caption className="sr-only">
              {t('positions.closedCaption')}
            </caption>
            <thead>
              <tr>
                <th>{t('positions.symbol')}</th>
                <th>{t('positions.closedAvgCost')}</th>
                <th>{t('positions.realized')}</th>
              </tr>
            </thead>
            <tbody>
              {closed.map((position, index) => (
                <tr key={positionKey(position, index)}>
                  <td>{String(position.symbol ?? '')}</td>
                  <td>{money(position.averageCost)}</td>
                  <RealizedCell
                    symbol={String(position.symbol ?? '')}
                    realized={realized}
                  />
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
