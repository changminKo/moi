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
      acquireLeases: async () => {
        order.push('acquireLeases');
        return {} as never;
      },
      recover: async (m) => {
        order.push(`recover:${m}`);
      },
      incidents: { activate: vi.fn(async () => undefined) },
    });
    await c.open();
    expect(order).toEqual([
      'closed',
      'closed',
      'acquireLeases',
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
        acquireLeases: vi.fn(),
        recover: vi.fn(),
        incidents: { activate },
      }).open(),
    ).rejects.toThrow('bad');
    expect(open).not.toHaveBeenCalled();
    // The cause code alone decides MANUAL (`MANUAL_CAUSES` in
    // ProductionRuntime, injected as the repository's `manualCauseCodes`);
    // the coordinator sends nothing else.
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith({
      causeCode: 'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
    });
  });
  it('propagates an aborted lease wait without recording an invariant incident', async () => {
    const activate = vi.fn(async () => undefined);
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(
      new StartupCoordinator({
        admission: { close: vi.fn(), open: vi.fn() },
        restore: async () => ({}),
        verifyInvariants: () => undefined,
        acquireLeases: async () => {
          throw abort;
        },
        recover: vi.fn(),
        incidents: { activate },
      }).open(),
    ).rejects.toBe(abort);
    expect(activate).not.toHaveBeenCalled();
  });
});
