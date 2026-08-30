import type { Market } from '@moi/trading-core';
import type { MarketCalendarDay, MarketCalendarSource } from './ports.js';

export interface FakeCalendarSourceOptions {
  /**
   * Day returned for a date nothing was seeded for. The default makes every
   * date a trading day whose regular session spans the whole UTC day, so a
   * fake bundle never blocks paper trading on a calendar the fake cannot know.
   */
  readonly defaultTradingDay?: boolean;
}

/**
 * Deterministic calendar for the `fake` provider bundle and for tests: seeded
 * days are returned verbatim, everything else follows the documented default.
 * Nothing here contacts a provider.
 */
export class FakeCalendarSource implements MarketCalendarSource {
  readonly #days = new Map<string, MarketCalendarDay>();
  readonly #defaultTradingDay: boolean;
  #calls = 0;

  constructor(options: FakeCalendarSourceOptions = {}) {
    this.#defaultTradingDay = options.defaultTradingDay ?? true;
  }

  get calls(): number {
    return this.#calls;
  }

  seed(day: MarketCalendarDay): void {
    this.#days.set(`${day.market}:${day.tradingDate}`, day);
  }

  async getCalendarDay(
    market: Market,
    tradingDate: string,
    _signal: AbortSignal,
  ): Promise<MarketCalendarDay> {
    this.#calls += 1;
    const seeded = this.#days.get(`${market}:${tradingDate}`);
    if (seeded) return seeded;
    return {
      market,
      tradingDate,
      isTradingDay: this.#defaultTradingDay,
      regularSession: this.#defaultTradingDay
        ? {
            opensAt: `${tradingDate}T00:00:00.000Z`,
            closesAt: `${tradingDate}T23:59:59.999Z`,
          }
        : null,
    };
  }
}
