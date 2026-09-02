import type { InstrumentRef } from '@moi/strategy-sdk/strategy';
import { describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import {
  StreamClient,
  type StreamHandlers,
  type StreamSocket,
} from './stream-client.js';

const SAMSUNG: InstrumentRef = { market: 'KR', symbol: '005930' };
const HYNIX: InstrumentRef = { market: 'KR', symbol: '000660' };

/** One socket the test drives by hand. */
class FakeSocket implements StreamSocket {
  onopen?: () => void;
  onclose?: (event: { code?: number; reason?: string }) => void;
  onerror?: (event: { message?: string }) => void;
  onmessage?: (event: { data: unknown }) => void;
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly headers: Readonly<Record<string, string>>,
  ) {}

  close(code?: number, reason?: string): void {
    this.closed = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
  }

  open(): void {
    this.onopen?.();
  }

  send(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006, reason = 'gone'): void {
    this.onclose?.({ code, reason });
  }
}

interface Harness {
  readonly client: StreamClient;
  readonly sockets: FakeSocket[];
  readonly reporter: ReturnType<typeof createRecordingReporter>;
  readonly seen: string[];
  /** Runs every timer the client has pending, innermost first. */
  fire(): Promise<void>;
  readonly delays: number[];
}

function harness(
  options: {
    readonly instruments?: readonly InstrumentRef[];
    readonly cursor?: () => string | null;
    readonly handlers?: Partial<StreamHandlers>;
  } = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const reporter = createRecordingReporter();
  const seen: string[] = [];
  const delays: number[] = [];
  let pending: (() => void)[] = [];
  const client = new StreamClient({
    origin: 'http://127.0.0.1:3001',
    publicOrigin: 'http://localhost:8080',
    credentials: () => ({
      sessionId: 'session-1',
      cookie: 'moi_session=secret-cookie-value',
      csrfToken: 'csrf-token',
    }),
    instruments: options.instruments ?? [SAMSUNG],
    cursor: options.cursor ?? (() => null),
    reporter,
    handlers: {
      onReady: (sequence) => seen.push(`ready:${sequence}`),
      onQuote: (market, symbol) => seen.push(`quote:${market}:${symbol}`),
      onEvent: async (event) => {
        seen.push(`event:${event.accountSequence}`);
      },
      onResync: async (reason) => {
        seen.push(`resync:${reason}`);
      },
      ...options.handlers,
    },
    socketFactory: (url, init) => {
      const socket = new FakeSocket(url, init.headers);

      sockets.push(socket);

      return socket;
    },
    timer: (fn, ms) => {
      delays.push(ms);
      pending.push(fn);

      return () => {
        pending = pending.filter((each) => each !== fn);
      };
    },
    policy: { random: () => 0 },
  });

  return {
    client,
    sockets,
    reporter,
    seen,
    delays,
    fire: async () => {
      const due = pending;

      pending = [];

      for (const fn of due) {
        fn();
      }

      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Lets the client's serial event drain settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
};

describe('the stream upgrade', () => {
  /**
   * Design §4.2: the upgrade needs `Origin` and `Cookie`, and phase B's finding
   * stands — the header value is `BOT_PUBLIC_ORIGIN`, which the server compares
   * against its own `publicOrigin`, not the host the socket dials.
   */
  it('dials the API origin and sends the public origin as the header', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    expect(socket.url).toBe(
      'ws://127.0.0.1:3001/api/v1/stream?quoteSymbols=KR%3A005930',
    );
    expect(socket.headers).toStrictEqual({
      origin: 'http://localhost:8080',
      cookie: 'moi_session=secret-cookie-value',
    });
  });

  it('upgrades over wss when the API origin is https', () => {
    const dialled: string[] = [];
    const secure = new StreamClient({
      origin: 'https://paper.example.com',
      publicOrigin: 'https://paper.example.com',
      credentials: () => ({
        sessionId: 's',
        cookie: 'moi_session=c',
        csrfToken: 't',
      }),
      instruments: [SAMSUNG],
      cursor: () => null,
      reporter: createRecordingReporter(),
      handlers: {
        onReady: () => {},
        onQuote: () => {},
        onEvent: async () => {},
        onResync: async () => {},
      },
      socketFactory: (url) => {
        dialled.push(url);

        return new FakeSocket(url, {});
      },
      timer: (fn) => {
        fn();

        return () => {};
      },
    });

    secure.start();
    secure.stop();

    expect(dialled).toStrictEqual([
      'wss://paper.example.com/api/v1/stream?quoteSymbols=KR%3A005930',
    ]);
  });

  it('subscribes to every configured instrument, comma separated', async () => {
    const h = harness({ instruments: [SAMSUNG, HYNIX] });

    h.client.start();
    await h.fire();

    expect((h.sockets[0] as FakeSocket).url).toContain(
      'quoteSymbols=KR%3A005930%2CKR%3A000660',
    );
  });

  /**
   * §6.4: the runner replays account events from the cursor it committed. A
   * first connect has none, and must **omit** the parameter rather than send
   * `0` — the server answers `afterSequence` below its retained floor with
   * `resync-required`, so `0` on a session whose outbox has been trimmed asks
   * to be disconnected.
   */
  it('replays from the committed cursor, and omits it when there is none', async () => {
    const withCursor = harness({ cursor: () => '41' });

    withCursor.client.start();
    await withCursor.fire();

    expect((withCursor.sockets[0] as FakeSocket).url).toContain(
      'afterSequence=41',
    );

    const fresh = harness({ cursor: () => null });

    fresh.client.start();
    await fresh.fire();

    expect((fresh.sockets[0] as FakeSocket).url).not.toContain('afterSequence');
  });

  it('never puts the cookie in a report', async () => {
    const h = harness();

    h.client.start();
    await h.fire();
    (h.sockets[0] as FakeSocket).drop(1006, 'moi_session=secret-cookie-value');
    await settle();

    expect(h.reporter.lines.join('\n')).not.toContain('secret-cookie-value');
    expect(h.reporter.lines.join('\n')).toContain('moi_session=***');
  });
});

describe('frames', () => {
  it('hands each frame kind to its handler', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({
      type: 'ready',
      accountSequence: '7',
      heartbeatIntervalMs: 30_000,
    });
    socket.send({
      type: 'quote',
      market: 'KR',
      symbol: '005930',
      recoveryEpoch: '1',
      marketDataVersion: '3',
      payload: { price: '70000' },
    });
    socket.send({
      type: 'event',
      eventId: 'e1',
      accountSequence: '8',
      eventType: 'ORDER_FILLED',
      payload: { orderId: 'o1' },
    });
    await settle();

    expect(h.seen).toStrictEqual(['ready:7', 'quote:KR:005930', 'event:8']);
  });

  it('ignores a heartbeat and an unknown frame without dying', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({ type: 'heartbeat', serverTime: 'now' });
    socket.send({ type: 'something-new' });
    socket.send('not json at all');
    await settle();

    expect(h.seen).toStrictEqual([]);
    expect(socket.closed).toBeNull();
  });

  /**
   * `onEvent` reads the portfolio and may submit an order, so it is async — and
   * two of them running at once would interleave two cursor advances over one
   * append-only log. They are drained one at a time, in arrival order.
   */
  it('processes account events one at a time, in order', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    const h = harness({
      handlers: {
        onEvent: async (event) => {
          order.push(`start:${event.accountSequence}`);

          if (event.accountSequence === '1') {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }

          order.push(`end:${event.accountSequence}`);
        },
      },
    });

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({
      type: 'event',
      eventId: 'a',
      accountSequence: '1',
      eventType: 'ORDER_FILLED',
      payload: {},
    });
    socket.send({
      type: 'event',
      eventId: 'b',
      accountSequence: '2',
      eventType: 'ORDER_FILLED',
      payload: {},
    });
    await settle();

    expect(order).toStrictEqual(['start:1']);

    (release as unknown as () => void)();
    await settle();

    expect(order).toStrictEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  /**
   * An event whose handler throws must not stop the drain or kill the socket:
   * the cursor did not advance, so the next connect replays it, and meanwhile
   * the market data on the same socket is still worth having.
   */
  it('contains a handler that throws', async () => {
    const h = harness({
      handlers: {
        onEvent: async (event) => {
          if (event.accountSequence === '1') {
            throw new Error('nope');
          }

          h.seen.push(`event:${event.accountSequence}`);
        },
      },
    });

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({
      type: 'event',
      eventId: 'a',
      accountSequence: '1',
      eventType: 'ORDER_FILLED',
      payload: {},
    });
    socket.send({
      type: 'event',
      eventId: 'b',
      accountSequence: '2',
      eventType: 'ORDER_FILLED',
      payload: {},
    });
    await settle();

    expect(h.seen).toStrictEqual(['event:2']);
    expect(h.reporter.lines.join('\n')).toMatch(
      /an account event could not be/u,
    );
  });
});

