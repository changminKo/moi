import type { Market } from '@skipjack/trading-core';
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
  async markHealthy(epoch: bigint): Promise<boolean> {
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
    if (this.#state === 'HEALTHY') this.#state = 'DEGRADED';
    if (!this.#incident)
      this.#incident = await this.#incidents.activate({
        market: this.market,
        causeCode,
        recoveryEpoch: null,
      });
  }
}
