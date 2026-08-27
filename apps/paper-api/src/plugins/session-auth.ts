import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  SessionPrincipal,
  SessionService,
} from '../modules/session/session-service.js';
import { SESSION_COOKIE } from '../modules/session/session-token.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionPrincipal;
  }
}
/** Header-level cookie parser shared by Fastify routes and the raw upgrade bridge. */
export function cookieValueFromHeader(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}
export function cookieValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  return cookieValueFromHeader(request.headers.cookie, name);
}
export function registerSessionAuth(
  app: FastifyInstance,
  service: SessionService,
): void {
  app.decorateRequest('session');
  app.decorate(
    'authenticateSession',
    async function authenticateSession(request: FastifyRequest) {
      const token = cookieValue(request, SESSION_COOKIE);
      if (!token)
        throw Object.assign(new Error('session is required'), {
          statusCode: 401,
        });
      const result = await service.authenticate(token);
      request.session = result.session;
    },
  );
}
