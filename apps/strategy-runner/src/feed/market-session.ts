import type { Market } from '@moi/trading-core';
import type { PaperApiClient } from '../transport/paper-api-client.js';

/**
 * `GET /api/v1/markets/:m/session` (design §5.1, added by #31), cached for 60
 * seconds as §5.1 specifies. It is public reference data with a
 * `Cache-Control: public, max-age=60`, so the cache mirrors what the endpoint
 * already asks clients to do rather than inventing a policy.
 *
 * A phase this cannot determine is reported as `null`, never guessed. The
 * endpoint itself answers 503 rather than inventing one when the calendar is
 * unavailable, for the same reason: a wrong phase would either open trading
 * outside market hours or close it during them, and the caller is better placed
 * to decide which way to fail than a default here would be. `RiskGate` fails
 * closed on `null`.
 */

export const MARKET_SESSION_TTL_MS = 60_000;

export interface MarketSessionCacheOptions {
  readonly api: PaperApiClient;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

interface Entry {
  readonly phase: string;
  readonly atMs: number;
}

export class MarketSessionCache {
  readonly #api: PaperApiClient;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #entries = new Map<Market, Entry>();

  constructor(options: MarketSessionCacheOptions) {
    this.#api = options.api;
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? MARKET_SESSION_TTL_MS;
  }

  /** The market's phase, or `null` when it could not be determined. */
  async phase(market: Market): Promise<string | null> {
    const at = this.#now();
    const cached = this.#entries.get(market);

    if (cached !== undefined && at - cached.atMs < this.#ttlMs) {
      return cached.phase;
    }

    let phase: unknown;

    try {
      const response = await this.#api.send({
        method: 'GET',
        path: `/api/v1/markets/${encodeURIComponent(market)}/session`,
        authenticated: false,
      });

      if (response.status !== 200) {
        return null;
      }

      phase = (response.body as { phase?: unknown } | undefined)?.phase;
    } catch {
      return null;
    }

    if (typeof phase !== 'string' || phase.length === 0) {
      return null;
    }

    // Only a good answer refreshes the cache. A failed lookup leaves the
    // previous entry to expire on its own schedule rather than replacing a known
    // phase with an unknown one.
    this.#entries.set(market, { phase, atMs: at });

    return phase;
  }
}
