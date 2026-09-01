import { describe, expect, it } from 'vitest';
import type { MarketEvent } from '../types.js';
import { type TossSocket, TossWebSocketMarketData } from './toss-websocket.js';

const TRADE_FRAME = (price: string) => ({
  type: 'message',
  topic: 'trade:us:AAPL',
  data: {
    price,
    volume: '10',
    timestamp: '2026-06-18T23:30:00.000+09:00',
    currency: 'USD',
  },
});

/**
 * A socket the test drives by hand. It answers a declaration and a PING the
 * way the contract does, and it never closes itself — so a callback the
 * adapter installed on a socket it has since walked away from can be fired
 * deliberately, which is exactly what a dead TCP connection does late.
 */
class FakeSocket implements TossSocket {
  readonly sent: string[] = [];
  readonly closeCalls: Array<{
    code: number | undefined;
    reason: string | undefined;
  }> = [];
  onopen?: () => void;
  onclose?: (event?: { reason?: string; code?: number }) => void;
  onerror?: (error: unknown) => void;
  onmessage?: (event: { data: unknown }) => void;

  send(data: string): void {
    this.sent.push(data);
    if (data === 'PING') {
      queueMicrotask(() => this.deliver({ type: 'pong' }));
      return;
    }
    const [envelope] = JSON.parse(data) as [{ id?: string }];
    queueMicrotask(() =>
      this.deliver({
        type: 'subscriptions',
        ...(envelope.id === undefined ? {} : { id: envelope.id }),
        subscribed: ['trade:us:AAPL'],
        rejected: [],
      }),
    );
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function build() {
  const sockets: FakeSocket[] = [];
  const stream = new TossWebSocketMarketData({
    url: new URL('ws://127.0.0.1:1/socket'),
    market: 'US',
    tokenProvider: { getAccessToken: async () => 'tok-1' },
    controlTimeoutMs: 1_000,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      // The handshake installs its handlers synchronously after the factory
      // returns, so the open lands on the next microtask.
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  });
  return { stream, sockets };
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('reconnecting over a socket that is still open', () => {
  it('does not let the replaced socket close the connection that replaced it', async () => {
    const { stream, sockets } = build();
    const signal = new AbortController().signal;
    await stream.connect(signal);
    const first = sockets[0] as FakeSocket;
    // Captured while it is still the live socket: a dead connection has its
    // callbacks queued long before the adapter gives up on it.
    const lateClose = first.onclose;

    await stream.connect(signal);
    expect(sockets).toHaveLength(2);
    // The abandoned socket is what the provider evicts as a duplicate
    // subscription, so the reconnect must close it.
    expect(first.closeCalls).toHaveLength(1);

    const events: MarketEvent[] = [];
    const drain = (async () => {
      for await (const event of stream.events(signal)) events.push(event);
    })();
    await flush();

    lateClose?.({ reason: 'Bye', code: 1000 });
    await flush();

    await expect(
      stream.declare([{ channel: 'trade', market: 'US', symbols: ['AAPL'] }]),
    ).resolves.toEqual({ accepted: ['trade:US:AAPL'], rejected: [] });
    expect(stream.isConnected).toBe(true);
    expect(events).toEqual([]);

    await stream.close();
    await drain;
  });

  it('keeps a frame that arrives on the replaced socket out of the new stream', async () => {
    const { stream, sockets } = build();
    const signal = new AbortController().signal;
    await stream.connect(signal);
    const first = sockets[0] as FakeSocket;
    const lateMessage = first.onmessage;

    await stream.connect(signal);
    const second = sockets[1] as FakeSocket;

    const events: MarketEvent[] = [];
    const drain = (async () => {
      for await (const event of stream.events(signal)) events.push(event);
    })();
    await flush();

    lateMessage?.({ data: JSON.stringify(TRADE_FRAME('1.00')) });
    await flush();
    expect(events).toEqual([]);

    second.deliver(TRADE_FRAME('2.00'));
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'trade', price: '2.00' });

    await stream.close();
    await drain;
  });

  it('closes and detaches the live socket on close()', async () => {
    const { stream, sockets } = build();
    const signal = new AbortController().signal;
    await stream.connect(signal);
    const first = sockets[0] as FakeSocket;
    const lateClose = first.onclose;
    await stream.close();
    expect(first.closeCalls).toEqual([
      { code: 1000, reason: 'client shutdown' },
    ]);

    // A reconnect after a shutdown must not inherit the old socket's close.
    await stream.connect(signal);
    const events: MarketEvent[] = [];
    const drain = (async () => {
      for await (const event of stream.events(signal)) events.push(event);
    })();
    await flush();
    lateClose?.({ reason: 'Bye', code: 1000 });
    await flush();
    expect(events).toEqual([]);
    expect(stream.isConnected).toBe(true);

    await stream.close();
    await drain;
  });
});
