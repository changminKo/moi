import type { Market } from '@skipjack/trading-core';
import type { MarketDataStream, TokenProvider } from '../ports.js';
import {
  MarketDataError,
  type MarketEvent,
  type SubscriptionAck,
  type SubscriptionDeclaration,
  subscriptionTopicKey,
} from '../types.js';
import {
  parseTossFrame,
  type TossInboundFrame,
  toMarketEvent,
} from './parse-frame.js';

export interface TossSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: () => void;
  onclose?: (event?: { reason?: string }) => void;
  onerror?: (error: unknown) => void;
  onmessage?: (event: { data: unknown }) => void;
}
export type TossSocketFactory = (
  url: URL,
  options: { headers: Record<string, string> },
) => TossSocket;
export interface TossWebSocketOptions {
  url: URL;
  tokenProvider: TokenProvider;
  socketFactory: TossSocketFactory;
  now?: () => string;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  random?: () => number;
}

/** Capped exponential reconnect delay with full jitter. */
export const reconnectDelayMs = (
  attempt: number,
  random = Math.random,
  baseMs = 250,
  capMs = 30_000,
): number =>
  Math.floor(random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt)));

export class TossWebSocketMarketData implements MarketDataStream {
  private socket: TossSocket | null = null;
  private connected = false;
  private closed = false;
  private queue: MarketEvent[] = [];
  private waiters: Array<(r: IteratorResult<MarketEvent>) => void> = [];
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private pongFailures = 0;
  private readonly now: () => string;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly random: () => number;
  constructor(private readonly options: TossWebSocketOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
    this.random = options.random ?? Math.random;
  }
  async connect(signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      throw new DOMException('The operation was aborted', 'AbortError');
    const token = await this.options.tokenProvider.getAccessToken(signal);
    if (signal.aborted)
      throw new DOMException('The operation was aborted', 'AbortError');
    this.closed = false;
    this.socket = this.options.socketFactory(this.options.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      const s = this.socket;
      if (!s) {
        reject(
          new MarketDataError(
            'TRANSPORT_CLOSED',
            'Toss WebSocket was not created',
          ),
        );
        return;
      }
      const oldError = s.onerror;
      s.onerror = (e) => {
        oldError?.(e);
        reject(
          new MarketDataError(
            'TRANSPORT_CLOSED',
            'Toss WebSocket connection failed',
          ),
        );
      };
      s.onopen = () => {
        this.connected = true;
        this.startKeepalive();
        resolve();
      };
      s.onclose = (e) => {
        this.connected = false;
        this.finish(e?.reason ?? 'closed');
      };
      s.onmessage = (e) => this.receive(e.data);
      signal.addEventListener(
        'abort',
        () => {
          this.close().catch(() => undefined);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
  async reconnect(signal: AbortSignal, maxAttempts = 5): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.connect(signal);
        return;
      } catch (error) {
        if (attempt === maxAttempts - 1 || signal.aborted) throw error;
        await new Promise<void>((resolve, reject) => {
          const timer = this.setTimeoutFn(
            resolve,
            reconnectDelayMs(attempt, this.random),
          );
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(
                new DOMException('The operation was aborted', 'AbortError'),
              );
            },
            { once: true },
          );
        });
      }
    }
  }
  async declare(
    subscriptions: readonly SubscriptionDeclaration[],
  ): Promise<SubscriptionAck> {
    if (!this.socket || !this.connected)
      throw new MarketDataError(
        'NOT_CONNECTED',
        'Toss WebSocket is not connected',
      );
    const expected = subscriptions.flatMap((d) =>
      d.symbols.map((symbol) =>
        subscriptionTopicKey(d.channel, d.market, symbol),
      ),
    );
    this.socket.send(
      JSON.stringify({
        type: 'subscriptions',
        subscriptions: subscriptions.map((d) => ({
          channel: `${d.channel === 'orderBook' ? 'orderbook' : d.channel}:${d.market.toLowerCase()}`,
          codes: d.symbols,
        })),
      }),
    );
    const frame = await this.nextControl('subscriptionAck');
    if (frame.kind !== 'subscriptionAck')
      throw new MarketDataError(
        'SUBSCRIPTION_REJECTED',
        'Unexpected subscription response',
      );
    const rejected = frame.rejected.map((r) => ({
      topic: r.target.includes(':')
        ? r.target
        : (expected.find((k) => k.endsWith(`:${r.target}`)) ?? r.target),
      reason: r.message,
    }));
    const rejectedKeys = new Set(rejected.map((r) => r.topic));
    return { accepted: expected.filter((k) => !rejectedKeys.has(k)), rejected };
  }
  async *events(signal: AbortSignal): AsyncIterable<MarketEvent> {
    while (!signal.aborted) {
      if (this.queue.length) {
        const event = this.queue.shift();
        if (event) yield event;
        continue;
      }
      const event = await new Promise<MarketEvent | null>((resolve) => {
        this.waiters.push((r) => resolve(r.done ? null : r.value));
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });
      if (event === null) return;
      yield event;
    }
  }
  async ping(): Promise<number> {
    if (!this.socket || !this.connected)
      throw new MarketDataError(
        'NOT_CONNECTED',
        'Toss WebSocket is not connected',
      );
    const started = Date.now();
    this.socket.send('PING');
    const frame = await this.nextControl('pong');
    if (frame.kind !== 'pong')
      throw new MarketDataError('PONG_FAILED', 'Invalid PONG');
    this.pongFailures = 0;
    return Date.now() - started;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    this.socket?.close(1000, 'client shutdown');
    this.socket = null;
    this.connected = false;
    this.finish('closed');
  }
  private startKeepalive() {
    this.keepalive = setInterval(() => {
      this.ping().catch(() => {
        this.pongFailures += 1;
        if (this.pongFailures >= 2) void this.close();
      });
    }, 60_000);
  }
  private receive(raw: unknown) {
    let frame: TossInboundFrame;
    try {
      frame = parseTossFrame(raw, this.now());
    } catch {
      return;
    }
    if (frame.kind === 'trade' || frame.kind === 'orderBook') {
      try {
        const event = toMarketEvent(frame);
        const waiter = this.waiters.shift();
        if (waiter) waiter({ done: false, value: event });
        else this.queue.push(event);
      } catch {
        /* unsupported data is intentionally not normalized */
      }
    } else {
      const waiter = this.waiters.shift();
      if (waiter) waiter({ done: false, value: frame as never });
      else this.queue.push(frame as never);
    }
  }
  private async nextControl(
    kind: 'pong' | 'subscriptionAck',
  ): Promise<TossInboundFrame> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const i = this.queue.findIndex(
          (x) => (x as unknown as TossInboundFrame).kind === kind,
        );
        if (i >= 0) {
          resolve(this.queue.splice(i, 1)[0] as unknown as TossInboundFrame);
          return;
        }
        this.setTimeoutFn(check, 0);
      };
      check();
      this.setTimeoutFn(
        () =>
          reject(
            new MarketDataError(
              kind === 'pong' ? 'PONG_FAILED' : 'SUBSCRIPTION_REJECTED',
              `Timed out waiting for ${kind}`,
            ),
          ),
        30_000,
      );
    });
  }
  private finish(reason: string) {
    if (this.closed) return;
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined as never });
    this.queue.push({
      kind: 'transportClosed',
      market: 'US' as Market,
      reason,
      receivedAt: this.now(),
    });
  }
}
