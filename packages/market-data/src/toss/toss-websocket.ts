import type { Market } from '@moi/trading-core';
import WebSocket from 'ws';
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
  onclose?: (event?: { reason?: string; code?: number }) => void;
  /** Handshake rejections carry the HTTP `statusCode`. */
  onerror?: (error: unknown) => void;
  onmessage?: (event: { data: unknown }) => void;
}
export type TossSocketFactory = (
  url: URL,
  options: { headers: Record<string, string> },
) => TossSocket;

export interface TossWebSocketOptions {
  url: URL;
  /** The one market this connection serves (§5.2); reported on transportClosed. */
  market: Market;
  tokenProvider: TokenProvider;
  socketFactory?: TossSocketFactory;
  now?: () => string;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  random?: () => number;
  /** Wait for a control frame before failing (contract keepalive budget). */
  controlTimeoutMs?: number;
  /** Delay before the single re-declare after `rate-limit-exceeded`. */
  rateLimitRetryMs?: number;
}

/** Capped exponential reconnect delay with full jitter. */
export const reconnectDelayMs = (
  attempt: number,
  random = Math.random,
  baseMs = 250,
  capMs = 30_000,
): number =>
  Math.floor(random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt)));

/** Default factory: the `ws` client, which (unlike the built-in) accepts handshake headers (§3.10). */
export const createWsSocketFactory =
  (): TossSocketFactory => (url, options) => {
    const ws = new WebSocket(url, { headers: options.headers });
    const socket: TossSocket = {
      send: (data) => ws.send(data),
      close: (code, reason) => {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
          ws.close(code, reason);
      },
    };
    ws.on('open', () => socket.onopen?.());
    ws.on('message', (data) => socket.onmessage?.({ data: String(data) }));
    ws.on('close', (code, reason) =>
      socket.onclose?.({ code, reason: String(reason) }),
    );
    ws.on('error', (error) => socket.onerror?.(error));
    ws.on('unexpected-response', (_request, response) => {
      socket.onerror?.(
        Object.assign(new Error(`handshake ${response.statusCode}`), {
          statusCode: response.statusCode,
        }),
      );
      response.resume();
      ws.terminate();
    });
    return socket;
  };

type ControlKind = 'pong' | 'subscriptionAck' | 'error';
type ControlWaiter = {
  readonly kinds: ReadonlySet<ControlKind>;
  readonly resolve: (frame: TossInboundFrame) => void;
};

const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
const RATE_LIMIT_RETRY_MS = 1_000;

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), {
    name: 'AbortError',
  });
}

/**
 * Toss WebSocket market-data adapter. Owns no timer of its own: keepalive
 * pings come from the caller (`KeepaliveLoop`), and every wait is bounded by
 * an injected timeout so the adapter never keeps a process alive.
 */
export class TossWebSocketMarketData implements MarketDataStream {
  private socket: TossSocket | null = null;
  /**
   * Bumped for every socket this adapter stands up. Every handler closes over
   * the generation it was installed for, so an event from a socket the adapter
   * has already replaced is dropped instead of being read as the current
   * connection's — a late `onclose` used to fail the connection that replaced
   * it, and a late frame used to enter its stream.
   */
  private generation = 0;
  /** Settles a handshake whose socket is being replaced under it. */
  private abandonHandshake: (() => void) | null = null;
  private connected = false;
  private closed = false;
  private queue: MarketEvent[] = [];
  private waiters: Array<(r: IteratorResult<MarketEvent>) => void> = [];
  private controlQueue: TossInboundFrame[] = [];
  private controlWaiters: ControlWaiter[] = [];
  private readonly now: () => string;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly random: () => number;
  private readonly socketFactory: TossSocketFactory;

  constructor(private readonly options: TossWebSocketOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
    this.random = options.random ?? Math.random;
    this.socketFactory = options.socketFactory ?? createWsSocketFactory();
  }

  get market(): Market {
    return this.options.market;
  }

  /** True between a successful handshake and the transport closing. */
  get isConnected(): boolean {
    return this.connected;
  }

