import { describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../../observability/metrics.js';
import {
  STREAM_OPENING_QUEUE_MAX,
  STREAM_PROMOTE_MAX_ROUNDS,
  StreamHub,
} from './stream-hub.js';
import {
  type DurableAccountEvent,
  type DurableEventSource,
  StreamSession,
  type StreamSocket,
} from './stream-session.js';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}
function socket() {
  const messages: string[] = [];
  let closed: { code: number; reason: string | undefined } | undefined;
  const s: StreamSocket & {
    messages: string[];
    readonly closed: typeof closed;
    bufferedAmount: number;
  } = {
    messages,
    get closed() {
      return closed;
    },
    bufferedAmount: 0,
    send: (m) => {
      messages.push(m);
    },
    close: (code, reason) => {
      closed = { code, reason };
    },
  };
  return s;
}
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
const received = (s: { messages: string[] }) =>
  s.messages
    .map((m) => JSON.parse(m))
    .filter((m) => m.type !== 'ready')
    .map((m) => (m.type === 'event' ? m.eventId : m.type));

function sourceWith(
  replay:
    | Deferred<readonly DurableAccountEvent[]>
    | readonly DurableAccountEvent[],
  latest = '4',
): DurableEventSource {
  return {
    latest: async () => latest,
    oldest: async () => '1',
    replay: async () => (replay instanceof Deferred ? replay.promise : replay),
  };
}

describe('StreamHub registration', () => {
  it('tracks OPENING and LIVE entries, sizes, and idempotent unregister', async () => {
    const hub = new StreamHub();
    const s = socket();
    const handle = hub.registerOpening('sid', s);
    expect(hub.size()).toBe(1);
    expect(hub.stateOf(handle)).toBe('OPENING');
    const opened = await StreamSession.open({
      sessionId: 'sid',
      source: sourceWith([]),
      socket: s,
    });
    expect(await hub.promoteToLive('sid', handle, opened)).toBe(true);
    expect(hub.stateOf(handle)).toBe('LIVE');
    hub.unregister('sid', handle);
    hub.unregister('sid', handle);
    expect(hub.size()).toBe(0);
    expect(hub.stateOf(handle)).toBeUndefined();
    await expect(hub.deliver('sid', E(9))).resolves.toBeUndefined();
  });

  it('StreamSession.open returns explicit replay metadata', async () => {
    const s = socket();
    const opened = await StreamSession.open({
      sessionId: 'sid',
      source: sourceWith([E(3), E(4)]),
      socket: s,
      afterSequence: '2',
    });
    expect(opened.replayedUpTo).toBe('4');
    expect([...opened.replayedEventIds].sort()).toEqual(['e3', 'e4']);
    const empty = await StreamSession.open({
      sessionId: 'sid',
      source: sourceWith([], '7'),
      socket: socket(),
    });
    expect(empty.replayedUpTo).toBe('7');
    expect(empty.replayedEventIds.size).toBe(0);
  });
});

