import type { FastifyInstance } from 'fastify';
import { cookieValue } from '../../plugins/session-auth.js';
import { SESSION_COOKIE } from './session-token.js';
import type { SessionService } from './session-service.js';

export async function registerSessionRoutes(app: FastifyInstance, service: SessionService): Promise<void> {
  app.post('/api/v1/sessions/anonymous', async (request, reply) => {
    const result = await service.bootstrap(cookieValue(request, SESSION_COOKIE));
    reply.header('Set-Cookie', result.setCookie).send({ session: result.session, csrfToken: result.csrfToken });
  });
  app.get('/api/v1/session', async (request, reply) => {
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) throw Object.assign(new Error('session is required'), { statusCode: 401 });
    const result = await service.authenticate(token);
    reply.send(result);
  });
}
