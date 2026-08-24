import type { Market } from '@skipjack/trading-core';
export interface MarketCalendar {
  readonly market: Market;
  readonly session: 'REGULAR' | 'CLOSED';
  readonly asOf: string;
  readonly source: string;
}
export interface MarketCalendarPort {
  get(market: Market): Promise<MarketCalendar>;
}
export class MarketCalendarService {
  #cache = new Map<Market, MarketCalendar>();
  constructor(readonly port: MarketCalendarPort) {}
  async get(market: Market): Promise<MarketCalendar> {
    const cached = this.#cache.get(market);
    if (cached) return cached;
    const value = await this.port.get(market);
    this.#cache.set(market, value);
    return value;
  }
  clear(market?: Market): void {
    market ? this.#cache.delete(market) : this.#cache.clear();
  }
}