  async connect(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    const token = await this.options.tokenProvider.getAccessToken(signal);
    try {
      await this.handshake(token, signal);
    } catch (error) {
      // One retry after the provider rejects the token (§5.5): invalidate, reissue.
      if (
        error instanceof MarketDataError &&
        error.code === 'AUTH_FAILED' &&
        error.statusCode === 401 &&
        this.options.tokenProvider.invalidate
      ) {
        this.options.tokenProvider.invalidate(token);
        await this.handshake(
          await this.options.tokenProvider.getAccessToken(signal),
          signal,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Drops the socket this adapter is holding: its handlers are removed and it
   * is closed. Both halves matter. A socket left registered with the provider
   * is a *duplicate subscription* on the next connect, which the provider
   * evicts with `"Bye"` — one reconnect then causes the next. And a socket
   * left wired keeps calling back into an adapter that has moved on.
   */
  private detachSocket(reason: string): void {
    this.abandonHandshake?.();
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (!socket) return;
    delete socket.onopen;
    delete socket.onclose;
    delete socket.onerror;
    delete socket.onmessage;
    try {
      socket.close(1000, reason);
    } catch {
      /* a socket that is already gone needs no closing */
    }
  }

  private async handshake(token: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortError();
    this.detachSocket('client reconnect');
    this.closed = false;
    this.controlQueue = [];
    // Whatever the previous connection left unread belongs to a recovery epoch
    // that is over; a queued `transportClosed` would degrade the new one.
    //
    // This drops unread *data* frames too, and is only safe under an invariant
    // this class cannot enforce: `events()` has exactly one consumer, it
    // drains in order, and `finish()` has already pushed the terminal
    // `transportClosed` that makes that consumer return — so by the time a new
    // handshake runs the queue holds nothing but that spent marker.
    // `MarketRuntime.#startLoop` is that single consumer today. A caller that
    // runs two consumers, or reconnects before its consumer has drained, loses
    // market data here silently. Recovery re-baselines every symbol from REST
    // (`RecoveryCoordinator`), which is what makes the trade worth taking.
    this.queue = [];
    this.generation += 1;
    const generation = this.generation;
    const isCurrent = (): boolean => this.generation === generation;
    const socket = this.socketFactory(this.options.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.abandonHandshake = null;
        fn();
      };
      this.abandonHandshake = () =>
        settle(() =>
          reject(
            new MarketDataError(
              'TRANSPORT_CLOSED',
              'Toss WebSocket handshake superseded by a new connection',
            ),
          ),
        );
      socket.onerror = (e) => {
        if (!isCurrent()) return;
        const statusCode = (e as { statusCode?: number })?.statusCode;
        if (statusCode === 401 || statusCode === 403) {
          settle(() =>
            reject(
              new MarketDataError(
                'AUTH_FAILED',
                statusCode === 403
                  ? 'provider rejected the client IP'
                  : 'provider rejected the access token',
                { statusCode },
              ),
            ),
          );
          return;
        }
        if (!this.connected)
          settle(() =>
            reject(
              new MarketDataError(
                'TRANSPORT_CLOSED',
                'Toss WebSocket connection failed',
                {
                  ...(statusCode !== undefined ? { statusCode } : {}),
                },
              ),
            ),
          );
      };
      socket.onopen = () => {
        if (!isCurrent()) return;
        this.connected = true;
        settle(resolve);
      };
      socket.onclose = (e) => {
        if (!isCurrent()) return;
        const wasConnected = this.connected;
        this.connected = false;
        if (!wasConnected)
          settle(() =>
            reject(
              new MarketDataError(
                'TRANSPORT_CLOSED',
                'Toss WebSocket closed during handshake',
              ),
            ),
          );
        this.finish(e?.reason && e.reason.length > 0 ? e.reason : 'closed');
      };
      socket.onmessage = (e) => {
        if (!isCurrent()) return;
        this.receive(e.data);
      };
      signal.addEventListener(
        'abort',
        () => {
          // Settle first: `close()` detaches this socket, and an abandoned
          // handshake must still report the abort that caused it.
          settle(() => reject(abortError()));
          this.close().catch(() => undefined);
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
              this.clearTimeoutFn(timer);
              reject(abortError());
            },
            { once: true },
          );
        });
      }
    }
  }

