import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REARM_BASE_MS,
  REARM_CEILING_MS,
  ReconnectSupervisor,
} from './reconnect-supervisor.js';

/** Deterministic stand-in for `Math.random`, so a jittered delay is exact. */
const lcg = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

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

  it('holds after three failures inside five minutes and an operator can resume at once', async () => {
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
    // The hold is long, not permanent: the ordinary backoff no longer fires.
    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);
    supervisor.resume();
    expect(supervisor.exhausted).toBe(false);
    supervisor.schedule(run, { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('re-arms itself after the hold instead of waiting for an operator', async () => {
    const onExhausted = vi.fn(async () => undefined);
    const supervisor = new ReconnectSupervisor({
      delayMs: () => 10,
      onExhausted,
      random: () => 1,
    });
    const run = vi.fn(async () => {
      supervisor.recordFailure();
      return false;
    });
    for (let i = 0; i < 3; i += 1) {
      supervisor.schedule(run);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(supervisor.exhausted).toBe(true);

    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(REARM_BASE_MS - 1);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
    // The hold stays visible as an alert, and it is raised once on the way in.
    expect(supervisor.exhausted).toBe(true);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  const exhaust = async (supervisor: ReconnectSupervisor) => {
    const run = vi.fn(async () => {
      supervisor.recordFailure();
      return false;
    });
    for (let i = 0; i < 3; i += 1) {
      supervisor.schedule(run);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(supervisor.exhausted).toBe(true);
    return run;
  };

  it.each([
    [
      'the top of the jitter band',
      () => 1,
      [30_000, 60_000, 120_000, 240_000, REARM_CEILING_MS, REARM_CEILING_MS],
    ],
    [
      'the bottom of the jitter band',
      () => 0,
      [15_000, 30_000, 60_000, 120_000, 150_000, 150_000],
    ],
  ])(
    'caps the re-arm backoff at its ceiling instead of hot-looping — %s',
    async (_label, random, expected) => {
      const rearms: number[] = [];
      const supervisor = new ReconnectSupervisor({
        delayMs: () => 10,
        onExhausted: vi.fn(async () => undefined),
        onRearm: (delayMs) => rearms.push(delayMs),
        random,
      });
      const run = await exhaust(supervisor);
      for (let i = 0; i < 6; i += 1) {
        supervisor.schedule(run);
        await vi.advanceTimersByTimeAsync(REARM_CEILING_MS);
      }
      expect(rearms).toEqual(expected);
      expect(run).toHaveBeenCalledTimes(9);
    },
  );

  it('decorrelates two scopes that exhausted on the same event', async () => {
    // KR and US hold in separate supervisors but fail on one provider event.
    // A fixed delay would line their retries up for as long as both are down,
    // and they share one OAuthTokenProvider with a 10 s reissue floor.
    const drawn: number[] = [];
    const supervisors = [lcg(1), lcg(9_999)].map(
      (random) =>
        new ReconnectSupervisor({
          delayMs: () => 10,
          onExhausted: vi.fn(async () => undefined),
          onRearm: (delayMs) => drawn.push(delayMs),
          random,
        }),
    );
    for (const supervisor of supervisors) {
      const run = await exhaust(supervisor);
      supervisor.schedule(run);
      supervisor.cancel();
    }
    const [kr, us] = drawn as [number, number];
    expect(kr).not.toBe(us);
    for (const delay of drawn) {
      expect(delay).toBeGreaterThanOrEqual(REARM_BASE_MS / 2);
      expect(delay).toBeLessThanOrEqual(REARM_BASE_MS);
    }
  });

  it('clears the hold when a re-armed attempt finally succeeds', async () => {
    const supervisor = new ReconnectSupervisor({
      delayMs: () => 10,
      onExhausted: vi.fn(async () => undefined),
    });
    let recovered = false;
    const run = vi.fn(async () => {
      if (recovered) return true;
      supervisor.recordFailure();
      return false;
    });
    for (let i = 0; i < 3; i += 1) {
      supervisor.schedule(run);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(supervisor.exhausted).toBe(true);
    recovered = true;
    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(REARM_BASE_MS);
    expect(run).toHaveBeenCalledTimes(4);
    expect(supervisor.exhausted).toBe(false);
    // Back to the ordinary backoff, from the first attempt.
    supervisor.schedule(run);
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(5);
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
