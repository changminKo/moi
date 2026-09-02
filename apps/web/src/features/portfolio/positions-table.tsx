import { useTranslation } from 'react-i18next';
import {
  capFractionDigits,
  formatDecimal,
  MONEY_DISPLAY_FRACTION_DIGITS,
} from '../../lib/format-number';
import { type RealizedPnlReport, realizedKey } from './realized-pnl';
import { formatRealizedPnl } from './realized-pnl-format';

export type Position = Readonly<Record<string, unknown>>;

const cell = (value: unknown, fallback: string) =>
  formatDecimal(String(value ?? fallback));
const money = (value: unknown) =>
  formatDecimal(
    capFractionDigits(String(value ?? '—'), MONEY_DISPLAY_FRACTION_DIGITS),
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
 * colours; zero is left plain. A position the fold could not account for
 * (`realized.unavailable`) shows a dash that says so to assistive tech and
 * carries the reason as a tooltip — silently showing `0` for it would read as
 * "nothing sold". A position the fold has no row for at all (no report yet,
 * or a position the snapshot's fills do not mention) shows a bare dash.
 */
function RealizedCell({
  position,
  realized,
}: {
  position: Position;
  realized: RealizedPnlReport | undefined;
}) {
  const { t } = useTranslation();
  const key = realizedKey(
    String(position.market ?? ''),
    String(position.symbol ?? ''),
  );
  const reason = realized?.unavailable.get(key);
  if (reason !== undefined)
    return (
      <td aria-label={t('positions.realizedUnavailable')} title={reason}>
        —
      </td>
    );
  const entry = realized?.byPosition.get(key);
  if (entry === undefined) return <td>—</td>;
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
  realized?: RealizedPnlReport;
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
                  <RealizedCell position={position} realized={realized} />
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
                  <RealizedCell position={position} realized={realized} />
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
