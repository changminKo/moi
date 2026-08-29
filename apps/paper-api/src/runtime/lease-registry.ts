import type { Market } from '@moi/trading-core';
import {
  AbortError,
  LeaderLease,
  type LeaseAuditPort,
  type LeaseConnection,
} from '../market-data/leader-lease.js';
import type { MetricsRegistry } from '../observability/metrics.js';

/** Fixed acquisition order; both processes contend for the same lock first (§3.11). */
export const LEASE_BUNDLE_ORDER: readonly Market[] = ['KR', 'US'];

export type LeasePhase = 'SERVING' | 'RECOVERING' | 'ACQUIRING';
export type LeaseBundle = Readonly<Record<Market, LeaderLease>>;

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export class LeaseNotHeldError extends Error {
  constructor(readonly market: Market) {
    super(`leader lease for ${market} is not held`);
    this.name = 'LeaseNotHeldError';
  }
}

export class LeaseLostError extends Error {
  constructor(readonly market: Market) {
    super(`leader lease for ${market} was lost during acquisition`);
    this.name = 'LeaseLostError';
  }
}

export interface LeaseRegistryDeps {
  readonly connectionString: string;
  readonly leaderId: string;
  readonly audit: LeaseAuditPort;
  /** Unintentional loss of a HELD lease in a completed bundle → global re-election. */
  readonly onLostHeld: (market: Market) => void;
  readonly phase: () => LeasePhase;
  readonly log: LogFn;
  readonly metrics: MetricsRegistry;
  readonly clientFactory?: () => Promise<LeaseConnection>;
  readonly pollIntervalMs?: number;
}

interface Generation {
  readonly generation: number;
  readonly controller: AbortController;
  pending: Market | null;
  held: LeaderLease[];
  lostMarket: Market | null;
  promise: Promise<LeaseBundle>;
  settled: boolean;
  reelected: boolean;
}

/**
 * Owns the KR+US lease bundle (§5.4). `acquireAll` is the only acquisition
 * API: markets are acquired strictly in `LEASE_BUNDLE_ORDER`, a partial bundle
 * is released in reverse on abort/failure, and a held lease that dies is
 * promoted at most once per generation — to `onLostHeld` when the bundle was
 * complete, or to a `LeaseLostError` rejection when it was still pending.
 */
export class LeaseRegistry {
  readonly #deps: LeaseRegistryDeps;
  #current: Generation | null = null;
  #bundle: Map<Market, LeaderLease> = new Map();
  #nextGeneration = 0;

  constructor(deps: LeaseRegistryDeps) {
    this.#deps = deps;
  }

  get pending(): Market | null {
    return this.#current?.pending ?? null;
  }

  get generation(): number {
    return this.#current?.generation ?? this.#nextGeneration;
  }

  acquireAll(signal: AbortSignal): Promise<LeaseBundle> {
    if (this.#current !== null && !this.#current.settled)
      return this.#current.promise;
    this.#nextGeneration += 1;
    const controller = new AbortController();
    const generation: Generation = {
      generation: this.#nextGeneration,
      controller,
      pending: null,
      held: [],
      lostMarket: null,
      promise: Promise.resolve({} as LeaseBundle),
      settled: false,
      reelected: false,
    };
    const forward = (): void => controller.abort();
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
    generation.promise = this.#run(generation).finally(() => {
      generation.settled = true;
      signal.removeEventListener('abort', forward);
    });
    this.#current = generation;
    return generation.promise;
  }

  held(market: Market): LeaderLease {
    const lease = this.#bundle.get(market);
    if (lease === undefined) throw new LeaseNotHeldError(market);
    return lease;
  }

  async abortPending(): Promise<void> {
    const generation = this.#current;
    if (generation === null || generation.settled) return;
    generation.controller.abort();
    await generation.promise.catch(() => undefined);
  }

  async releaseAll(): Promise<void> {
    const leases = [...this.#bundle.values()];
    this.#bundle = new Map();
    for (const market of [...LEASE_BUNDLE_ORDER].reverse()) {
      const lease = leases.find((l) => l.market === market);
      if (lease === undefined) continue;
      await lease.release();
      this.#deps.metrics.gauge('leader_lease_held', 0, { market });
    }
  }

  async #run(generation: Generation): Promise<LeaseBundle> {
    const { controller } = generation;
    try {
      for (const market of LEASE_BUNDLE_ORDER) {
        if (controller.signal.aborted) throw new AbortError();
        generation.pending = market;
        const lease = await LeaderLease.acquire(market, {
          connectionString: this.#deps.connectionString,
          leaderId: this.#deps.leaderId,
          signal: controller.signal,
          audit: this.#deps.audit,
          onLost: (lost) => this.#onLost(generation, lost),
          log: this.#deps.log,
          metrics: this.#deps.metrics,
          ...(this.#deps.clientFactory
            ? { clientFactory: this.#deps.clientFactory }
            : {}),
          ...(this.#deps.pollIntervalMs !== undefined
            ? { pollIntervalMs: this.#deps.pollIntervalMs }
            : {}),
        });
        generation.held.push(lease);
        generation.pending = null;
        if (generation.lostMarket !== null) throw new AbortError();
      }
      const bundle = new Map<Market, LeaderLease>();
      for (const lease of generation.held) bundle.set(lease.market, lease);
      this.#bundle = bundle;
      return Object.freeze(
        Object.fromEntries(bundle) as Record<Market, LeaderLease>,
      );
    } catch (error) {
      generation.pending = null;
      await this.#releasePartial(generation);
      if (generation.lostMarket !== null)
        throw new LeaseLostError(generation.lostMarket);
      throw error;
    }
  }

  async #releasePartial(generation: Generation): Promise<void> {
    const held = generation.held.splice(0).reverse();
    for (const lease of held) {
      if (lease.isHeld) {
        await lease.release();
        this.#deps.log('lease.partial_released', {
          market: lease.market,
          epoch: lease.epoch.toString(),
          leaderId: this.#deps.leaderId,
        });
      } else {
        await lease.release(); // LOST → connection close only
      }
    }
  }

  #onLost(generation: Generation, market: Market): void {
    const phase = this.#deps.phase();
    this.#deps.metrics.counter('lease_lost_total', { market, phase });
    if (!generation.settled) {
      // Partial bundle: abort this generation; the supervisor starts a new one.
      if (generation.lostMarket === null) {
        generation.lostMarket = market;
        generation.controller.abort();
      }
      return;
    }
    if (!this.#bundle.has(market)) return;
    if (generation.reelected) return;
    generation.reelected = true;
    this.#deps.metrics.counter('leader_reelection_total', { market });
    this.#deps.onLostHeld(market);
  }
}
