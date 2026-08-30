import type { MarketCalendarSource } from '@moi/market-data';
import type { Market } from '@moi/trading-core';
import type {
  MarketCalendarFacts,
  MarketCalendarPort,
} from './market-calendar-service.js';
import { derivePhase, tradingDateFor } from './market-session.js';

export interface CalendarPortOptions {
  readonly now?: () => Date;
  /** Budget for one provider calendar call. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Adapts a provider `MarketCalendarSource` to the calendar port the service
 * caches. The trading date is the market's own calendar date, never the UTC
 * one — asking Toss for the UTC date would fetch yesterday's KR calendar every
 * evening in Seoul.
 */
export function calendarPortFromSource(
  source: MarketCalendarSource,
  options: CalendarPortOptions = {},
): MarketCalendarPort {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async get(market: Market): Promise<MarketCalendarFacts> {
      const at = now();
      const tradingDate = tradingDateFor(market, at);
      const day = await source.getCalendarDay(
        market,
        tradingDate,
        AbortSignal.timeout(timeoutMs),
      );
      const opensAt = day.regularSession?.opensAt ?? null;
      const closesAt = day.regularSession?.closesAt ?? null;
      const phase = derivePhase(
        { isTradingDay: day.isTradingDay, opensAt, closesAt },
        at,
      );
      return {
        market,
        session: phase === 'REGULAR' ? 'REGULAR' : 'CLOSED',
        asOf: at.toISOString(),
        source: 'provider-calendar',
        tradingDate: day.tradingDate,
        isTradingDay: day.isTradingDay,
        opensAt,
        closesAt,
      };
    },
  };
}
