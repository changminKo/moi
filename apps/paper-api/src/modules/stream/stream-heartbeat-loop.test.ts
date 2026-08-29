import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamHeartbeatLoop } from './stream-heartbeat-loop.js';
import { StreamHub } from './stream-hub.js';
import {
  type DurableEventSource,
  STREAM_HEARTBEAT_MS,
  StreamSession,
  type StreamSocket,
} from './stream-session.js';

function socket(): StreamSocket & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    send: (m) => {
      messages.push(m);
    },
    close: () => undefined,
    bufferedAmount: 0,
  };
}
const source: DurableEventSource = {
  latest: async () => '0',
  oldest: async () => undefined,
  replay: async () => [],
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('StreamHeartbeatLoop (H1)', () => {
  it('drives every LIVE session from one interval and stops cleanly', async () => {
    const hub = new StreamHub();
    const sockets = [socket(), socket(), socket()];
    let tick = 0;
    const clock = () =>
      new Date(1_700_000_000_000 + tick * STREAM_HEARTBEAT_MS);
    for (const [index, s] of sockets.entries()) {
      const handle = hub.registerOpening(`s${index}`, s);
      const opened = await StreamSession.open({
        sessionId: `s${index}`,
        source,
        socket: s,
      });
      expect(await hub.promoteToLive(`s${index}`, handle, opened)).toBe(true);
    }
    const loop = new StreamHeartbeatLoop({ hub, clock });
    loop.start();
    expect(vi.getTimerCount()).toBe(1);
    for (tick = 1; tick <= 3; tick += 1) {
      await vi.advanceTimersByTimeAsync(STREAM_HEARTBEAT_MS);
      for (const s of sockets) {
        const heartbeats = s.messages
          .map((m) => JSON.parse(m))
          .filter((m) => m.type === 'heartbeat');
        expect(heartbeats).toHaveLength(tick);
        expect(heartbeats.at(-1).serverTime).toBe(clock().toISOString());
      }
    }
    expect(vi.getTimerCount()).toBe(1);
    loop.stop();
    loop.stop();
    await vi.advanceTimersByTimeAsync(STREAM_HEARTBEAT_MS * 2);
    for (const s of sockets)
      expect(
        s.messages
          .map((m) => JSON.parse(m))
          .filter((m) => m.type === 'heartbeat'),
      ).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('advertises the same interval the loop uses', async () => {
    const s = socket();
    await StreamSession.open({ sessionId: 'x', source, socket: s });
    const ready = JSON.parse(s.messages[0] as string);
    expect(ready.type).toBe('ready');
    expect(ready.heartbeatIntervalMs).toBe(STREAM_HEARTBEAT_MS);
    expect(new StreamHeartbeatLoop({ hub: new StreamHub() }).intervalMs).toBe(
      STREAM_HEARTBEAT_MS,
    );
  });
});
