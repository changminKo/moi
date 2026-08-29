import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionPrincipal } from '../modules/session/session-service.js';
import { verifyCsrfToken } from '../modules/session/session-service.js';

export interface CsrfOptions {
  readonly secret: string;
  readonly origin: string;
}
export function requireCsrf(
  request: FastifyRequest,
  session: SessionPrincipal | undefined,
  options: CsrfOptions,
): void {
  const method = request.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  if (
    !session ||
    request.headers.origin !== options.origin ||
    typeof request.headers['x-csrf-token'] !== 'string' ||
    !verifyCsrfToken(
      options.secret,
      session.id,
      request.headers['x-csrf-token'],
    )
  ) {
    throw Object.assign(new Error('CSRF validation failed'), {
      statusCode: 403,
    });
  }
}
export function registerCsrf(app: FastifyInstance, options: CsrfOptions): void {
  app.addHook('preHandler', async (request) =>
    requireCsrf(request, request.session, options),
  );
}
