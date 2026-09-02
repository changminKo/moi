/**
 * The adapter the runner actually wires: a Discord implementation of the
 * `Reporter` interface `apps/strategy-runner/src/reporter.ts` already defines.
 *
 * That interface is the contract, so this file implements it rather than
 * proposing a second one. It is satisfied structurally — the runner's
 * `Reporter` type is `report(level, message, fields?)` and so is
 * `RunnerReporter` here — which is what lets the runner hold a
 * `Reporter | DiscordReporter` without this package appearing in its type
 * imports, and keeps the dependency pointing one way: the app may depend on
 * this package, never the reverse.
 *
 * **On masking.** The runner's `formatReport` runs `redact` over every line it
 * writes, unconditionally, covering the four shapes design §7.4 names. This
 * reporter masks again on the way out, with a superset: the same four, plus
 * Discord webhook URLs, `Bearer` values, credentials inside a URL and
 * `*KEY|TOKEN|SECRET*=` assignments, plus exact-value substitution for the
 * secrets the runner holds and a tripwire that drops a payload in which one
 * survived. Masking twice is idempotent and neither side has to trust the
 * other; `discord-reporter.test.ts` holds this masker to every rule the
 * runner's has, so a rule added there and missed here fails a test rather than
 * reaching a channel.
 *
 * **On levels.** The runner says `info | warn | error`; Discord embeds here use
 * the four colours `infra/oracle/notify.sh` posts. `error` maps onto the red
 * that notifier calls `fail`.
 *
 * **On money.** A field value may be a `number` because the runner's interface
 * says so. Money must not travel that way (AGENTS.md hard rule 5) — format it
 * with the `@moi/trading-core` decimal helpers and pass the string.
 */
import type { ReportField, ReportLevel } from './events.js';
import {
  createReporter,
  type Reporter,
  type ReporterOptions,
  type ReporterStats,
} from './reporter.js';

/** Mirrors `ReportLevel` in `apps/strategy-runner/src/reporter.ts`. */
export type RunnerReportLevel = 'info' | 'warn' | 'error';

/** Mirrors `ReportFields` in `apps/strategy-runner/src/reporter.ts`. */
export type RunnerReportFields = Readonly<
  Record<string, string | number | boolean>
>;

/** Structurally the runner's `Reporter`. */
export interface RunnerReporter {
  report(
    level: RunnerReportLevel,
    message: string,
    fields?: RunnerReportFields,
  ): void;
}

export interface DiscordReporter extends RunnerReporter {
  flush(): Promise<void>;
  close(): Promise<void>;
  stats(): ReporterStats;
}

const LEVELS: Readonly<Record<RunnerReportLevel, ReportLevel>> = {
  info: 'info',
  warn: 'warn',
  error: 'fail',
};

export function createDiscordReporter(
  options: ReporterOptions = {},
): DiscordReporter {
  const reporter: Reporter = createReporter(options);

  return {
    report(level, message, fields = {}) {
      const rendered: readonly ReportField[] = Object.entries(fields).map(
        ([name, value]) => ({ name, value: String(value) }),
      );
      reporter.report({
        level: LEVELS[level],
        // The message is the stable half of a report — the varying half lives
        // in `fields` — so it is what aggregation keys on. Keying on the
        // rendered fields too would let a tick counter defeat the budget by
        // making every message unique.
        kind: message,
        dedupeKey: `${level}:${message}`,
        title: message,
        ...(rendered.length > 0 ? { fields: rendered } : {}),
      });
    },
    flush: () => reporter.flush(),
    close: () => reporter.close(),
    stats: () => reporter.stats(),
  };
}
