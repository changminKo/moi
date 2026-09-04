import type { Market } from '@moi/trading-core';
import { derivePhase, type MarketPhase } from './market-session.js';

/**
 * What a calendar port reports for one market. `session` is the legacy field
 * the order service gates MARKET orders on; the window fields are optional so
 * a port that only knows open/closed keeps working unchanged.
 */
export interface MarketCalendarFacts {
  readonly market: Market;
  readonly session: 'REGULAR' | 'CLOSED';
  readonly asOf: string;
  readonly source: string;
  readonly tradingDate?: string;
  readonly isTradingDay?: boolean;
  readonly opensAt?: string | null;
  readonly closesAt?: string | null;
}

/** Facts plus the phase derived for the instant of the call. */
export type MarketCalendar = MarketCalendarFacts & {
  readonly phase: MarketPhase;
};

export interface MarketCalendarPort {
  get(market: Market): Promise<MarketCalendarFacts>;
}

export interface MarketCalendarServiceOptions {
  readonly now?: () => Date;
  /** How long a fetched day is reused before the port is asked again. */
  readonly ttlMs?: number;
  /** How long a failed fetch is remembered before the port is tried again. */
  readonly failureTtlMs?: number;
}

/** Five minutes: short enough to pick up a date rollover, long enough to
 * keep the order-placement path off the provider. */
const DEFAULT_TTL_MS = 300_000;

/**
 * Fifteen seconds. A failure is cached too, or a provider that answers a shape
 * the decoder rejects would draw one fresh call per session request and per
 * MARKET order — straight into the provider's `MARKET_INFO` rate limit. Short
 * enough that a recovered provider is picked up almost at once (#122).
 */
const DEFAULT_FAILURE_TTL_MS = 15_000;

interface CacheEntry {
  readonly facts: MarketCalendarFacts;
  readonly fetchedAt: number;
}

interface FailureEntry {
  readonly error: unknown;
  readonly failedAt: number;
}

export class MarketCalendarService {
  #cache = new Map<Market, CacheEntry>();
  #failures = new Map<Market, FailureEntry>();
  #inFlight = new Map<Market, Promise<MarketCalendarFacts>>();
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #failureTtlMs: number;

  constructor(
    readonly port: MarketCalendarPort,
    options: MarketCalendarServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  }

  async get(market: Market): Promise<MarketCalendar> {
    const now = this.#now();
    const facts = await this.#facts(market, now);
    return decorate(facts, now);
  }

  async #facts(market: Market, now: Date): Promise<MarketCalendarFacts> {
    const cached = this.#cache.get(market);
    if (cached && now.getTime() - cached.fetchedAt < this.#ttlMs)
      return cached.facts;
    // A recent failure is answered from memory with the same error, so a
    // provider the decoder cannot read is asked once per failure window rather
    // than once per request.
    const failed = this.#failures.get(market);
    if (failed && now.getTime() - failed.failedAt < this.#failureTtlMs)
      throw failed.error;
    // Collapse a stampede: concurrent misses share one provider call.
    const pending = this.#inFlight.get(market);
    if (pending) return pending;
    const request = this.port
      .get(market)
      .then((facts) => {
        this.#cache.set(market, { facts, fetchedAt: this.#now().getTime() });
        this.#failures.delete(market);
        return facts;
      })
      .catch((error: unknown) => {
        this.#failures.set(market, {
          error,
          failedAt: this.#now().getTime(),
        });
        throw error;
      })
      .finally(() => {
        this.#inFlight.delete(market);
      });
    this.#inFlight.set(market, request);
    return request;
  }

  clear(market?: Market): void {
    if (market) {
      this.#cache.delete(market);
      this.#failures.delete(market);
      return;
    }
    this.#cache.clear();
    this.#failures.clear();
  }
}

/**
 * Adds the phase for `now`. When the port supplied a session window the phase
 * (and the legacy `session`) is recomputed per call, so a cached day can never
 * pin a stale answer across an open or a close.
 */
function decorate(facts: MarketCalendarFacts, now: Date): MarketCalendar {
  if (facts.isTradingDay === undefined)
    return {
      ...facts,
      phase: facts.session === 'REGULAR' ? 'REGULAR' : 'CLOSED',
    };
  const phase = derivePhase(
    {
      isTradingDay: facts.isTradingDay,
      opensAt: facts.opensAt ?? null,
      closesAt: facts.closesAt ?? null,
    },
    now,
  );
  return {
    ...facts,
    phase,
    session: phase === 'REGULAR' ? 'REGULAR' : 'CLOSED',
  };
}
