import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MetricsRegistry } from '../../observability/metrics.js';
export interface HealthDependencies {
  db: () => boolean | Promise<boolean>;
  audit: () => boolean | Promise<boolean>;
  marketData: () => unknown;
  metrics?: MetricsRegistry;
  trading?: (request: FastifyRequest) => unknown | Promise<unknown>;
  /** While draining, readiness answers 503 `{draining:true}` (§6.6-1). */
  draining?: () => boolean;
}
const headers = (reply: FastifyReply, request: FastifyRequest): void => {
  reply.header('Cache-Control', 'no-store').header('X-Request-Id', request.id);
};

async function dependencyAvailable(
  probe: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDependencies,
): Promise<void> {
  app.get('/health/live', async (request, reply) => {
    headers(reply, request);
    return { status: 'ok', requestId: request.id };
  });
  app.get('/health/ready', async (request, reply) => {
    headers(reply, request);
    const draining = deps.draining?.() === true;
    const [db, audit] = await Promise.all([
      dependencyAvailable(deps.db),
      dependencyAvailable(deps.audit),
    ]);
    const body = {
      status: db && audit && !draining ? 'ready' : 'not_ready',
      db,
      audit,
      draining,
      requestId: request.id,
    };
    if (!db || !audit || draining)
      return reply.code(503).send({
        code: 'NOT_READY',
        message: 'Required dependencies are unavailable',
        retryable: true,
        retryAfter: 1,
        requestId: request.id,
        details: body,
      });
    return body;
  });
  app.get('/health/market-data', async (request, reply) => {
    headers(reply, request);
    return deps.marketData();
  });
  app.get('/metrics', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-cache')
      .header('Content-Type', 'text/plain; version=0.0.4')
      .header('X-Request-Id', request.id);
    return deps.metrics?.metrics() ?? '';
  });
  app.get('/api/v1/health/trading', async (request, reply) => {
    headers(reply, request);
    if (!deps.trading)
      return {
        placement: false,
        cancellation: false,
        fx: false,
        reasons: ['UNAVAILABLE'],
        requestId: request.id,
      };
    return deps.trading(request);
  });
}
