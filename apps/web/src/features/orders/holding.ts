import { formatDecimal, isZeroDecimal } from '../../lib/format-number';

/**
 * What the sell side of the ticket says about the instrument the reader is
 * about to sell.
 *
 * Selling blind is the problem: the quantity field starts empty and, before
 * this, nothing on the screen said how many shares there were to sell. The
 * numbers come from the position rows already in the portfolio snapshot the
 * trade page holds, so this costs no request of its own.
 *
 * Which number: `available` is the one that answers "how many can I sell
 * right now" — `total` includes shares an open order is already holding, and
 * offering it would invite a rejection. But `reserved` is named whenever
 * there is any, because otherwise the difference between what the reader owns
 * and what the ticket will accept has no visible explanation.
 */

/** A position row as the portfolio snapshot states it; validated on read. */
export type PositionRow = unknown;

/**
 * Discriminated rather than a `{ key, values }` pair: `holding.none` takes no
 * interpolation, and i18next's typed `t` will not accept a key union that
 * mixes a key with placeholders and one without. Each branch is rendered by
 * its own literal-key `t` call.
 */
export type HoldingNotice =
  | Readonly<{ key: 'holding.none' }>
  | Readonly<{
      key: 'holding.available';
      values: Readonly<{ available: string }>;
    }>
  | Readonly<{
      key: 'holding.availableReserved';
      values: Readonly<{ available: string; reserved: string }>;
    }>;

const asRecord = (
  value: unknown,
): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Nothing there, or there but worth zero. A value it cannot read is not zero. */
const nothing = (value: string | undefined): boolean =>
  value === undefined || isZeroDecimal(value);

export function findPosition(
  positions: readonly PositionRow[] | undefined,
  market: string,
  symbol: string,
): PositionRow | undefined {
  return positions?.find((entry) => {
    const row = asRecord(entry);
    return row?.market === market && row.symbol === symbol;
  });
}

export function describeHolding(position: PositionRow): HoldingNotice {
  const row = asRecord(position);
  const available = asString(row?.available);
  const reserved = asString(row?.reserved);
  if (nothing(available) && nothing(reserved)) return { key: 'holding.none' };
  const shown = formatDecimal(available ?? '0');
  return nothing(reserved)
    ? { key: 'holding.available', values: { available: shown } }
    : {
        key: 'holding.availableReserved',
        values: { available: shown, reserved: formatDecimal(reserved ?? '0') },
      };
}
