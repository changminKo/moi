import { describe, expect, it, vi } from 'vitest';
import { StartupCoordinator } from './startup-coordinator.js';

describe('StartupCoordinator', () => {
  it('opens only after both markets recover', async () => {
    const order: string[] = [],
      latch = {
        close: vi.fn(() => {
          order.push('closed');
        }),
        open: vi.fn(() => {
          order.push('open');
        }),
      };
    const c = new StartupCoordinator({
      admission: latch,
      matching: latch,
      restore: async () => ({}),
      verifyInvariants: () => undefined,
      acquireLease: async (m) =>
        ({ epoch: 1n, fencingToken: 1n, market: m }) as never,
      recover: async (m) => {
        order.push(`recover:${m}`);
      },
      incidents: { activate: vi.fn(async () => undefined) },
    });
    await c.open();
    expect(order).toEqual([
      'closed',
      'closed',
      'recover:KR',
      'recover:US',
      'open',
      'open',
    ]);
  });
  it('keeps latches closed and records manual incident on invariant failure', async () => {
    const open = vi.fn(),
      activate = vi.fn(async () => undefined),
      latch = { close: vi.fn(), open };
    await expect(
      new StartupCoordinator({
        admission: latch,
        restore: async () => ({}),
        verifyInvariants: () => {
          throw new Error('bad');
        },
        acquireLease: vi.fn(),
        recover: vi.fn(),
        incidents: { activate },
      }).open(),
    ).rejects.toThrow('bad');
    expect(open).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ manual: true }),
    );
  });
});
