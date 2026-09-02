import { createHash } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MetricsRegistry } from '../../observability/metrics.js';
import { LayeredRateLimiter } from '../../plugins/rate-limits.js';
import { SESSION_COOKIE } from '../session/session-token.js';
import { StreamHeartbeatLoop } from './stream-heartbeat-loop.js';
import { StreamHub } from './stream-hub.js';
import { registerStreamRoutes } from './stream-routes.js';
import {
  type DurableAccountEvent,
  type DurableEventSource,
  StreamSession,
} from './stream-session.js';
import {
  createStreamUpgradeHandler,
  STREAM_CLOSE_GRACE_MS,
  STREAM_MAX_PAYLOAD_BYTES,
  type StreamUpgradeHandler,
} from './stream-upgrade.js';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const ORIGIN = 'https://app.moi.test';
const TRADABLE = new Set(['US:AAPL', 'KR:005930', 'US:MSFT']);
const E = (
  sequence: number,
  eventId = `e${sequence}`,
): DurableAccountEvent => ({
  id: `row-${eventId}`,
  eventId,
  sessionId: 'sid',
  accountSequence: String(sequence),
  eventType: 'ORDER_PLACED',
  payload: { sequence },
  createdAt: new Date(0).toISOString(),
});

interface Fixture {
  app: FastifyInstance;
  port: number;
  hub: StreamHub;
  handler: StreamUpgradeHandler;
  metrics: MetricsRegistry;
  logs: { event: string; fields: Record<string, unknown> }[];
  gate: { open: boolean };
  auth: {
    deferred?: Deferred<void>;
    reject?: unknown;
    status: string;
    calls: number;
  };
  source: {
    replayDeferred?: Deferred<readonly DurableAccountEvent[]>;
    events: DurableAccountEvent[];
    replayCalls: (string | undefined)[];
  };
  closeGraceMs: number;
}

let fixture: Fixture;
const clients: WebSocket[] = [];
const rawSockets: Socket[] = [];

async function build(
  options: { closeGraceMs?: number } = {},
): Promise<Fixture> {
  const app = Fastify({ logger: false });
  const hub = new StreamHub();
  const metrics = new MetricsRegistry();
  const logs: Fixture['logs'] = [];
  const gate = { open: true };
  const auth: Fixture['auth'] = { status: 'ACTIVE', calls: 0 };
  const source: Fixture['source'] = {
    events: [E(1), E(2), E(3), E(4)],
    replayCalls: [],
  };
  const durable: DurableEventSource = {
    latest: async () => String(source.events.at(-1)?.accountSequence ?? '0'),
    oldest: async () => source.events[0]?.accountSequence,
    replay: async (_sessionId, after) => {
      source.replayCalls.push(after);
      if (source.replayDeferred) return source.replayDeferred.promise;
      return source.events.filter(
        (e) => after === undefined || BigInt(e.accountSequence) > BigInt(after),
      );
    },
  };
  const sessionService = {
    authenticate: async (token: string) => {
      auth.calls += 1;
      if (auth.deferred) await auth.deferred.promise;
      if (auth.reject) throw auth.reject;
      if (token !== 'good')
        throw Object.assign(new Error('expired'), {
          statusCode: 401,
          code: 'SESSION_EXPIRED',
        });
      return { session: { id: 'sid', status: auth.status }, csrfToken: 'x' };
    },
  };
  const limiter = new LayeredRateLimiter();
  await registerStreamRoutes(app, {
    principal: async () => ({ id: 'sid', status: 'ACTIVE' }),
    source: durable,
    quoteSymbols: TRADABLE,
    limiter,
  });
  await app.ready();
  const handler = createStreamUpgradeHandler({
    server: app.server,
    publicOrigin: ORIGIN,
    sessionService,
    limiter,
    hub,
    gate: { isOpen: () => gate.open },
    source: durable,
    tradableSymbols: TRADABLE,
    maxPayloadBytes: STREAM_MAX_PAYLOAD_BYTES,
    closeGraceMs: options.closeGraceMs ?? STREAM_CLOSE_GRACE_MS,
    metrics,
    log: (event, fields) => logs.push({ event, fields }),
  });
  handler.attach();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    port: Number(new URL(address).port),
    hub,
    handler,
    metrics,
    logs,
    gate,
    auth,
    source,
    closeGraceMs: options.closeGraceMs ?? STREAM_CLOSE_GRACE_MS,
  };
}

