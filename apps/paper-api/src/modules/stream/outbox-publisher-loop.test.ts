import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../../observability/metrics.js';
import { OutboxPublisherLoop } from './outbox-publisher-loop.js';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

type PollResult = { claimed: number; published: number; failed: number };

function build(options: { results?: PollResult[]; block?: Deferred } = {}) {
  const results = [...(options.results ?? [])];
  const metrics = new MetricsRegistry();
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const pollOnce = vi.fn(async ({ mode }: { mode: string }) => {
    if (options.block) await options.block.promise;
    const next = results.shift() ?? { claimed: 0, published: 0, failed: 0 };
    metrics.counter('outbox_claims_total', { mode });
    return next;
  });
  const prune = vi.fn(async () => undefined);
  const loop = new OutboxPublisherLoop({
    publisher: { pollOnce },
    prune,
    metrics,
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { loop, pollOnce, prune, metrics, logs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('OutboxPublisherLoop.start', () => {
  it('is a total synchronous function: no await/throw/try/async, one setTimeout, no dependency calls', () => {
    const source = OutboxPublisherLoop.prototype.start.toString();
    expect(OutboxPublisherLoop.prototype.start.constructor.name).toBe(
      'Function',
    );
    expect(source).not.toMatch(/\bawait\b|\bthrow\b|\btry\b|\basync\b/);
    const calls = source.match(/\b[a-zA-Z_.#]+\s*\(/g) ?? [];
    const named = calls
      .map((c) => c.replace(/\s*\($/, ''))
      .filter((c) => c !== 'start');
    expect(named).toEqual(['setTimeout']);
  });

  it('returns and reports running even when every dependency throws', () => {
    const throwing = () => {
      throw new Error('dependency exploded');
    };
    const loop = new OutboxPublisherLoop({
      publisher: { pollOnce: throwing as never },
      prune: throwing as never,
      metrics: new Proxy({}, { get: () => throwing }) as never,
      log: throwing,
    });
    expect(() => loop.start()).not.toThrow();
    expect(loop.isRunning()).toBe(true);
    loop.start();
    expect(vi.getTimerCount()).toBe(1);
  });

  it('logs a failing tick and re-arms the next one without touching state', async () => {
    const { loop, pollOnce, logs } = build();
    pollOnce.mockRejectedValueOnce(new Error('db down'));
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.event === 'outbox.poll_failed')).toBe(true);
    expect(loop.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(pollOnce).toHaveBeenCalledTimes(2);
    expect(pollOnce.mock.calls[1]?.[0]).toEqual({ mode: 'periodic' });
  });

  it('re-arms 200 ms after each poll completes (no overlap) and prunes every 10 minutes', async () => {
    const { loop, pollOnce, prune } = build();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pollOnce).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(prune).toHaveBeenCalledTimes(1);
  });
});

describe('OutboxPublisherLoop.pauseScheduling', () => {
  it('synchronously stops scheduling and captures the single in-flight poll', async () => {
    const block = new Deferred();
    const { loop, pollOnce } = build({
      block,
      results: [{ claimed: 1, published: 1, failed: 0 }],
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(loop.hasInFlightPoll()).toBe(true);
    const captured = loop.pauseScheduling();
    expect(loop.isRunning()).toBe(false);
    expect(loop.hasInFlightPoll()).toBe(true);
    expect(captured).toBeInstanceOf(Promise);
    expect(loop.pauseScheduling()).toBe(captured);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    block.resolve();
    await captured;
    expect(loop.hasInFlightPoll()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollOnce).toHaveBeenCalledTimes(1);
  });

  it('returns null when idle or never started', async () => {
    const { loop, pollOnce } = build();
    expect(loop.pauseScheduling()).toBeNull();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(loop.hasInFlightPoll()).toBe(false);
    expect(loop.pauseScheduling()).toBeNull();
    expect(loop.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pollOnce).toHaveBeenCalledTimes(1);
  });

  it('a tick that fires after pause returns before polling', async () => {
    const { loop, pollOnce } = build();
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    // timer for the next tick is armed; pause clears it
    loop.pauseScheduling();
    await vi.advanceTimersByTimeAsync(500);
    expect(pollOnce).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('OutboxPublisherLoop.shutdownDrain', () => {
  it('rejects when scheduling is still running or a poll is in flight, without claiming', async () => {
    const { loop, pollOnce } = build();
    loop.start();
    await expect(loop.shutdownDrain(Date.now() + 1_000)).rejects.toThrow(
      /precondition/,
    );
    expect(pollOnce).toHaveBeenCalledTimes(0);
    loop.pauseScheduling();
  });

  it('repeats shutdown_drain polls until two consecutive empty claims, registering no timers', async () => {
    const { loop, pollOnce, logs, metrics } = build({
      results: [
        { claimed: 3, published: 3, failed: 0 },
        { claimed: 0, published: 0, failed: 0 },
        { claimed: 2, published: 2, failed: 0 },
        { claimed: 0, published: 0, failed: 0 },
        { claimed: 0, published: 0, failed: 0 },
      ],
    });
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const summary = await loop.shutdownDrain(Date.now() + 10_000);
    expect(
      pollOnce.mock.calls.every(([arg]) => arg.mode === 'shutdown_drain'),
    ).toBe(true);
    expect(pollOnce).toHaveBeenCalledTimes(5);
    expect(summary).toEqual({
      rounds: 5,
      claimed: 5,
      remaining: 0,
      deadlineHit: false,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(loop.isRunning()).toBe(false);
    const drainLogs = logs.filter((l) => l.event === 'outbox.drain');
    expect(drainLogs).toHaveLength(1);
    expect(drainLogs[0]?.fields).toMatchObject({
      skipped: false,
      rounds: 5,
      claimed: 5,
      remaining: 0,
      deadlineHit: false,
    });
    expect(
      logs
        .filter((l) => l.event === 'outbox.poll')
        .every((l) => l.fields.mode === 'shutdown_drain'),
    ).toBe(true);
    expect(metrics.metrics()).toContain(
      'outbox_claims_total{mode="shutdown_drain"} 5',
    );
    expect(metrics.metrics()).toContain('outbox_shutdown_drain_rounds 5');
    const source = OutboxPublisherLoop.prototype.shutdownDrain.toString();
    expect(source).not.toMatch(/setTimeout|setInterval|running\s*=/);
  });

  it('stops at the deadline and reports remaining rows', async () => {
    const { loop, metrics, logs } = build({
      results: Array.from({ length: 50 }, () => ({
        claimed: 100,
        published: 100,
        failed: 0,
      })),
    });
    vi.useRealTimers();
    const summary = await loop.shutdownDrain(Date.now() - 1);
    expect(summary.deadlineHit).toBe(true);
    expect(summary.rounds).toBeGreaterThanOrEqual(1);
    expect(metrics.metrics()).toContain('outbox_drain_remaining');
    expect(logs.at(-1)?.fields).toMatchObject({ deadlineHit: true });
  });

  it('source never uses setInterval or methods named stop()/drain()', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('./outbox-publisher-loop.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/setInterval/);
    expect(source).not.toMatch(/\bstop\s*\(/);
    expect(source).not.toMatch(/(^|[^a-zA-Z])drain\s*\(/);
  });
});

describe('OutboxPublisher.pollOnce claim ordering', () => {
  it('issues the claim and bumps outbox_claims_total{mode} before the first await', async () => {
    const { OutboxPublisher } = await import('./outbox-publisher.js');
    const metrics = new MetricsRegistry();
    let claimStarted = false;
    const publisher = new OutboxPublisher({
      claim: async () => {
        claimStarted = true;
        return [];
      },
      markPublished: async () => undefined,
      publish: async () => undefined,
      metrics,
    });
    const pending = publisher.pollOnce({ mode: 'shutdown_drain' });
    expect(claimStarted).toBe(true);
    expect(metrics.metrics()).toContain(
      'outbox_claims_total{mode="shutdown_drain"} 1',
    );
    await pending;
    expect(
      OutboxPublisher.prototype.pollOnce.toString().indexOf('claim('),
    ).toBeLessThan(
      OutboxPublisher.prototype.pollOnce.toString().indexOf('await'),
    );
  });
});
