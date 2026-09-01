/**
 * A strategy runner in its own process, so a test can send it a real `SIGKILL`.
 *
 * The in-process crash tests reproduce a chosen instant by abandoning objects
 * and reopening the state directory; this reproduces the thing itself. `SIGKILL`
 * cannot be caught, cannot be deferred, and runs no `finally` — so anything the
 * next process finds on disk is there because it was fsynced, not because a
 * shutdown path was polite about it.
 *
 * Node 24 strips the types and runs this file as it stands, so the test spawns
 * the source and the compiler still checks it — which matters, because a child
 * that fails to start is a test that times out with nothing to read.
 *
 * `KILL_MODE` names where the kill lands, by replacing `FillJournal.commit`:
 *
 * - `before-commit` — the decisions `onFill` produced are durably recorded and
 *   the cursor never moves. The window design §6.4 is really about.
 * - `after-commit` — the cursor moves and the exit is never submitted.
 * - anything else — no kill; the process runs until the test stops it.
 */
import { writeFileSync } from 'node:fs';
import {
  createLineReporter,
  loadRunnerConfig,
  RunnerSupervisor,
} from '@moi/strategy-runner';
import type {
  FillEvent,
  InstrumentRef,
  Strategy,
  StrategyContext,
  StrategyDecision,
  Tick,
} from '@moi/strategy-sdk/strategy';
import {
  defineParameterSchema,
  quantityParameter,
  symbolParameter,
} from '@moi/strategy-sdk/strategy';

export const FILL_ECHO_ID = 'fill-echo';

/**
 * Buys once and, when that buy fills, puts an exit out.
 *
 * Two properties matter for the test and both are deliberate.
 *
 * The entry is gated twice, and it needs both gates. Within one process an
 * in-memory flag stops a second entry on the next tick, before the fill has
 * reached the portfolio the runner reads once a cycle. Across processes the
 * **ledger's** position is the gate, because the flag lives in `runtime.json`,
 * which is written at the end of a cycle and is therefore exactly the thing a
 * `SIGKILL` mid-cycle throws away. So re-entry after a restart is impossible for
 * a reason that has nothing to do with what the runner remembered, which keeps
 * the test measuring the fill path rather than the snapshot path.
 *
 * The exit is a limit far above the market, so it rests rather than filling.
 * A second fill would be a second event, and the question here is what happens
 * to *one*.
 */
interface FillEchoParams {
  readonly symbol: string;
  readonly quantity: string;
  readonly exitPrice: string;
}

export function createFillEcho(): Strategy<FillEchoParams> {
  let entered = false;

  return {
    id: FILL_ECHO_ID,
    parameterSchema: defineParameterSchema({
      symbol: symbolParameter(),
      quantity: quantityParameter(),
      // A whole-number price. There is no money parameter in the schema
      // vocabulary, and `quantityParameter` is the one that means "a positive
      // whole number in plain decimal form", which is what this is.
      exitPrice: quantityParameter(),
    }),
    subscriptions: (params: FillEchoParams): readonly InstrumentRef[] => [
      { market: 'KR', symbol: params.symbol },
    ],
    onTick: (
      _tick: Tick,
      context: StrategyContext,
      params: FillEchoParams,
    ): readonly StrategyDecision[] => {
      const held = context.position({ market: 'KR', symbol: params.symbol });

      if (entered || (held !== null && held.total !== '0')) {
        return [{ kind: 'noop', reason: 'already-holding' }];
      }

      entered = true;

      return [
        {
          kind: 'place',
          reason: 'entry',
          intent: {
            market: 'KR',
            symbol: params.symbol,
            side: 'BUY',
            type: 'MARKET',
            quantity: params.quantity,
          },
        },
      ];
    },
    onFill: (
      fill: FillEvent,
      _context: StrategyContext,
      params: FillEchoParams,
    ): readonly StrategyDecision[] =>
      fill.side === 'BUY'
        ? [
            {
              kind: 'place',
              reason: 'exit-after-fill',
              intent: {
                market: fill.market,
                symbol: fill.symbol,
                side: 'SELL',
                type: 'LIMIT',
                limitPrice: params.exitPrice,
                quantity: fill.quantity,
              },
            },
          ]
        : [],
  } as Strategy<FillEchoParams>;
}

function die(): never {
  process.kill(process.pid, 'SIGKILL');

  // `SIGKILL` is delivered by the kernel whatever the process is doing, and
  // spinning here guarantees no further JavaScript runs in the meantime. A
  // `return` would let the caller carry on for however long delivery takes,
  // which is the one thing a crash test must not allow.
  for (;;) {
    /* waiting to be killed */
  }
}

/**
 * Only when spawned. The test also *imports* this module, for the strategy and
 * its id, and an import that started a runner would have every case racing a
 * process nobody asked for. `main.ts` guards its entry point the same way.
 */
const isEntryModule = (
  meta: ImportMeta & { readonly main?: boolean },
): boolean => meta.main === true;

async function run(): Promise<void> {
  const reporter = createLineReporter((line) => {
    // Unbuffered, so the parent sees the last line before the kill.
    // `process.stdout.write` on a pipe is asynchronous, and its buffer dies
    // with the process.
    writeFileSync(1, `${line}\n`);
  });
  const config = loadRunnerConfig({
    env: process.env,
    registry: new Map([
      [FILL_ECHO_ID, createFillEcho as () => Strategy<unknown>],
    ]),
  });
  const supervisor = new RunnerSupervisor({ config, reporter });
  const mode = process.env.KILL_MODE;

  if (mode === 'before-commit' || mode === 'after-commit') {
    const journal = supervisor.state.fills;
    const commit = journal.commit.bind(journal);

    // An own property shadowing the prototype method. `FillProcessor` reaches
    // the journal through `state.fills` on every call, so it sees this.
    journal.commit = (record: Parameters<typeof commit>[0]): void => {
      // Only a commit that carries a fill. Every account event commits — an
      // `ORDER_ACCEPTED` moves the cursor with an empty `fills` — and killing on
      // one of those would test the cursor and never reach the window this is
      // about.
      if (record.fills.length === 0) {
        commit(record);

        return;
      }

      if (mode === 'after-commit') {
        commit(record);
      }

      writeFileSync(1, `[info] killing at ${mode}\n`);
      die();
    };
  }

  process.once('SIGTERM', () => supervisor.stop());

  try {
    await supervisor.start();
    await supervisor.run();
  } finally {
    supervisor.close();
  }
}

if (isEntryModule(import.meta)) {
  await run();
}
