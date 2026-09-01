/**
 * The reporter's message budget.
 *
 * A strategy that decides on every tick would, wired carelessly, emit a
 * message per tick: Discord rate-limits the webhook and the operator stops
 * reading the channel. This module is the policy that prevents both, and it is
 * pure — `admit` takes the clock as an argument — so the policy is testable
 * without waiting.
 *
 * Three mechanisms, in the order they apply:
 *
 *   1. **Aggregation.** Every event carries a key (the event kind by default).
 *      A repeat of a key inside `aggregationWindowMs` is counted, not posted,
 *      and the count rides along on that key's next post. This is what turns a
 *      per-tick decision stream into one message a minute with `+N more`.
 *   2. **A token bucket.** `capacity` tokens, one refilled every
 *      `refillIntervalMs` — a burst of 5 and a sustained 5/min, an order of
 *      magnitude under the ~30 messages/minute Discord allows a channel
 *      webhook, so the runner never has to learn about a 429.
 *   3. **A reserve.** `info` and `ok` may only spend a token while more than
 *      `reservedForAlerts` remain, so a flood of routine traffic can never
 *      starve the `warn` that reports a session swap or the `fail` that
 *      reports a kill switch with residual orders.
 *
 * Nothing vanishes unaccounted for: `info`/`ok` past the reserve are dropped
 * and counted, `warn`/`fail` are deferred until a token exists, and the next
 * post carries both counts.
 */
import type { ReportLevel } from './events.js';

export interface RateLimitOptions {
  readonly capacity: number;
  readonly refillIntervalMs: number;
  readonly reservedForAlerts: number;
  readonly aggregationWindowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  capacity: 5,
  refillIntervalMs: 12_000,
  reservedForAlerts: 2,
  aggregationWindowMs: 60_000,
};

export interface RateLimitRequest {
  readonly level: ReportLevel;
  readonly key: string;
}

export type RateLimitVerdict =
  /** Post it, and say how much was folded into it. */
  | {
      readonly kind: 'post';
      readonly suppressed: number;
      readonly dropped: number;
    }
  /** A repeat inside the window: counted onto this key's next post. */
  | { readonly kind: 'suppress' }
  /** Routine traffic past the alert reserve: counted, not kept. */
  | { readonly kind: 'drop' }
  /** An alert with no token yet: the caller must retry it later. */
  | { readonly kind: 'defer' };

export interface RateLimiter {
  admit(request: RateLimitRequest, now: number): RateLimitVerdict;
}

/**
 * The levels that get the reserved tokens and are never dropped to make room
 * for routine traffic. Exported so the reporter's queue policy asks the same
 * question this one does, rather than restating the answer.
 */
export const ALERT_LEVELS: ReadonlySet<ReportLevel> = new Set(['warn', 'fail']);

export function createRateLimiter(
  options: Partial<RateLimitOptions> = {},
): RateLimiter {
  const { capacity, refillIntervalMs, reservedForAlerts, aggregationWindowMs } =
    { ...DEFAULT_RATE_LIMIT, ...options };

  let tokens = capacity;
  let lastRefillAt: number | undefined;
  let dropped = 0;
  const lastPostAt = new Map<string, number>();
  const suppressedByKey = new Map<string, number>();

  const refill = (now: number): void => {
    if (lastRefillAt === undefined) {
      lastRefillAt = now;
      return;
    }
    const gained = Math.floor((now - lastRefillAt) / refillIntervalMs);
    if (gained <= 0) return;
    tokens = Math.min(capacity, tokens + gained);
    lastRefillAt += gained * refillIntervalMs;
  };

  return {
    admit({ level, key }, now) {
      const previous = lastPostAt.get(key);
      if (previous !== undefined && now - previous < aggregationWindowMs) {
        suppressedByKey.set(key, (suppressedByKey.get(key) ?? 0) + 1);
        return { kind: 'suppress' };
      }

      refill(now);
      const isAlert = ALERT_LEVELS.has(level);
      const floor = isAlert ? 0 : reservedForAlerts;
      if (tokens <= floor) {
        if (isAlert) return { kind: 'defer' };
        dropped += 1;
        return { kind: 'drop' };
      }

      tokens -= 1;
      lastPostAt.set(key, now);
      const suppressed = suppressedByKey.get(key) ?? 0;
      suppressedByKey.delete(key);
      const carried = dropped;
      dropped = 0;
      return { kind: 'post', suppressed, dropped: carried };
    },
  };
}
