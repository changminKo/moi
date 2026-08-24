import { describe, expect, it } from 'vitest';
import { LeaderLease } from './leader-lease.js';

describe('LeaderLease', () => {
  it('exposes a fencing token and closes its latch on connection loss', async () => {
    const events: string[] = [];
    const lease = await LeaderLease.acquire('US', {
      clientFactory: async () =>
        ({
          query: async () => ({ rows: [{ fencing_token: '1', epoch: '1' }] }),
          on: (event: string) => {
            events.push(event);
          },
          release: async () => undefined,
        }) as never,
    });
    expect(lease.fencingToken).toBe(1n);
    expect(lease.isHeld).toBe(true);
    expect(events).toContain('error');
    await lease.release();
    expect(lease.isHeld).toBe(false);
  });
});
