import { describe, expect, it, vi } from 'vitest';
import { StreamSession, type StreamSocket } from './stream-session.js';

function socket(): StreamSocket & { messages: unknown[]; closed?: number } {
  const result: StreamSocket & { messages: unknown[]; closed?: number } = {
    messages: [] as unknown[],
    send(message: string) {
      result.messages.push(JSON.parse(message));
    },
    close(code: number) {
      result.closed = code;
    },
    get bufferedAmount() {
      return 0;
    },
  };
  return result;
}

describe('stream session', () => {
  it('replays committed events and preserves decimal sequences for duplicate delivery', async () => {
    const events = [1, 2].map((n) => ({
      id: `row-${n}`,
      eventId: `event-${n}`,
      sessionId: 's1',
      accountSequence: String(n),
      eventType: 'portfolio.updated',
      payload: { value: `${n}.10` },
      createdAt: new Date().toISOString(),
    }));
    const source = {
      latest: async () => '2',
      oldest: async () => '1',
      replay: async () => events,
    };
    const first = socket();
    const stream = await StreamSession.open({
      sessionId: 's1',
      source,
      socket: first,
    });
    expect(first.messages).toEqual([
      { type: 'ready', accountSequence: '2', heartbeatIntervalMs: 30_000 },
      ...events.map(({ eventId, accountSequence, eventType, payload }) => ({
        type: 'event',
        eventId,
        accountSequence,
        eventType,
        payload,
      })),
    ]);
    const firstEvent = events.at(0);
    if (firstEvent === undefined) throw new Error('test event missing');
    await stream.deliver(firstEvent);
    expect(first.messages.at(-1)).toEqual({
      type: 'event',
      eventId: 'event-1',
      accountSequence: '1',
      eventType: 'portfolio.updated',
      payload: { value: '1.10' },
    });
  });

  it('requires resync when retention cannot satisfy the cursor and limits quotes to five', async () => {
    const gap = socket();
    await expect(
      StreamSession.open({
        sessionId: 's1',
        afterSequence: '0',
        source: {
          latest: async () => '9',
          oldest: async () => '5',
          replay: vi.fn(),
        },
        socket: gap,
      }),
    ).rejects.toThrow('OUTBOX_GAP');
    expect(gap.messages).toEqual([
      { type: 'resync-required', reason: 'OUTBOX_GAP' },
    ]);
    const source = {
      latest: async () => '0',
      oldest: async () => '1',
      replay: async () => [],
    };
    const quote = {
      market: 'KR' as const,
      symbol: '005930',
      recoveryEpoch: 1n,
      marketDataVersion: 2n,
      payload: { price: '1.00' },
    };
    const symbols = new Set(
      Array.from({ length: 6 }, (_, i) => `KR:${quote.symbol}-${i}`),
    );
    const session = await StreamSession.open({
      sessionId: 's1',
      source,
      socket: socket(),
      quoteSymbols: symbols,
    });
    for (let i = 0; i < 5; i += 1)
      await session.subscribeQuote(quote.market, `${quote.symbol}-${i}`);
    await expect(
      session.subscribeQuote('KR', `${quote.symbol}-5`),
    ).rejects.toThrow('quote subscription limit');
  });

  it('closes a slow client after a bounded queue and emits backpressure when possible', async () => {
    const s = socket();
    Object.defineProperty(s, 'bufferedAmount', {
      value: 100,
      configurable: true,
    });
    const session = await StreamSession.open({
      sessionId: 's1',
      source: {
        latest: async () => '0',
        oldest: async () => '1',
        replay: async () => [],
      },
      socket: s,
      maxQueue: 1,
    });
    const event = {
      id: 'x',
      eventId: 'x',
      sessionId: 's1',
      accountSequence: '1',
      eventType: 'x',
      payload: {},
      createdAt: new Date().toISOString(),
    };
    await session.deliver(event);
    await session.deliver(event);
    expect(s.messages.at(-1)).toEqual({
      type: 'resync-required',
      reason: 'BACKPRESSURE',
    });
    expect(s.closed).toBe(4008);
  });
});
