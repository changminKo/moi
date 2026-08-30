/**
 * The API states every instant in UTC (`2026-08-30T07:49:08.683Z`) because the
 * ledger is zone-free. A reader is not: the same instant has to read as the
 * wall clock they trade against, in the language they picked. This turns the
 * wire value into that, and nothing else — the raw ISO string stays available
 * to callers for `<time dateTime>`.
 */
export function formatTimestamp(
  iso: string,
  locale: string,
  timeZone?: string,
): string {
  const at = new Date(iso);
  // A malformed timestamp must not blank the panel it sits in: a quote is
  // still worth reading when only its clock is wrong, so show the raw value.
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}
