/**
 * The reference `MarketDataStream`: an explicitly scripted feed.
 *
 * Every fault this package must survive is a method call here — emit, drop,
 * reorder, close, subscription-ACK rejection, PONG failure, and the default
 * no-initial-snapshot handshake. Nothing is timing-driven and nothing is
 * random, so a test that reproduces a fault reproduces it every run.
 */
import type { Market, OrderBookSnapshot } from '@skipjack/trading-core';
import type { MarketDataStream } from './ports.js';
import {
  declaredTopicKeys,
  MarketDataError,
  type MarketEvent,
  readDecimalString,
  readOptionalTimestamp,
  readOrderBookSnapshot,
  type SubscriptionAck,
  type SubscriptionDeclaration,
  type SubscriptionRejection,
  subscriptionTopicKey,
} from './types.js';

export interface FakeTradeInput {
  readonly market: Market;
  readonly symbol: string;
  readonly price: string;
  readonly volume: string;
  readonly sourceTimestamp: string | null;
}

export interface FakeOrderBookInput {
  readonly market: Market;
  readonly symbol: string;
  readonly book: OrderBookSnapshot;
  readonly sourceTimestamp: string | null;
}

/**
 * `NONE` models the feeds this package actually consumes: declaring a topic
 * yields nothing until the provider pushes. `ON_DECLARE` exists for a provider
 * that does replay a baseline — and even then the fake replays only a baseline
 * that was explicitly seeded, so no snapshot is ever invented.
 */
export type FakeInitialSnapshotMode = 'NONE' | 'ON_DECLARE';

/**
 * Counts concurrently open fake connections across every `FakeMarketData`
 * that shares it, mirroring the provider's per-account connection limit.
 */
export class FakeConnectionLedger {
  #open = 0;
  #peak = 0;
  #connects = 0;
  get open(): number {
    return this.#open;
  }
  get peak(): number {
    return this.#peak;
  }
  get connects(): number {
    return this.#connects;
  }
  opened(): void {
    this.#open += 1;
    this.#connects += 1;
    this.#peak = Math.max(this.#peak, this.#open);
  }
  closed(): void {
    this.#open = Math.max(0, this.#open - 1);
  }
}

export interface FakeMarketDataOptions {
  readonly now?: () => string;
  readonly initialSnapshot?: FakeInitialSnapshotMode;
  readonly pingLatencyMs?: number;
  readonly ledger?: FakeConnectionLedger;
}

type EventWaiter = (event: MarketEvent | undefined) => void;

const DEFAULT_PING_LATENCY_MS = 1;

export class FakeMarketData implements MarketDataStream {
  readonly #now: () => string;
  readonly #initialSnapshot: FakeInitialSnapshotMode;
  readonly #pingLatencyMs: number;
  readonly #ledger: FakeConnectionLedger | undefined;

  readonly #log: MarketEvent[] = [];
  readonly #pending: MarketEvent[] = [];
  readonly #waiters: EventWaiter[] = [];
  readonly #declared = new Set<string>();
  readonly #topicRejections = new Map<string, string>();
  readonly #baselines = new Map<string, FakeOrderBookInput>();

  #connected = false;
  #closed = false;
  #dropRemaining = 0;
  #pongFailuresRemaining = 0;

  constructor(options: FakeMarketDataOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#initialSnapshot = options.initialSnapshot ?? 'NONE';
    this.#pingLatencyMs = options.pingLatencyMs ?? DEFAULT_PING_LATENCY_MS;
    this.#ledger = options.ledger;
  }

  // --- MarketDataStream -----------------------------------------------------

