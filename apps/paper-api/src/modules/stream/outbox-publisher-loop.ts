import type { MetricsRegistry } from '../../observability/metrics.js';
import type { OutboxPollMode } from './outbox-publisher.js';

export type { OutboxPollMode } from './outbox-publisher.js';

export interface OutboxPollResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export interface OutboxPollingPublisher {
  pollOnce(options: {
    readonly mode: OutboxPollMode;
  }): Promise<OutboxPollResult>;
}

export interface ShutdownDrainSummary {
  readonly rounds: number;
  readonly claimed: number;
  readonly remaining: number;
  readonly deadlineHit: boolean;
}

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface OutboxPublisherLoopDeps {
  readonly publisher: OutboxPollingPublisher;
  readonly prune: () => Promise<void>;
  readonly metrics: MetricsRegistry;
  readonly log: LogFn;
  readonly intervalMs?: number;
  readonly pruneEveryMs?: number;
  /** Rows still pending when a shutdown drain hits its deadline; feeds the gauge. */
  readonly pendingCount?: () => Promise<number>;
}

const DEFAULT_INTERVAL_MS = 200;
const DEFAULT_PRUNE_EVERY_MS = 600_000;
const EMPTY_ROUNDS_TO_FINISH = 2;

/**
 * Single-owner outbox publisher scheduling (§7.4).
 *
 * - `start()` is a total function: it only sets a flag and arms one timer, so
 *   `RuntimeStateMachine.enterServing()` can never be left half-open.
 * - `pauseScheduling()` is synchronous and idempotent: it clears the timer,
 *   forbids new periodic claims, and hands back the (at most one) in-flight
 *   poll so callers can wait for its tail before releasing leases.
 * - `shutdownDrain(deadline)` is the only other claim path: a bounded,
 *   timer-free one-shot loop used solely by shutdown step 4b.
 */
export class OutboxPublisherLoop {
  readonly #deps: OutboxPublisherLoopDeps;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<OutboxPollResult> | null = null;
  #lastPruneAt = 0;

  constructor(deps: OutboxPublisherLoopDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#running = true;
    this.#timer = this.#timer ?? setTimeout(this.#tick, 0);
  }

  pauseScheduling(): Promise<unknown> | null {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#inFlight;
  }

  isRunning(): boolean {
    return this.#running;
  }

  hasInFlightPoll(): boolean {
    return this.#inFlight !== null;
  }

  async shutdownDrain(deadline: number): Promise<ShutdownDrainSummary> {
    if (this.#running || this.#inFlight !== null) {
      throw new Error(
        'shutdownDrain precondition violated: scheduling must be paused and no poll in flight',
      );
    }
    let rounds = 0;
    let claimed = 0;
    let emptyRounds = 0;
    let deadlineHit = false;
    while (emptyRounds < EMPTY_ROUNDS_TO_FINISH) {
      const result = await this.#deps.publisher.pollOnce({
        mode: 'shutdown_drain',
      });
      rounds += 1;
      claimed += result.claimed;
      emptyRounds = result.claimed === 0 ? emptyRounds + 1 : 0;
      this.#deps.log('outbox.poll', { mode: 'shutdown_drain', ...result });
      if (emptyRounds < EMPTY_ROUNDS_TO_FINISH && Date.now() >= deadline) {
        deadlineHit = true;
        break;
      }
    }
    const remaining = deadlineHit
      ? await (this.#deps.pendingCount?.() ?? Promise.resolve(-1))
      : 0;
    this.#deps.metrics.gauge('outbox_shutdown_drain_rounds', rounds);
    if (deadlineHit)
      this.#deps.metrics.gauge(
        'outbox_drain_remaining',
        Math.max(remaining, 0),
      );
    const summary = { rounds, claimed, remaining, deadlineHit };
    this.#deps.log('outbox.drain', { skipped: false, ...summary });
    return summary;
  }

  readonly #tick = (): void => {
    this.#timer = null;
    if (!this.#running) return;
    const poll = this.#deps.publisher.pollOnce({ mode: 'periodic' });
    const settled = { claimed: 0, published: 0, failed: 0 };
    const tracked: Promise<OutboxPollResult> = poll
      .then((result) => {
        Object.assign(settled, result);
        this.#deps.log('outbox.poll', { mode: 'periodic', ...result });
        if (result.published > 0)
          this.#deps.metrics.observe(
            'outbox_published_total',
            result.published,
          );
      })
      .catch((error: unknown) => {
        this.#deps.log('outbox.poll_failed', {
          mode: 'periodic',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => this.#maybePrune())
      .then(() => {
        if (this.#inFlight === tracked) this.#inFlight = null;
        if (this.#running && this.#timer === null)
          this.#timer = setTimeout(
            this.#tick,
            this.#deps.intervalMs ?? DEFAULT_INTERVAL_MS,
          );
        return settled;
      });
    this.#inFlight = tracked;
  };

  async #maybePrune(): Promise<void> {
    const now = Date.now();
    if (this.#lastPruneAt === 0) this.#lastPruneAt = now;
    if (
      now - this.#lastPruneAt <
      (this.#deps.pruneEveryMs ?? DEFAULT_PRUNE_EVERY_MS)
    )
      return;
    this.#lastPruneAt = now;
    try {
      await this.#deps.prune();
    } catch (error) {
      this.#deps.log('outbox.prune_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