  /** Full-replace declaration as one JSON array text frame (contract §connection). */
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
    const frame = JSON.stringify([
      { id: `req-${Date.now().toString(36)}` },
      ...subscriptions.map((d) => ({
        type: `${d.channel === 'orderBook' ? 'orderbook' : 'trade'}:${d.market.toLowerCase()}`,
        codes: [...d.symbols],
      })),
    ]);
    let ack = await this.sendDeclaration(frame);
    if (ack.kind === 'error' && ack.code === 'rate-limit-exceeded') {
      await new Promise<void>((resolve) =>
        this.setTimeoutFn(
          resolve,
          this.options.rateLimitRetryMs ?? RATE_LIMIT_RETRY_MS,
        ),
      );
      ack = await this.sendDeclaration(frame);
    }
    if (ack.kind !== 'subscriptionAck') {
      const code = ack.kind === 'error' ? ack.code : 'unexpected';
      throw new MarketDataError(
        'SUBSCRIPTION_REJECTED',
        `declaration rejected: ${code}`,
      );
    }
    const rejected = ack.rejected.map((r) => ({
      topic: this.canonicalTopic(r.target, expected),
      reason: r.message,
    }));
    const rejectedKeys = new Set(rejected.map((r) => r.topic));
    return { accepted: expected.filter((k) => !rejectedKeys.has(k)), rejected };
  }

  private async sendDeclaration(frame: string): Promise<TossInboundFrame> {
    this.socket?.send(frame);
    return this.nextControl(
      ['subscriptionAck', 'error'],
      'SUBSCRIPTION_REJECTED',
    );
  }

  /** `trade:us:AAPL` (provider) → `trade:US:AAPL` (canonical). */
  private canonicalTopic(target: string, expected: readonly string[]): string {
    const [channel, market, ...rest] = target.split(':');
    if (channel && market && rest.length > 0) {
      const canonical = `${channel === 'orderbook' ? 'orderBook' : channel}:${market.toUpperCase()}:${rest.join(':')}`;
      if (expected.includes(canonical)) return canonical;
    }
    return expected.find((k) => k.endsWith(`:${target}`)) ?? target;
  }

  async *events(signal: AbortSignal): AsyncIterable<MarketEvent> {
    while (!signal.aborted) {
      if (this.queue.length) {
        const event = this.queue.shift();
        if (event) yield event;
        continue;
      }
      if (this.closed) return;
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
    const frame = await this.nextControl(['pong'], 'PONG_FAILED');
    if (frame.kind !== 'pong')
      throw new MarketDataError('PONG_FAILED', 'Invalid PONG');
    return Date.now() - started;
  }

  async close(): Promise<void> {
    this.detachSocket('client shutdown');
    this.finish('closed');
    this.closed = true;
  }

  private receive(raw: unknown): void {
    let frame: TossInboundFrame;
    try {
      frame = parseTossFrame(raw, this.now());
    } catch {
      return;
    }
    if (frame.kind === 'trade' || frame.kind === 'orderBook') {
      try {
        this.pushEvent(toMarketEvent(frame));
      } catch {
        /* unsupported data is intentionally not normalized */
      }
      return;
    }
    if (
      frame.kind === 'error' &&
      (frame.code === 'server-shutdown' || frame.code === 'internal-error')
    ) {
      // The provider closes right after; surface the reason as a transport close.
      this.connected = false;
      this.finish(frame.code);
      return;
    }
    const waiterIndex = this.controlWaiters.findIndex((w) =>
      w.kinds.has(frame.kind as ControlKind),
    );
    if (waiterIndex >= 0) {
      const [waiter] = this.controlWaiters.splice(waiterIndex, 1);
      waiter?.resolve(frame);
    } else this.controlQueue.push(frame);
  }

  private pushEvent(event: MarketEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.queue.push(event);
  }

  private nextControl(
    kinds: readonly ControlKind[],
    timeoutCode: 'PONG_FAILED' | 'SUBSCRIPTION_REJECTED',
  ): Promise<TossInboundFrame> {
    const wanted = new Set(kinds);
    const queued = this.controlQueue.findIndex((f) =>
      wanted.has(f.kind as ControlKind),
    );
    if (queued >= 0)
      return Promise.resolve(
        this.controlQueue.splice(queued, 1)[0] as TossInboundFrame,
      );
    return new Promise((resolve, reject) => {
      const waiter: ControlWaiter = {
        kinds: wanted,
        resolve: (frame) => {
          this.clearTimeoutFn(timer);
          resolve(frame);
        },
      };
      const timer = this.setTimeoutFn(() => {
        const index = this.controlWaiters.indexOf(waiter);
        if (index >= 0) this.controlWaiters.splice(index, 1);
        reject(
          new MarketDataError(
            timeoutCode,
            `Timed out waiting for ${kinds.join('|')}`,
          ),
        );
      }, this.options.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS);
      this.controlWaiters.push(waiter);
    });
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.controlWaiters.splice(0))
      waiter.resolve({
        kind: 'error',
        code: 'transport-closed',
        message: reason,
        requestId: null,
        receivedAt: this.now(),
      });
    const event: MarketEvent = {
      kind: 'transportClosed',
      market: this.options.market,
      reason,
      receivedAt: this.now(),
    };
    this.pushEvent(event);
    for (const waiter of this.waiters.splice(0))
      waiter({ done: true, value: undefined as never });
  }
}
