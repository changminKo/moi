import { hostname } from 'node:os';
import {
  createDiscordReporter,
  type ReportTransport,
  readReporterConfig,
} from '@moi/strategy-reporter';
import { DomainError } from '@moi/trading-core';
import { createLineReporter, type Reporter } from '../reporter.js';

/**
 * How the runner speaks (design §3, §7.4): always to stdout — `docker logs` is
 * the operator's first look — and, when `DISCORD_WEBHOOK_TRADE_URL` is set, to
 * the bot's own Discord channel as well. The two are fanned out here so that
 * every module keeps taking one `Reporter`.
 *
 * A malformed webhook refuses to start rather than starting silent: the
 * preflight makes the same judgement for a deploy, and a bot whose alerts go
 * nowhere is a bot nobody is watching. A *missing* webhook is not an error —
 * reporting may not be a reason a runner refuses to start
 * (`readReporterConfig`), and the operational `DISCORD_WEBHOOK_URL` is never
 * read as a fallback: trading noise must not bury an incident alert.
 *
 * The Discord side masks the secrets it is handed — the session cookie and the
 * CSRF token — by exact value on top of the pattern rules, and drops a payload
 * in which one survived. `secrets` is read at send time because both rotate.
 */
export interface ReporterWiring {
  readonly reporter: Reporter;
  /** Whether a Discord channel is wired. Reported at start so `docker logs` says which. */
  readonly discord: boolean;
  /** Flushes what Discord has queued. For shutdown. */
  close(): Promise<void>;
}

export interface ReporterWiringOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where lines go. Defaults to stdout. */
  readonly write?: (line: string) => void;
  /** Read at send time: the session cookie and CSRF token rotate. */
  readonly secrets: () => readonly string[];
  /** The embed footer's source. Defaults to the container hostname. */
  readonly source?: string;
  /** Overrides the Discord transport; tests use this. */
  readonly transport?: ReportTransport;
}

export function wireReporter(options: ReporterWiringOptions): ReporterWiring {
  const lines = createLineReporter(options.write, options.secrets);
  const config = readReporterConfig(options.env);

  if (!config.ok) {
    // The same code and prefix `loadRunnerConfig` uses for a configuration it
    // refuses, so the entry point reports it the same way.
    throw new DomainError(
      'INVALID_ORDER',
      `invalid runner configuration: ${config.problem}`,
    );
  }

  if (config.webhookUrl.length === 0 && options.transport === undefined) {
    return { reporter: lines, discord: false, close: async () => {} };
  }

  const discord = createDiscordReporter({
    ...(config.webhookUrl.length === 0
      ? {}
      : { webhookUrl: config.webhookUrl }),
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    secrets: options.secrets,
    source: options.source ?? hostname(),
    // A diagnostic carries a counter and a status, never reported content, so
    // it is safe on stdout and useful there: it is how a dead webhook is seen.
    onDiagnostic: (line) => lines.report('warn', line),
  });

  return {
    discord: true,
    reporter: {
      report: (level, message, fields) => {
        lines.report(level, message, fields);
        discord.report(level, message, fields);
      },
    },
    close: () => discord.close(),
  };
}

/** The part of `RunnerSupervisor` the entry point drives. */
export interface Runnable {
  start(): Promise<void>;
  run(): Promise<void>;
  close(): void;
}

/**
 * Starts, runs until stopped, and — whatever happened — says so through the
 * wired reporter *before* the channel is closed, then closes it even if the
 * supervisor's own close threw. A runner that dies is the one event §7.4 most
 * wants in the channel, and a crash that only reached stdout would be a crash
 * nobody was told about.
 */
export async function runUntilStopped(
  supervisor: Runnable,
  wiring: ReporterWiring,
): Promise<void> {
  try {
    await supervisor.start();
    await supervisor.run();
  } catch (error) {
    wiring.reporter.report('error', 'the strategy runner stopped on an error', {
      // The code or the class, never the message: it may be the server's.
      error:
        error instanceof DomainError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
    });
    throw error;
  } finally {
    try {
      supervisor.close();
    } finally {
      // Last: whatever the shutdown said still has to reach the channel.
      await wiring.close();
    }
  }
}