  async connect(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    // A reconnect starts from nothing declared: adapters replace the whole
    // subscription set on every connection rather than resuming one.
    this.#declared.clear();
    if (!this.#connected) this.#ledger?.opened();
    this.#connected = true;
    this.#closed = false;
  }

  async declare(
    subscriptions: readonly SubscriptionDeclaration[],
  ): Promise<SubscriptionAck> {
    this.#assertConnected();

    const accepted: string[] = [];
    const rejected: SubscriptionRejection[] = [];

    this.#declared.clear();

    for (const topic of declaredTopicKeys(subscriptions)) {
      const reason = this.#topicRejections.get(topic);

      if (reason === undefined) {
        this.#declared.add(topic);
        accepted.push(topic);
        continue;
      }

      rejected.push({ topic, reason });
    }

    this.#topicRejections.clear();

    if (this.#initialSnapshot === 'ON_DECLARE') {
      for (const topic of accepted) {
        const baseline = this.#baselines.get(topic);

        if (baseline !== undefined) {
          this.#publishOrderBook(baseline);
        }
      }
    }

    return { accepted, rejected };
  }

  async *events(signal?: AbortSignal): AsyncIterable<MarketEvent> {
    while (true) {
      if (signal?.aborted === true) {
        return;
      }

      const queued = this.#pending.shift();

      if (queued !== undefined) {
        yield queued;
        continue;
      }

      if (this.#closed) {
        return;
      }

      const event = await this.#waitForEvent(signal);

      if (event === undefined) {
        return;
      }

      yield event;
    }
  }

  async ping(): Promise<number> {
    this.#assertConnected();

    if (this.#pongFailuresRemaining > 0) {
      this.#pongFailuresRemaining -= 1;
      throw new MarketDataError('PONG_FAILED', 'the transport sent no PONG');
    }

    return this.#pingLatencyMs;
  }

  async close(): Promise<void> {
    if (this.#connected) this.#ledger?.closed();
    this.#connected = false;
    this.#closed = true;
    this.#releaseWaiters();
  }

  // --- Scripting ------------------------------------------------------------

  /** Records the baseline an `ON_DECLARE` provider would replay. */
  seedOrderBook(input: FakeOrderBookInput): void {
    this.#baselines.set(
      subscriptionTopicKey('orderBook', input.market, input.symbol),
      input,
    );
  }

  emitTrade(input: FakeTradeInput): void {
    this.#assertConnected();

    const price = readDecimalString(input.price, 'trade price');
    const volume = readDecimalString(input.volume, 'trade volume');
    const sourceTimestamp = readOptionalTimestamp(
      input.sourceTimestamp,
      'trade sourceTimestamp',
    );

    this.#assertDeclared('trade', input.market, input.symbol);

    if (this.#consumeDrop()) {
      return;
    }

    this.#publish({
      kind: 'trade',
      market: input.market,
      symbol: input.symbol,
      price,
      volume,
      sourceTimestamp,
      receivedAt: this.#now(),
    });
  }

  emitOrderBook(input: FakeOrderBookInput): void {
    this.#assertConnected();
    this.#assertDeclared('orderBook', input.market, input.symbol);
    this.#publishOrderBook(input);
  }

  /**
   * Delivers trades in the given arrival order regardless of their source
   * timestamps. The normalized stream must hand them on in arrival order: with
   * no provider sequence there is nothing to resequence them by.
   */
  emitOutOfOrder(inputs: readonly FakeTradeInput[]): void {
    for (const input of inputs) {
      this.emitTrade(input);
    }
  }

  /** Silently discards the next `count` data messages, as a LOSSY feed does. */
  dropNext(count: number): void {
    this.#dropRemaining += count;
  }

  /** Fails the next `count` pings, without closing the transport itself. */
  failNextPongs(count: number): void {
    this.#pongFailuresRemaining += count;
  }

  /** Rejects these topic keys on the next `declare` and only that one. */
  rejectTopics(topics: readonly string[]): void {
    for (const topic of topics) {
      this.#topicRejections.set(topic, 'topic rejected by the fake provider');
    }
  }

  /** The provider hung up: the last event, then the end of the stream. */
  emitTransportClosed(reason: string): void {
    this.#assertConnected();

    const event: MarketEvent = {
      kind: 'transportClosed',
      market: this.#closedMarket(),
      reason,
      receivedAt: this.#now(),
    };

    if (this.#connected) this.#ledger?.closed();
    this.#connected = false;
    this.#closed = true;
    this.#log.push(event);

    const waiter = this.#waiters.shift();

    if (waiter !== undefined) {
      waiter(event);
    } else {
      this.#pending.push(event);
    }

    this.#releaseWaiters();
  }

  // --- Inspection -----------------------------------------------------------

  /** Every event this fake produced, in production order. */
  receivedEvents(): readonly MarketEvent[] {
    return [...this.#log];
  }

  /** The next produced event, for tests that do not drive `events()`. */
  async next(): Promise<MarketEvent> {
    const queued = this.#pending.shift();

    if (queued !== undefined) {
      return queued;
    }

    if (this.#closed) {
      throw new MarketDataError(
        'TRANSPORT_CLOSED',
        'the transport closed before the next event',
      );
    }

    const event = await this.#waitForEvent();

    if (event === undefined) {
      throw new MarketDataError(
        'TRANSPORT_CLOSED',
        'the transport closed before the next event',
      );
    }

    return event;
  }

  // --- Internals ------------------------------------------------------------

  #publishOrderBook(input: FakeOrderBookInput): void {
    const book = readOrderBookSnapshot(input.book, 'order book');
    const sourceTimestamp = readOptionalTimestamp(
      input.sourceTimestamp,
      'order book sourceTimestamp',
    );

    if (this.#consumeDrop()) {
      return;
    }

    this.#publish({
      kind: 'orderBook',
      market: input.market,
      symbol: input.symbol,
      book,
      sourceTimestamp,
      receivedAt: this.#now(),
    });
  }

  #publish(event: MarketEvent): void {
    this.#log.push(event);

    const waiter = this.#waiters.shift();

    if (waiter !== undefined) {
      waiter(event);
      return;
    }

    this.#pending.push(event);
  }

  #consumeDrop(): boolean {
    if (this.#dropRemaining === 0) {
      return false;
    }

    this.#dropRemaining -= 1;
    return true;
  }

  async #waitForEvent(signal?: AbortSignal): Promise<MarketEvent | undefined> {
    return new Promise<MarketEvent | undefined>((resolve) => {
      const waiter: EventWaiter = (event) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(event);
      };

      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);

        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }

        resolve(undefined);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #releaseWaiters(): void {
    while (this.#waiters.length > 0) {
      this.#waiters.shift()?.(undefined);
    }
  }

  #assertConnected(): void {
    if (!this.#connected) {
      throw new MarketDataError(
        'NOT_CONNECTED',
        'the fake transport is not connected',
      );
    }
  }

  #assertDeclared(
    channel: 'trade' | 'orderBook',
    market: Market,
    symbol: string,
  ): void {
    const topic = subscriptionTopicKey(channel, market, symbol);

    if (!this.#declared.has(topic)) {
      throw new MarketDataError(
        'UNDECLARED_TOPIC',
        `${topic} was never declared`,
      );
    }
  }

  /**
   * A close is transport-wide, and one connection serves one market, so the
   * market is read from what was declared rather than guessed.
   */
  #closedMarket(): Market {
    for (const topic of this.#declared) {
      const market = topic.split(':')[1];

      if (market === 'KR' || market === 'US') {
        return market;
      }
    }

    throw new MarketDataError(
      'NOT_CONNECTED',
      'the fake transport closed before any topic was declared',
    );
  }
}
