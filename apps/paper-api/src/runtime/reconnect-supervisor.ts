export interface ReconnectSupervisorOptions {
  /** Full-jitter backoff by attempt number (§8.3); attempt starts at 1. */
  readonly delayMs: (attempt: number) => number;
  readonly onExhausted: () => Promise<void> | void;
  /**
   * Delay before the n-th attempt made *after* the window was exhausted
   * (n starts at 1). Defaults to `rearmDelayMs`.
   */
  readonly rearmDelayMs?: (rearm: number) => number;
  /** Observability seam: the delay chosen for a re-armed attempt. */
  readonly onRearm?: (delayMs: number, rearm: number) => void;
  readonly windowMs?: number;
  readonly maxFailures?: number;
  readonly now?: () => number;
}

export interface ScheduleOptions {
  readonly immediate?: boolean;
  /** Provider announced `server-shutdown`: first retry after a fixed 1 s. */
  readonly serverShutdown?: boolean;
}

const DEFAULT_WINDOW_MS = 300_000;
const DEFAULT_MAX_FAILURES = 3;
const SERVER_SHUTDOWN_DELAY_MS = 1_000;

export const REARM_BASE_MS = 30_000;
export const REARM_CEILING_MS = 300_000;

/**
 * Delay before a retry attempted while the failure window is exhausted:
 * 30 s doubling to a 5 min ceiling. No jitter — the scope is already alone in
 * holding, and a predictable interval is what an operator reads off the log.
 */
export const rearmDelayMs = (rearm: number): number =>
  Math.min(REARM_CEILING_MS, REARM_BASE_MS * 2 ** Math.max(0, rearm - 1));

/**
 * Bounded retry scheduler: one pending attempt at a time, a sliding failure
 * window, and — once the window is exhausted (§8.3) — a slow re-arm on top of
 * the `RECOVERY_RETRY_EXHAUSTED` incident. The incident is the alert; it is
 * never the only way back, so `resume()` (operator) and the re-arm (automatic)
 * both lift the hold. It owns the only retry timer for its scope.
 */
export class ReconnectSupervisor {
  readonly #o: ReconnectSupervisorOptions;
  readonly #failures: number[] = [];
  #attempt = 0;
  #rearm = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #exhausted = false;

  constructor(options: ReconnectSupervisorOptions) {
    this.#o = options;
  }

  get exhausted(): boolean {
    return this.#exhausted;
  }

  get pending(): boolean {
    return this.#timer !== null;
  }

  schedule(run: () => Promise<boolean>, options: ScheduleOptions = {}): void {
    if (this.#timer !== null) return;
    const delay = this.#exhausted
      ? this.#nextRearmDelay()
      : this.#nextAttemptDelay(options);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void run().then(
        (succeeded) => {
          if (succeeded) this.reset();
        },
        () => undefined,
      );
    }, delay);
  }

  /** Returns true while the sliding window is exhausted. */
  recordFailure(): boolean {
    const now = this.#o.now?.() ?? Date.now();
    const windowMs = this.#o.windowMs ?? DEFAULT_WINDOW_MS;
    while (
      this.#failures.length > 0 &&
      now - (this.#failures[0] as number) > windowMs
    )
      this.#failures.shift();
    this.#failures.push(now);
    if (this.#failures.length < (this.#o.maxFailures ?? DEFAULT_MAX_FAILURES))
      return false;
    // Only the transition raises the incident; the re-armed attempts that
    // follow keep failing inside the same window and must not duplicate it.
    if (!this.#exhausted) {
      this.#exhausted = true;
      this.cancel();
      try {
        const outcome = this.#o.onExhausted();
        if (outcome !== undefined) outcome.catch(() => undefined);
      } catch {
        /* an exhausted hold must never crash the process */
      }
    }
    return true;
  }

  /** Clean slate: the hold is lifted and both backoffs start over. */
  reset(): void {
    this.#failures.length = 0;
    this.#attempt = 0;
    this.#rearm = 0;
    this.#exhausted = false;
  }

  /**
   * Called after an operator resolves `RECOVERY_RETRY_EXHAUSTED`. The pending
   * re-arm is dropped: an operator resuming means "retry now", not "wait out
   * the hold you were already waiting out".
   */
  resume(): void {
    this.cancel();
    this.reset();
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #nextAttemptDelay(options: ScheduleOptions): number {
    if (options.immediate) return 0;
    this.#attempt += 1;
    return options.serverShutdown && this.#attempt === 1
      ? SERVER_SHUTDOWN_DELAY_MS
      : this.#o.delayMs(this.#attempt);
  }

  /**
   * An exhausted scope ignores `immediate`: that flag exists to make the first
   * ordinary retry prompt, and honouring it here would hot-loop the hold.
   */
  #nextRearmDelay(): number {
    this.#rearm += 1;
    const delay = (this.#o.rearmDelayMs ?? rearmDelayMs)(this.#rearm);
    this.#o.onRearm?.(delay, this.#rearm);
    return delay;
  }
}
