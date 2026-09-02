/**
 * How long the stream client waits before trying to connect again.
 *
 * This is deliberately a copy of a lesson rather than a copy of an
 * implementation: design §3 forbids the runner from importing `@moi/paper-api`,
 * where `ReconnectSupervisor` lives, so what crosses the boundary is the
 * reasoning behind spec §16.34's two fixes, not the code.
 *
 * ## Two bands, and why they are not the same band
 *
 * **An ordinary retry draws with full jitter** — uniformly from `[0, step]`,
 * the step doubling from `ATTEMPT_BASE_MS` to `ATTEMPT_CEILING_MS`. The lower
 * edge at zero is the point: a client that has just lost its socket to a
 * one-off should be allowed to come straight back, and spreading the draw over
 * the whole band is what keeps several clients from lining up.
 *
 * **A retry made while the failure window is exhausted draws with half
 * jitter** — from the top half of a step that doubles from `REARM_BASE_MS` to
 * `REARM_CEILING_MS`. Here the zero edge is the bug: an exhausted scope is one
 * that has failed repeatedly in a short window, and a draw that can come back
 * as ~0 collapses the hold into the retry storm the ceiling exists to prevent.
 * The band still has to be a band rather than a fixed delay — the paper API's
 * stream rate limiter counts *connections per session*, so a runner that
 * retries in lock-step with anything else on the same session manufactures a
 * `429` out of its own timing.
 *
 * ## There is no permanent latch
 *
 * The paper API's supervisor used to stop for good once the window was
 * exhausted, and only an operator could lift it (§16.34). That is defensible
 * for a service with an on-call rotation; it is not defensible for a bot in a
 * container that nobody is watching, whose whole failure story is
 * `restart: unless-stopped`. So exhaustion here changes the *band* and nothing
 * else: the client keeps trying, slowly, forever, and says loudly that it is
 * doing so. `onHold` fires on the transition alone, because a hold that
 * re-announced itself every 5 minutes would be the noise that hides it.
 */

export const ATTEMPT_BASE_MS = 500;
export const ATTEMPT_CEILING_MS = 30_000;
export const REARM_BASE_MS = 30_000;
export const REARM_CEILING_MS = 300_000;
/** The re-arm band's lower edge, as a fraction of the step. */
export const REARM_JITTER_FLOOR = 0.5;

const DEFAULT_MAX_FAILURES = 5;
const DEFAULT_WINDOW_MS = 120_000;

export interface ReconnectPolicyOptions {
  /** Failures inside `windowMs` that put the policy into the slow band. */
  readonly maxFailures?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  /** Fires once, on the transition into the slow band. */
  readonly onHold?: (failures: number) => void;
}

/** `step` doubled from `base`, capped at `ceiling`. `n` starts at 1. */
const stepMs = (base: number, ceiling: number, n: number): number =>
  Math.min(ceiling, base * 2 ** Math.max(0, n - 1));

export class ReconnectPolicy {
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onHold: ((failures: number) => void) | undefined;
  readonly #failures: number[] = [];
  #attempt = 0;
  #rearm = 0;
  #holding = false;

  constructor(options: ReconnectPolicyOptions = {}) {
    this.#maxFailures = options.maxFailures ?? DEFAULT_MAX_FAILURES;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onHold = options.onHold;
  }

  /** True while the recent-failure window is exhausted and the band is slow. */
  get holding(): boolean {
    return this.#holding;
  }

  /** How long to wait before the next attempt. Advances the band. */
  nextDelayMs(): number {
    if (this.#holding) {
      this.#rearm += 1;

      const step = stepMs(REARM_BASE_MS, REARM_CEILING_MS, this.#rearm);

      return Math.floor(
        step * (REARM_JITTER_FLOOR + (1 - REARM_JITTER_FLOOR) * this.#random()),
      );
    }

    this.#attempt += 1;

    return Math.floor(
      stepMs(ATTEMPT_BASE_MS, ATTEMPT_CEILING_MS, this.#attempt) *
        this.#random(),
    );
  }

  recordFailure(): void {
    const now = this.#now();

    while (
      this.#failures.length > 0 &&
      now - (this.#failures[0] as number) > this.#windowMs
    ) {
      this.#failures.shift();
    }

    this.#failures.push(now);

    if (this.#failures.length < this.#maxFailures || this.#holding) {
      return;
    }

    this.#holding = true;
    this.#onHold?.(this.#failures.length);
  }

  /** A connection that came up. Both bands start over. */
  recordSuccess(): void {
    this.#failures.length = 0;
    this.#attempt = 0;
    this.#rearm = 0;
    this.#holding = false;
  }
}
