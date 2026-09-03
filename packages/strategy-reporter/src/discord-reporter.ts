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
 * **On masking.** Since phase D (#92) the runner's own `formatReport` runs this
 * package's `maskOutbound` — one masker, not two — so a line reaching this
 * reporter has already been masked by pattern and by held value. This reporter
 * masks again on the way out and adds the tripwire that drops a payload in
 * which a held secret survived. Masking twice is idempotent; the rules
 * themselves are pinned once, in `masking.test.ts`.
 *
 * **On levels.** The runner says `info | warn | error`; Discord embeds here use
 * the four colours `infra/oracle/notify.sh` posts. `error` maps onto the red
 * that notifier calls `fail`.
 *
 * **On money.** A field value may be a `number` because the runner's interface
 * says so. Money must not travel that way (AGENTS.md hard rule 5) — format it
 * with the `@moi/trading-core` decimal helpers and pass the string.
 *
 * **On language.** The operator reads Korean, so the embed title is the Korean
 * `korean.ts` has for the runner's message and the original English line sits
 * under it behind a spoiler. The English line itself is untouched as the
 * aggregation key and the footer's `kind`: it is what the runner logs, and
 * what a runbook quotes.
 */
import type { ReportField, ReportLevel } from './events.js';
import { fieldLabel, localizeMessage, withOriginal } from './korean.js';
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
        ([name, value]) => ({ name: fieldLabel(name), value: String(value) }),
      );
      const korean = localizeMessage(message);
      reporter.report({
        level: LEVELS[level],
        // The message is the stable half of a report — the varying half lives
        // in `fields` — so it is what aggregation keys on. Keying on the
        // rendered fields too would let a tick counter defeat the budget by
        // making every message unique.
        kind: message,
        dedupeKey: `${level}:${message}`,
        title: korean ?? message,
        ...(korean === undefined ? {} : { description: withOriginal(message) }),
        ...(rendered.length > 0 ? { fields: rendered } : {}),
      });
    },
    flush: () => reporter.flush(),
    close: () => reporter.close(),
    stats: () => reporter.stats(),
  };
}
