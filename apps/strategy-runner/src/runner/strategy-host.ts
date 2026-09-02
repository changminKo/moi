import type {
  FillEvent,
  StrategyContext,
  StrategyDecision,
  StrategyState,
  Tick,
} from '@moi/strategy-sdk/strategy';
import { readStrategyDecisions } from '@moi/strategy-sdk/strategy';
import type { ConfiguredStrategy } from '../config.js';
import type { Reporter } from '../reporter.js';

/**
 * One configured strategy, and the runner's policy for what happens when it
 * misbehaves.
 *
 * ## What `onTick` throwing means, after phase A
 *
 * Phase A closed the case that could not recover on its own: a window sum
 * outside the exact money domain is now a `noop` with reason
 * `price-out-of-domain` rather than an exception, the ring still advances, and
 * the offending price ages out within `slowPeriod + 1` ticks. A *malformed*
 * price still throws, once, before any state changes, and the next valid tick
 * proceeds normally.
 *
 * So what is left for the runner to have a policy about is a genuine
 * exception — a bug, an assumption that stopped holding, an operator-edited
 * state file that got past validation. The policy is:
 *
 * **Contain the tick.** The throw does not reach the poll loop. No decision is
 * taken, nothing is submitted, the failure is reported, and the other strategies
 * carry on. A strategy is caller code from the runner's point of view; one of
 * them being broken is not a reason to stop trading the others.
 *
 * **Quarantine after `QUARANTINE_AFTER` *consecutive* throws.** Consecutive
 * rather than cumulative, and the distinction is phase A's doing. The one
 * remaining throwing case recovers on the very next valid tick, so a cumulative
 * counter would eventually quarantine a strategy that is working exactly as
 * designed and has merely seen a handful of bad prices over a long run. A
 * consecutive counter fires only on the shape that does not self-heal, and one
 * good tick clears it.
 *
 * Three is the threshold because the known self-healing case clears in one tick;
 * a strategy still throwing on the third consecutive tick is not recovering.
 *
 * ## Quarantine is not a kill switch, and it is not persisted
 *
 * A quarantined strategy stops receiving ticks. It does **not** have its resting
 * orders cancelled and its position is not closed — that is the submission
 * barrier of §7.2, which design §11 puts in phase D. What quarantine does is
 * stop a broken decision path from producing more decisions, and say so loudly.
 *
 * It is held in memory and re-derived after a restart, deliberately. The bot
 * runs under `restart: unless-stopped` (§7.3), and a quarantine written to disk
 * would mean a strategy that cannot restart itself out of a transient fault —
 * a bad state file replaced, a dependency fixed — without someone deleting a
 * file. A strategy that is genuinely broken re-quarantines within three ticks
 * and reports again; one that was not stays running. The runner does not exit
 * on a quarantine, so there is no crash loop for this to feed.
 */

export const QUARANTINE_AFTER = 3;

export interface StrategyHostOptions {
  readonly configured: ConfiguredStrategy;
  readonly reporter: Reporter;
  readonly quarantineAfter?: number;
}

export class StrategyHost {
  readonly #configured: ConfiguredStrategy;
  readonly #reporter: Reporter;
  readonly #quarantineAfter: number;
  #consecutiveFailures = 0;
  /**
   * Counted apart from the tick failures, and it has to be. A strategy whose
   * `onFill` is broken while its `onTick` works would never reach three
   * *consecutive* failures on a shared counter — every good tick would clear
   * it — so the one path that authorises orders off the back of an execution
   * would be the one path that could never be quarantined.
   */
  #consecutiveFillFailures = 0;
  #quarantined = false;
  #active = false;

  constructor(options: StrategyHostOptions) {
    this.#configured = options.configured;
    this.#reporter = options.reporter;
    this.#quarantineAfter = options.quarantineAfter ?? QUARANTINE_AFTER;
  }

  get name(): string {
    return this.#configured.name;
  }

  get quarantined(): boolean {
    return this.#quarantined;
  }

