/**
 * The reported-event shape.
 *
 * Which events exist is deliberately not enumerated here. §4.3 gives one
 * concrete case — a session swap — and §7 will add more once the kill-switch
 * barrier exists; inventing a taxonomy now would fix the wrong names in place.
 * So `kind` is a free string used for aggregation and for the footer, and
 * adding an event is one helper function next to `sessionSwapped`.
 *
 * Fields are plain strings on purpose. Everything the reporter renders goes
 * through `maskOutbound` at one choke point, and a string is the only shape
 * that pass can reason about; an arbitrary object would let a secret ride
 * along inside a value the masker never sees. Format money with the
 * `@moi/trading-core` decimal helpers before it becomes a field — never a JS
 * `number` (AGENTS.md hard rule 5).
 */

export type ReportLevel = 'info' | 'ok' | 'warn' | 'fail';

export interface ReportField {
  readonly name: string;
  readonly value: string;
}

export interface ReportEvent {
  readonly level: ReportLevel;
  /** Stable machine name, e.g. `session-swapped`. Also the default dedupe key. */
  readonly kind: string;
  readonly title: string;
  readonly description?: string;
  readonly fields?: readonly ReportField[];
  /**
   * Repeats collapse onto this key inside the aggregation window. Defaults to
   * `kind`. Give a narrower key — `${kind}:${symbol}` — when two instances of
   * the same kind deserve their own message.
   */
  readonly dedupeKey?: string;
}

/** Discord's embed colours, the same four `infra/oracle/notify.sh` posts. */
export const LEVEL_COLOURS: Readonly<Record<ReportLevel, number>> = {
  ok: 3_066_993,
  warn: 16_098_596,
  fail: 15_026_253,
  info: 5_793_266,
};

/**
 * §4.3: a session swap is reported as a `warn` and keeps the old `sessionId`,
 * because the bot can no longer cancel that session's resting orders and a
 * human has to know which session they were left in.
 */
export function sessionSwapped(input: {
  readonly previousSessionId: string;
  readonly sessionId: string;
  readonly reason: string;
}): ReportEvent {
  return {
    level: 'warn',
    kind: 'session-swapped',
    title: 'session replaced',
    description: `The runner is on a new ledger session. Orders resting on the previous session can no longer be cancelled by the bot: ${input.reason}`,
    fields: [
      { name: 'previous sessionId', value: input.previousSessionId },
      { name: 'sessionId', value: input.sessionId },
    ],
  };
}
