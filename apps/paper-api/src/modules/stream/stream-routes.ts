import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LayeredRateLimiter } from '../../plugins/rate-limits.js';
import {
  type DurableEventSource,
  StreamSession,
  type StreamSocket,
} from './stream-session.js';

export interface StreamRouteDependencies {
  readonly principal: (
    request: FastifyRequest,
  ) => Promise<{ readonly id: string; readonly status?: string }>;
  readonly source: DurableEventSource;
  readonly quoteSymbols?: ReadonlySet<string>;
  readonly upgrade?: (
    request: FastifyRequest,
    onSocket: (socket: StreamSocket) => Promise<void>,
  ) => void;
  readonly limiter?: LayeredRateLimiter;
}

export async function registerStreamRoutes(
  app: FastifyInstance,
  dependencies: StreamRouteDependencies,
): Promise<void> {
  app.get('/api/v1/stream', async (request, reply) => {
    const origin = request.headers.origin;
    const expectedOrigin = (
      app as FastifyInstance & { config?: { publicOrigin?: string } }
    ).config?.publicOrigin;
    if (expectedOrigin !== undefined && origin !== expectedOrigin)
      return reply.code(403).send({
        code: 'FORBIDDEN',
        message: 'Request origin is not allowed',
        retryable: false,
        requestId: request.id,
      });
    const principal = await dependencies.principal(request);
    if (dependencies.limiter) {
      const connection = dependencies.limiter.checkWebsocketConnection(
        principal.id,
      );
      if (!connection.allowed)
        return reply
          .header('Retry-After', String(connection.retryAfter ?? 1))
          .code(429)
          .send({
            code: 'RATE_LIMITED',
            message: 'Too many stream connections',
            retryable: true,
            retryAfter: connection.retryAfter ?? 1,
            requestId: request.id,
          });
      const requested = (request.query as { quoteSymbols?: string })
        .quoteSymbols;
      const subscriptions = requested
        ? requested.split(',').filter(Boolean).length
        : 0;
      const subscription = dependencies.limiter.checkSubscription(
        principal.id,
        subscriptions,
      );
      if (!subscription.allowed)
        return reply
          .header('Retry-After', String(subscription.retryAfter ?? 1))
          .code(429)
          .send({
            code: 'RATE_LIMITED',
            message: 'Too many stream subscriptions',
            retryable: true,
            retryAfter: subscription.retryAfter ?? 1,
            requestId: request.id,
          });
    }
    if (principal.status !== undefined && principal.status !== 'ACTIVE')
      throw Object.assign(new Error('session expired'), {
        statusCode: 401,
        code: 'SESSION_EXPIRED',
      });
    if (dependencies.upgrade) {
      dependencies.upgrade(request, async (socket) => {
        const query = request.query as { afterSequence?: string };
        const options = {
          sessionId: principal.id,
          source: dependencies.source,
          socket,
        } as Parameters<typeof StreamSession.open>[0];
        if (query.afterSequence !== undefined)
          Object.assign(options, { afterSequence: query.afterSequence });
        if (dependencies.quoteSymbols !== undefined)
          Object.assign(options, { quoteSymbols: dependencies.quoteSymbols });
        await StreamSession.open(options);
        // The 426 fallback route keeps this branch only for unit-test compatibility;
        // production upgrades go through stream-upgrade.ts.
      });
      return reply.hijack();
    }
    return reply.code(426).send({
      code: 'UPGRADE_REQUIRED',
      message: 'WebSocket upgrade required',
      retryable: false,
      requestId: request.id,
    });
  });
}
