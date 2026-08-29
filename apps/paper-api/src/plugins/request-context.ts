import type { FastifyInstance } from 'fastify';

export interface RequestClock {
  now(): number;
}

export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  readonly clock: RequestClock;
}

declare module 'fastify' {
  interface FastifyRequest {
    context: RequestContext;
  }
}

export async function registerRequestContext(
  app: FastifyInstance,
  clock: RequestClock,
): Promise<void> {
  app.decorateRequest('context');
  app.addHook('onRequest', async (request) => {
    request.context = { requestId: request.id, startedAt: clock.now(), clock };
  });
}
