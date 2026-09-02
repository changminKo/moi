import { readFileSync } from 'node:fs';
import { DomainError } from '@moi/trading-core';
import { DEFAULT_REGISTRY, type StrategyRegistry } from '../registry.js';
import { runBacktest } from './engine.js';
import { readBacktestPlan } from './plan.js';
import { formatBacktestReport } from './report.js';
import { readTickLog } from './tick-log.js';

/**
 * `pnpm --filter @moi/strategy-runner backtest --plan <plan.json> --ticks
 * <ticks.ndjson>` — design §8.2's replay, from the command line.
 *
 * It is the runner's `main.ts` in miniature and for the same reasons: parse,
 * refuse loudly, run, exit. Everything it needs is injected — the file reader,
 * the writer, the registry — so the whole command is exercised by
 * `main.test.ts` without a process, and so nothing here reads an environment
 * variable a test would have to set.
 *
 * A failure is a *message*, never a stack. Almost everything that can go wrong
 * is a `DomainError` from the plan gates — a limit that is not exact money, a
 * market with no fee schedule, two strategies on one symbol — and the person
 * running a backtest wants the sentence.
 */

export interface BacktestCliOptions {
  readonly argv: readonly string[];
  readonly write: (line: string) => void;
  readonly registry?: StrategyRegistry;
  readonly readFile?: (path: string) => string;
}

function optionOf(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1];

  return value === undefined || value.startsWith('--') ? null : value;
}

/** The process exit code: `0` for a completed replay, `1` for a refusal. */
export async function backtestMain(
  options: BacktestCliOptions,
): Promise<number> {
  const read =
    options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const planPath = optionOf(options.argv, '--plan');
  const tickPath = optionOf(options.argv, '--ticks');

  if (planPath === null || tickPath === null) {
    options.write(
      'usage: backtest --plan <plan.json> --ticks <ticks.ndjson>\n' +
        `  --plan  ${planPath ?? 'is required: the strategies, limits, fees and opening cash'}\n` +
        `  --ticks ${tickPath ?? 'is required: an NDJSON tick log recorded by a run'}`,
    );

    return 1;
  }

  try {
    let source: unknown;

    try {
      source = JSON.parse(read(planPath));
    } catch (error) {
      throw new DomainError(
        'INVALID_ORDER',
        `${planPath} could not be read as JSON: ${describe(error)}`,
      );
    }

    const plan = readBacktestPlan(source, options.registry ?? DEFAULT_REGISTRY);
    const report = await runBacktest({ plan, ticks: readTickLog(tickPath) });

    options.write(formatBacktestReport(report));

    return 0;
  } catch (error) {
    options.write(`the backtest refused to run: ${describe(error)}`);

    return 1;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Node 24 sets `import.meta.main` on the entry module, so importing this file
 * from a test does not run a replay.
 */
const isEntryModule = (
  meta: ImportMeta & { readonly main?: boolean },
): boolean => meta.main === true;

if (isEntryModule(import.meta)) {
  process.exitCode = await backtestMain({
    argv: process.argv.slice(2),
    write: (line) => {
      process.stdout.write(`${line}\n`);
    },
  });
}
