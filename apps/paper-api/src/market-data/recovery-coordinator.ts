import type { Market, DecimalString, OrderBookSnapshot } from '@skipjack/trading-core';
import type { LeaderLease } from './leader-lease.js';
import { MarketStateStore } from './market-state-store.js';
import { SnapshotRateLimiter } from './snapshot-rate-limiter.js';
export interface SubscriptionDeclaration { readonly channel: 'trade' | 'orderBook'; readonly market: Market; readonly symbols: readonly string[]; }
export interface RecoverySnapshot { readonly market: Market; readonly symbol: string; readonly price: DecimalString; readonly book: OrderBookSnapshot; readonly fetchedAt: string; }
export interface MarketDataStream { connect(signal: AbortSignal): Promise<void>; declare(subscriptions: readonly SubscriptionDeclaration[]): Promise<{ accepted: readonly string[]; rejected: readonly { topic: string; reason: string }[] }>; }
export interface MarketSnapshotSource { getRecoverySnapshot(market: Market, symbol: string, signal: AbortSignal): Promise<RecoverySnapshot>; }

export interface RecoveryClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }
export interface RecoveryTrigger { readonly symbol: string; readonly recoveryFill: boolean; readonly referencePrice: DecimalString; readonly book: OrderBookSnapshot; }
export interface RecoveryOutcome { readonly market: Market; readonly epoch: bigint; readonly recoveredSymbols: readonly string[]; readonly blockedSymbols: readonly string[]; readonly recoveryTriggers: readonly RecoveryTrigger[]; }
export interface RecoveryIncidentPort { activate(input: { market: Market; symbol?: string; causeCode: string; recoveryEpoch: bigint }): Promise<unknown>; }
export interface RecoveryCoordinatorOptions {
  readonly stream: MarketDataStream;
  readonly snapshots: MarketSnapshotSource;
  readonly stateStore: MarketStateStore<unknown>;
  readonly acquireLease: (market: Market) => Promise<LeaderLease>;
  readonly symbols: readonly string[];
  readonly subscriptions: readonly SubscriptionDeclaration[];
  readonly limiter?: SnapshotRateLimiter;
  readonly clock?: RecoveryClock;
  readonly stabilityMs?: number;
  readonly incidents?: RecoveryIncidentPort;
  /** Conditions are evaluated only against the current REST snapshot. */
  readonly evaluateRecovery?: (snapshot: RecoverySnapshot) => readonly Omit<RecoveryTrigger, 'book'>[];
}

const defaultClock: RecoveryClock = { now: () => Date.now(), sleep: async (ms, signal) => {
  await new Promise<void>((resolve, reject) => { if (signal?.aborted) { reject(signal.reason); return; } const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true }); });
} };

export class RecoveryCoordinator {
  readonly #o: RecoveryCoordinatorOptions;
  constructor(options: RecoveryCoordinatorOptions) { this.#o = options; }
  async recover(market: Market, signal: AbortSignal): Promise<RecoveryOutcome> {
    const lease = await this.#o.acquireLease(market);
    const epoch = lease.epoch;
    this.#o.stateStore.beginEpoch({ recoveryEpoch: epoch, leaderFencingToken: lease.fencingToken });
    await this.#o.stream.connect(signal);
    const ack = await this.#o.stream.declare(this.#o.subscriptions);
    if (ack.rejected.length) throw new Error(`subscription rejected: ${ack.rejected.map((x) => x.topic).join(',')}`);
    const recovered: string[] = [], blocked: string[] = [], triggers: RecoveryTrigger[] = [];
    for (const symbol of this.#o.symbols) {
      try {
        await (this.#o.limiter ?? new SnapshotRateLimiter()).acquire(signal);
        const snapshot = await this.#o.snapshots.getRecoverySnapshot(market, symbol, signal);
        this.#o.stateStore.replaceBaseline(symbol, snapshot);
        recovered.push(symbol);
        for (const trigger of this.#o.evaluateRecovery?.(snapshot) ?? []) triggers.push({ ...trigger, book: snapshot.book });
      } catch (error) {
        blocked.push(symbol);
        if (this.#o.incidents) await this.#o.incidents.activate({ market, symbol, causeCode: 'RECOVERY_SNAPSHOT_FAILED', recoveryEpoch: epoch });
      }
    }
    if (this.#o.stabilityMs ?? 5000) await (this.#o.clock ?? defaultClock).sleep(this.#o.stabilityMs ?? 5000, signal);
    return { market, epoch, recoveredSymbols: recovered, blockedSymbols: blocked, recoveryTriggers: triggers };
  }
}
