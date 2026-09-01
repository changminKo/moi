import type {
  MarketDataStream,
  MarketEvent,
  MarketSnapshotSource,
  TokenProvider,
} from '@moi/market-data';
import { reconnectDelayMs } from '@moi/market-data';
import type { Market, OrderBookSnapshot } from '@moi/trading-core';
import type { MarketHealthMachine } from '../market-data/health-machine.js';
import type { LeaderLease } from '../market-data/leader-lease.js';
import type {
  MarketEnvelope,
  MarketStateStore,
} from '../market-data/market-state-store.js';
import {
  type RecoveryClock,
  RecoveryCoordinator,
  type RecoveryOutcome,
  type SubscriptionDeclaration,
} from '../market-data/recovery-coordinator.js';
import {
  type SymbolQuoteState,
  withBook,
  withTrade,
} from '../market-data/symbol-quote-state.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { ReconnectSupervisor } from './reconnect-supervisor.js';

export const KEEPALIVE_INTERVAL_MS = 60_000;
export const PONG_TIMEOUT_MS = 30_000;
export const REJECTION_BURST_LIMIT = 20;

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface MarketIncidentPort {
  activate(input: {
    readonly market: Market;
    readonly causeCode: string;
    readonly symbol?: string;
    readonly recoveryEpoch: bigint | null;
    readonly manual?: boolean;
  }): Promise<unknown>;
}

export interface MarketEngine {
  onTrade(envelope: MarketEnvelope<unknown>): Promise<void>;
  onOrderBook(envelope: MarketEnvelope<OrderBookSnapshot>): Promise<void>;
  onRecoveryOrderBook(
    envelope: MarketEnvelope<OrderBookSnapshot>,
  ): Promise<void>;
}

export interface QuotePublisher {
  publishQuote(event: {
    readonly market: Market;
    readonly symbol: string;
    readonly recoveryEpoch: bigint;
    readonly marketDataVersion: bigint;
    readonly payload: unknown;
  }): void;
}

export interface MarketRuntimeDeps {
  readonly market: Market;
  readonly stream: MarketDataStream;
  readonly snapshots: MarketSnapshotSource;
  readonly tokenProvider?: TokenProvider;
  readonly stateStore: MarketStateStore<unknown>;
  readonly health: MarketHealthMachine;
  readonly engine: MarketEngine;
  readonly hub: QuotePublisher;
  readonly incidents: MarketIncidentPort;
  readonly leases: { held(market: Market): LeaderLease };
  readonly symbols: readonly string[];
  readonly subscriptions: readonly SubscriptionDeclaration[];
  readonly stabilityMs: number;
  readonly metrics: MetricsRegistry;
  readonly log: LogFn;
  readonly clock?: RecoveryClock;
  readonly reconnectDelayMs?: (attempt: number) => number;
  readonly keepaliveIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  /** Fired when this market's provider transport opens or closes (§12.2 gauge). */
  readonly onTransport?: (state: 'connected' | 'closed') => void;
}

type ProviderFailure = { readonly statusCode?: number; readonly code?: string };

/** §8.2 / §8.4 mapping of adapter failures to market incident cause codes. */
export function causeCodeFor(error: unknown): string {
  const failure = (error ?? {}) as ProviderFailure;
  if (failure.statusCode === 401 || failure.code === 'AUTH_FAILED')
    return failure.statusCode === 403
      ? 'PROVIDER_IP_NOT_ALLOWED'
      : 'PROVIDER_AUTH_FAILED';
  if (failure.statusCode === 403) return 'PROVIDER_IP_NOT_ALLOWED';
  if (failure.statusCode === 429 || failure.code === 'RATE_LIMITED')
    return 'PROVIDER_RATE_LIMITED';
  if (failure.code === 'SUBSCRIPTION_REJECTED') return 'SUBSCRIPTION_REJECTED';
  if (failure.code === 'TRANSPORT_CLOSED') return 'TRANSPORT_CLOSED';
  if (failure.code === 'PONG_FAILED') return 'PONG_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  if (/subscription rejected/i.test(message)) return 'SUBSCRIPTION_REJECTED';
  if (/ECONN|ENOTFOUND|EAI_AGAIN|connect/i.test(message))
    return 'PROVIDER_CONNECT_FAILED';
  return 'PROVIDER_UNAVAILABLE';
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string })?.name === 'AbortError';
}

function isInvariantFailure(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return (
    code === 'INVARIANT_VIOLATION' || code === 'TRANSACTIONAL_AUDIT_FAILURE'
  );
}

/**
 * Everything one market owns at runtime (§4): the provider stream, health
 * machine, state store, supervised recovery, event loop, keepalive, and the
 * market-local reconnect supervisor. Lease acquisition is *not* here — the
 * lease is looked up through `leases.held(market)` (§5.4).
 */
