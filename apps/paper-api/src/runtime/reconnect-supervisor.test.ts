import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconnectSupervisor } from './reconnect-supervisor.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ReconnectSupervisor (§8.3)', () => {
  it('runs the first attempt immediately when asked and backs off afterwards', async () => {
    const delays: number[] = [];
    const supervisor = new ReconnectSupervisor({
      delayMs: (attempt) => {
        delays.push(attempt);
        return 100 * attempt;
      },
      onExhausted: vi.fn(async () => undefined),
    });
    const run = vi.fn(async () => false);
    supervisor.schedule(run, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(99);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1]);
  });

  it('uses a fixed 1 s first delay after server-shutdown', async () => {
    const supervisor = new ReconnectSupervisor({
      delayMs: () => 5,
      onExhausted: vi.fn(async () => undefined),
    });
    const run = vi.fn(async () => true);
    supervisor.schedule(run, { serverShutdown: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stops after three failures inside five minutes and resumes on demand', async () => {
    const onExhausted = vi.fn(async () => undefined);
    const supervisor = new ReconnectSupervisor({
      delayMs: () => 10,
      onExhausted,
    });
    const run = vi.fn(async () => {
      supervisor.recordFailure();
      return false;
    });
    for (let i = 0; i < 3; i += 1) {
      supervisor.schedule(run);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(run).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(supervisor.exhausted).toBe(true);
    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);
    supervisor.resume();
    expect(supervisor.exhausted).toBe(false);
    supervisor.schedule(run, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('forgets failures that slide out of the window and resets on success', async () => {
    const onExhausted = vi.fn(async () => undefined);
    const supervisor = new ReconnectSupervisor({
      delayMs: () => 0,
      onExhausted,
      windowMs: 1_000,
    });
    expect(supervisor.recordFailure()).toBe(false);
    expect(supervisor.recordFailure()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(supervisor.recordFailure()).toBe(false);
    supervisor.reset();
    expect(supervisor.recordFailure()).toBe(false);
    expect(supervisor.recordFailure()).toBe(false);
    expect(supervisor.recordFailure()).toBe(true);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('never overlaps: a schedule while one is pending is ignored', async () => {
    const supervisor = new ReconnectSupervisor({
      delayMs: () => 50,
      onExhausted: vi.fn(async () => undefined),
    });
    const run = vi.fn(async () => true);
    supervisor.schedule(run);
    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    supervisor.cancel();
    supervisor.schedule(run);
    supervisor.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
