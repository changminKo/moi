import type { FastifyInstance } from 'fastify';
import {
  httpStatusFor,
  PUBLIC_ERROR_CODES,
} from '../../plugins/error-handler.js';
import { fxQuoteSchema } from './fx-schemas.js';
import type { FxService } from './fx-service.js';
export async function registerFxRoutes(
  app: FastifyInstance,
  service: FxService,
  dependencies: {
    readonly principal?: (request: unknown) => Promise<{ id: string }>;
    readonly canFx?: () => boolean;
  } = {},
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
    if (dependencies.canFx?.() === false)
      throw Object.assign(new Error('FX is disabled'), {
        code: 'CANCEL_ONLY',
        statusCode: 409,
      });
    const sessionId = dependencies.principal
      ? (await dependencies.principal(request)).id
      : String(request.headers['x-session-id'] ?? 'anonymous');
    const quote = await service.quote(sessionId, parsed.data);
    return {
      quoteId: quote.id,
      rate: quote.rate,
      fee: quote.fee,
      sourceAmount: quote.sourceAmount,
      destinationAmount: quote.targetAmount,
      expiresAt: quote.expiresAt,
    };
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
    if (dependencies.canFx?.() === false)
      throw Object.assign(new Error('FX is disabled'), {
        code: 'CANCEL_ONLY',
        statusCode: 409,
      });
    const sessionId = dependencies.principal
      ? (await dependencies.principal(request)).id
      : String(request.headers['x-session-id'] ?? 'anonymous');
    const key = String(request.headers['idempotency-key'] ?? '');
    if (!key) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Idempotency-Key is required',
        retryable: false,
        requestId: request.id,
      });
    }
    try {
      return await service.exchange(sessionId, body.quoteId, key);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string' && PUBLIC_ERROR_CODES.has(code))
        return reply.code(httpStatusFor(code)).send({
          code,
          message:
            error instanceof Error ? error.message : 'FX conversion failed',
          retryable: false,
          requestId: request.id,
        });
      throw error;
    }
  });
}
