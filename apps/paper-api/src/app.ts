import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from './config.js';
import { registerErrorHandler } from './plugins/error-handler.js';
import {
  type RequestClock,
  registerRequestContext,
} from './plugins/request-context.js';

export interface AppDependencies {
  readonly logger?: FastifyServerOptions['logger'];
  readonly requestId?: (request: IncomingMessage) => string;
  readonly clock: RequestClock;
  /** Registered before any other hook so an ingress fence sees every request first. */
  readonly registerIngress?: (app: FastifyInstance) => void;
  readonly registerRoutes?: (
    app: FastifyInstance,
    dependencies: AppDependencies,
  ) => Promise<void> | void;
}

declare module 'fastify' {
  interface FastifyInstance {
    readonly redactedLogPaths: readonly string[];
  }
}

const redactedLogPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.x-csrf-token',
  'req.headers.x-session-token',
  'req.headers.session-token',
];

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: dependencies.logger ?? {
      level: config.nodeEnv === 'test' ? 'silent' : 'info',
      redact: { paths: redactedLogPaths, censor: '[REDACTED]' },
    },
    genReqId: dependencies.requestId ?? (() => randomUUID()),
    bodyLimit: 65_536,
    ajv: { customOptions: { removeAdditional: false } },
  }) as unknown as FastifyInstance;
  app.decorate('redactedLogPaths', redactedLogPaths);
  dependencies.registerIngress?.(app);
  await app.register(helmet);
  await app.register(cors, { origin: config.publicOrigin, credentials: true });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== config.publicOrigin) {
      reply.code(403).send({
        code: 'FORBIDDEN',
        message: 'Request origin is not allowed',
        retryable: false,
        requestId: request.id,
      });
    }
  });
  await registerRequestContext(app, dependencies.clock);
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.context === undefined) return payload;
    const duration = Math.max(
      0,
      request.context.clock.now() - request.context.startedAt,
    );
    reply.header('Server-Timing', `app;dur=${duration.toFixed(3)}`);
    return payload;
  });
  await registerErrorHandler(app);
  await dependencies.registerRoutes?.(app, dependencies);
  return app;
}
