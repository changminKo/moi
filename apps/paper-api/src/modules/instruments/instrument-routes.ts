import type { FastifyInstance } from 'fastify';
import type { InstrumentService } from './instrument-service.js';
export async function registerInstrumentRoutes(
  app: FastifyInstance,
  service: InstrumentService,
  quote?: (market: 'KR' | 'US', symbol: string) => Promise<unknown> | unknown,
): Promise<void> {
  app.get('/api/v1/instruments', async (request) => {
    const query = request.query as { q?: string; market?: 'KR' | 'US' };
    return (await service.search(query.q, query.market)).items;
  });
  app.get('/api/v1/instruments/:market/:symbol', async (request, reply) => {
    const p = request.params as { market: 'KR' | 'US'; symbol: string };
    const item = await service.detail(p.market, p.symbol);
    if (!item) {
      return reply.code(404).send({
        code: 'NOT_FOUND',
        message: 'Instrument not found',
        retryable: false,
        requestId: request.id,
      });
    }
    return item;
  });
  app.get('/api/v1/markets/:market/symbols/:symbol/quote', async (request) => {
    const params = request.params as { market: 'KR' | 'US'; symbol: string };
    return (
      quote?.(params.market, params.symbol) ?? {
        market: params.market,
        symbol: params.symbol,
        price: null,
        asOf: new Date().toISOString(),
      }
    );
  });
}
