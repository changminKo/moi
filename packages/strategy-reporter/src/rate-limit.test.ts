import { beforeEach, describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT,
  type RateLimiter,
} from './rate-limit.js';

const { capacity, refillIntervalMs, reservedForAlerts, aggregationWindowMs } =
  DEFAULT_RATE_LIMIT;

describe('createRateLimiter', () => {
  let limiter: RateLimiter;
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    limiter = createRateLimiter();
  });

  const admit = (level: 'info' | 'warn', key: string) =>
    limiter.admit({ level, key }, now);

  it('collapses a repeat of the same key inside the aggregation window', () => {
    expect(admit('info', 'tick').kind).toBe('post');

    now += aggregationWindowMs - 1;

    expect(admit('info', 'tick')).toStrictEqual({ kind: 'suppress' });
  });

  it('carries the suppressed count onto the next post for that key', () => {
    admit('info', 'tick');
    for (let i = 0; i < 200; i += 1) {
      now += 250;
      limiter.admit({ level: 'info', key: 'tick' }, now);
    }
    now += aggregationWindowMs;

    expect(limiter.admit({ level: 'info', key: 'tick' }, now)).toStrictEqual({
      kind: 'post',
      suppressed: 200,
      dropped: 0,
    });
  });

  it('a strategy deciding every tick costs one message per window, not per tick', () => {
    let posts = 0;
    for (let i = 0; i < 600; i += 1) {
      if (
        limiter.admit({ level: 'info', key: 'decision' }, now).kind === 'post'
      )
        posts += 1;
      now += 1_000;
    }

    expect(posts).toBe(600_000 / aggregationWindowMs);
  });

  it('spends the burst, then refills one token per interval', () => {
    for (let i = 0; i < capacity; i += 1)
      expect(limiter.admit({ level: 'warn', key: `k${i}` }, now).kind).toBe(
        'post',
      );

    expect(limiter.admit({ level: 'warn', key: 'overflow' }, now).kind).toBe(
      'defer',
    );

    now += refillIntervalMs;

    expect(limiter.admit({ level: 'warn', key: 'overflow' }, now).kind).toBe(
      'post',
    );
  });

  it('reserves the last tokens for warn and fail, dropping info instead', () => {
    for (let i = 0; i < capacity - reservedForAlerts; i += 1)
      expect(limiter.admit({ level: 'info', key: `i${i}` }, now).kind).toBe(
        'post',
      );

    expect(limiter.admit({ level: 'info', key: 'one-more' }, now).kind).toBe(
      'drop',
    );
    expect(limiter.admit({ level: 'fail', key: 'kill-switch' }, now).kind).toBe(
      'post',
    );
  });

  it('never drops a warn or a fail: it defers them for the next token', () => {
    for (let i = 0; i < capacity; i += 1)
      limiter.admit({ level: 'fail', key: `f${i}` }, now);

    expect(
      limiter.admit({ level: 'fail', key: 'residual' }, now),
    ).toStrictEqual({ kind: 'defer' });
  });

  it('reports how many info messages it dropped on the next post', () => {
    for (let i = 0; i < capacity - reservedForAlerts; i += 1)
      limiter.admit({ level: 'info', key: `i${i}` }, now);
    limiter.admit({ level: 'info', key: 'lost-a' }, now);
    limiter.admit({ level: 'info', key: 'lost-b' }, now);

    now += refillIntervalMs * capacity;

    expect(limiter.admit({ level: 'warn', key: 'later' }, now)).toStrictEqual({
      kind: 'post',
      suppressed: 0,
      dropped: 2,
    });
  });

  it('stays under the webhook budget Discord enforces', () => {
    expect((capacity * 60_000) / refillIntervalMs / capacity).toBeLessThan(30);
    expect(reservedForAlerts).toBeGreaterThan(0);
    expect(reservedForAlerts).toBeLessThan(capacity);
  });
});
