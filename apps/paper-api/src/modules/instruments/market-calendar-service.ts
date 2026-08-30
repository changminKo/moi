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
}

/** Five minutes: short enough to pick up a date rollover, long enough to
 * keep the order-placement path off the provider. */
const DEFAULT_TTL_MS = 300_000;

interface CacheEntry {
  readonly facts: MarketCalendarFacts;
  readonly fetchedAt: number;
}

export class MarketCalendarService {
  #cache = new Map<Market, CacheEntry>();
  #inFlight = new Map<Market, Promise<MarketCalendarFacts>>();
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(
    readonly port: MarketCalendarPort,
    options: MarketCalendarServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
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
    // Collapse a stampede: concurrent misses share one provider call.
    const pending = this.#inFlight.get(market);
    if (pending) return pending;
    const request = this.port
      .get(market)
      .then((facts) => {
        this.#cache.set(market, { facts, fetchedAt: this.#now().getTime() });
        return facts;
      })
      .finally(() => {
        this.#inFlight.delete(market);
      });
    this.#inFlight.set(market, request);
    return request;
  }

  clear(market?: Market): void {
    market ? this.#cache.delete(market) : this.#cache.clear();
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
