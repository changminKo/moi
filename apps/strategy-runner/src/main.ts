import { DomainError } from '@moi/trading-core';
import { loadRunnerConfig } from './config.js';
import { DEFAULT_REGISTRY } from './registry.js';
import { createLineReporter } from './reporter.js';
import { RunnerSupervisor } from './runner/supervisor.js';

/**
 * The container entry point. It does as little as an entry point can: load the
 * configuration — which is where every fail-closed check lives, including the
 * origin allow-list of §4.1 — build the supervisor, and run.
 *
 * A configuration failure exits non-zero without starting. Under
 * `restart: unless-stopped` that is a container that restarts and fails the same
 * way, loudly, which is the correct behaviour for a bot whose configuration says
 * something it must not act on.
 */
export async function main(): Promise<void> {
  const reporter = createLineReporter();
  const config = loadRunnerConfig({
    env: process.env,
    registry: DEFAULT_REGISTRY,
  });

  const supervisor = new RunnerSupervisor({ config, reporter });

  const stop = (signal: string): void => {
    reporter.report('info', 'stopping', { signal });
    supervisor.stop();
  };

  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  reporter.report('info', 'the strategy runner is starting', {
    origin: config.apiOrigin,
    strategies: config.strategies.map((each) => each.name).join(','),
  });

  try {
    await supervisor.start();
    await supervisor.run();
  } finally {
    supervisor.close();
  }
}

/**
 * Node 24 sets `import.meta.main` on the entry module, so importing this file
 * from a test does not start the loop. TypeScript's `ImportMeta` does not
 * declare it yet, hence the narrowing rather than a plain property read.
 */
const isEntryModule = (
  meta: ImportMeta & { readonly main?: boolean },
): boolean => meta.main === true;

if (isEntryModule(import.meta)) {
  try {
    await main();
  } catch (error) {
    // A refusal is a message, not a stack. Almost every failure that reaches
    // here is a `DomainError` from the configuration gates — a host off the
    // allow-list, a limit that is not exact money — and an operator reading
    // `docker logs` should see the sentence, through the same masker every
    // other line goes through. A stack is still printed for anything that is
    // not one of those, because then the sentence is not the whole story.
    createLineReporter().report('error', 'the strategy runner refused to run', {
      error: error instanceof Error ? error.message : String(error),
    });

    if (!(error instanceof DomainError)) {
      console.error(error);
    }

    process.exitCode = 1;
  }
}
