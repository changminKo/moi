import { DomainError } from '@moi/trading-core';
import { openTickRecorder } from './backtest/tick-log.js';
import { loadRunnerConfig } from './config.js';
import { DEFAULT_REGISTRY } from './registry.js';
import { createLineReporter } from './reporter.js';
import { runUntilStopped, wireReporter } from './runner/reporter-wiring.js';
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
  const config = loadRunnerConfig({
    env: process.env,
    registry: DEFAULT_REGISTRY,
  });
  let supervisor: RunnerSupervisor | null = null;
  // Phase D: stdout always, Discord when the trade webhook is set. The session
  // cell is the runner's own file; it is read lazily because the supervisor
  // that owns it is built below, and because the cookie and token rotate.
  const wiring = wireReporter({
    env: process.env,
    secrets: () => {
      const session = supervisor?.state.session.read() as
        | { readonly cookie?: unknown; readonly csrfToken?: unknown }
        | null
        | undefined;

      return [session?.cookie, session?.csrfToken].filter(
        (value): value is string => typeof value === 'string',
      );
    },
  });
  const reporter = wiring.reporter;

  // Opt-in, and read here rather than in `loadRunnerConfig` because it decides
  // nothing the runner trades on: it is a research artifact, and a bad path
  // fails loudly at `AppendLog.open` before the first cycle either way.
  const tickLog = process.env.BOT_TICK_LOG;

  supervisor = new RunnerSupervisor({
    config,
    reporter,
    ...(tickLog === undefined || tickLog.trim().length === 0
      ? {}
      : { recorder: openTickRecorder({ path: tickLog, reporter }) }),
  });

  const stop = (signal: string): void => {
    reporter.report('info', 'stopping', { signal });
    supervisor.stop();
  };

  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  reporter.report('info', 'the strategy runner is starting', {
    origin: config.apiOrigin,
    strategies: config.strategies.map((each) => each.name).join(','),
    discord: wiring.discord,
  });

  await runUntilStopped(supervisor, wiring);
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
