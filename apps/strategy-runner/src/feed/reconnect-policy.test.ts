import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_BASE_MS,
  ATTEMPT_CEILING_MS,
  REARM_BASE_MS,
  REARM_CEILING_MS,
  REARM_JITTER_FLOOR,
  ReconnectPolicy,
} from './reconnect-policy.js';

/** A deterministic `random()` that walks a fixed list and then repeats its last. */
function draws(...values: readonly number[]): () => number {
  let index = 0;

  return () => values[Math.min(index++, values.length - 1)] as number;
}

describe('the stream reconnect policy', () => {
  it('backs off exponentially, with full jitter, up to a ceiling', () => {
    const policy = new ReconnectPolicy({ random: () => 1 });

    // Attempt n draws from [0, base · 2^(n-1)], capped.
    expect(policy.nextDelayMs()).toBe(ATTEMPT_BASE_MS);
    expect(policy.nextDelayMs()).toBe(ATTEMPT_BASE_MS * 2);
    expect(policy.nextDelayMs()).toBe(ATTEMPT_BASE_MS * 4);

    for (let i = 0; i < 20; i += 1) {
      expect(policy.nextDelayMs()).toBeLessThanOrEqual(ATTEMPT_CEILING_MS);
    }

    expect(policy.nextDelayMs()).toBe(ATTEMPT_CEILING_MS);
  });

  it('draws an ordinary retry from the whole band, floor included', () => {
    const policy = new ReconnectPolicy({ random: () => 0 });

    expect(policy.nextDelayMs()).toBe(0);
  });

  /**
   * The bug the paper API had (spec §16.34): a window of failures latched the
   * scope off permanently and only an operator could lift it. A bot nobody is
   * watching must come back on its own.
   */
  it('keeps retrying after the failure window is exhausted', () => {
    const policy = new ReconnectPolicy({
      maxFailures: 3,
      windowMs: 60_000,
      now: () => 0,
      random: () => 1,
    });

    for (let i = 0; i < 3; i += 1) {
      policy.recordFailure();
    }

    expect(policy.holding).toBe(true);
    expect(policy.nextDelayMs()).toBeGreaterThan(0);
    expect(policy.nextDelayMs()).toBeGreaterThan(0);
  });

  /**
   * And it must not come back as a hot loop. Full jitter's lower edge is ~0, so
   * an exhausted hold drawn with it would collapse into the very retry storm the
   * ceiling exists to prevent. The re-arm draws from the *top half* of its step.
   */
  it('holds the exhausted scope off for at least half of its step', () => {
    const policy = new ReconnectPolicy({
      maxFailures: 1,
      windowMs: 60_000,
      now: () => 0,
      random: draws(0, 0, 0),
    });

    policy.recordFailure();

    expect(policy.holding).toBe(true);
    expect(policy.nextDelayMs()).toBe(REARM_BASE_MS * REARM_JITTER_FLOOR);
    expect(policy.nextDelayMs()).toBe(REARM_BASE_MS * 2 * REARM_JITTER_FLOOR);
  });

  it('caps the re-arm step too', () => {
    const policy = new ReconnectPolicy({
      maxFailures: 1,
      windowMs: 60_000,
      now: () => 0,
      random: () => 1,
    });

    policy.recordFailure();

    for (let i = 0; i < 20; i += 1) {
      expect(policy.nextDelayMs()).toBeLessThanOrEqual(REARM_CEILING_MS);
    }

    expect(policy.nextDelayMs()).toBe(REARM_CEILING_MS);
  });

  /**
   * The window slides: failures spread thinly over a long run are not the same
   * fact as three in a minute, and treating them as one would hold off a runner
   * that reconnects cleanly once an hour.
   */
  it('forgets failures that fall out of the window', () => {
    let clock = 0;
    const policy = new ReconnectPolicy({
      maxFailures: 3,
      windowMs: 1_000,
      now: () => clock,
      random: () => 1,
    });

    policy.recordFailure();
    policy.recordFailure();
    clock = 2_000;
    policy.recordFailure();

    expect(policy.holding).toBe(false);
  });

  it('starts over on a connection that succeeded', () => {
    const policy = new ReconnectPolicy({
      maxFailures: 1,
      windowMs: 60_000,
      now: () => 0,
      random: () => 1,
    });

    policy.recordFailure();
    expect(policy.holding).toBe(true);

    policy.recordSuccess();

    expect(policy.holding).toBe(false);
    expect(policy.nextDelayMs()).toBe(ATTEMPT_BASE_MS);
  });

  /** Reported once on the way in, so the log says a hold began, not that it recurs. */
  it('announces the hold exactly once', () => {
    const held: number[] = [];
    const policy = new ReconnectPolicy({
      maxFailures: 2,
      windowMs: 60_000,
      now: () => 0,
      random: () => 1,
      onHold: (failures) => held.push(failures),
    });

    policy.recordFailure();
    policy.recordFailure();
    policy.recordFailure();

    expect(held).toStrictEqual([2]);
  });
});