/**
 * The two bugs spec §16.34 records, written as the tests that would have caught
 * them. The paper API's own adapter now guards both with `detachSocket()` plus a
 * per-socket generation token; this client is not allowed to import that code,
 * so it has to earn the same guarantee and prove it.
 */
describe('a socket the client has already replaced', () => {
  it('cannot tear down its successor with a late close', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const first = h.sockets[0] as FakeSocket;

    first.open();
    first.drop();
    await settle();
    await h.fire();

    expect(h.sockets).toHaveLength(2);

    const second = h.sockets[1] as FakeSocket;

    second.open();
    // The replaced socket's `onclose` arrives now. Before §16.34's fix, this
    // failed the connection that had replaced it and started a reconnect for a
    // socket that was perfectly healthy.
    first.onclose?.({ code: 1006, reason: 'late' });
    await settle();

    expect(h.sockets).toHaveLength(2);
    expect(second.closed).toBeNull();

    second.send({
      type: 'ready',
      accountSequence: '9',
      heartbeatIntervalMs: 30_000,
    });
    await settle();

    expect(h.seen).toStrictEqual(['ready:9']);
  });

  it('cannot put a late frame into its successor stream', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const first = h.sockets[0] as FakeSocket;

    first.open();
    first.drop();
    await settle();
    await h.fire();

    const second = h.sockets[1] as FakeSocket;

    second.open();
    first.onmessage?.({
      data: JSON.stringify({
        type: 'event',
        eventId: 'stale',
        accountSequence: '1',
        eventType: 'ORDER_FILLED',
        payload: {},
      }),
    });
    await settle();

    expect(h.seen).toStrictEqual([]);
  });

  it('is closed and unwired when it is dropped', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const first = h.sockets[0] as FakeSocket;

    first.open();
    h.client.stop();

    expect(first.closed).not.toBeNull();
    expect(first.onclose).toBeUndefined();
    expect(first.onmessage).toBeUndefined();
    expect(first.onopen).toBeUndefined();
    expect(first.onerror).toBeUndefined();
  });
});

