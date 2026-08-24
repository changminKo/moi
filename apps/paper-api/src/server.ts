import type { FastifyInstance } from 'fastify';
import { type AppDependencies, buildApp } from './app.js';
import { type AppConfig, loadConfig } from './config.js';

export interface ServerDependencies extends AppDependencies {
  readonly startupCoordinator?: { open(): Promise<void> };
  readonly shutdownCoordinator?: { drain(): Promise<void> };
}

export async function startServer(
  config: AppConfig = loadConfig(),
  dependencies: ServerDependencies,
): Promise<FastifyInstance> {
  const app = await buildApp(config, dependencies);
  await dependencies.startupCoordinator?.open();
  await app.listen({ host: config.host, port: config.port });
  const shutdown = async (): Promise<void> => {
    await dependencies.shutdownCoordinator?.drain();
    await app.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return app;
}
