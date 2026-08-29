export interface ReconnectSupervisorOptions {
  /** Full-jitter backoff by attempt number (§8.3); attempt starts at 1. */
  readonly delayMs: (attempt: number) => number;
  readonly onExhausted: () => Promise<void> | void;
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

/**
 * Bounded retry scheduler: one pending attempt at a time, a sliding failure
 * window, and a manual hold once the window is exhausted (§8.3). It owns the
 * only retry timer for its scope; `resume()` lifts the hold after an operator
 * resolves `RECOVERY_RETRY_EXHAUSTED`.
 */
export class ReconnectSupervisor {
  readonly #o: ReconnectSupervisorOptions;
  readonly #failures: number[] = [];
  #attempt = 0;
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
    if (this.#exhausted || this.#timer !== null) return;
    if (!options.immediate) this.#attempt += 1;
    const delay = options.immediate
      ? 0
      : options.serverShutdown && this.#attempt === 1
        ? SERVER_SHUTDOWN_DELAY_MS
        : this.#o.delayMs(this.#attempt);
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

  /** Returns true when this failure exhausted the window. */
  recordFailure(): boolean {
    const now = this.#o.now?.() ?? Date.now();
    const windowMs = this.#o.windowMs ?? DEFAULT_WINDOW_MS;
    while (
      this.#failures.length > 0 &&
      now - (this.#failures[0] as number) > windowMs
    )
      this.#failures.shift();
    this.#failures.push(now);
    if (
      this.#failures.length >= (this.#o.maxFailures ?? DEFAULT_MAX_FAILURES)
    ) {
      this.#exhausted = true;
      this.cancel();
      try {
        const outcome = this.#o.onExhausted();
        if (outcome !== undefined) outcome.catch(() => undefined);
      } catch {
        /* an exhausted hold must never crash the process */
      }
      return true;
    }
    return false;
  }

  reset(): void {
    this.#failures.length = 0;
    this.#attempt = 0;
  }

  resume(): void {
    this.#exhausted = false;
    this.reset();
  }

  cancel(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
