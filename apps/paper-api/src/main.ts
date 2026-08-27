import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { safeAuditLog } from './observability/logger.js';
import { ProductionRuntime } from './runtime/production-runtime.js';
import { createProviderBundle } from './runtime/provider-bundle.js';

export interface StartOptions {
  /** Register SIGTERM/SIGINT handlers (default true). */
  readonly signals?: boolean;
}

/**
 * Production composition root: configuration → provider bundle → runtime.
 * Every lifecycle decision lives in `ProductionRuntime` (§4); this file only
 * assembles and reports.
 */
export async function startProductionServer(
  environment: NodeJS.ProcessEnv = process.env,
  options: StartOptions = {},
): Promise<ProductionRuntime> {
  const config = loadConfig(environment);
  const bundle = createProviderBundle(config);
  const runtime = new ProductionRuntime({
    config,
    bundle,
    log: (event, fields) =>
      console.log(
        JSON.stringify({
          level: 'info',
          event,
          ...safeAuditLog(fields),
          at: new Date().toISOString(),
        }),
      ),
    ...(options.signals !== undefined ? { signals: options.signals } : {}),
  });
  await runtime.start();
  return runtime;
}

const invokedAsProgram =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsProgram) {
  await startProductionServer().catch((error: unknown) => {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[paper-api] startup failed: ${name}: ${message}`);
    process.exitCode = 1;
  });
}
