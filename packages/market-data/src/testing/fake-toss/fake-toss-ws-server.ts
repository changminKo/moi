import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Market, OrderBookSnapshot } from '@moi/trading-core';
import { type WebSocket, WebSocketServer } from 'ws';

export const FAKE_WS_MAX_CONNECTIONS = 2;
export const FAKE_WS_MAX_TOPICS = 100;
export const FAKE_WS_MAX_DECLARES_PER_SECOND = 5;
export const FAKE_WS_IDLE_TIMEOUT_MS = 180_000;

export interface FakeWsTradeInput {
  readonly market: Market;
  readonly symbol: string;
  readonly price: string;
  readonly volume: string;
  readonly sourceTimestamp: string | null;
}
export interface FakeWsOrderBookInput {
  readonly market: Market;
  readonly symbol: string;
  readonly book: OrderBookSnapshot;
  readonly sourceTimestamp: string | null;
}
export interface FakeTossWsServerOptions {
  readonly idleTimeoutMs?: number;
  readonly now?: () => string;
}

interface Connection {
  readonly ws: WebSocket;
  readonly topics: Set<string>;
  readonly declareTimes: number[];
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  'wrong-format': 'declaration must be a JSON array',
  'no-type': 'each entry needs a type',
  'invalid-type': 'unknown declaration type',
  'no-codes': 'codes must be a non-empty array',
  'too-many-topics': 'too many topics for one connection',
  'too-many': 'too many entries',
  'rate-limit-exceeded': 'declare rate limit exceeded',
  'internal-error': 'internal error',
  'server-shutdown': '서버가 재시작됩니다. 재연결해주세요.',
};

/**
 * Behavioural model of the pinned AsyncAPI connection rules (§9.3): bearer
 * handshake, two connections per account with oldest eviction, JSON-array
 * full-replace declarations, 100-topic and 5-declares-per-second limits,
 * ack-before-data, text `PING` → `{"type":"pong"}`, idle timeout, and the
 * `server-shutdown` error frame. Loopback only; no order channel exists here.
 */
export class FakeTossWsServer {
  readonly #http: Server;
  readonly #wss = new WebSocketServer({ noServer: true });
  readonly #connections: Connection[] = [];
  readonly #validTokens = new Set<string>();
  readonly #rejectNext = new Map<string, string>();
  readonly #now: () => string;
  readonly #idleTimeoutMs: number;
  #ipAllowed = true;
  #pongFailuresRemaining = 0;
  #dropRemaining = 0;
  #peak = 0;
  #evictions = 0;
  /**
   * Every connection open/close with the concurrency observed right after it.
   * Event-based, so a zero-connection window of a few milliseconds is
   * recorded even when a periodic sampler would miss it.
   */
  readonly lifecycle: {
    t: number;
    event: 'open' | 'close';
    concurrent: number;
  }[] = [];
  #pongs = 0;
  #declares = 0;
  #handshakes: number[] = [];
  #port = 0;

