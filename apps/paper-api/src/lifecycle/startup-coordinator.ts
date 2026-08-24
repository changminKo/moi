import type { Market } from '@skipjack/trading-core';
import type { LeaderLease } from '../market-data/leader-lease.js';

export interface StartupLatch {
  close(): void | Promise<void>;
  open(): void | Promise<void>;
  isClosed?: boolean;
}
export interface StartupIncident {
  activate(input: {
    causeCode: string;
    market?: Market;
    manual: boolean;
  }): Promise<unknown>;
}
export interface StartupCoordinatorOptions {
  readonly markets?: readonly Market[];
  readonly admission: StartupLatch;
  readonly matching?: StartupLatch;
  readonly restore: () => Promise<unknown>;
  readonly verifyInvariants: (state: unknown) => Promise<void> | void;
  readonly acquireLease: (market: Market) => Promise<LeaderLease>;
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
      await Promise.all(markets.map((market) => this.#o.acquireLease(market)));
      await Promise.all(
        markets.map((market) => this.#o.recover(market, signal)),
      );
      await this.#o.matching?.open();
      await this.#o.admission.open();
    } catch (error) {
      await this.#o.incidents.activate({
        causeCode: 'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
        manual: true,
      });
      // A manual incident is deliberately not resolved or released here.
      throw error;
    }
  }
}
