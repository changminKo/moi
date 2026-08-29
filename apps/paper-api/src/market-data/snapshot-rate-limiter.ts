export interface RateLimiterClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
const systemClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
};

/** FIFO token bucket; acquire is deterministic and never performs a request. */
export class SnapshotRateLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #clock: RateLimiterClock;
  #tokens: number;
  #at: number;
  constructor(
    options: {
      capacity?: number;
      refillPerSecond?: number;
      clock?: RateLimiterClock;
    } = {},
  ) {
    this.#capacity = options.capacity ?? 10;
    this.#refillPerMs = (options.refillPerSecond ?? this.#capacity) / 1000;
    this.#clock = options.clock ?? systemClock;
    this.#tokens = this.#capacity;
    this.#at = this.#clock.now();
  }
  get availableTokens(): number {
    this.refill();
    return this.#tokens;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      this.refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const wait = Math.max(
        1,
        Math.ceil((1 - this.#tokens) / this.#refillPerMs),
      );
      await this.#clock.sleep(wait, signal);
    }
  }
  private refill(): void {
    const now = this.#clock.now();
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + Math.max(0, now - this.#at) * this.#refillPerMs,
    );
    this.#at = now;
  }
}
