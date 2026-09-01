import {
  FakeMarketData,
  type MarketSnapshotSource,
  type RecoverySnapshot,
} from '@moi/market-data';
import { DomainError, type Market } from '@moi/trading-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketHealthMachine } from '../market-data/health-machine.js';
import type { LeaderLease } from '../market-data/leader-lease.js';
import { MarketStateStore } from '../market-data/market-state-store.js';
import { MetricsRegistry } from '../observability/metrics.js';
import {
  KEEPALIVE_INTERVAL_MS,
  MarketRuntime,
  type MarketRuntimeDeps,
  PONG_TIMEOUT_MS,
  REJECTION_BURST_LIMIT,
} from './market-runtime.js';

const BOOK = {
  market: 'US' as const,
  symbol: 'AAPL',
  currency: 'USD' as const,
  bids: [{ price: '100', volume: '10' }],
  asks: [{ price: '101', volume: '10' }],
};

function build(
  overrides: Partial<MarketRuntimeDeps> & {
    connectError?: unknown;
    snapshotError?: unknown;
  } = {},
) {
  const stream = new FakeMarketData();
  const incidents = {
    activate: vi.fn(async (input: unknown) => ({
      incidentId: `i${Math.random()}`,
      version: 1n,
      input,
    })),
    resolveCas: vi.fn(async () => true),
  };
  const health = new MarketHealthMachine({ market: 'US', incidents });
  const stateStore = new MarketStateStore();
  const engine = {
    onTrade: vi.fn(async () => undefined),
    onOrderBook: vi.fn(async () => undefined),
    onRecoveryOrderBook: vi.fn(async () => undefined),
  };
  const hub = { publishQuote: vi.fn() };
  const metrics = new MetricsRegistry();
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const lease = {
    market: 'US',
    epoch: 3n,
    fencingToken: 3n,
    isHeld: true,
  } as unknown as LeaderLease;
  const connectSpy = vi.spyOn(stream, 'connect');
  if (overrides.connectError)
    connectSpy.mockRejectedValueOnce(overrides.connectError);
  const getRecoverySnapshot = vi.fn<
    (
      market: Market,
      symbol: string,
      signal: AbortSignal,
    ) => Promise<RecoverySnapshot>
  >(async (market, symbol) => {
    if (overrides.snapshotError) throw overrides.snapshotError;
    return {
      market,
      symbol,
      price: '100.5',
      book: BOOK,
      fetchedAt: new Date().toISOString(),
    };
  });
  const snapshots = {
    getRecoverySnapshot,
  } as unknown as MarketSnapshotSource & {
    getRecoverySnapshot: typeof getRecoverySnapshot;
  };
  const runtime = new MarketRuntime({
    market: 'US',
    stream,
    snapshots,
    stateStore,
    health,
    engine,
    hub,
    incidents,
    leases: { held: () => lease },
    symbols: ['AAPL'],
    subscriptions: [
      { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
      { channel: 'trade', market: 'US', symbols: ['AAPL'] },
    ],
    stabilityMs: 0,
    metrics,
    log: (event, fields) => logs.push({ event, fields }),
    reconnectDelayMs: () => 0,
    ...overrides,
  });
  return {
    runtime,
    stream,
    incidents,
    health,
    engine,
    hub,
    metrics,
    logs,
    snapshots,
    connectSpy,
    stateStore,
  };
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('MarketRuntime', () => {
  afterEach(() => vi.useRealTimers());

  it('recovers on connect, then forwards trades and books to the engine and hub with the lease epoch', async () => {
    const { runtime, stream, health, engine, hub, metrics, logs, stateStore } =
      build();
    await runtime.connect(new AbortController().signal);
    expect(health.state).toBe('HEALTHY');
    expect(stateStore.recoveryEpoch).toBe(3n);
    expect(logs.some((l) => l.event === 'recovery.complete')).toBe(true);
    expect(metrics.metrics()).toContain('leader_epoch{market="US"} 3');
    stream.emitTrade({
      market: 'US',
      symbol: 'AAPL',
      price: '100.25',
      volume: '5',
      sourceTimestamp: null,
    });
    stream.emitOrderBook({
      market: 'US',
      symbol: 'AAPL',
      book: BOOK,
      sourceTimestamp: null,
    });
    await vi.waitFor(() => expect(engine.onOrderBook).toHaveBeenCalledTimes(1));
    expect(engine.onTrade).toHaveBeenCalledTimes(1);
    const trade = (engine.onTrade.mock.calls as unknown[][])[0]?.[0] as {
      recoveryEpoch: bigint;
      leaderFencingToken: bigint;
      payload: { price: string };
    };
    expect(trade.recoveryEpoch).toBe(3n);
    expect(trade.leaderFencingToken).toBe(3n);
    expect(trade.payload.price).toBe('100.25');
    expect(hub.publishQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'US',
        symbol: 'AAPL',
        recoveryEpoch: 3n,
      }),
    );
    await runtime.close();
  });

  it('degrades only on transport close, reconnects, and counts the reconnect (A2)', async () => {
    const { runtime, stream, health, incidents, metrics, connectSpy } = build();
    await runtime.connect(new AbortController().signal);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    stream.emitTransportClosed('provider closed');
    await vi.waitFor(() =>
      expect(incidents.activate).toHaveBeenCalledWith(
        expect.objectContaining({
          market: 'US',
          causeCode: 'TRANSPORT_CLOSED',
        }),
      ),
    );
    await vi.waitFor(() => expect(health.state).toBe('HEALTHY'), {
      timeout: 2_000,
    });
    expect(connectSpy).toHaveBeenCalledTimes(2);
    expect(metrics.metrics()).toContain('feed_reconnect_total{market="US"} 1');
    expect(incidents.resolveCas).toHaveBeenCalled();
    await runtime.close();
  });

  it('turns provider errors into incidents, returns normally, and exhausts after three failures (A3, §8.2)', async () => {
    const { runtime, incidents, connectSpy, health, logs, stream } = build();
    connectSpy.mockRejectedValue(
      Object.assign(new Error('nope'), { statusCode: 401 }),
    );
    await expect(
      runtime.connect(new AbortController().signal),
    ).resolves.toBeUndefined();
    await vi.waitFor(
      () =>
        expect(
          incidents.activate.mock.calls.filter(
            (c) =>
              (c[0] as { causeCode: string }).causeCode ===
              'RECOVERY_RETRY_EXHAUSTED',
          ),
        ).toHaveLength(1),
      { timeout: 3_000 },
    );
    const codes = incidents.activate.mock.calls.map(
      (c) => (c[0] as { causeCode: string }).causeCode,
    );
    // The health machine holds one MARKET incident per degrade; every failed attempt is logged.
    expect(codes.filter((c) => c === 'PROVIDER_AUTH_FAILED')).toHaveLength(1);
    expect(connectSpy).toHaveBeenCalledTimes(3);
    expect(incidents.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        causeCode: 'RECOVERY_RETRY_EXHAUSTED',
        manual: true,
      }),
    );
    expect(health.state).toBe('DEGRADED');
    expect(runtime.supervisor.exhausted).toBe(true);
    const attemptsBefore = connectSpy.mock.calls.length;
    await flush(20);
    expect(connectSpy.mock.calls.length).toBe(attemptsBefore);
    connectSpy.mockImplementation((signal) =>
      FakeMarketData.prototype.connect.call(stream, signal),
    );
    runtime.resumeRetries();
    await vi.waitFor(() => expect(health.state).toBe('HEALTHY'), {
      timeout: 2_000,
    });
    expect(
      logs.filter((l) => l.event === 'recovery.failed').length,
    ).toBeGreaterThanOrEqual(3);
    await runtime.close();
  });

  it('keeps retrying after the hold and clears it without an operator (A3, §16.33)', async () => {
    const { runtime, incidents, connectSpy, health, logs, stream } = build({
      // The production re-arm is 30 s doubling to 5 min; the shape is what is
      // under test, so the test runs it at millisecond scale.
      rearmDelayMs: () => 5,
    });
    connectSpy.mockRejectedValue(
      Object.assign(new Error('nope'), { statusCode: 401 }),
    );
    await runtime.connect(new AbortController().signal);
    await vi.waitFor(() => expect(runtime.supervisor.exhausted).toBe(true), {
      timeout: 3_000,
    });
    const attemptsAtHold = connectSpy.mock.calls.length;

    // No operator touches anything: the supervisor re-arms on its own.
    await vi.waitFor(
      () =>
        expect(connectSpy.mock.calls.length).toBeGreaterThan(attemptsAtHold),
      { timeout: 3_000 },
    );
    expect(
      logs.filter((l) => l.event === 'recovery.rearmed').length,
    ).toBeGreaterThanOrEqual(1);
    // The hold is raised once, not once per re-armed failure.
    expect(
      incidents.activate.mock.calls.filter(
        (c) =>
          (c[0] as { causeCode: string }).causeCode ===
          'RECOVERY_RETRY_EXHAUSTED',
      ),
    ).toHaveLength(1);

    connectSpy.mockImplementation((signal) =>
      FakeMarketData.prototype.connect.call(stream, signal),
    );
    await vi.waitFor(() => expect(health.state).toBe('HEALTHY'), {
      timeout: 3_000,
    });
    expect(runtime.supervisor.exhausted).toBe(false);
    // The incident row itself is cleared on the recovery path by
    // `resolveMarketIncidents` (§16.34), not from here.
    expect(
      logs.filter((l) => l.event === 'recovery.hold_cleared'),
    ).toHaveLength(1);
    await runtime.close();
  });

  it.each([
    [
      Object.assign(new Error('x'), { statusCode: 403 }),
      'PROVIDER_IP_NOT_ALLOWED',
    ],
    [
      Object.assign(new Error('x'), { statusCode: 429 }),
      'PROVIDER_RATE_LIMITED',
    ],
    [
      Object.assign(new Error('x'), { code: 'AUTH_FAILED', statusCode: 401 }),
      'PROVIDER_AUTH_FAILED',
    ],
    [
      Object.assign(new Error('x'), { code: 'SUBSCRIPTION_REJECTED' }),
      'SUBSCRIPTION_REJECTED',
    ],
    [new Error('ECONNREFUSED'), 'PROVIDER_CONNECT_FAILED'],
  ])('maps %s to %s', async (error, causeCode) => {
    const { runtime, incidents, connectSpy } = build();
    connectSpy.mockRejectedValueOnce(error);
    await runtime.connect(new AbortController().signal);
    expect(incidents.activate).toHaveBeenCalledWith(
      expect.objectContaining({ causeCode }),
    );
    await runtime.close();
  });

  it('maps a rejected subscription ack to SUBSCRIPTION_REJECTED', async () => {
    const { runtime, stream, incidents } = build();
    stream.rejectTopics(['trade:US:AAPL']);
    await runtime.connect(new AbortController().signal);
    expect(incidents.activate).toHaveBeenCalledWith(
      expect.objectContaining({ causeCode: 'SUBSCRIPTION_REJECTED' }),
    );
    await runtime.close();
  });

  it('rethrows invariant failures and aborts instead of swallowing them', async () => {
    const invariant = build({
      connectError: new DomainError('INVARIANT_VIOLATION', 'ledger broken'),
    });
    await expect(
      invariant.runtime.connect(new AbortController().signal),
    ).rejects.toThrow('ledger broken');
    expect(invariant.incidents.activate).not.toHaveBeenCalled();
    const aborted = build();
    const controller = new AbortController();
    aborted.snapshots.getRecoverySnapshot.mockImplementation(
      async (_m, _s, signal: AbortSignal) => {
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          ),
        );
        throw new Error('unreachable');
      },
    );
    const connecting = aborted.runtime.connect(controller.signal);
    await flush();
    controller.abort();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      aborted.incidents.activate.mock.calls.map(
        (c) => (c[0] as { causeCode: string }).causeCode,
      ),
    ).not.toContain('PROVIDER_UNAVAILABLE');
    await aborted.runtime.close();
  });

  it('keeps recovery alive when a single snapshot fails (blocked symbol, market still healthy)', async () => {
    const { runtime, health, incidents, logs } = build({
      snapshotError: new Error('snapshot 500'),
    });
    await runtime.connect(new AbortController().signal);
    expect(health.state).toBe('HEALTHY');
    expect(incidents.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        causeCode: 'RECOVERY_SNAPSHOT_FAILED',
        symbol: 'AAPL',
      }),
    );
    expect(
      logs.find((l) => l.event === 'recovery.complete')?.fields,
    ).toMatchObject({ blocked: ['AAPL'] });
    await runtime.close();
  });

  it('pings every 60 s and degrades after two missed pongs by closing the transport (§7.3)', async () => {
    vi.useFakeTimers();
    const { runtime, stream, health, incidents } = build();
    await runtime.connect(new AbortController().signal);
    const ping = vi.spyOn(stream, 'ping');
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(health.missedPongs).toBe(0);
    stream.failNextPongs(2);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    expect(health.missedPongs).toBe(1);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(10);
    expect(incidents.activate).toHaveBeenCalledWith(
      expect.objectContaining({ causeCode: 'PONG_FAILED' }),
    );
    expect(PONG_TIMEOUT_MS).toBe(30_000);
    await runtime.close();
  });

  it('drops rejected events, counts them, and degrades after a burst (§7.1)', async () => {
    const { runtime, stream, engine, metrics, incidents } = build();
    engine.onTrade.mockRejectedValue(new Error('bad event'));
    await runtime.connect(new AbortController().signal);
    for (let i = 0; i < REJECTION_BURST_LIMIT; i += 1)
      stream.emitTrade({
        market: 'US',
        symbol: 'AAPL',
        price: '1',
        volume: '1',
        sourceTimestamp: null,
      });
    await vi.waitFor(() =>
      expect(incidents.activate).toHaveBeenCalledWith(
        expect.objectContaining({ causeCode: 'EVENT_REJECTION_BURST' }),
      ),
    );
    expect(metrics.metrics()).toMatch(
      /market_event_rejected_total\{market="US",reason="engine"\} 20/,
    );
    await runtime.close();
  });

  it('abort() cancels the event loop, keepalive, and an in-flight recovery without new provider calls', async () => {
    vi.useFakeTimers();
    const { runtime, stream, snapshots, connectSpy } = build();
    let release: (() => void) | undefined;
    snapshots.getRecoverySnapshot.mockImplementationOnce(
      async (_m, _s, signal: AbortSignal) => {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
        throw new Error('unreachable');
      },
    );
    const connecting = runtime.connect(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5);
    const calls = connectSpy.mock.calls.length;
    runtime.abort();
    await expect(connecting).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2);
    expect(connectSpy.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
    release?.();
    await runtime.close();
    expect(stream.receivedEvents()).toBeDefined();
  });

  it('feeds every recovered REST baseline into the engine as a RECOVERY_REST book and reports transport changes', async () => {
    const transports: string[] = [];
    const { runtime, engine, stream } = build({
      onTransport: (state) => transports.push(state),
    });
    await runtime.connect(new AbortController().signal);
    expect(engine.onRecoveryOrderBook).toHaveBeenCalledTimes(1);
    const envelope = (
      engine.onRecoveryOrderBook.mock.calls as unknown[][]
    )[0]?.[0] as {
      recoveryEpoch: bigint;
      payload: { symbol: string; asks: unknown[] };
    };
    expect(envelope.recoveryEpoch).toBe(3n);
    expect(envelope.payload).toMatchObject({ symbol: 'AAPL', asks: BOOK.asks });
    expect(transports).toEqual(['connected']);
    stream.emitTransportClosed('gone');
    await vi.waitFor(() => expect(transports).toContain('closed'));
    await runtime.close();
  });
});
