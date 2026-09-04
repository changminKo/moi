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
  /**
   * Receives `calendar.decode_failed` when the provider call or its decoding
   * fails. Without it the failure is invisible: the session route answers 503
   * from an empty `catch`, the admission gate drops the error, and the custom
   * Fastify error handler replaces the framework's own logging (#122).
   */
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
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
      let day: Awaited<ReturnType<MarketCalendarSource['getCalendarDay']>>;
      try {
        day = await source.getCalendarDay(
          market,
          tradingDate,
          AbortSignal.timeout(timeoutMs),
        );
      } catch (error) {
        // The reason, never the answer: a provider body could carry anything.
        options.log?.('calendar.decode_failed', {
          market,
          tradingDate,
          reason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
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
