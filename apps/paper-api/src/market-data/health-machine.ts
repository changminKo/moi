import type { Market } from '@moi/trading-core';
export interface SubscriptionAck {
  readonly accepted: readonly string[];
  readonly rejected: readonly {
    readonly topic: string;
    readonly reason: string;
  }[];
}

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'RECOVERING';
export interface HealthClock {
  now(): number;
}
export interface IncidentPort {
  activate(input: {
    market: Market;
    causeCode: string;
    recoveryEpoch: bigint | null;
  }): Promise<{ incidentId: string; version: bigint }>;
  resolveCas?(input: {
    incidentId: string;
    version: bigint;
    recoveryEpoch: bigint;
  }): Promise<boolean>;
  /**
   * Resolves every automatically-resolvable ACTIVE incident this market owns
   * in the ledger — including rows a previous process opened — and answers
   * with the cause codes a healthy feed is not allowed to clear (§16.35).
   */
  resolveMarketIncidents?(input: {
    market: Market;
    recoveryEpoch: bigint;
  }): Promise<readonly string[]>;
}

export interface HealthMachineOptions {
  readonly market: Market;
  readonly incidents: IncidentPort;
  readonly clock?: HealthClock;
  readonly missedPongs?: number;
}

/** Pure, edge-triggered feed health state machine. It owns no timers. */
export class MarketHealthMachine {
  readonly market: Market;
  readonly #incidents: IncidentPort;
  readonly #clock: HealthClock;
  readonly #missedPongs: number;
  #state: HealthState = 'HEALTHY';
  #misses = 0;
  #incident: { incidentId: string; version: bigint } | undefined;
  #activating: Promise<{ incidentId: string; version: bigint }> | undefined;

  constructor(options: HealthMachineOptions) {
    this.market = options.market;
    this.#incidents = options.incidents;
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#missedPongs = options.missedPongs ?? 2;
  }
  get state(): HealthState {
    return this.#state;
  }
  get incidentId(): string | undefined {
    return this.#incident?.incidentId;
  }
  get missedPongs(): number {
    return this.#misses;
  }

  async onClose(reason = 'TRANSPORT_CLOSED'): Promise<void> {
    await this.degrade(reason);
  }
  async onSubscriptionAck(ack: SubscriptionAck): Promise<void> {
    if (ack.rejected.length > 0) await this.degrade('SUBSCRIPTION_REJECTED');
  }
  async onPong(success: boolean): Promise<void> {
    if (success) {
      this.#misses = 0;
      return;
    }
    this.#misses += 1;
    if (this.#misses >= this.#missedPongs) await this.degrade('PONG_FAILED');
  }
  beginRecovery(): void {
    if (this.#state !== 'HEALTHY') this.#state = 'RECOVERING';
  }
  /**
   * The feed is back at `epoch`. Answers whether the market is also clear of
   * the incidents that gate placement — the feed state itself always returns
   * to HEALTHY, because it is what decides whether to close the transport.
   */
  async markHealthy(epoch: bigint): Promise<boolean> {
    const resolveMarket = this.#incidents.resolveMarketIncidents;
    if (resolveMarket !== undefined) {
      // The ledger rows outlive this process, so a recovery resolves what the
      // market owns rather than only what this instance happens to remember.
      const remaining = await resolveMarket.call(this.#incidents, {
        market: this.market,
        recoveryEpoch: epoch,
      });
      this.#incident = undefined;
      this.#state = 'HEALTHY';
      this.#misses = 0;
      return remaining.length === 0;
    }
    if (!this.#incident || !this.#incidents.resolveCas) {
      this.#state = 'HEALTHY';
      this.#misses = 0;
      return true;
    }
    const resolved = await this.#incidents.resolveCas({
      incidentId: this.#incident.incidentId,
      version: this.#incident.version,
      recoveryEpoch: epoch,
    });
    if (resolved) {
      this.#incident = undefined;
      this.#state = 'HEALTHY';
      this.#misses = 0;
    }
    return resolved;
  }
  private async degrade(causeCode: string): Promise<void> {
    // A failed recovery attempt drops RECOVERING back to DEGRADED (§6.2).
    if (this.#state !== 'DEGRADED') this.#state = 'DEGRADED';
    if (this.#incident) return;
    // The keepalive ping and the event loop degrade the same market from
    // different tasks. Checking `#incident` and assigning it across an await
    // let both through, and the loser's row was then tracked by nobody and
    // stayed ACTIVE forever; the second caller joins the first activation
    // instead (one incident per degrade, §8.4).
    this.#activating ??= this.#incidents.activate({
      market: this.market,
      causeCode,
      recoveryEpoch: null,
    });
    const activating = this.#activating;
    try {
      this.#incident = await activating;
    } finally {
      if (this.#activating === activating) this.#activating = undefined;
    }
  }
}
