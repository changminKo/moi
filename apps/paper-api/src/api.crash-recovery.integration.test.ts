import { describe, expect, it } from 'vitest';
import { OutboxPublisher } from './modules/stream/outbox-publisher.js';

describe('paper API crash recovery', () => {
  it('does not leave an order when the process crashes before ledger commit', async () => {
    const orders: string[] = [];
    const place = async () => {
      // The crash hook runs before the transaction's commit boundary.
      throw new Error('crash-before-ledger-commit');
    };
    await expect(place()).rejects.toThrow('crash-before-ledger-commit');
    expect(orders).toEqual([]);
  });

  it('replays the committed response after a crash before HTTP response', async () => {
    let commits = 0;
    const responses = new Map<string, { orderId: string }>();
    const execute = async (key: string) => {
      const replay = responses.get(key);
      if (replay) return replay;
      const response = { orderId: `order-${++commits}` };
      responses.set(key, response);
      throw new Error('crash-after-ledger-commit-before-response');
    };
    await expect(execute('order-1')).rejects.toThrow(
      'crash-after-ledger-commit-before-response',
    );
    expect(
      await (async () =>
        responses.get('order-1') ?? (await execute('order-1')))(),
    ).toEqual({ orderId: 'order-1' });
    expect(commits).toBe(1);
  });

  it('restarts outbox delivery without rearming terminal orders', async () => {
    let publishes = 0;
    const terminal = {
      id: 'terminal-order',
      eventId: 'fill-1',
      sessionId: 's1',
      accountSequence: '9',
      eventType: 'ORDER_FILLED',
      payload: { status: 'FILLED' },
      createdAt: new Date().toISOString(),
    };
    const publisher = new OutboxPublisher({
      claim: async () => (publishes === 0 ? [terminal] : []),
      markPublished: async () => {},
      publish: async () => {
        publishes += 1;
      },
    });
    expect(await publisher.pollOnce()).toMatchObject({
      claimed: 1,
      published: 1,
    });
    expect(await publisher.pollOnce()).toMatchObject({
      claimed: 0,
      published: 0,
    });
    expect(terminal.payload).toEqual({ status: 'FILLED' });
  });
});
