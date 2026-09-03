import type { Market } from '@moi/trading-core';

export interface StartupLatch {
  close(): void | Promise<void>;
  open(): void | Promise<void>;
  isClosed?: boolean;
}
/**
 * Whether an incident is MANUAL is decided by the repository from its cause
 * code (`MANUAL_CAUSES`, spec §16.35), not by the caller: a `manual` flag here
 * was accepted and dropped by the production adapter (#64), which read as a
 * second mechanism for the same decision. There is one.
 */
export interface StartupIncident {
  activate(input: { causeCode: string; market?: Market }): Promise<unknown>;
}
export interface StartupCoordinatorOptions {
  readonly markets?: readonly Market[];
  readonly admission: StartupLatch;
  readonly matching?: StartupLatch;
  readonly restore: () => Promise<unknown>;
  readonly verifyInvariants: (state: unknown) => Promise<void> | void;
  /** Acquires the whole KR→US lease bundle (§5.4); cancellable through `signal`. */
  readonly acquireLeases: (signal: AbortSignal) => Promise<unknown>;
  readonly recover: (market: Market, signal: AbortSignal) => Promise<unknown>;
  readonly incidents: StartupIncident;
  readonly signal?: AbortSignal;
}
export class StartupCoordinator {
  readonly #o: StartupCoordinatorOptions;
  constructor(options: StartupCoordinatorOptions) {
    this.#o = options;
  }
  async open(
    signal = this.#o.signal ?? new AbortController().signal,
  ): Promise<void> {
    await this.#o.admission.close();
    await this.#o.matching?.close();
    try {
      const state = await this.#o.restore();
      await this.#o.verifyInvariants(state);
      const markets = this.#o.markets ?? ['KR', 'US'];
      await this.#o.acquireLeases(signal);
      await Promise.all(
        markets.map((market) => this.#o.recover(market, signal)),
      );
      await this.#o.matching?.open();
      await this.#o.admission.open();
    } catch (error) {
      // A cancelled lease wait (SIGTERM while ACQUIRING_LEASES) is not an
      // invariant failure and must not latch a manual incident.
      if ((error as { name?: string })?.name === 'AbortError') throw error;
      // The cause code is one of `MANUAL_CAUSES`, so the repository records a
      // MANUAL incident that no automatic recovery resolves.
      await this.#o.incidents.activate({
        causeCode: 'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
      });
      // A manual incident is deliberately not resolved or released here.
      throw error;
    }
  }
}
