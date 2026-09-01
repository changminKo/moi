import type { InstrumentRef } from '@moi/strategy-sdk/strategy';
import type { Reporter } from '../reporter.js';
import type { SessionCredentials } from '../transport/paper-api-client.js';
import { instrumentKey } from './quote-ticker.js';
import {
  ReconnectPolicy,
  type ReconnectPolicyOptions,
} from './reconnect-policy.js';

/**
 * The runner's subscription to `GET /api/v1/stream` (design §5.1), and the
 * reconnection around it (§5.3, §7.1).
 *
 * ## What crosses the boundary from the paper API, and what does not
 *
 * The server has a WebSocket client with exactly this problem already solved —
 * `packages/market-data/src/toss/toss-websocket.ts`, after the 34-hour outage
 * spec §16.34 records. Design §3 forbids importing it, and that is the right
 * call: it speaks the Toss protocol, it carries a token provider, and depending
 * on it would put a live provider adapter in the bot's decision path. So what
 * is reused is the two bugs it found, both reproduced as tests here:
 *
 * 1. **A replaced socket's late `onclose` tore down its successor.** Every
 *    handler closes over the generation it was installed for and returns
 *    immediately if the client has moved on, and `#detach` unwires a socket
 *    before closing it. Both halves are needed: a socket left wired keeps
 *    calling back into a client that has replaced it, and a socket left open is
 *    a second subscription against the same session — which the paper API's own
 *    `checkWebsocketConnection` limiter counts, so one leak turns the next
 *    reconnect into a `429`.
 *
 * 2. **A permanent exhaustion latch.** See `ReconnectPolicy`: the band gets
 *    slow, never closed.
 *
 * ## Why there is a liveness watchdog
 *
 * Neither of those covers the failure that produces no event at all. A half-open
 * TCP connection — a NAT table entry dropped, a container paused — leaves the
 * socket `OPEN` forever with nothing arriving on it, and a bot that trusts
 * `onclose` to tell it sits there believing it is subscribed while the market
 * moves without it. The server advertises `heartbeatIntervalMs` in its `ready`
 * frame precisely so a client can notice; silence past `LIVENESS_INTERVALS`
 * multiples of it is treated as a close the client has to declare itself.
 *
 * ## Account events are drained one at a time
 *
 * `onEvent` reads the portfolio and may submit an order, so it is async. Two of
 * them in flight would interleave two cursor advances over one append-only log,
 * and the exactly-once argument in `FillJournal` rests on them not doing that.
 * Frames therefore go onto a queue and a single chain drains it in arrival
 * order. A handler that throws is contained: the cursor did not advance, so the
 * next connect replays the event, and the quotes on the same socket are still
 * worth having in the meantime.
 */

/** Silence worth this many advertised heartbeat intervals is a dead socket. */
export const LIVENESS_INTERVALS = 3;
/** Used until a `ready` frame states the server's own interval. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

export interface StreamSocket {
  onopen?: (() => void) | undefined;
  onclose?: ((event: { code?: number; reason?: string }) => void) | undefined;
  onerror?: ((event: { message?: string }) => void) | undefined;
  onmessage?: ((event: { data: unknown }) => void) | undefined;
  close(code?: number, reason?: string): void;
}

export type StreamSocketFactory = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => StreamSocket;

/** One account event off the stream, exactly as `StreamSession` frames it. */
export interface StreamAccountEvent {
  readonly eventId: string;
  readonly accountSequence: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export interface StreamHandlers {
  onReady(accountSequence: string, heartbeatIntervalMs: number): void;
  onQuote(
    market: string,
    symbol: string,
    payload: Readonly<Record<string, unknown>>,
  ): void;
  onEvent(event: StreamAccountEvent): Promise<void>;
  /**
   * The server refused the requested replay. The runner cannot fill the hole
   * from the stream; this is where it re-baselines the cursor so the next
   * connect does not ask for the same impossible replay again.
   */
  onResync(reason: string): Promise<void>;
  /** Every established connection, after `ready`. Where the re-baseline runs. */
  onConnected?(accountSequence: string): Promise<void>;
}

export interface StreamClientOptions {
  /** Where the socket dials. Already allow-listed by `readApiOrigin`. */
  readonly origin: string;
  /** The `Origin` header value the server's own check compares (§4.2). */
  readonly publicOrigin: string;
  readonly credentials: () => SessionCredentials | null;
  readonly instruments: readonly InstrumentRef[];
  /** The committed account cursor, or `null` on a session with no history. */
  readonly cursor: () => string | null;
  readonly reporter: Reporter;
  readonly handlers: StreamHandlers;
  readonly socketFactory?: StreamSocketFactory;
  /** Schedules `fn`; the returned function cancels it. Injected for tests. */
  readonly timer?: (fn: () => void, ms: number) => () => void;
  readonly policy?: ReconnectPolicyOptions;
}

interface Frame {
  readonly type?: unknown;
  readonly [field: string]: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function defaultSocketFactory(
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
): StreamSocket {
  // Node 24's built-in `WebSocket` takes non-standard `headers`, which is the
  // whole reason the runner needs no `ws` dependency: the upgrade must carry
  // `Origin` and `Cookie` (§4.2), and the browser API has no way to set either.
  return new WebSocket(url, {
    headers: { ...init.headers },
  } as unknown as string[]) as unknown as StreamSocket;
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);