  /**
   * Restores the strategy's own state, when there is state to restore.
   *
   * `null` means the state store holds nothing for this strategy — a first run,
   * or a strategy added to an existing configuration — and `onStart` is **not**
   * called at all. That is not a shortcut: passing `{}` to mean "nothing" makes
   * the runner ask a strategy to restore a window it never wrote, and phase A's
   * `readSmaCrossoverState` correctly refuses that, because `{}` names no
   * instrument and a window for an unnamed instrument is not a window. Its own
   * `onTick` falls back to `initialSmaCrossoverState(params)`, so a strategy
   * that was never started is warmed up rather than broken.
   *
   * (Phase A's docstring says the runner calls `onStart` "with the stored state,
   * or with an empty one". Its code does not accept an empty one, and the code
   * is right — the docstring is the half that should move.)
   *
   * A failure here quarantines immediately rather than counting towards three:
   * `onStart` runs once, so "three consecutive" has no meaning for it, and a
   * strategy that cannot restore its window must not then trade on an empty one
   * it never declared.
   */
  start(saved: StrategyState | null, context: StrategyContext): void {
    const { strategy, params } = this.#configured;

    if (saved === null || strategy.onStart === undefined) {
      return;
    }

    try {
      strategy.onStart(saved, context, params);
      this.#active = true;
    } catch (error) {
      this.#quarantined = true;
      this.#reporter.report(
        'error',
        'a strategy could not restore its state and is quarantined',
        { strategy: this.name, error: describe(error) },
      );
    }
  }

  onTick(tick: Tick, context: StrategyContext): readonly StrategyDecision[] {
    if (this.#quarantined) {
      return [];
    }

    const { strategy, params } = this.#configured;

    try {
      // Validated through the SDK's own reader: a strategy is caller code, so
      // what it returns crosses a boundary and is snapshotted before the gateway
      // acts on it. A malformed decision is a throw, and therefore counts.
      const decisions = readStrategyDecisions(
        strategy.onTick(tick, context, params),
      );

      this.#consecutiveFailures = 0;
      this.#active = true;

      return decisions;
    } catch (error) {
      this.#consecutiveFailures += 1;

      return this.#contain(error, this.#consecutiveFailures, 'a tick');
    }
  }

  /**
   * A fill the runner has resolved and committed to deliver. Contained exactly
   * as `onTick` is: a broken strategy must not stop the fill from being
   * recorded, because the cursor advancing is what stops the fill from being
   * delivered twice.
   *
   * A strategy that declares no `onFill` answers nothing, which is not the same
   * as a strategy whose `onFill` returned nothing — the first never had an
   * opinion, and asking phase A's `sma-crossover` for one would be inventing it.
   */
  onFill(
    fill: FillEvent,
    context: StrategyContext,
  ): readonly StrategyDecision[] {
    const { strategy, params } = this.#configured;

    if (this.#quarantined || strategy.onFill === undefined) {
      return [];
    }

    try {
      const decisions = readStrategyDecisions(
        strategy.onFill(fill, context, params),
      );

      this.#consecutiveFillFailures = 0;

      return decisions;
    } catch (error) {
      this.#consecutiveFillFailures += 1;

      return this.#contain(error, this.#consecutiveFillFailures, 'a fill');
    }
  }

  snapshot(): StrategyState | null {
    const { strategy } = this.#configured;

    // Nothing has been restored and no tick has landed, so the strategy has no
    // state to hand over and asking would be a fault rather than a fact —
    // phase A's `snapshot()` says exactly that by throwing. Asking every cycle
    // until the first tick would fill the log with a warning about a runner
    // that is behaving correctly.
    if (strategy.snapshot === undefined || !this.#active) {
      return null;
    }

    try {
      return strategy.snapshot();
    } catch (error) {
      // Losing a snapshot costs a warm-up after the next restart, and nothing
      // else. It is not worth quarantining a strategy that is deciding
      // correctly, and it is certainly not worth failing the poll cycle.
      this.#reporter.report('warn', 'a strategy could not be snapshotted', {
        strategy: this.name,
        error: describe(error),
      });

      return null;
    }
  }

  #contain(
    error: unknown,
    consecutiveFailures: number,
    what: string,
  ): readonly StrategyDecision[] {
    if (consecutiveFailures >= this.#quarantineAfter) {
      this.#quarantined = true;
      this.#reporter.report(
        'error',
        `a strategy threw on ${consecutiveFailures} consecutive calls and is quarantined; its open orders and position are untouched and need a person`,
        { strategy: this.name, on: what, error: describe(error) },
      );
    } else {
      this.#reporter.report('warn', `a strategy threw on ${what}`, {
        strategy: this.name,
        consecutiveFailures,
        error: describe(error),
      });
    }

    return [];
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
