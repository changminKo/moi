import Fastify, { type FastifyInstance } from 'fastify';
import { type AdminDependencies, registerAdminRoutes } from './admin-routes.js';
export async function buildAdminApp(
  deps: AdminDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerAdminRoutes(app, deps);
  return app;
}
