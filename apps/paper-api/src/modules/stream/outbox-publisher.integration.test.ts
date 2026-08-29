import { describe, expect, it } from 'vitest';
import { OutboxPublisher } from './outbox-publisher.js';

describe('outbox publisher', () => {
  it('publishes claimed rows at least once and safely retries failed delivery', async () => {
    let attempts = 0;
    const marked: string[] = [];
    const publisher = new OutboxPublisher({
      claim: async () =>
        attempts === 0
          ? [
              {
                id: '1',
                eventId: 'e1',
                sessionId: 's1',
                accountSequence: '1',
                eventType: 'x',
                payload: {},
                createdAt: new Date().toISOString(),
              },
            ]
          : [],
      markPublished: async (id) => {
        marked.push(id);
      },
      publish: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary');
      },
    });
    expect(await publisher.pollOnce()).toEqual({
      claimed: 1,
      published: 0,
      failed: 1,
    });
    expect(await publisher.pollOnce()).toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });
    expect(marked).toEqual([]);
  });
});
