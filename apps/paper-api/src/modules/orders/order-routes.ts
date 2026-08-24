import type { FastifyInstance } from 'fastify';
import { DomainError } from '@skipjack/trading-core';
import { canonicalRequestHash } from './canonical-request.js';
import { IdempotencyService, type StoredHttpResponse } from './idempotency-service.js';
import { amendOrderSchema, placeOrderSchema } from './order-schemas.js';
import { OrderService } from './order-service.js';
export interface OrderRouteDependencies {
  readonly principal: (request: unknown) => Promise<{ id: string; status?: string }>;
  readonly execute?: ((command: { action: 'place' | 'amend' | 'cancel'; sessionId: string; orderId?: string; input?: unknown }) => Promise<unknown>) | undefined;
  readonly capabilities?: ((sessionId: string, market: 'KR' | 'US', symbol: string) => ReadonlySet<string> | Record<string, boolean>) | undefined;
  readonly service?: OrderService;
  readonly idempotency?: IdempotencyService;
}
const headers = (request: any): Record<string, string> => ({ 'content-type': 'application/json', ...(request.headers['idempotency-key'] ? { 'idempotency-key': String(request.headers['idempotency-key']) } : {}) });
export async function registerOrderRoutes(app: FastifyInstance, deps: OrderRouteDependencies): Promise<void> {
  const idem = deps.idempotency ?? new IdempotencyService();
  const service = deps.service ?? new OrderService({ execute: deps.execute, capabilities: deps.capabilities });
  async function run(request: any, action: 'place' | 'amend' | 'cancel', orderId?: string): Promise<StoredHttpResponse> {
    const principal = await deps.principal(request);
    if (principal.status && principal.status !== 'ACTIVE') throw Object.assign(new Error('session expired'), { statusCode: 401, code: 'SESSION_EXPIRED' });
    const key = String(request.headers['idempotency-key'] ?? '');
    if (!key) return { statusCode: 400, headers: {}, body: JSON.stringify({ code: 'VALIDATION_ERROR', message: 'Idempotency-Key is required', retryable: false, requestId: request.id }) };
    const input = request.body ?? {};
    const parsed = action === 'place' ? placeOrderSchema.safeParse(input) : action === 'amend' ? amendOrderSchema.safeParse(input) : { success: true as const, data: {} };
    if (!parsed.success) return { statusCode: 400, headers: {}, body: JSON.stringify({ code: 'VALIDATION_ERROR', message: parsed.error.message, retryable: false, requestId: request.id }) };
    try {
      return await idem.execute(principal.id, key, canonicalRequestHash(input), async () => {
      try {
        const body = action === 'place' ? await service.place(principal.id, parsed.data as any) : action === 'amend' ? await service.amend(principal.id, orderId!, parsed.data as any) : await service.cancel(principal.id, orderId!);
        return { statusCode: action === 'place' ? 201 : 200, headers: headers(request), body: JSON.stringify(body) };
      } catch (error) {
        if (error instanceof DomainError) return { statusCode: error.code === 'MARKET_CLOSED' || error.code === 'CANCEL_ONLY' ? 409 : 400, headers: {}, body: JSON.stringify({ code: error.code, message: error.message, retryable: error.retryable, requestId: request.id }) };
        throw error;
      }
      });
    } catch (error) {
      if (error instanceof DomainError) return { statusCode: error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400, headers: {}, body: JSON.stringify({ code: error.code, message: error.message, retryable: error.retryable, requestId: request.id }) };
      throw error;
    }
  }
  const send = (reply: any, response: StoredHttpResponse) => { reply.code(response.statusCode); for (const [key, value] of Object.entries(response.headers)) reply.header(key, value); return reply.send(response.body); };
  app.post('/api/v1/orders', async (request, reply) => send(reply, await run(request, 'place')));
  app.patch('/api/v1/orders/:id', async (request, reply) => send(reply, await run(request, 'amend', (request.params as any).id)));
  app.delete('/api/v1/orders/:id', async (request, reply) => send(reply, await run(request, 'cancel', (request.params as any).id)));
}
