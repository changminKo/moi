export type RuntimeState =
  | 'BOOTING'
  | 'RESTORING'
  | 'ACQUIRING_LEASES'
  | 'RECOVERING'
  | 'SERVING'
  | 'RE_ELECTING'
  | 'DRAINING'
  | 'STOPPED'
  | 'FAILED_CLOSED';

export type LeaveServingTarget = 'RE_ELECTING' | 'DRAINING';

export interface RuntimeStateObserver {
  /** Synchronous; the runtime records audit/metrics from it asynchronously. */
  onTransition(from: RuntimeState, to: RuntimeState): void;
}

export interface ServingPublisher {
  /** Total function: must not throw, await, or call injected dependencies. */
  start(): void;
  /** Synchronous, idempotent; returns the in-flight poll (if any). */
  pauseScheduling(): Promise<unknown> | null;
}

export interface ServingHooks {
  readonly openLatches: () => void;
  readonly closeLatches: () => void;
  readonly publisher: ServingPublisher;
}

export interface StreamGate {
  isOpen(): boolean;
}

/**
 * Process lifecycle state. `enterServing` / `leaveServing` are deliberately
 * synchronous so no I/O event can observe "SERVING but publisher stopped"
 * (or the reverse): the stream gate is derived from `current`, and the
 * publisher flips inside the same synchronous stack.
 */
export class RuntimeStateMachine {
  readonly #hooks: ServingHooks;
  readonly #observer: RuntimeStateObserver | undefined;
  #current: RuntimeState = 'BOOTING';
  #leftFrom: RuntimeState | undefined;
  #pendingPoll: Promise<unknown> | null = null;

  constructor(hooks: ServingHooks, observer?: RuntimeStateObserver) {
    this.#hooks = hooks;
    this.#observer = observer;
  }

  get current(): RuntimeState {
    return this.#current;
  }

  get leftFrom(): RuntimeState | undefined {
    return this.#leftFrom;
  }

  get pendingPoll(): Promise<unknown> | null {
    return this.#pendingPoll;
  }

  gate(): StreamGate {
    return { isOpen: () => this.#current === 'SERVING' };
  }

  transition(to: RuntimeState): void {
    const from = this.#current;
    this.#current = to;
    this.#observer?.onTransition(from, to);
  }

  enterServing(): void {
    this.transition('SERVING');
    this.#hooks.openLatches();
    this.#hooks.publisher.start();
  }

  leaveServing(to: LeaveServingTarget): Promise<unknown> | null {
    this.#leftFrom = this.#current;
    this.transition(to);
    this.#hooks.closeLatches();
    this.#pendingPoll = this.#hooks.publisher.pauseScheduling();
    return this.#pendingPoll;
  }
}