describe('StreamHub replay→live barrier (U11)', () => {
  it('queues during OPENING, flushes in rounds, preserves total order, then goes LIVE on an observed empty queue', async () => {
    const hub = new StreamHub();
    const s = socket();
    const replay = new Deferred<readonly DurableAccountEvent[]>();
    const handle = hub.registerOpening('sid', s);
    const opening = StreamSession.open({
      sessionId: 'sid',
      source: sourceWith(replay),
      socket: s,
    });
    let deliverResolved = false;
    const deliverE5 = hub.deliver('sid', E(5)).then(() => {
      deliverResolved = true;
    });
    await Promise.resolve();
    expect(deliverResolved).toBe(true);
    expect(hub.queueDepth(handle)).toBe(1);
    replay.resolve([E(3), E(4)]);
    const opened = await opening;
    // block the first session.deliver so E6 arrives mid-flush
    const gate = new Deferred();
    const originalDeliver = opened.session.deliver.bind(opened.session);
    const deliverSpy = vi
      .spyOn(opened.session, 'deliver')
      .mockImplementationOnce(async (event) => {
        await gate.promise;
        await originalDeliver(event);
      });
    const promote = hub.promoteToLive('sid', handle, opened);
    await vi.waitFor(() => expect(deliverSpy).toHaveBeenCalledTimes(1));
    await hub.deliver('sid', E(6));
    expect(hub.stateOf(handle)).toBe('OPENING');
    expect(hub.queueDepth(handle)).toBe(1);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect(await promote).toBe(true);
    expect(received(s)).toEqual(['e3', 'e4', 'e5', 'e6']);
    expect(hub.stateOf(handle)).toBe('LIVE');
    expect(hub.depthAtLiveTransition(handle)).toBe(0);
    await hub.deliver('sid', E(7));
    expect(hub.queueDepth(handle)).toBe(0);
    expect(received(s)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);
    await deliverE5;
  });

  it('dedupes against replay metadata and across rounds, and sorts within a round (U11b)', async () => {
    const hub = new StreamHub();
    const s = socket();
    const replay = new Deferred<readonly DurableAccountEvent[]>();
    const handle = hub.registerOpening('sid', s);
    const opening = StreamSession.open({
      sessionId: 'sid',
      source: sourceWith(replay),
      socket: s,
    });
    await hub.deliver('sid', E(4));
    await hub.deliver('sid', E(4, 'e4-prime'));
    await hub.deliver('sid', E(7));
    await hub.deliver('sid', E(5));
    await hub.deliver('sid', E(6));
    replay.resolve([E(3), E(4)]);
    const opened = await opening;
    const gate = new Deferred();
    const original = opened.session.deliver.bind(opened.session);
    vi.spyOn(opened.session, 'deliver').mockImplementationOnce(
      async (event) => {
        await gate.promise;
        await original(event);
      },
    );
    const promote = hub.promoteToLive('sid', handle, opened);
    await Promise.resolve();
    await hub.deliver('sid', E(5)); // retry duplicate arriving in a later round
    gate.resolve();
    expect(await promote).toBe(true);
    expect(received(s)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);
  });

  it('overflows the OPENING queue with resync-required + 4010 and later promote returns false (U11c)', async () => {
    const metrics = new MetricsRegistry();
    const hub = new StreamHub({ metrics });
    const s = socket();
    const replay = new Deferred<readonly DurableAccountEvent[]>();
    const handle = hub.registerOpening('sid', s);
    const opening = StreamSession.open({
      sessionId: 'sid',
      source: sourceWith(replay),
      socket: s,
    });
    for (let i = 0; i <= STREAM_OPENING_QUEUE_MAX; i += 1)
      await hub.deliver('sid', E(10 + i));
    expect(s.closed).toEqual({ code: 4010, reason: 'REPLAY_OVERFLOW' });
    expect(JSON.parse(s.messages.at(-1) as string)).toEqual({
      type: 'resync-required',
      reason: 'REPLAY_OVERFLOW',
    });
    expect(hub.size()).toBe(0);
    expect(metrics.metrics()).toContain('stream_replay_overflow_total 1');
    replay.resolve([]);
    const opened = await opening;
    const spy = vi.spyOn(opened.session, 'deliver');
    expect(await hub.promoteToLive('sid', handle, opened)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('converges a pathological session to 4010 after the round limit', async () => {
    const hub = new StreamHub();
    const s = socket();
    const handle = hub.registerOpening('sid', s);
    const opened = await StreamSession.open({
      sessionId: 'sid',
      source: sourceWith([]),
      socket: s,
    });
    let n = 100;
    vi.spyOn(opened.session, 'deliver').mockImplementation(async () => {
      n += 1;
      await hub.deliver('sid', E(n));
    });
    await hub.deliver('sid', E(n));
    expect(await hub.promoteToLive('sid', handle, opened)).toBe(false);
    expect(s.closed?.code).toBe(4010);
    expect(hub.size()).toBe(0);
    expect(STREAM_PROMOTE_MAX_ROUNDS).toBe(20);
  });

  it('cleans up when the socket closes during replay (U11d)', async () => {
    const hub = new StreamHub();
    const s = socket();
    const replay = new Deferred<readonly DurableAccountEvent[]>();
    const handle = hub.registerOpening('sid', s);
    const opening = StreamSession.open({
      sessionId: 'sid',
      source: sourceWith(replay),
      socket: s,
    });
    hub.unregister('sid', handle);
    expect(hub.size()).toBe(0);
    replay.resolve([]);
    expect(await hub.promoteToLive('sid', handle, await opening)).toBe(false);
    await expect(hub.deliver('sid', E(3))).resolves.toBeUndefined();
  });

  it('supports two entries for one session and fans out deliver/quote/heartbeat to LIVE only (U13)', async () => {
    const hub = new StreamHub();
    const a = socket();
    const b = socket();
    const ha = hub.registerOpening('sid', a);
    const hb = hub.registerOpening('sid', b);
    const openedA = await StreamSession.open({
      sessionId: 'sid',
      source: sourceWith([]),
      socket: a,
      quoteSymbols: new Set(['US:AAPL']),
    });
    expect(await hub.promoteToLive('sid', ha, openedA)).toBe(true);
    await openedA.session.subscribeQuote('US', 'AAPL');
    hub.heartbeat('2026-01-01T00:00:00.000Z');
    hub.publishQuote({
      market: 'US',
      symbol: 'AAPL',
      recoveryEpoch: 1n,
      marketDataVersion: 1n,
      payload: {},
    });
    expect(received(a)).toEqual(['heartbeat', 'quote']);
    expect(received(b)).toEqual([]);
    expect(hub.size()).toBe(2);
    await hub.deliver('sid', E(3));
    expect(received(a)).toEqual(['heartbeat', 'quote', 'e3']);
    expect(hub.queueDepth(hb)).toBe(1);
    await hub.closeAll(1012, 'SERVICE_RESTART');
    expect(a.closed?.code).toBe(1012);
    expect(b.closed?.code).toBe(1012);
    expect(hub.size()).toBe(0);
  });
});
