import type { Market } from '@moi/trading-core';
import type { FastifyInstance } from 'fastify';
import type { MarketCalendar } from './market-calendar-service.js';

export interface MarketSessionDependencies {
  readonly calendar: { get(market: Market): Promise<MarketCalendar> };
  readonly now?: () => Date;
}

const MARKETS: ReadonlySet<string> = new Set<Market>(['KR', 'US']);

/** Public reference data: cacheable, no session and no CSRF. */
const CACHE_CONTROL = 'public, max-age=60';

/**
 * `GET /api/v1/markets/:market/session` — the market calendar the browser needs
 * to say "장 마감 · 09:00 개장" instead of a generic placeholder. Before this,
 * a client could only learn the market was closed by having an order rejected
 * with MARKET_CLOSED (§16.31).
 */
export async function registerMarketSessionRoutes(
  app: FastifyInstance,
  deps: MarketSessionDependencies,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  app.get('/api/v1/markets/:market/session', async (request, reply) => {
    const { market } = request.params as { market: string };
    reply.header('X-Request-Id', request.id);
    if (!MARKETS.has(market)) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'market must be KR or US',
        retryable: false,
        requestId: request.id,
      });
    }
    let calendar: MarketCalendar;
    try {
      calendar = await deps.calendar.get(market as Market);
    } catch {
      // The calendar is the only source of truth here; guessing a phase would
      // put a wrong "장 마감" in front of the user.
      return reply.code(503).send({
        code: 'SERVICE_UNAVAILABLE',
        message: 'market calendar is unavailable',
        retryable: true,
        requestId: request.id,
      });
    }
    reply.header('Cache-Control', CACHE_CONTROL);
    return {
      market: calendar.market,
      phase: calendar.phase,
      // A calendar that does not report the day is treated as tradable unless
      // it said otherwise; only `phase` claims a holiday.
      isTradingDay: calendar.isTradingDay ?? calendar.phase !== 'HOLIDAY',
      opensAt: calendar.opensAt ?? null,
      closesAt: calendar.closesAt ?? null,
      asOf: calendar.asOf,
      serverTime: now().toISOString(),
    };
  });
}
