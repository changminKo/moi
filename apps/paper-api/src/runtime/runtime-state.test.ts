import { describe, expect, it, vi } from 'vitest';
import { RuntimeStateMachine, type ServingHooks } from './runtime-state.js';

function hooks(pollResult: Promise<unknown> | null = null) {
  const order: string[] = [];
  const h: ServingHooks = {
    openLatches: vi.fn(() => {
      order.push('openLatches');
    }),
    closeLatches: vi.fn(() => {
      order.push('closeLatches');
    }),
    publisher: {
      start: vi.fn(() => {
        order.push('publisher.start');
      }),
      pauseScheduling: vi.fn(() => {
        order.push('publisher.pauseScheduling');
        return pollResult;
      }),
    },
  };
  return { h, order };
}

describe('RuntimeStateMachine', () => {
  it('starts in BOOTING with the stream gate closed', () => {
    const machine = new RuntimeStateMachine(hooks().h);
    expect(machine.current).toBe('BOOTING');
    expect(machine.gate().isOpen()).toBe(false);
  });

  it('records transitions and notifies the observer synchronously', () => {
    const observer = { onTransition: vi.fn() };
    const machine = new RuntimeStateMachine(hooks().h, observer);
    machine.transition('RESTORING');
    machine.transition('ACQUIRING_LEASES');
    expect(machine.current).toBe('ACQUIRING_LEASES');
    expect(observer.onTransition.mock.calls).toEqual([
      ['BOOTING', 'RESTORING'],
      ['RESTORING', 'ACQUIRING_LEASES'],
    ]);
  });

  it('enterServing flips state, opens latches, then starts the publisher in one synchronous stack', () => {
    const { h, order } = hooks();
    const observer = { onTransition: vi.fn() };
    const machine = new RuntimeStateMachine(h, observer);
    machine.transition('RECOVERING');
    let microtaskRan = false;
    (h.publisher.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('publisher.start');
      expect(microtaskRan).toBe(false);
    });
    queueMicrotask(() => {
      microtaskRan = true;
    });
    machine.enterServing();
    expect(machine.current).toBe('SERVING');
    expect(machine.gate().isOpen()).toBe(true);
    expect(order).toEqual(['openLatches', 'publisher.start']);
    expect(observer.onTransition).toHaveBeenLastCalledWith(
      'RECOVERING',
      'SERVING',
    );
  });

  it('leaveServing closes the gate immediately, closes latches, and captures the in-flight poll', () => {
    const pending = new Promise<void>(() => undefined);
    const { h, order } = hooks(pending);
    const machine = new RuntimeStateMachine(h);
    machine.transition('RECOVERING');
    machine.enterServing();
    const captured = machine.leaveServing('DRAINING');
    expect(machine.current).toBe('DRAINING');
    expect(machine.leftFrom).toBe('SERVING');
    expect(machine.gate().isOpen()).toBe(false);
    expect(captured).toBe(pending);
    expect(machine.pendingPoll).toBe(pending);
    expect(order.slice(-2)).toEqual([
      'closeLatches',
      'publisher.pauseScheduling',
    ]);
  });

  it('leaveServing from RECOVERING yields no pending poll and remembers where it left from', () => {
    const { h } = hooks(null);
    const machine = new RuntimeStateMachine(h);
    machine.transition('RECOVERING');
    expect(machine.leaveServing('RE_ELECTING')).toBeNull();
    expect(machine.leftFrom).toBe('RECOVERING');
    expect(machine.current).toBe('RE_ELECTING');
  });

  it('enterServing and leaveServing are plain synchronous functions without await', () => {
    for (const name of ['enterServing', 'leaveServing'] as const) {
      const fn = RuntimeStateMachine.prototype[name];
      expect(fn.constructor.name).toBe('Function');
      expect(fn.toString()).not.toMatch(/\bawait\b/);
    }
  });
});