describe('reconnection', () => {
  it('comes back after a close, and says so', async () => {
    const h = harness();

    h.client.start();
    await h.fire();
    (h.sockets[0] as FakeSocket).open();
    (h.sockets[0] as FakeSocket).drop(1006, 'network');
    await settle();
    await h.fire();

    expect(h.sockets).toHaveLength(2);
    expect(h.reporter.lines.join('\n')).toMatch(/the market stream closed/u);
  });

  it('does not reconnect after stop', async () => {
    const h = harness();

    h.client.start();
    await h.fire();
    (h.sockets[0] as FakeSocket).open();
    h.client.stop();
    await h.fire();

    expect(h.sockets).toHaveLength(1);
  });

  /**
   * The other half of §16.34: the paper API used to latch a scope off for good
   * once its failure window was exhausted, and only an operator could lift it. A
   * bot in a container with nobody watching must come back on its own — slowly,
   * but on its own.
   */
  it('keeps trying, more slowly, once failures pile up', async () => {
    const h = harness();

    h.client.start();

    for (let i = 0; i < 12; i += 1) {
      await h.fire();
      (h.sockets[i] as FakeSocket).drop();
      await settle();
    }

    await h.fire();

    expect(h.sockets.length).toBeGreaterThan(12);
    expect(h.reporter.lines.join('\n')).toMatch(
      /the market stream has failed repeatedly/u,
    );
    // Slower, not stopped: the last delay comes from the re-arm band, whose
    // floor is half the step, not zero.
    expect(h.delays[h.delays.length - 1]).toBeGreaterThanOrEqual(15_000);
  });

  it('resets the backoff once a connection is ready', async () => {
    const h = harness();

    h.client.start();

    for (let i = 0; i < 3; i += 1) {
      await h.fire();
      (h.sockets[i] as FakeSocket).drop();
      await settle();
    }

    await h.fire();

    const socket = h.sockets[3] as FakeSocket;

    socket.open();
    socket.send({
      type: 'ready',
      accountSequence: '1',
      heartbeatIntervalMs: 30_000,
    });
    await settle();

    const before = h.delays.length;

    socket.drop();
    await settle();

    // Back at the base of the ordinary band, not wherever the run of failures
    // had pushed it.
    expect(h.delays[before]).toBe(0);
  });

  /**
   * A half-open socket produces no `onclose` at all: the process sits there
   * believing it is subscribed while the market moves without it. The server
   * advertises its heartbeat interval in `ready`, so silence past a multiple of
   * it is the only evidence available that the connection is gone.
   */
  it('replaces a socket that stopped sending heartbeats', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({
      type: 'ready',
      accountSequence: '1',
      heartbeatIntervalMs: 1_000,
    });
    await settle();
    // The liveness deadline, then the reconnect delay.
    await h.fire();
    await settle();
    await h.fire();

    expect(socket.closed).not.toBeNull();
    expect(h.sockets).toHaveLength(2);
    expect(h.reporter.lines.join('\n')).toMatch(/stopped sending heartbeats/u);
  });

  /**
   * The counterpart: a frame arriving pushes the deadline out again. The fake
   * timer has no clock, so what is asserted is the re-arm itself — the pending
   * deadline is cancelled and a fresh one of the same length is scheduled, and
   * the socket is untouched in the meantime.
   */
  it('pushes the deadline out again on every frame', async () => {
    const h = harness();

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({
      type: 'ready',
      accountSequence: '1',
      heartbeatIntervalMs: 1_000,
    });
    await settle();

    const armed = h.delays.filter((ms) => ms === 3_000).length;

    socket.send({ type: 'heartbeat', serverTime: 'now' });
    await settle();

    expect(h.delays.filter((ms) => ms === 3_000).length).toBe(armed + 1);
    expect(socket.closed).toBeNull();
    expect(h.sockets).toHaveLength(1);
  });
});

describe('resync', () => {
  /**
   * The server answers a cursor below its retained floor by closing the socket.
   * The runner cannot fill the hole from the stream, so it says so loudly and
   * hands the decision to `onResync`, which re-baselines the cursor before the
   * next connect asks for the same impossible replay again.
   */
  it('re-baselines rather than asking for the same replay again', async () => {
    const resynced: string[] = [];
    let cursor: string | null = '3';
    const h = harness({
      cursor: () => cursor,
      handlers: {
        onResync: async (reason) => {
          resynced.push(reason);
          cursor = '99';
        },
      },
    });

    h.client.start();
    await h.fire();

    const socket = h.sockets[0] as FakeSocket;

    socket.open();
    socket.send({ type: 'resync-required', reason: 'OUTBOX_GAP' });
    await settle();
    socket.drop(4009, 'OUTBOX_GAP');
    await settle();
    await h.fire();

    expect(resynced).toStrictEqual(['OUTBOX_GAP']);
    expect((h.sockets[1] as FakeSocket).url).toContain('afterSequence=99');
    expect(h.reporter.lines.join('\n')).toMatch(
      /the market stream demanded a resync/u,
    );
  });
});
