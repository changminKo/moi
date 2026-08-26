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
export function cookieValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const pair of raw.split(';')) {
    const [key, ...value] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
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
