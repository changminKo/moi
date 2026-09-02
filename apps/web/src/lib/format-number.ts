import Decimal from 'decimal.js';

/**
 * Display-only formatting for decimal strings coming from the API.
 * Never converts to a JS number: the integer part is grouped textually and
 * the fraction is kept verbatim. Anything that is not a plain decimal
 * (empty string, "—", labels) passes through unchanged.
 */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** True when the string is a plain decimal this module can format. */
export function isDecimal(value: string): boolean {
  return DECIMAL.test(value);
}

export function formatDecimal(value: string): string {
  const match = DECIMAL.exec(value);
  if (!match) return value;
  const [, sign, whole, fraction] = match;
  const grouped = (whole ?? '').replace(GROUP, ',');
  return fraction === undefined
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${fraction}`;
}

/**
 * The one render cap every money column shares — wallet balances, the FX
 * ticket, the order ticket's estimate, average cost, realized P&L. The values
 * behind them are exact (ten-place quotients, eighty-digit sums); only what is
 * drawn is shortened, and it is shortened the same everywhere.
 */
export const MONEY_DISPLAY_FRACTION_DIGITS = 2;

/**
 * Rounds the fraction to at most `maxDigits` places without padding a
 * shorter fraction out to that length — "233.3" stays "233.3", only
 * "233.3331" becomes "233.33". This is a render-boundary cap: the value it
 * returns is for display only, never for what gets submitted or computed
 * elsewhere. Anything that is not a plain decimal passes through unchanged,
 * the same contract `formatDecimal` uses.
 */
export function capFractionDigits(value: string, maxDigits: number): string {
  if (!isDecimal(value)) return value;
  return new Decimal(value).toDecimalPlaces(maxDigits).toString();
}

/**
 * True when the string is a plain decimal worth nothing — "0", "0.00" and
 * "-0" alike. Guarded by `isDecimal` first, so anything the module cannot
 * parse answers false rather than throwing: a value this cannot read is not
 * something to claim is zero.
 */
export function isZeroDecimal(value: string): boolean {
  return isDecimal(value) && new Decimal(value).isZero();
}

/**
 * The same grouping applied to a value that is still being typed: the integer
 * part may be empty and the fraction may be absent right after the point, so
 * `1234.` groups to `1,234.` instead of failing the completed-number pattern.
 * Anything else — a lone sign, a second point, letters — is returned verbatim
 * so validation, not the formatter, decides what a bad value means.
 */
const PARTIAL_DECIMAL = /^(-?)(\d*)(\.\d*)?$/;

export function formatDecimalInput(value: string): string {
  const match = PARTIAL_DECIMAL.exec(value);
  if (!match) return value;
  const [, sign, whole, fraction] = match;
  const grouped = (whole ?? '').replace(GROUP, ',');
  return `${sign}${grouped}${fraction ?? ''}`;
}

/** The plain decimal string behind a grouped display value. */
export function stripGrouping(value: string): string {
  return value.replaceAll(',', '');
}

/**
 * Caret arithmetic for a grouped input. The caret is anchored to the number of
 * characters that carry meaning (everything except the separators) rather than
 * to a raw offset, so inserting or removing a separator elsewhere in the string
 * cannot move it: count them on the value the browser just produced, then find
 * the offset in the reformatted value that has the same count to its left.
 */
export function significantBefore(display: string, caret: number): number {
  let seen = 0;
  for (let i = 0; i < caret && i < display.length; i += 1)
    if (display[i] !== ',') seen += 1;
  return seen;
}

export function caretForSignificant(
  formatted: string,
  significant: number,
): number {
  if (significant <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < formatted.length; i += 1) {
    if (formatted[i] !== ',') seen += 1;
    if (seen === significant) return i + 1;
  }
  return formatted.length;
}
