import type { FastifyInstance } from 'fastify';
import type { InstrumentService } from './instrument-service.js';
export async function registerInstrumentRoutes(
  app: FastifyInstance,
  service: InstrumentService,
): Promise<void> {
  app.get('/api/v1/instruments', async (request) => {
    const query = request.query as { q?: string; market?: 'KR' | 'US' };
    return service.search(query.q, query.market);
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
  app.get('/api/v1/markets/:market/symbols/:symbol/quote', async (request) => ({
    market: (request.params as { market: string }).market,
    symbol: (request.params as { symbol: string }).symbol,
    price: null,
    asOf: new Date().toISOString(),
  }));
}
