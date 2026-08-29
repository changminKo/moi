/**
 * Display-only formatting for decimal strings coming from the API.
 * Never converts to a JS number: the integer part is grouped textually and
 * the fraction is kept verbatim. Anything that is not a plain decimal
 * (empty string, "—", labels) passes through unchanged.
 */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const GROUP = /\B(?=(\d{3})+(?!\d))/g;

export function formatDecimal(value: string): string {
  const match = DECIMAL.exec(value);
  if (!match) return value;
  const [, sign, whole, fraction] = match;
  const grouped = (whole ?? '').replace(GROUP, ',');
  return fraction === undefined
    ? `${sign}${grouped}`
    : `${sign}${grouped}.${fraction}`;
}
