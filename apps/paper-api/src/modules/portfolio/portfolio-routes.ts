import type { FastifyInstance } from 'fastify';
import { fillsQuerySchema } from './fill-schemas.js';
import { portfolioQuerySchema } from './portfolio-schemas.js';
import {
  createPortfolioService,
  PortfolioService,
  type PortfolioUnitOfWork,
} from './portfolio-service.js';

export interface PortfolioRouteDependencies {
  readonly principal: (
    request: unknown,
  ) => Promise<{ readonly id: string; readonly status?: string }>;
  readonly service?: PortfolioService;
  readonly unitOfWork?: PortfolioUnitOfWork;
}

export async function registerPortfolioRoutes(
  app: FastifyInstance,
  dependencies: PortfolioRouteDependencies,
): Promise<void> {
  const service =
    dependencies.service ??
    (dependencies.unitOfWork
      ? createPortfolioService(dependencies.unitOfWork)
      : new PortfolioService());
  async function session(request: unknown): Promise<string> {
    const principal = await dependencies.principal(request);
    if (principal.status !== undefined && principal.status !== 'ACTIVE')
      throw Object.assign(new Error('session expired'), {
        statusCode: 401,
        code: 'SESSION_EXPIRED',
      });
    return principal.id;
  }
  app.get('/api/v1/portfolio', async (request) =>
    service.snapshot(await session(request)),
  );
  app.get('/api/v1/orders', async (request, reply) => {
    const parsed = portfolioQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: parsed.error.message,
        retryable: false,
        requestId: request.id,
      });
    return service.listOrders(await session(request), parsed.data);
  });
  // Session-scoped catch-up for a client that was offline longer than the
  // account stream's replay window keeps events. `no-store`, because it is one
  // session's own ledger history and a shared cache must never hold it.
  app.get('/api/v1/fills', async (request, reply) => {
    const parsed = fillsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: parsed.error.message,
        retryable: false,
        requestId: request.id,
      });
    const sessionId = await session(request);
    void reply.header('Cache-Control', 'private, no-store');
    return service.listFills(sessionId, parsed.data);
  });
  app.get('/api/v1/orders/:id', async (request, reply) => {
    const order = await service.getOrder(
      await session(request),
      String((request.params as { id: string }).id),
    );
    if (order === undefined)
      return reply.code(404).send({
        code: 'NOT_FOUND',
        message: 'order not found',
        retryable: false,
        requestId: request.id,
      });
    return order;
  });
}
