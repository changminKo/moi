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
  // One redacting log for both halves: the adapter reports decode events of its
  // own, and every field passes through `safeAuditLog` before it is printed.
  const log = (event: string, fields: Record<string, unknown>): void =>
    console.log(
      JSON.stringify({
        level: 'info',
        event,
        ...safeAuditLog(fields),
        at: new Date().toISOString(),
      }),
    );
  const bundle = createProviderBundle(config, { log });
  const runtime = new ProductionRuntime({
    config,
    bundle,
    log,
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