  constructor(options: FakeTossWsServerOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idleTimeoutMs = options.idleTimeoutMs ?? FAKE_WS_IDLE_TIMEOUT_MS;
    this.#http = createServer((_request, response) => {
      response.writeHead(426, { connection: 'close' });
      response.end();
    });
    this.#http.on('upgrade', (request, socket, head) =>
      this.#upgrade(request, socket, head),
    );
  }

  get url(): string {
    return `ws://127.0.0.1:${this.#port}/ws/v1`;
  }
  get connections(): number {
    return this.#connections.length;
  }
  get peakConcurrentConnections(): number {
    return this.#peak;
  }
  get evictions(): number {
    return this.#evictions;
  }
  get pongCount(): number {
    return this.#pongs;
  }
  get declareCount(): number {
    return this.#declares;
  }
  get handshakeStatuses(): readonly number[] {
    return [...this.#handshakes];
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#http.listen(0, '127.0.0.1', resolve),
    );
    const address = this.#http.address();
    this.#port = typeof address === 'object' && address ? address.port : 0;
  }

  async stop(): Promise<void> {
    for (const connection of [...this.#connections])
      this.#drop(connection, 1001, 'stop');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }

  // ---- control API --------------------------------------------------------

  allowToken(token: string): void {
    this.#validTokens.add(token);
  }
  revokeToken(token: string): void {
    this.#validTokens.delete(token);
  }
  setIpAllowed(allowed: boolean): void {
    this.#ipAllowed = allowed;
  }
  rejectTopics(
    topics: readonly string[],
    code = 'symbol-market-mismatch',
  ): void {
    for (const topic of topics) this.#rejectNext.set(topic, code);
  }
  failNextPongs(count: number): void {
    this.#pongFailuresRemaining = count;
  }
  dropNext(count: number): void {
    this.#dropRemaining = count;
  }
  subscribedTopics(): readonly string[] {
    return [...new Set(this.#connections.flatMap((c) => [...c.topics]))].sort();
  }

  emitTrade(input: FakeWsTradeInput): void {
    this.#emit(`trade:${input.market.toLowerCase()}:${input.symbol}`, {
      price: input.price,
      volume: input.volume,
      timestamp: input.sourceTimestamp,
      currency: input.market === 'US' ? 'USD' : 'KRW',
    });
  }
  emitOrderBook(input: FakeWsOrderBookInput): void {
    this.#emit(`orderbook:${input.market.toLowerCase()}:${input.symbol}`, {
      timestamp: input.sourceTimestamp,
      currency: input.book.currency,
      asks: input.book.asks,
      bids: input.book.bids,
    });
  }
  emitOutOfOrder(inputs: readonly FakeWsTradeInput[]): void {
    for (const input of inputs) this.emitTrade(input);
  }
  /**
   * Closes every connection. 1006 (the default) models the provider's
   * frame-less abnormal close; any other code sends a proper close frame with
   * `reason` so a harness can label the disconnect.
   */
  closeAll(code = 1006, reason = 'abnormal'): void {
    for (const connection of [...this.#connections])
      this.#drop(connection, code, code === 1006 ? 'abnormal' : reason);
  }
  /** Deploy: `server-shutdown` error frame, then close. */
  announceShutdownAndClose(): void {
    for (const connection of [...this.#connections]) {
      this.#send(connection, {
        type: 'error',
        error: {
          code: 'server-shutdown',
          message: ERROR_MESSAGES['server-shutdown'],
        },
      });
      this.#drop(connection, 1001, 'server-shutdown');
    }
  }

  // ---- protocol -----------------------------------------------------------

  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: number, text: string): void => {
      this.#handshakes.push(status);
      socket.write(
        `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
    };
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token || !this.#validTokens.has(token)) {
      reject(401, 'Unauthorized');
      return;
    }
    if (!this.#ipAllowed) {
      reject(403, 'Forbidden');
      return;
    }
    if (new URL(request.url ?? '/', 'http://x').pathname !== '/ws/v1') {
      reject(404, 'Not Found');
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => {
      this.#handshakes.push(101);
      const connection: Connection = {
        ws,
        topics: new Set(),
        declareTimes: [],
        idleTimer: null,
      };
      this.#connections.push(connection);
      this.#peak = Math.max(this.#peak, this.#connections.length);
      this.lifecycle.push({
        t: Date.now(),
        event: 'open',
        concurrent: this.#connections.length,
      });
      while (this.#connections.length > FAKE_WS_MAX_CONNECTIONS) {
        const oldest = this.#connections[0] as Connection;
        this.#evictions += 1;
        this.#drop(oldest, 1006, 'evicted');
      }
      this.#armIdle(connection);
      ws.on('message', (data, isBinary) =>
        this.#message(connection, isBinary ? '' : String(data)),
      );
      ws.on('close', () => this.#forget(connection));
      ws.on('error', () => this.#forget(connection));
    });
  }

  #message(connection: Connection, text: string): void {
    this.#armIdle(connection);
    if (text === 'PING') {
      if (this.#pongFailuresRemaining > 0) {
        this.#pongFailuresRemaining -= 1;
        return;
      }
      this.#pongs += 1;
      this.#send(connection, { type: 'pong' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#error(connection, 'wrong-format');
      return;
    }
    if (!Array.isArray(parsed)) {
      this.#error(connection, 'wrong-format');
      return;
    }
    const now = Date.now();
    connection.declareTimes.push(now);
    while (
      connection.declareTimes.length > 0 &&
      now - (connection.declareTimes[0] as number) > 1000
    )
      connection.declareTimes.shift();
    let id: string | undefined;
    const entries: { type: string; codes: string[] }[] = [];
    for (const item of parsed as unknown[]) {
      if (!item || typeof item !== 'object') {
        this.#error(connection, 'wrong-format');
        return;
      }
      const entry = item as { id?: unknown; type?: unknown; codes?: unknown };
      if (
        entry.type === undefined &&
        typeof entry.id === 'string' &&
        entry.codes === undefined
      ) {
        id = entry.id;
        continue;
      }
      if (typeof entry.type !== 'string') {
        this.#error(connection, 'no-type', id);
        return;
      }
      if (!/^(trade|orderbook):(us|kr)$/.test(entry.type)) {
        this.#error(connection, 'invalid-type', id);
        return;
      }
      if (
        !Array.isArray(entry.codes) ||
        entry.codes.length === 0 ||
        entry.codes.some((c) => typeof c !== 'string')
      ) {
        this.#error(connection, 'no-codes', id);
        return;
      }
      entries.push({ type: entry.type, codes: entry.codes as string[] });
    }
    if (connection.declareTimes.length > FAKE_WS_MAX_DECLARES_PER_SECOND) {
      this.#error(connection, 'rate-limit-exceeded', id);
      return;
    }
    const requested = entries.flatMap((e) =>
      e.codes.map((code) => `${e.type}:${code}`),
    );
    if (requested.length > FAKE_WS_MAX_TOPICS) {
      this.#error(connection, 'too-many-topics', id);
      return;
    }
    this.#declares += 1;
    const rejected: { target: string; code: string; message: string }[] = [];
    const subscribed: string[] = [];
    for (const topic of requested) {
      const code = this.#rejectNext.get(topic);
      if (code !== undefined) {
        this.#rejectNext.delete(topic);
        rejected.push({ target: topic, code, message: `rejected: ${code}` });
      } else subscribed.push(topic);
    }
    connection.topics.clear();
    for (const topic of subscribed) connection.topics.add(topic);
    this.#send(connection, {
      type: 'subscriptions',
      ...(id !== undefined ? { id } : {}),
      subscribed,
      rejected,
    });
  }

  #emit(topic: string, data: unknown): void {
    if (this.#dropRemaining > 0) {
      this.#dropRemaining -= 1;
      return;
    }
    for (const connection of this.#connections)
      if (connection.topics.has(topic))
        this.#send(connection, { type: 'message', topic, data });
  }

  #error(connection: Connection, code: string, id?: string): void {
    this.#send(connection, {
      type: 'error',
      error: { code, message: ERROR_MESSAGES[code] ?? code },
      ...(id !== undefined ? { id } : {}),
    });
  }

  #send(connection: Connection, frame: unknown): void {
    if (connection.ws.readyState === connection.ws.OPEN)
      connection.ws.send(JSON.stringify(frame));
  }

  #armIdle(connection: Connection): void {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(
      () => this.#drop(connection, 1006, 'idle'),
      this.#idleTimeoutMs,
    );
    connection.idleTimer.unref?.();
  }

  #drop(connection: Connection, code: number, reason: string): void {
    this.#forget(connection);
    if (reason === 'abnormal' || reason === 'evicted' || reason === 'idle')
      connection.ws.terminate();
    else connection.ws.close(code, reason);
  }

  #forget(connection: Connection): void {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    const index = this.#connections.indexOf(connection);
    if (index >= 0) {
      this.#connections.splice(index, 1);
      this.lifecycle.push({
        t: Date.now(),
        event: 'close',
        concurrent: this.#connections.length,
      });
    }
  }
}