function client(
  query = '',
  headers: Record<string, string> = {
    origin: ORIGIN,
    cookie: `${SESSION_COOKIE}=good`,
  },
) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${fixture.port}/api/v1/stream${query}`,
    { headers },
  );
  clients.push(ws);
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(String(data))));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) =>
      reject(
        Object.assign(new Error('rejected'), {
          status: res.statusCode,
          headers: res.headers,
        }),
      ),
    );
    ws.once('error', reject);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.once('close', (code, reason) =>
      resolve({ code, reason: String(reason) }),
    ),
  );
  return { ws, messages, opened, closed };
}

async function expectRejected(
  query: string,
  status: number,
  headers?: Record<string, string>,
) {
  const c = client(query, headers);
  const error = (await c.opened.then(() => undefined).catch((e) => e)) as
    | { status?: number; headers?: Record<string, string> }
    | undefined;
  expect(error?.status, `status for ${query}`).toBe(status);
  return error;
}

beforeEach(async () => {
  fixture = await build();
});
afterEach(async () => {
  for (const ws of clients.splice(0)) {
    ws.on('error', () => undefined);
    ws.terminate();
  }
  for (const s of rawSockets.splice(0)) s.destroy();
  await fixture.handler.closeAll(1001, 'test');
  fixture.handler.detach();
  await fixture.app.close();
});

const eventIds = (messages: Record<string, unknown>[]) =>
  messages.filter((m) => m.type === 'event').map((m) => m.eventId);

describe('stream upgrade bridge', () => {
  it('U1: happy path replays everything, registers the session, and unregisters on close', async () => {
    const c = client();
    await c.opened;
    await vi.waitFor(() =>
      expect(eventIds(c.messages)).toEqual(['e1', 'e2', 'e3', 'e4']),
    );
    expect(c.messages[0]).toMatchObject({
      type: 'ready',
      accountSequence: '4',
    });
    expect(fixture.hub.size()).toBe(1);
    c.ws.close(1000);
    await c.closed;
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(0));
  });

  it('U1b: afterSequence is honoured and validated', async () => {
    const c = client('?afterSequence=2');
    await c.opened;
    await vi.waitFor(() => expect(eventIds(c.messages)).toEqual(['e3', 'e4']));
    expect(fixture.source.replayCalls).toEqual(['2']);
    for (const bad of [
      '-1',
      '1.5',
      '%201',
      'abc',
      '1'.repeat(20),
      '1&afterSequence=2',
    ]) {
      await expectRejected(`?afterSequence=${bad}`, 400);
    }
    expect(fixture.hub.size()).toBe(1);
    expect(fixture.metrics.metrics()).toContain(
      'stream_upgrade_rejected_total{reason="bad_request"} 6',
    );
  });

  it('U1c: quoteSymbols subscribe only the requested allow-listed symbols', async () => {
    const c = client('?quoteSymbols=US:AAPL,KR:005930');
    await c.opened;
    await vi.waitFor(() => expect(eventIds(c.messages)).toHaveLength(4));
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    const quote = (symbol: string, market: 'US' | 'KR') =>
      fixture.hub.publishQuote({
        market,
        symbol,
        recoveryEpoch: 1n,
        marketDataVersion: 1n,
        payload: { symbol },
      });
    quote('AAPL', 'US');
    quote('005930', 'KR');
    quote('MSFT', 'US');
    await vi.waitFor(() =>
      expect(c.messages.filter((m) => m.type === 'quote')).toHaveLength(2),
    );
    expect(
      c.messages.filter((m) => m.type === 'quote').map((m) => m.symbol),
    ).toEqual(['AAPL', '005930']);
    for (const bad of [
      'US:ZZZZ',
      'US:AAPL,US:AAPL',
      'aapl',
      'US:AAPL,US:MSFT,KR:005930,US:A,US:B,US:C',
    ]) {
      await expectRejected(`?quoteSymbols=${bad}`, 400);
    }
  });

  it('U2: other paths get 404', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}/other`, {
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=good` },
    });
    clients.push(ws);
    const status = await new Promise<number>((resolve) =>
      ws.once('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(404);
  });

  it('U3: missing or mismatched Origin gets 403', async () => {
    await expectRejected('', 403, { cookie: `${SESSION_COOKIE}=good` });
    await expectRejected('', 403, {
      origin: 'https://evil.test',
      cookie: `${SESSION_COOKIE}=good`,
    });
    expect(fixture.auth.calls).toBe(0);
  });

  it('U4: missing cookie, expired token, or non-ACTIVE session gets 401', async () => {
    await expectRejected('', 401, { origin: ORIGIN });
    await expectRejected('', 401, {
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=expired`,
    });
    fixture.auth.status = 'REVOKED';
    await expectRejected('', 401);
    expect(fixture.hub.size()).toBe(0);
  });

  it('U5: connection and subscription rate limits return 429 with Retry-After', async () => {
    const opened: ReturnType<typeof client>[] = [];
    for (let i = 0; i < 5; i += 1) {
      const c = client();
      await c.opened;
      opened.push(c);
    }
    const error = await expectRejected('', 429);
    expect(error?.headers?.['retry-after']).toBeDefined();
  });

  it('U6: non-websocket upgrades get 426', async () => {
    const socket = connect(fixture.port, '127.0.0.1');
    rawSockets.push(socket);
    await new Promise<void>((r) => socket.once('connect', r));
    socket.write(
      `GET /api/v1/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: h2c\r\nOrigin: ${ORIGIN}\r\nCookie: ${SESSION_COOKIE}=good\r\n\r\n`,
    );
    const response = await new Promise<string>((r) =>
      socket.once('data', (d) => r(String(d))),
    );
    expect(response).toMatch(/^HTTP\/1\.1 426/);
    expect(response).toContain('UPGRADE_REQUIRED');
  });

  it('U7: a plain GET through Fastify still gets the 426 fallback with a requestId', async () => {
    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/v1/stream',
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=good` },
    });
    expect(response.statusCode).toBe(426);
    expect(response.json()).toMatchObject({ code: 'UPGRADE_REQUIRED' });
    expect(response.json().requestId).toBeTypeOf('string');
  });

  it('U8: an unexpected authenticate failure yields 500, destroys the socket, and never throws', async () => {
    const uncaught = vi.fn();
    process.once('uncaughtException', uncaught);
    fixture.auth.reject = new Error('db down');
    await expectRejected('', 500);
    expect(fixture.logs.some((l) => l.event === 'stream.upgrade_failed')).toBe(
      true,
    );
    expect(uncaught).not.toHaveBeenCalled();
    process.removeListener('uncaughtException', uncaught);
  });

  it('U8b: any inbound frame closes the socket with 1003', async () => {
    const c = client();
    await c.opened;
    c.ws.send(JSON.stringify({ afterSequence: '3' }));
    const closed = await c.closed;
    expect(closed.code).toBe(1003);
    expect(
      fixture.logs.filter((l) => l.event === 'stream.inbound_rejected'),
    ).toHaveLength(1);
    const b = client();
    await b.opened;
    b.ws.send(Buffer.from([1, 2, 3]));
    expect((await b.closed).code).toBe(1003);
  });

  it('U9: closeAll sends 1012 to everyone and detach removes the listener', async () => {
    const a = client();
    const b = client();
    await Promise.all([a.opened, b.opened]);
    await fixture.handler.closeAll(1012, 'SERVICE_RESTART');
    expect((await a.closed).code).toBe(1012);
    expect((await b.closed).code).toBe(1012);
    expect(fixture.hub.size()).toBe(0);
    fixture.handler.detach();
    expect(fixture.app.server.listenerCount('upgrade')).toBe(0);
    const late = client();
    await expect(late.opened).rejects.toBeDefined();
  });

  it('U9b/U9c: detach during authentication destroys the pending socket and blocks the late handshake', async () => {
    fixture.auth.deferred = new Deferred();
    const spy = vi.spyOn(fixture.handler, 'handleUpgradeForTest');
    const c = client();
    await vi.waitFor(() => expect(fixture.handler.pendingCount()).toBe(1));
    fixture.handler.detach();
    expect(fixture.handler.pendingCount()).toBe(0);
    await expect(c.opened).rejects.toBeDefined();
    fixture.auth.deferred.resolve();
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
    expect(fixture.hub.size()).toBe(0);
  });

  it('U9d: closeAll terminates clients that ignore the close frame within the grace period', async () => {
    await fixture.handler.closeAll(1001, 'rebuild');
    fixture.handler.detach();
    await fixture.app.close();
    fixture = await build({ closeGraceMs: 200 });
    const raw = async () => {
      const socket = connect(fixture.port, '127.0.0.1');
      rawSockets.push(socket);
      await new Promise<void>((r) => socket.once('connect', r));
      const key = Buffer.from(
        createHash('sha1').update(String(Math.random())).digest(),
      )
        .subarray(0, 16)
        .toString('base64');
      socket.write(
        `GET /api/v1/stream HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nOrigin: ${ORIGIN}\r\nCookie: ${SESSION_COOKIE}=good\r\n\r\n`,
      );
      const head = await new Promise<string>((r) =>
        socket.once('data', (d) => r(String(d))),
      );
      expect(head).toMatch(/^HTTP\/1\.1 101/);
      return socket;
    };
    const a = await raw();
    const b = await raw();
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(2));
    const started = Date.now();
    await fixture.handler.closeAll(1012, 'SERVICE_RESTART');
    expect(Date.now() - started).toBeLessThan(200 + 500);
    expect(fixture.hub.size()).toBe(0);
    await vi.waitFor(() => {
      expect(a.destroyed || a.closed).toBe(true);
      expect(b.destroyed || b.closed).toBe(true);
    });
  });

  it('U11: live events published during replay are queued and delivered in total order', async () => {
    fixture.source.replayDeferred = new Deferred();
    const c = client('?afterSequence=2');
    await c.opened;
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(1));
    await vi.waitFor(() => expect(fixture.source.replayCalls).toHaveLength(1));
    await fixture.hub.deliver('sid', E(5));
    await fixture.hub.deliver('sid', E(6));
    fixture.source.replayDeferred.resolve([E(3), E(4)]);
    await vi.waitFor(() =>
      expect(eventIds(c.messages)).toEqual(['e3', 'e4', 'e5', 'e6']),
    );
    await fixture.hub.deliver('sid', E(7));
    await vi.waitFor(() =>
      expect(eventIds(c.messages)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']),
    );
  });

  /**
   * §16.50: the wiring. While replay is still pending the entry is OPENING, and
   * a quote for a symbol the client asked for must reach it now — before the
   * replayed events, since those are what the client is waiting on — while a
   * quote for a tradable symbol it did not ask for must not. After promotion
   * the LIVE fan-out is the only path, so a quote arrives exactly once.
   */
  it('a quote published during replay reaches the client before the replayed events', async () => {
    fixture.source.replayDeferred = new Deferred();
    const c = client('?afterSequence=2&quoteSymbols=US:AAPL');
    await c.opened;
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(1));
    await vi.waitFor(() => expect(fixture.source.replayCalls).toHaveLength(1));
    const quote = (symbol: string, market: 'US' | 'KR', version: bigint) =>
      fixture.hub.publishQuote({
        market,
        symbol,
        recoveryEpoch: 1n,
        marketDataVersion: version,
        payload: { symbol },
      });
    quote('AAPL', 'US', 7n);
    quote('005930', 'KR', 8n);
    await vi.waitFor(() =>
      expect(c.messages.filter((m) => m.type === 'quote')).toHaveLength(1),
    );
    expect(eventIds(c.messages)).toEqual([]);
    fixture.source.replayDeferred.resolve([E(3), E(4)]);
    await vi.waitFor(() => expect(eventIds(c.messages)).toEqual(['e3', 'e4']));
    quote('AAPL', 'US', 9n);
    await vi.waitFor(() =>
      expect(c.messages.filter((m) => m.type === 'quote')).toHaveLength(2),
    );
    expect(
      c.messages
        .filter((m) => m.type === 'quote')
        .map((m) => m.marketDataVersion),
    ).toEqual(['7', '9']);
    const types = c.messages.map((m) => m.type);
    expect(types.indexOf('quote')).toBeLessThan(types.indexOf('event'));
  });

  it('U11d: an OUTBOX_GAP close during open leaves no registry entry', async () => {
    fixture.source.events = [E(10), E(11)];
    const c = client('?afterSequence=1');
    await c.opened;
    const closed = await c.closed;
    expect(closed.code).toBe(4009);
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(0));
  });

  it('U12: a closed gate rejects with 503 before authentication and on the post-auth recheck', async () => {
    fixture.gate.open = false;
    const error = await expectRejected('', 503);
    expect(error?.headers?.['retry-after']).toBe('1');
    expect(fixture.auth.calls).toBe(0);
    expect(fixture.metrics.metrics()).toContain(
      'stream_upgrade_rejected_total{reason="not_ready"} 1',
    );
    fixture.gate.open = true;
    fixture.auth.deferred = new Deferred();
    const spy = vi.spyOn(fixture.handler, 'handleUpgradeForTest');
    const c = client();
    await vi.waitFor(() => expect(fixture.auth.calls).toBe(1));
    fixture.gate.open = false;
    fixture.auth.deferred.resolve();
    await expectRejectedPromise(c.opened, 503);
    expect(spy).not.toHaveBeenCalled();
    expect(fixture.hub.size()).toBe(0);
  });

  it('H2: a LIVE client receives heartbeats from the process-wide loop', async () => {
    const c = client();
    await c.opened;
    await vi.waitFor(() => expect(eventIds(c.messages)).toHaveLength(4));
    const loop = new StreamHeartbeatLoop({ hub: fixture.hub, intervalMs: 30 });
    loop.start();
    await vi.waitFor(() =>
      expect(
        c.messages.filter((m) => m.type === 'heartbeat').length,
      ).toBeGreaterThanOrEqual(2),
    );
    loop.stop();
    c.ws.close();
    await c.closed;
    await vi.waitFor(() => expect(fixture.hub.size()).toBe(0));
    const sendSpy = vi.spyOn(StreamSession.prototype, 'heartbeat');
    fixture.hub.heartbeat(new Date().toISOString());
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });
});

async function expectRejectedPromise(opened: Promise<void>, status: number) {
  const error = (await opened.then(() => undefined).catch((e) => e)) as
    | { status?: number }
    | undefined;
  expect(error?.status).toBe(status);
}
