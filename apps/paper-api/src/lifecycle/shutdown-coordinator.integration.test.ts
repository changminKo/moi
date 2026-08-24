import { describe, expect, it } from 'vitest';
import { ShutdownCoordinator } from './shutdown-coordinator.js';

describe('ShutdownCoordinator', () => {
  it('retains cancel-only and closes sockets before releasing leases', async () => {
    const order: string[] = [],
      c = new ShutdownCoordinator({
        cancelOnly: () => {
          order.push('cancel-only');
        },
        admission: {
          close: () => {
            order.push('admission');
          },
        },
        drainInflight: async () => {
          order.push('inflight');
        },
        drainOutbox: async () => {
          order.push('outbox');
        },
        closeSockets: async () => {
          order.push('sockets');
        },
        releaseLeases: async () => {
          order.push('leases');
        },
      });
    await c.drain();
    expect(order).toEqual([
      'cancel-only',
      'admission',
      'inflight',
      'outbox',
      'sockets',
      'leases',
    ]);
  });
});
