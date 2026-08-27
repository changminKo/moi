import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { TokenProvider } from '../ports.js';
import { FakeTossWsServer } from '../testing/fake-toss/fake-toss-ws-server.js';
import { TossWebSocketMarketData } from './toss-websocket.js';

let server: FakeTossWsServer;
const streams: TossWebSocketMarketData[] = [];
const rawClients: WebSocket[] = [];

function adapter(
  tokens: TokenProvider = { getAccessToken: async () => 'tok-1' },
  market: 'US' | 'KR' = 'US',
  rateLimitRetryMs = 20,
) {
  const stream = new TossWebSocketMarketData({
    url: new URL(server.url),
    market,
    tokenProvider: tokens,
    controlTimeoutMs: 1_000,
    rateLimitRetryMs,
  });
  streams.push(stream);
  return stream;
}
const signal = () => new AbortController().signal;
async function raw(token = 'tok-1') {
  const ws = new WebSocket(server.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  rawClients.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_r, res) =>
      reject(new Error(`handshake ${res.statusCode}`)),
    );
  });
  return { ws, frames };
}

beforeEach(async () => {
  server = new FakeTossWsServer();
  await server.start();
  server.allowToken('tok-1');
});
afterEach(async () => {
  for (const stream of streams.splice(0)) await stream.close();
  for (const ws of rawClients.splice(0)) {
    ws.on('error', () => undefined);
    ws.terminate();
  }
  await server.stop();
});

describe('declaration frame (B2)', () => {
  it('sends the contract JSON array and the fake rejects the legacy object frame with wrong-format', async () => {
    const stream = adapter();
    await stream.connect(signal());
    const ack = await stream.declare([
      { channel: 'trade', market: 'US', symbols: ['AAPL'] },
      { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
    ]);
    expect([...ack.accepted].sort()).toEqual([
      'orderBook:US:AAPL',
      'trade:US:AAPL',
    ]);
    expect(server.subscribedTopics()).toEqual([
      'orderbook:us:AAPL',
      'trade:us:AAPL',
    ]);
    const { ws, frames } = await raw();
    ws.send(
      JSON.stringify({
        type: 'subscriptions',
        subscriptions: [{ channel: 'trade:us', codes: ['AAPL'] }],
      }),
    );
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        type: 'error',
        error: { code: 'wrong-format' },
      }),
    );
  });

  it('maps partial rejections back to canonical topic keys', async () => {
    const stream = adapter();
    await stream.connect(signal());
    server.rejectTopics(['trade:us:NOPE'], 'stock-not-found');
    const ack = await stream.declare([
      { channel: 'trade', market: 'US', symbols: ['AAPL', 'NOPE'] },
    ]);
    expect(ack.accepted).toEqual(['trade:US:AAPL']);
    expect(ack.rejected).toEqual([
      { topic: 'trade:US:NOPE', reason: 'rejected: stock-not-found' },
    ]);
  });

  it('re-declares once after rate-limit-exceeded and fails on other declaration errors', async () => {
    const stream = adapter(undefined, 'US', 1_050);
    await stream.connect(signal());
    for (let i = 0; i < 5; i += 1)
      await stream.declare([
        { channel: 'trade', market: 'US', symbols: ['AAPL'] },
      ]);
    const before = server.declareCount;
    await expect(
      stream.declare([{ channel: 'trade', market: 'US', symbols: ['AAPL'] }]),
    ).resolves.toBeDefined();
    expect(server.declareCount).toBeGreaterThanOrEqual(before);
    await expect(
      stream.declare([
        {
          channel: 'trade',
          market: 'US',
          symbols: Array.from({ length: 101 }, (_, i) => `S${i}`),
        },
      ]),
    ).rejects.toMatchObject({
      code: 'SUBSCRIPTION_REJECTED',
      message: /too-many-topics/,
    });
  });
});

describe('transport events (B3, §8.4)', () => {
  it('reports transportClosed with the instance market on abnormal close', async () => {
    const stream = adapter(undefined, 'KR');
    await stream.connect(signal());
    const controller = new AbortController();
    const iterator = stream.events(controller.signal)[Symbol.asyncIterator]();
    server.closeAll(1006, 'evicted');
    const event = await iterator.next();
    expect(event.value).toMatchObject({
      kind: 'transportClosed',
      market: 'KR',
    });
    controller.abort();
  });

  it('turns server-shutdown into a transportClosed with that reason', async () => {
    const stream = adapter();
    await stream.connect(signal());
    const controller = new AbortController();
    const iterator = stream.events(controller.signal)[Symbol.asyncIterator]();
    server.announceShutdownAndClose();
    const event = await iterator.next();
    expect(event.value).toMatchObject({
      kind: 'transportClosed',
      market: 'US',
      reason: 'server-shutdown',
    });
    controller.abort();
  });

  it('evicts the oldest connection past two per account and counts it', async () => {
    const a = adapter();
    const b = adapter();
    const c = adapter();
    await a.connect(signal());
    await b.connect(signal());
    const controller = new AbortController();
    const iterator = a.events(controller.signal)[Symbol.asyncIterator]();
    await c.connect(signal());
    expect((await iterator.next()).value).toMatchObject({
      kind: 'transportClosed',
    });
    expect(server.connections).toBe(2);
    expect(server.peakConcurrentConnections).toBe(3);
    expect(server.evictions).toBe(1);
    controller.abort();
  });
});

describe('handshake authentication', () => {
  it('invalidates and retries once on 401, then fails with AUTH_FAILED', async () => {
    let issued = 0;
    const tokens: TokenProvider = {
      getAccessToken: async () => {
        issued += 1;
        return issued === 1 ? 'stale-token' : 'tok-2';
      },
      invalidate: vi.fn(),
    };
    server.allowToken('tok-2');
    const stream = adapter(tokens);
    await stream.connect(signal());
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(server.handshakeStatuses).toEqual([401, 101]);
    const twice = adapter({
      getAccessToken: async () => 'nope',
      invalidate: vi.fn(),
    });
    await expect(twice.connect(signal())).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      statusCode: 401,
    });
    server.setIpAllowed(false);
    await expect(adapter().connect(signal())).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      statusCode: 403,
    });
  });
});

describe('keepalive ownership (B4)', () => {
  it('owns no interval timer and answers caller-driven pings one for one', async () => {
    const source = readFileSync(
      new URL('./toss-websocket.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/setInterval/);
    const stream = adapter();
    await stream.connect(signal());
    for (let i = 0; i < 3; i += 1)
      expect(await stream.ping()).toBeGreaterThanOrEqual(0);
    expect(server.pongCount).toBe(3);
    server.failNextPongs(1);
    await expect(stream.ping()).rejects.toMatchObject({ code: 'PONG_FAILED' });
    expect(server.pongCount).toBe(3);
  });
});