  // A pending reconnect must not be the reason the process cannot exit.
  handle.unref?.();

  return () => clearTimeout(handle);
}

export class StreamClient {
  readonly #options: StreamClientOptions;
  readonly #socketFactory: StreamSocketFactory;
  readonly #timer: (fn: () => void, ms: number) => () => void;
  readonly #policy: ReconnectPolicy;
  #socket: StreamSocket | null = null;
  /**
   * Bumped for every socket this client stands up. Every handler closes over
   * the generation it was installed for, so an event from a socket the client
   * has already replaced is dropped instead of being read as the current
   * connection's.
   */
  #generation = 0;
  #running = false;
  #cancelReconnect: (() => void) | null = null;
  #cancelLiveness: (() => void) | null = null;
  #heartbeatMs = DEFAULT_HEARTBEAT_MS;
  #queue: StreamAccountEvent[] = [];
  #draining = false;

  constructor(options: StreamClientOptions) {
    this.#options = options;
    this.#socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.#timer = options.timer ?? defaultTimer;
    this.#policy = new ReconnectPolicy({
      ...options.policy,
      onHold: (failures) => {
        options.reporter.report(
          'error',
          'the market stream has failed repeatedly and is retrying on a slow schedule',
          { failures },
        );
        options.policy?.onHold?.(failures);
      },
    });
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  /** Schedules the first connect. Returns immediately; nothing blocks on a socket. */
  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#scheduleConnect();
  }

  /**
   * Stops for good. The socket is unwired *and* closed — a socket left
   * registered is a second connection against the session's limit, and one left
   * wired keeps calling back into a client that has finished.
   */
  stop(): void {
    this.#running = false;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#detach('runner shutdown');
  }

  #scheduleConnect(): void {
    if (!this.#running || this.#cancelReconnect !== null) {
      return;
    }

    const delay = this.#policy.nextDelayMs();

    this.#cancelReconnect = this.#timer(() => {
      this.#cancelReconnect = null;
      this.#connect();
    }, delay);
  }

  #connect(): void {
    if (!this.#running) {
      return;
    }

    const credentials = this.#options.credentials();

    if (credentials === null) {
      // No session to upgrade with. Not a stream failure — the session client
      // is establishing one — so it does not count against the failure window.
      this.#options.reporter.report(
        'warn',
        'the market stream has no session to connect with yet',
      );
      this.#scheduleConnect();

      return;
    }

    // Replaces whatever came before, unwired and closed, before the generation
    // moves. Anything the old socket says after this belongs to a generation
    // that is over.
    this.#detach('client reconnect');
    this.#generation += 1;

    const generation = this.#generation;
    const isCurrent = (): boolean => this.#generation === generation;
    const socket = this.#socketFactory(this.#url(), {
      headers: {
        origin: this.#options.publicOrigin,
        cookie: credentials.cookie,
      },
    });

    this.#socket = socket;

    socket.onopen = (): void => {
      if (!isCurrent()) {
        return;
      }

      this.#armLiveness();
    };
    socket.onmessage = (event): void => {
      if (!isCurrent()) {
        return;
      }

      this.#armLiveness();
      this.#receive(event.data);
    };
    socket.onerror = (event): void => {
      if (!isCurrent()) {
        return;
      }

      // Every rejection the upgrade can make — 400, 401, 403, 429 — arrives
      // here as one indistinguishable failure, because a WebSocket that never
      // reached 101 surfaces no status. The runner therefore does not branch on
      // it: the session client's own `GET /api/v1/portfolio` is what discovers
      // an expired session, and everything else is a backoff.
      this.#options.reporter.report('warn', 'the market stream errored', {
        error: event.message ?? 'unknown',
      });
    };
    socket.onclose = (event): void => {
      if (!isCurrent()) {
        return;
      }

      this.#options.reporter.report('warn', 'the market stream closed', {
        code: event.code ?? 0,
        reason: event.reason ?? '',
      });
      this.#fail();
    };
  }

  #url(): string {
    const url = new URL('/api/v1/stream', this.#options.origin);

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set(
      'quoteSymbols',
      this.#options.instruments.map(instrumentKey).join(','),
    );

    const cursor = this.#options.cursor();

    // Omitted rather than sent as `0` on a session with no committed cursor.
    // The server refuses an `afterSequence` below the outbox's retained floor
    // with `resync-required`, so `0` is a request to be disconnected on any
    // session whose outbox has been trimmed.
    if (cursor !== null) {
      url.searchParams.set('afterSequence', cursor);
    }

    return url.toString();
  }

  /** A connection that is over: drop it, count it, and schedule the next. */
  #fail(): void {
    this.#detach('connection failed');
    this.#policy.recordFailure();
    this.#scheduleConnect();
  }

  #detach(reason: string): void {
    this.#cancelLiveness?.();
    this.#cancelLiveness = null;

    const socket = this.#socket;

    this.#socket = null;
    // Whatever the dead connection left unprocessed belongs to a subscription
    // that is over. The next connect replays from the committed cursor, so
    // dropping the queue loses nothing and keeps a stale event from being
    // processed against a fresh connection's ordering.
    this.#queue = [];

    if (socket === null) {
      return;
    }

    socket.onopen = undefined;
    socket.onclose = undefined;
    socket.onerror = undefined;
    socket.onmessage = undefined;

    try {
      socket.close(1000, reason);
    } catch {
      /* a socket that is already gone needs no closing */
    }
  }

  /**
   * Restarts the silence deadline. Any frame counts, not only a heartbeat: a
   * socket carrying quotes is demonstrably alive whether or not the heartbeat
   * loop happens to have fired.
   */
  #armLiveness(): void {
    this.#cancelLiveness?.();

    const generation = this.#generation;

    this.#cancelLiveness = this.#timer(() => {
      if (this.#generation !== generation || !this.#running) {
        return;
      }

      this.#options.reporter.report(
        'warn',
        'the market stream stopped sending heartbeats and is being replaced',
        { silentMs: this.#heartbeatMs * LIVENESS_INTERVALS },
      );
      this.#fail();
    }, this.#heartbeatMs * LIVENESS_INTERVALS);
  }

  #receive(data: unknown): void {
    let frame: Frame;

    try {
      const parsed: unknown = JSON.parse(
        typeof data === 'string' ? data : String(data),
      );

      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }

      frame = parsed as Frame;
    } catch {
      // Not JSON. There is nothing to do with it and nothing it can break.
      return;
    }

    switch (frame.type) {
      case 'ready':
        this.#ready(frame);
        break;
      case 'quote':
        this.#quote(frame);
        break;
      case 'event':
        this.#enqueue(frame);
        break;
      case 'resync-required':
        this.#resync(frame);
        break;
      default:
        // `heartbeat`, and anything the server learns to send later. Both have
        // already refreshed the liveness deadline by arriving.
        break;
    }
  }

  #ready(frame: Frame): void {
    const sequence = text(frame.accountSequence);

    if (sequence === null) {
      return;
    }

    const advertised = frame.heartbeatIntervalMs;

    if (typeof advertised === 'number' && advertised > 0) {
      this.#heartbeatMs = advertised;
      this.#armLiveness();
    }

    // A connection that reached `ready` is a connection that worked: the
    // backoff starts over, so a single bad afternoon does not leave the next
    // reconnect five minutes slow.
    this.#policy.recordSuccess();
    this.#options.handlers.onReady(sequence, this.#heartbeatMs);

    const connected = this.#options.handlers.onConnected;

    if (connected !== undefined) {
      void connected(sequence).catch((error: unknown) => {
        this.#options.reporter.report(
          'warn',
          'the market stream could not re-baseline after connecting',
          { error: describe(error) },
        );
      });
    }
  }

  #quote(frame: Frame): void {
    const market = text(frame.market);
    const symbol = text(frame.symbol);
    const payload = frame.payload;

    if (
      market === null ||
      symbol === null ||
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      return;
    }

    this.#options.handlers.onQuote(
      market,
      symbol,
      payload as Record<string, unknown>,
    );
  }

  #resync(frame: Frame): void {
    const reason = text(frame.reason) ?? 'UNKNOWN';

    this.#options.reporter.report(
      'error',
      'the market stream demanded a resync; account events between the committed cursor and now were not delivered',
      { reason },
    );

    void this.#options.handlers.onResync(reason).catch((error: unknown) => {
      this.#options.reporter.report('error', 'the resync failed', {
        reason,
        error: describe(error),
      });
    });
  }

  #enqueue(frame: Frame): void {
    const eventId = text(frame.eventId);
    const accountSequence = text(frame.accountSequence);
    const eventType = text(frame.eventType);

    if (eventId === null || accountSequence === null || eventType === null) {
      this.#options.reporter.report(
        'warn',
        'an account event arrived without its identity and was dropped',
      );

      return;
    }

    this.#queue.push(
      Object.freeze({
        eventId,
        accountSequence,
        eventType,
        payload: frame.payload,
      }),
    );
    void this.#drain();
  }

  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }

    this.#draining = true;

    try {
      for (;;) {
        const event = this.#queue.shift();

        if (event === undefined) {
          return;
        }

        try {
          await this.#options.handlers.onEvent(event);
        } catch (error) {
          // Contained. The cursor did not advance, so the next connect replays
          // this event; stopping the drain would strand every event behind it
          // for no gain.
          this.#options.reporter.report(
            'error',
            'an account event could not be processed and will be replayed',
            {
              accountSequence: event.accountSequence,
              eventType: event.eventType,
              error: describe(error),
            },
          );
        }
      }
    } finally {
      this.#draining = false;
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
