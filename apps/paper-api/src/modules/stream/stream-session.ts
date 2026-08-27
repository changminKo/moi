import type { Market } from '@skipjack/trading-core';

export interface StreamSocket {
  send(message: string): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount?: number;
}

export interface DurableAccountEvent {
  readonly id: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly accountSequence: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface QuoteEvent {
  readonly market: Market;
  readonly symbol: string;
  readonly recoveryEpoch: bigint | string;
  readonly marketDataVersion: bigint | string;
  readonly payload: unknown;
}

export interface DurableEventSource {
  latest(sessionId: string): Promise<string>;
  oldest(sessionId: string): Promise<string | undefined>;
  replay(
    sessionId: string,
    afterSequence?: string,
  ): Promise<readonly DurableAccountEvent[]>;
}

export interface StreamSessionOptions {
  readonly sessionId: string;
  readonly source: DurableEventSource;
  readonly socket: StreamSocket;
  readonly afterSequence?: string;
  readonly quoteSymbols?: ReadonlySet<string>;
  readonly maxQueue?: number;
}

/** Advertised in `ready` and used by the single process-wide StreamHeartbeatLoop. */
export const STREAM_HEARTBEAT_MS = 30_000;
/** Same bound as the per-session `subscribeQuote` limit. */
export const STREAM_MAX_QUOTE_SUBSCRIPTIONS = 5;

export interface StreamOpenResult {
  readonly session: StreamSession;
  /** accountSequence of the last replayed event, or `ready.accountSequence` when replay was empty. */
  readonly replayedUpTo: string;
  readonly replayedEventIds: ReadonlySet<string>;
}

function message(value: unknown): string {
  return JSON.stringify(value);
}

export class StreamSession {
  readonly #sessionId: string;
  readonly #source: DurableEventSource;
  readonly #socket: StreamSocket;
  readonly #symbols: ReadonlySet<string>;
  readonly #maxQueue: number;
  readonly #queue: DurableAccountEvent[] = [];
  readonly #subscriptions = new Set<string>();
  #closed = false;

  private constructor(options: StreamSessionOptions) {
    this.#sessionId = options.sessionId;
    this.#source = options.source;
    this.#socket = options.socket;
    this.#symbols = options.quoteSymbols ?? new Set();
    this.#maxQueue = options.maxQueue ?? 100;
  }

  static async open(options: StreamSessionOptions): Promise<StreamOpenResult> {
    const stream = new StreamSession(options);
    const after = options.afterSequence;
    const oldest = await options.source.oldest(options.sessionId);
    if (
      after !== undefined &&
      oldest !== undefined &&
      BigInt(after) < BigInt(oldest) - 1n
    ) {
      stream.#send({ type: 'resync-required', reason: 'OUTBOX_GAP' });
      stream.#socket.close(4009, 'OUTBOX_GAP');
      throw new Error('OUTBOX_GAP');
    }
    const latest = await options.source.latest(options.sessionId);
    stream.#send({
      type: 'ready',
      accountSequence: latest,
      heartbeatIntervalMs: STREAM_HEARTBEAT_MS,
    });
    let replayedUpTo = latest;
    const replayedEventIds = new Set<string>();
    for (const event of await options.source.replay(options.sessionId, after)) {
      stream.#send(stream.#event(event));
      replayedUpTo = event.accountSequence;
      replayedEventIds.add(event.eventId);
    }
    return { session: stream, replayedUpTo, replayedEventIds };
  }

  /** Not queued behind backpressure: heartbeats carry no ordering guarantee. */
  heartbeat(serverTime: string): void {
    this.#send({ type: 'heartbeat', serverTime });
  }

  async deliver(event: DurableAccountEvent): Promise<void> {
    if (this.#closed || event.sessionId !== this.#sessionId) return;
    if ((this.#socket.bufferedAmount ?? 0) > 0) {
      if (this.#queue.length >= this.#maxQueue) {
        this.#send({ type: 'resync-required', reason: 'BACKPRESSURE' });
        this.#closed = true;
        this.#socket.close(4008, 'BACKPRESSURE');
        return;
      }
      this.#queue.push(event);
      return;
    }
    this.#send(this.#event(event));
  }

  async subscribeQuote(market: Market, symbol: string): Promise<void> {
    const key = `${market}:${symbol}`;
    if (!this.#symbols.has(key)) throw new Error('symbol is not tradable');
    if (
      !this.#subscriptions.has(key) &&
      this.#subscriptions.size >= STREAM_MAX_QUOTE_SUBSCRIPTIONS
    )
      throw new Error('quote subscription limit');
    this.#subscriptions.add(key);
  }

  unsubscribeQuote(market: Market, symbol: string): void {
    this.#subscriptions.delete(`${market}:${symbol}`);
  }
  close(code = 1000): void {
    this.#closed = true;
    this.#subscriptions.clear();
    this.#socket.close(code);
  }

  publishQuote(event: QuoteEvent): void {
    if (this.#subscriptions.has(`${event.market}:${event.symbol}`))
      this.#send({
        type: 'quote',
        ...event,
        recoveryEpoch: String(event.recoveryEpoch),
        marketDataVersion: String(event.marketDataVersion),
      });
  }

  #event(event: DurableAccountEvent): unknown {
    return {
      type: 'event',
      eventId: event.eventId,
      accountSequence: event.accountSequence,
      eventType: event.eventType,
      payload: event.payload,
    };
  }
  #send(value: unknown): void {
    if (!this.#closed) this.#socket.send(message(value));
  }
}
