import { DomainError } from '@skipjack/trading-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { httpStatusFor } from '../../plugins/error-handler.js';
import { canonicalRequestHash } from './canonical-request.js';
import {
  IdempotencyService,
  type StoredHttpResponse,
} from './idempotency-service.js';
import { amendOrderSchema, placeOrderSchema } from './order-schemas.js';
import { OrderService } from './order-service.js';

type OrderAction = 'place' | 'amend' | 'cancel';

export interface OrderRouteDependencies {
  readonly principal: (
    request: unknown,
  ) => Promise<{ id: string; status?: string }>;
  readonly execute?:
    | ((command: {
        action: OrderAction;
        sessionId: string;
        orderId?: string;
        input?: unknown;
      }) => Promise<unknown>)
    | undefined;
  readonly capabilities?:
    | ((
        sessionId: string,
        market: 'KR' | 'US',
        symbol: string,
      ) => ReadonlySet<string> | Record<string, boolean>)
    | undefined;
  readonly service?: OrderService;
  readonly idempotency?: IdempotencyService;
}

const responseHeaders = (request: FastifyRequest): Record<string, string> => ({
  'content-type': 'application/json',
  ...(request.headers['idempotency-key']
    ? { 'idempotency-key': String(request.headers['idempotency-key']) }
    : {}),
});

const validationFailure = (
  requestId: string,
  message: string,
): StoredHttpResponse => ({
  statusCode: 400,
  headers: {},
  body: JSON.stringify({
    code: 'VALIDATION_ERROR',
    message,
    retryable: false,
    requestId,
  }),
});

function requiredOrderId(orderId: string | undefined): string {
  if (orderId === undefined) {
    throw new DomainError('INVARIANT_VIOLATION', 'order id is required');
  }
  return orderId;
}

export async function registerOrderRoutes(
  app: FastifyInstance,
  deps: OrderRouteDependencies,
): Promise<void> {
  const idem = deps.idempotency ?? new IdempotencyService();
  const service =
    deps.service ??
    new OrderService({
      execute: deps.execute,
      capabilities: deps.capabilities,
    });

  async function run(
    request: FastifyRequest,
    action: OrderAction,
    orderId?: string,
  ): Promise<StoredHttpResponse> {
    const principal = await deps.principal(request);
    if (principal.status && principal.status !== 'ACTIVE') {
      throw Object.assign(new Error('session expired'), {
        statusCode: 401,
        code: 'SESSION_EXPIRED',
      });
    }
    const key = String(request.headers['idempotency-key'] ?? '');
    if (!key) {
      return validationFailure(request.id, 'Idempotency-Key is required');
    }
    const input = request.body ?? {};
    const requestHash = canonicalRequestHash(input);
    let execute: () => Promise<unknown>;
    if (action === 'place') {
      const parsed = placeOrderSchema.safeParse(input);
      if (!parsed.success) {
        return validationFailure(request.id, parsed.error.message);
      }
      execute = () =>
        service.place(principal.id, parsed.data, {
          idempotencyKey: key,
          requestHash,
        });
    } else if (action === 'amend') {
      const parsed = amendOrderSchema.safeParse(input);
      if (!parsed.success) {
        return validationFailure(request.id, parsed.error.message);
      }
      execute = () =>
        service.amend(principal.id, requiredOrderId(orderId), parsed.data);
    } else {
      execute = () => service.cancel(principal.id, requiredOrderId(orderId));
    }

    try {
      return await idem.execute(principal.id, key, requestHash, async () => {
        try {
          const body = await execute();
          return {
            statusCode: action === 'place' ? 201 : 200,
            headers: responseHeaders(request),
            body: JSON.stringify(body),
          };
        } catch (error) {
          if (error instanceof DomainError) {
            return {
              statusCode: httpStatusFor(error.code),
              headers: {},
              body: JSON.stringify({
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                requestId: request.id,
              }),
            };
          }
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof DomainError) {
        return {
          statusCode: httpStatusFor(error.code),
          headers: {},
          body: JSON.stringify({
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            requestId: request.id,
          }),
        };
      }
      throw error;
    }
  }

  const send = (reply: FastifyReply, response: StoredHttpResponse) => {
    reply.code(response.statusCode);
    for (const [key, value] of Object.entries(response.headers)) {
      reply.header(key, value);
    }
    return reply.send(response.body);
  };
  app.post('/api/v1/orders', async (request, reply) =>
    send(reply, await run(request, 'place')),
  );
  app.patch<{ Params: { id: string } }>(
    '/api/v1/orders/:id',
    async (request, reply) =>
      send(reply, await run(request, 'amend', request.params.id)),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/v1/orders/:id',
    async (request, reply) =>
      send(reply, await run(request, 'cancel', request.params.id)),
  );
}