export class MarketRuntime {
  readonly #d: MarketRuntimeDeps;
  readonly #recovery: RecoveryCoordinator;
  readonly supervisor: ReconnectSupervisor;
  #controller = new AbortController();
  #keepalive: ReturnType<typeof setInterval> | null = null;
  #rejections = 0;
  #recovering = false;
  #connectedOnce = false;
  #loop: Promise<void> | null = null;

  constructor(deps: MarketRuntimeDeps) {
    this.#d = deps;
    this.#recovery = new RecoveryCoordinator({
      stream: deps.stream,
      snapshots: deps.snapshots,
      stateStore: deps.stateStore,
      acquireLease: async (market) => deps.leases.held(market),
      symbols: deps.symbols,
      subscriptions: deps.subscriptions,
      stabilityMs: deps.stabilityMs,
      incidents: {
        activate: (input) =>
          deps.incidents.activate({
            market: input.market,
            causeCode: input.causeCode,
            recoveryEpoch: input.recoveryEpoch,
            ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
          }),
      },
      ...(deps.clock ? { clock: deps.clock } : {}),
    });
    this.supervisor = new ReconnectSupervisor({
      delayMs:
        deps.reconnectDelayMs ?? ((attempt) => reconnectDelayMs(attempt)),
      onExhausted: async () => {
        await deps.incidents.activate({
          market: deps.market,
          causeCode: 'RECOVERY_RETRY_EXHAUSTED',
          recoveryEpoch: null,
          manual: true,
        });
        deps.log('recovery.exhausted', { market: deps.market });
      },
    });
  }

  get health(): MarketHealthMachine {
    return this.#d.health;
  }

  /**
   * Supervised recovery (§8.2): provider failures become incidents plus a
   * scheduled retry and resolve normally; aborts and invariant failures throw.
   */
  async connect(signal: AbortSignal): Promise<void> {
    if (this.#controller.signal.aborted)
      this.#controller = new AbortController();
    const onAbort = (): void => this.#controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.#recoverOnce();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  abort(): void {
    this.#controller.abort();
    this.supervisor.cancel();
    this.#stopKeepalive();
  }

  async close(): Promise<void> {
    this.abort();
    await this.#d.stream.close().catch(() => undefined);
    await this.#loop?.catch(() => undefined);
  }

  /** Called after an operator resolves RECOVERY_RETRY_EXHAUSTED. */
  resumeRetries(): void {
    this.supervisor.resume();
    this.supervisor.schedule(() => this.#recoverOnce(), { immediate: true });
  }

  async #recoverOnce(): Promise<boolean> {
    if (this.#recovering) return false;
    this.#recovering = true;
    const signal = this.#controller.signal;
    const startedAt = Date.now();
    this.#d.health.beginRecovery();
    this.#d.log('recovery.start', { market: this.#d.market });
    try {
      const outcome = await this.#recovery.recover(this.#d.market, signal);
      if (signal.aborted)
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      await this.#applyRecovery(outcome);
      this.#d.metrics.gauge(
        'recovery_duration_seconds',
        (Date.now() - startedAt) / 1000,
        { market: this.#d.market },
      );
      this.#d.metrics.gauge('leader_epoch', Number(outcome.epoch), {
        market: this.#d.market,
      });
      if (this.#connectedOnce)
        this.#d.metrics.counter('feed_reconnect_total', {
          market: this.#d.market,
        });
      this.#connectedOnce = true;
      this.#d.log('recovery.complete', {
        market: this.#d.market,
        epoch: outcome.epoch.toString(),
        recovered: outcome.recoveredSymbols,
        blocked: outcome.blockedSymbols,
      });
      this.#startLoop();
      this.#startKeepalive();
      this.#d.onTransport?.('connected');
      return true;
    } catch (error) {
      if (isAbort(error) || signal.aborted) throw error;
      if (isInvariantFailure(error)) throw error;
      const causeCode = causeCodeFor(error);
      this.#d.log('recovery.failed', {
        market: this.#d.market,
        causeCode,
        error: error instanceof Error ? error.message : String(error),
      });
      // The health machine activates the MARKET incident (once per degrade).
      await this.#d.health.onClose(causeCode);
      const exhausted = this.supervisor.recordFailure();
      if (!exhausted) this.supervisor.schedule(() => this.#recoverOnce());
      return false;
    } finally {
      this.#recovering = false;
    }
  }

  async #applyRecovery(outcome: RecoveryOutcome): Promise<void> {
    const store = this.#d.stateStore;
    // Every recovered REST baseline becomes the engine's book for that symbol,
    // labelled RECOVERY_REST so any fill it produces is a recovery fill. Without
    // it, resting orders would wait for the first live frame after a reconnect.
    for (const symbol of outcome.recoveredSymbols) {
      const snapshot = store.get(symbol) as
        | { book?: OrderBookSnapshot }
        | undefined;
      if (snapshot?.book === undefined) continue;
      await this.#d.engine.onRecoveryOrderBook({
        recoveryEpoch: store.recoveryEpoch,
        leaderFencingToken: store.leaderFencingToken,
        marketDataVersion: store.currentVersion,
        payload: snapshot.book,
      });
    }
    for (const trigger of outcome.recoveryTriggers) {
      await this.#d.engine.onRecoveryOrderBook({
        recoveryEpoch: store.recoveryEpoch,
        leaderFencingToken: store.leaderFencingToken,
        marketDataVersion: store.currentVersion,
        payload: trigger.book,
      });
    }
    await this.#d.health.markHealthy(outcome.epoch);
  }

  #startLoop(): void {
    const signal = this.#controller.signal;
    this.#rejections = 0;
    this.#loop = (async () => {
      try {
        for await (const event of this.#d.stream.events(signal)) {
          if (signal.aborted) return;
          if (event.kind === 'transportClosed') {
            await this.#onTransportClosed(event.reason);
            return;
          }
          await this.#dispatch(event);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.#d.log('market.loop_failed', {
          market: this.#d.market,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.#onTransportClosed('EVENT_LOOP_FAILED');
      }
    })();
  }

  async #dispatch(event: MarketEvent): Promise<void> {
    const store = this.#d.stateStore;
    try {
      if (event.kind === 'trade') {
        // The slot keeps both shapes (`SymbolQuoteState`); the engine keeps
        // receiving the trade on its own, as its envelope contract expects.
        const envelope = store.applyEvent({
          symbol: event.symbol,
          version: store.currentVersion + 1n,
          payload: withTrade(
            store.get(event.symbol) as SymbolQuoteState | undefined,
            {
              price: event.price,
              sourceTimestamp: event.sourceTimestamp,
            },
          ),
        });
        await this.#d.engine.onTrade({
          ...envelope,
          payload: {
            market: event.market,
            symbol: event.symbol,
            price: event.price,
            sourceTimestamp: event.sourceTimestamp,
          },
        });
      } else if (event.kind === 'orderBook') {
        const stored = store.applyEvent({
          symbol: event.symbol,
          version: store.currentVersion + 1n,
          payload: withBook(
            store.get(event.symbol) as SymbolQuoteState | undefined,
            event.book,
          ),
        });
        const envelope = {
          ...stored,
          payload: event.book,
        } as MarketEnvelope<OrderBookSnapshot>;
        await this.#d.engine.onOrderBook(envelope);
        this.#d.hub.publishQuote({
          market: event.market,
          symbol: event.symbol,
          recoveryEpoch: envelope.recoveryEpoch,
          marketDataVersion: envelope.marketDataVersion,
          payload: event.book,
        });
      }
      this.#rejections = 0;
    } catch (error) {
      this.#rejections += 1;
      const reason =
        (error as { code?: string })?.code === 'ORDER_STATE_CONFLICT'
          ? 'stale'
          : (error as { code?: string })?.code === 'UNSUPPORTED_DATA'
            ? 'unsupported'
            : 'engine';
      this.#d.metrics.counter('market_event_rejected_total', {
        market: this.#d.market,
        reason,
      });
      if (this.#rejections >= REJECTION_BURST_LIMIT) {
        this.#rejections = 0;
        await this.#d.health.onClose('EVENT_REJECTION_BURST');
        await this.#closeTransport();
      }
    }
  }

  async #onTransportClosed(reason: string): Promise<void> {
    this.#stopKeepalive();
    this.#d.onTransport?.('closed');
    if (this.#controller.signal.aborted) return;
    this.#d.log('provider.close', { market: this.#d.market, reason });
    // Any transport loss is TRANSPORT_CLOSED (§8.4); the provider's reason is
    // kept in the log, and burst/pong degrades already carry their own code.
    const causeCode =
      reason === 'EVENT_REJECTION_BURST' || reason === 'EVENT_LOOP_FAILED'
        ? reason
        : 'TRANSPORT_CLOSED';
    await this.#d.health.onClose(causeCode);
    this.supervisor.schedule(() => this.#recoverOnce(), {
      serverShutdown: reason === 'server-shutdown',
    });
  }

  #startKeepalive(): void {
    this.#stopKeepalive();
    const interval = this.#d.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
    const timeout = this.#d.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.#keepalive = setInterval(() => {
      void this.#ping(timeout);
    }, interval);
  }

  async #ping(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PONG_TIMEOUT')), timeoutMs);
    });
    try {
      const latency = await Promise.race([this.#d.stream.ping(), timeout]);
      this.#d.metrics.gauge('feed_ping_latency_seconds', latency / 1000);
      await this.#d.health.onPong(true);
    } catch {
      await this.#d.health.onPong(false);
      if (this.#d.health.state !== 'HEALTHY') {
        await this.#closeTransport();
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Closes the provider socket; the resulting transportClosed event drives degrade + retry. */
  async #closeTransport(): Promise<void> {
    this.#stopKeepalive();
    await this.#d.stream.close().catch(() => undefined);
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== null) clearInterval(this.#keepalive);
    this.#keepalive = null;
  }
}
