import type { FastifyInstance } from 'fastify';
import { fxQuoteSchema } from './fx-schemas.js';
import type { FxService } from './fx-service.js';
export async function registerFxRoutes(
  app: FastifyInstance,
  service: FxService,
): Promise<void> {
  app.post('/api/v1/fx/quotes', async (request, reply) => {
    const parsed = fxQuoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: parsed.error.message,
        retryable: false,
        requestId: request.id,
      });
    }
    const sessionId = String(request.headers['x-session-id'] ?? 'anonymous');
    return service.quote(sessionId, parsed.data);
  });
  app.post('/api/v1/fx/conversions', async (request, reply) => {
    const body = request.body as { quoteId?: string };
    if (!body.quoteId) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'quoteId is required',
        retryable: false,
        requestId: request.id,
      });
    }
    const sessionId = String(request.headers['x-session-id'] ?? 'anonymous');
    const key = String(request.headers['idempotency-key'] ?? '');
    if (!key) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Idempotency-Key is required',
        retryable: false,
        requestId: request.id,
      });
    }
    return service.exchange(sessionId, body.quoteId, key);
  });
}
