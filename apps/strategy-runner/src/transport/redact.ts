/**
 * Masks the four secret shapes design §7.4 names, for anything the runner
 * writes to a log, a report, or its own state.
 *
 * `Idempotency-Key` is on that list even though the runner's key is a hash of a
 * `decisionId` and not a secret. It is masked anyway, because the list is the
 * contract and because nothing is lost: the decision log holds the `decisionId`
 * itself, so an operator correlating a submission with a decision reads it
 * there rather than out of a log line.
 *
 * These are patterns over text, applied at the boundary where text is produced.
 * They are the last line rather than the first — the runner does not put a
 * cookie in a message in the first place — but a masker that only runs where
 * someone remembered to call it is not a masker, so the reporter applies it to
 * every line unconditionally.
 */
const RULES: readonly (readonly [RegExp, string])[] = Object.freeze([
  // Order matters: `Set-Cookie` carries a `moi_session=` inside it, and masking
  // the whole header value is stronger than masking the cookie within it.
  [/(set-cookie\s*:\s*)[^\n]*/giu, '$1[redacted]'],
  [/(moi_session=)[^\s;"'\\]+/giu, '$1[redacted]'],
  [/(x-csrf-token\s*:\s*)[^\s;,"'\\]+/giu, '$1[redacted]'],
  [/(idempotency-key\s*:\s*)[^\s;,"'\\]+/giu, '$1[redacted]'],
]);

export function redact(text: string): string {
  return RULES.reduce(
    (masked, [pattern, replacement]) => masked.replace(pattern, replacement),
    text,
  );
}
