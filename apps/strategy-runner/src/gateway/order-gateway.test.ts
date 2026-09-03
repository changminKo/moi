import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Broker,
  BrokerOrder,
  CancelOrderCommand,
  PlaceOrderCommand,
} from '@moi/strategy-sdk';
import type { PlaceDecision, Tick } from '@moi/strategy-sdk/strategy';
import { DomainError } from '@moi/trading-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import { StateStore } from '../state/state-store.js';
import { deriveIdempotencyKey } from './idempotency.js';
import { MAX_BACKOFF_MS, OrderGateway } from './order-gateway.js';

const NOW_MS = Date.parse('2026-09-02T02:00:00.000Z');

const TICK: Tick = Object.freeze({
  market: 'KR',
  symbol: '005930',
  price: '70000',
  priceSource: 'rest-snapshot',
  bestBid: '69900',
  bestAsk: '70100',
  asOf: '2026-09-02T02:00:00.000Z',
  marketDataVersion: '1',
  gapBefore: false,
});

const BUY: PlaceDecision = Object.freeze({
  kind: 'place',
  reason: 'golden-cross',
  intent: Object.freeze({
    market: 'KR',
    symbol: '005930',
    side: 'BUY',
    type: 'MARKET',
    quantity: '1',
  }),
});

const stores: StateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

interface BrokerCall {
  readonly kind: 'place' | 'cancel';
  readonly command: PlaceOrderCommand | CancelOrderCommand;
}

/** A broker whose answer per call is taken from a queue of results or errors. */
function fakeBroker(
  answers: readonly (BrokerOrder | Error)[] = [
    { id: 'o-1', status: 'OPEN' } as BrokerOrder,
  ],
): Broker & { readonly calls: BrokerCall[] } {
  const calls: BrokerCall[] = [];
  const queue = [...answers];
  const answer = (): BrokerOrder => {
    const next = queue.length > 1 ? queue.shift() : queue[0];

    if (next instanceof Error) {
      throw next;
    }

    return next as BrokerOrder;
  };

  return {
    calls,
    placeOrder: async (command) => {
      calls.push({ kind: 'place', command });

      return answer();
    },
    cancelOrder: async (command) => {
      calls.push({ kind: 'cancel', command });

      return answer();
    },
    exchange: async () => {
      throw new Error('not used');
    },
    getPortfolio: async () => {
      throw new Error('not used');
    },
  } as Broker & { readonly calls: BrokerCall[] };
}

function harness(
  options: {
    readonly answers?: readonly (BrokerOrder | Error)[];
    readonly directory?: string;
    readonly maxAttempts?: number;
    readonly barrier?: (kind: 'place' | 'cancel') => boolean;
    readonly onExhausted?: (failure: {
      readonly code: string;
      readonly consecutiveFailures: number;
    }) => void;
  } = {},
) {
  const directory =
    options.directory ?? mkdtempSync(join(tmpdir(), 'moi-gateway-'));
  const state = StateStore.open({ directory });

  stores.push(state);

  const broker = fakeBroker(options.answers);
  const reporter = createRecordingReporter();
  const reestablished: number[] = [];
  let decisions = 0;

  return {
    broker,
    directory,
    reestablished,
    reporter,
    state,
    gateway: new OrderGateway({
      broker,
      state,
      sessionId: () => 's-1',
      reporter,
      reestablishSession: async () => {
        reestablished.push(1);
      },
      now: () => NOW_MS,
      newDecisionId: () => {
        decisions += 1;

        return `d-${decisions}`;
      },
      sleep: async () => {},
      ...(options.maxAttempts === undefined
        ? {}
        : { maxAttempts: options.maxAttempts }),
      ...(options.barrier === undefined ? {} : { barrier: options.barrier }),
      ...(options.onExhausted === undefined
        ? {}
        : { onExhausted: options.onExhausted }),
    }),
  };
}

describe('OrderGateway happy path', () => {
  it('records the decision, derives the key from it, and submits', async () => {
    const { broker, gateway } = harness();

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toStrictEqual({
      decisionId: 'd-1',
      outcome: 'accepted',
      orderId: 'o-1',
    });
    expect(broker.calls[0]?.command).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      side: 'BUY',
      type: 'MARKET',
      quantity: '1',
      sessionId: 's-1',
      idempotencyKey: deriveIdempotencyKey('d-1'),
    });
  });

  /**
   * §6.2's ordering, asserted from inside the submission itself: by the time
   * the broker is called, the decision is already a durable line in the log. If
   * these were the other way round, a crash here would leave an order the runner
   * could never recognise as its own.
   */
  it('has the decision on disk before the broker is called', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-order-'));
    let logAtSubmit = '';
    const state = StateStore.open({ directory });

    stores.push(state);

    const gateway = new OrderGateway({
      broker: {
        placeOrder: async () => {
          logAtSubmit = readFileSync(
            join(directory, 'decisions.ndjson'),
            'utf8',
          );

          return { id: 'o-1', status: 'OPEN' } as BrokerOrder;
        },
      } as unknown as Broker,
      state,
      sessionId: () => 's-1',
      reporter: createRecordingReporter(),
      reestablishSession: async () => {},
      now: () => NOW_MS,
      newDecisionId: () => 'd-1',
    });

    await gateway.place('samsung', BUY, TICK);

    expect(logAtSubmit).toContain('"decisionId":"d-1"');
  });

  it('records the notional the decision committed', async () => {
    const { gateway, state } = harness();

    gateway.record('samsung', BUY, TICK);

    expect(state.dailyEntryNotional('2026-09-02')).toBe('70000');
  });

  it('writes a noop to the log and submits nothing', async () => {
    const { broker, gateway } = harness();

    await expect(
      gateway.place('samsung', { kind: 'noop', reason: 'warming-up' }, TICK),
    ).resolves.toBeNull();
    expect(broker.calls).toStrictEqual([]);
  });

  it('submits a cancel under a key derived the same way', async () => {
    const { broker, gateway } = harness({
      answers: [{ id: 'o-9', status: 'CANCELLED' } as BrokerOrder],
    });

    await gateway.place(
      'samsung',
      { kind: 'cancel', orderId: 'o-9', reason: 'risk-stop' },
      TICK,
    );

    expect(broker.calls[0]).toStrictEqual({
      kind: 'cancel',
      command: {
        sessionId: 's-1',
        idempotencyKey: deriveIdempotencyKey('d-1'),
        orderId: 'o-9',
      },
    });
  });
});

describe('OrderGateway recording under a reused decision id', () => {
  /**
   * #88: the fill path recomputes its decision ids on replay, so a second
   * `record()` under an id the log already holds is the replay of the first.
   * What the caller gets back — and what is then submitted — must be the
   * decision that was recorded, not whatever the strategy answered this time:
   * the idempotency key is derived from the id, and the ledger refuses the old
   * key with a new payload (`IDEMPOTENCY_CONFLICT`).
   */
  it('returns the recorded decision rather than the one offered now', () => {
    const { gateway, state } = harness();
    const first = gateway.record('samsung', BUY, TICK, {
      decisionId: 'fill:12:samsung:0',
    });
    const second = gateway.record(
      'samsung',
      { ...BUY, intent: { ...BUY.intent, quantity: '2' } },
      TICK,
      { decisionId: 'fill:12:samsung:0' },
    );

    expect(second).toStrictEqual(first);
    expect(second?.intent?.quantity).toBe('1');
    expect(state.pendingDecisions()).toHaveLength(1);
  });
});

describe('OrderGateway restart idempotency', () => {
  /**
   * The criterion design §11 names for phase B, as a unit test. The process is
   * killed between the decision append and the submission; a new gateway over
   * the same directory recovers the decision and submits it under a key it
   * recomputed from the recorded `decisionId` — the same key the dead process
   * would have used.
   */
  it('resubmits an unsubmitted decision under the very same key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-restart-'));
    const crashed = harness({ directory });

    // The crash: recorded, never submitted.
    const record = crashed.gateway.record('samsung', BUY, TICK);

    crashed.state.close();
    stores.splice(stores.indexOf(crashed.state), 1);

    const restarted = harness({ directory });

    await expect(restarted.gateway.recoverPending()).resolves.toStrictEqual([
      { decisionId: 'd-1', outcome: 'accepted', orderId: 'o-1' },
    ]);
    expect(restarted.broker.calls).toHaveLength(1);
    expect(restarted.broker.calls[0]?.command).toMatchObject({
      idempotencyKey: deriveIdempotencyKey(record?.decisionId as string),
    });
  });

  it('places nothing a second time once the decision has settled', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-settled-'));
    const first = harness({ directory });

    await first.gateway.place('samsung', BUY, TICK);
    first.state.close();
    stores.splice(stores.indexOf(first.state), 1);

    const restarted = harness({ directory });

    await expect(restarted.gateway.recoverPending()).resolves.toStrictEqual([]);
    expect(restarted.broker.calls).toStrictEqual([]);
  });

  it('recovers several pending decisions, each under its own key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-many-'));
    const crashed = harness({ directory });

    crashed.gateway.record('samsung', BUY, TICK);
    crashed.gateway.record('samsung', BUY, TICK);
    crashed.state.close();
    stores.splice(stores.indexOf(crashed.state), 1);

    const restarted = harness({ directory });

    await restarted.gateway.recoverPending();

    expect(
      restarted.broker.calls.map(
        (call) => (call.command as PlaceOrderCommand).idempotencyKey,
      ),
    ).toStrictEqual([deriveIdempotencyKey('d-1'), deriveIdempotencyKey('d-2')]);
  });

  it('reports the resubmission rather than doing it silently', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-report-'));
    const crashed = harness({ directory });

    crashed.gateway.record('samsung', BUY, TICK);
    crashed.state.close();
    stores.splice(stores.indexOf(crashed.state), 1);

    const restarted = harness({ directory });

    await restarted.gateway.recoverPending();

    expect(restarted.reporter.lines[0]).toBe(
      '[warn] resubmitting decisions that were recorded but never settled count=1',
    );
  });
});

describe('OrderGateway failure handling', () => {
  const domain = (code: string) =>
    new DomainError(code as never, `the API answered ${code}`);

  /** §7.1: 401 re-establishes once, and retries under the unchanged key. */
  it('re-establishes the session once on SESSION_EXPIRED and retries the same key', async () => {
    const { broker, gateway, reestablished } = harness({
      answers: [
        domain('SESSION_EXPIRED'),
        { id: 'o-1', status: 'OPEN' } as BrokerOrder,
      ],
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(reestablished).toHaveLength(1);
    expect(
      broker.calls.map(
        (call) => (call.command as PlaceOrderCommand).idempotencyKey,
      ),
    ).toStrictEqual([deriveIdempotencyKey('d-1'), deriveIdempotencyKey('d-1')]);
  });

  it('does not re-establish twice for one decision', async () => {
    const { gateway, reestablished } = harness({
      answers: [domain('SESSION_EXPIRED')],
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'rejected',
    });
    expect(reestablished).toHaveLength(1);
  });

  it('retries a rate limit under the unchanged key', async () => {
    const { broker, gateway } = harness({
      answers: [
        domain('RATE_LIMITED'),
        domain('RATE_LIMITED'),
        { id: 'o-1', status: 'OPEN' } as BrokerOrder,
      ],
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'accepted',
    });

    const keys = new Set(
      broker.calls.map(
        (call) => (call.command as PlaceOrderCommand).idempotencyKey,
      ),
    );

    expect(broker.calls).toHaveLength(3);
    expect(keys.size).toBe(1);
  });

  /**
   * A network failure is not a verdict on the order — the request may well have
   * arrived — so it is retried under the unchanged key rather than being
   * reported as a rejection.
   */
  it('retries a bare network error rather than treating it as a rejection', async () => {
    const { broker, gateway } = harness({
      answers: [
        new Error('socket hang up'),
        { id: 'o-1', status: 'OPEN' } as BrokerOrder,
      ],
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'accepted',
    });
    expect(broker.calls).toHaveLength(2);
  });

  /**
   * §7.1: `INSUFFICIENT_*` is recorded without a retry. Reformulating and
   * resending is the one recovery that must not happen.
   */
  it('records a non-retryable rejection once and never resends', async () => {
    const { broker, gateway, state } = harness({
      answers: [domain('INSUFFICIENT_AVAILABLE_CASH')],
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toStrictEqual({
      decisionId: 'd-1',
      outcome: 'rejected',
    });
    expect(broker.calls).toHaveLength(1);
    expect(state.pendingDecisions()).toStrictEqual([]);
  });

  /**
   * A retryable fault that never clears leaves the decision pending, so the next
   * start resubmits it under the same key. §7.1's escalation to a kill switch at
   * ten failures is phase D; the safe resting state is what B provides.
   */
  it('leaves a decision pending when the retries are exhausted', async () => {
    const { gateway, reporter, state } = harness({
      answers: [domain('SERVICE_UNAVAILABLE')],
      maxAttempts: 3,
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toStrictEqual({
      decisionId: 'd-1',
      outcome: 'pending',
    });
    expect(
      state.pendingDecisions().map((each) => each.decisionId),
    ).toStrictEqual(['d-1']);
    expect(reporter.lines.at(-1)).toMatch(
      /\[error\] the place could not be submitted and is left pending/u,
    );
  });

  it('never puts a server message into a report line', async () => {
    const { gateway, reporter } = harness({
      answers: [
        new DomainError(
          'INVALID_ORDER',
          'rejected for cookie moi_session=leaked',
        ),
      ],
    });

    await gateway.place('samsung', BUY, TICK);

    expect(reporter.lines.join('\n')).not.toContain('leaked');
  });
});

/**
 * Phase D's submission barrier (design §6, §7.2; kill-switch design §2.2). The
 * gateway does not know *why* the barrier is down — that is the kill switch's
 * business — only that a `place` may not go out and a `cancel` may.
 */
describe('OrderGateway under the kill switch barrier', () => {
  const CANCEL = Object.freeze({
    kind: 'cancel',
    reason: 'kill switch',
    orderId: 'o-9',
  } as const);

  it('settles a place as halted instead of submitting it', async () => {
    const { broker, directory, gateway, state, reporter } = harness({
      barrier: (kind) => kind === 'cancel',
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toStrictEqual({
      decisionId: 'd-1',
      outcome: 'halted',
    });
    expect(broker.calls).toStrictEqual([]);
    expect(state.pendingDecisions()).toStrictEqual([]);
    // Settled *as halted* on disk — not as a rejection the ledger never gave.
    expect(readFileSync(join(directory, 'submissions.ndjson'), 'utf8')).toMatch(
      /"outcome":"halted".*"code":"KILL_SWITCH"|"code":"KILL_SWITCH".*"outcome":"halted"/u,
    );
    expect(reporter.lines.at(-1)).toMatch(
      /\[warn\] the place was halted by the kill switch .*code=KILL_SWITCH/u,
    );
  });

  it('lets a cancel through the same barrier', async () => {
    const { broker, gateway } = harness({
      answers: [{ id: 'o-9', status: 'CANCELLED' } as BrokerOrder],
      barrier: (kind) => kind === 'cancel',
    });
    const record = gateway.record('kill-switch', CANCEL, null, {
      decisionId: 'kill:2026-09-02T02:00:00.000Z:o-9',
    });

    await expect(
      gateway.submit(record as NonNullable<typeof record>),
    ).resolves.toMatchObject({ outcome: 'accepted', orderId: 'o-9' });
    expect(broker.calls[0]?.kind).toBe('cancel');
  });

  /**
   * A restart under the latch. The pending place is a dead decision and settles
   * as halted; the pending cancel is the recorded half of an interrupted sweep
   * and goes out. This is the path that makes a failed sweep retry itself.
   */
  it('recovers pending decisions under the latch: places halted, cancels resubmitted', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-latched-'));
    const seeded = StateStore.open({ directory });

    stores.push(seeded);
    seeded.appendDecision({
      decisionId: 'd-place',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'place',
      reason: 'golden-cross',
      intent: BUY.intent,
      notional: '70000',
    });
    seeded.appendDecision({
      decisionId: 'kill:2026-09-02T01:30:00.000Z:o-7',
      at: '2026-09-02T01:30:00.000Z',
      strategy: 'kill-switch',
      kind: 'cancel',
      reason: 'kill switch: drill',
      orderId: 'o-7',
    });
    seeded.close();
    stores.pop();

    const { broker, gateway, state } = harness({
      directory,
      answers: [{ id: 'o-7', status: 'CANCELLED' } as BrokerOrder],
      barrier: (kind) => kind === 'cancel',
    });

    await expect(gateway.recoverPending()).resolves.toStrictEqual([
      { decisionId: 'd-place', outcome: 'halted' },
      {
        decisionId: 'kill:2026-09-02T01:30:00.000Z:o-7',
        outcome: 'accepted',
        orderId: 'o-7',
      },
    ]);
    expect(broker.calls.map((call) => call.kind)).toStrictEqual(['cancel']);
    expect(state.pendingDecisions()).toStrictEqual([]);
  });

  /**
   * The barrier is asked before *every* attempt, not once at the door. A trip
   * that lands during a retry backoff — a fill wedge on the other chain, say —
   * must stop the next attempt; the one already sent cannot be unsent, and the
   * sweep is what catches that.
   */
  it('stops retrying when the barrier comes down between attempts', async () => {
    let down = false;
    const { broker, gateway } = harness({
      answers: [new DomainError('SERVICE_UNAVAILABLE', 'try later')],
      barrier: () => !down,
      maxAttempts: 4,
    });
    const originalPlace = broker.placeOrder.bind(broker);

    broker.placeOrder = async (command) => {
      down = true;

      return originalPlace(command);
    };

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'halted',
    });
    expect(broker.calls).toHaveLength(1);
  });

  /**
   * The barrier is also asked *after* a failed attempt, before the decision is
   * left pending or put to sleep. A latch that came down while the request was
   * in flight must settle the place as halted — a pending place is exactly what
   * `recoverPending` would resubmit after the operator clears the latch.
   */
  it('halts an in-flight place whose final retryable attempt loses the barrier', async () => {
    let down = false;
    const { broker, gateway, state } = harness({
      barrier: () => !down,
      maxAttempts: 1,
    });

    broker.placeOrder = async () => {
      down = true;
      throw new DomainError('SERVICE_UNAVAILABLE', 'gone');
    };

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'halted',
    });
    expect(state.pendingDecisions()).toStrictEqual([]);
  });

  /**
   * A 401 whose re-establishment then fails, under a latch that came down in
   * the meantime: the place must settle as halted rather than escape as a throw
   * that leaves it pending for a cleared restart.
   */
  it('halts when the barrier closes during a failed session re-establishment', async () => {
    let down = false;
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-401-'));
    const state = StateStore.open({ directory });

    stores.push(state);

    const broker = fakeBroker([new DomainError('SESSION_EXPIRED', 'expired')]);
    const gateway = new OrderGateway({
      broker,
      state,
      sessionId: () => 's-1',
      reporter: createRecordingReporter(),
      reestablishSession: async () => {
        down = true;
        throw new DomainError('SERVICE_UNAVAILABLE', 'auth down');
      },
      now: () => NOW_MS,
      newDecisionId: () => 'd-1',
      sleep: async () => {},
      barrier: () => !down,
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'halted',
    });
    expect(state.pendingDecisions()).toStrictEqual([]);
  });

  it('still throws a failed re-establishment while the barrier is open', async () => {
    const { gateway, broker } = harness({
      answers: [new DomainError('SESSION_EXPIRED', 'expired')],
    });

    broker.placeOrder = async () => {
      throw new DomainError('SESSION_EXPIRED', 'expired');
    };

    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-401-open-'));
    const state = StateStore.open({ directory });

    stores.push(state);

    const failing = new OrderGateway({
      broker,
      state,
      sessionId: () => 's-1',
      reporter: createRecordingReporter(),
      reestablishSession: async () => {
        throw new DomainError('SERVICE_UNAVAILABLE', 'auth down');
      },
      now: () => NOW_MS,
      newDecisionId: () => 'd-1',
      sleep: async () => {},
    });

    await expect(failing.place('samsung', BUY, TICK)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    void gateway;
  });

  /**
   * A halt records how many attempts went out before it. Zero means the order
   * never left; one or more means the ledger may hold it, and the daily budget
   * has to keep counting it (see `StateStore.dailyEntryNotional`).
   */
  it('records the attempts a halted place had made', async () => {
    let down = false;
    const { broker, directory, gateway } = harness({
      barrier: () => !down,
      maxAttempts: 1,
    });

    broker.placeOrder = async () => {
      down = true;
      throw new DomainError('SERVICE_UNAVAILABLE', 'gone');
    };

    await gateway.place('samsung', BUY, TICK);

    expect(readFileSync(join(directory, 'submissions.ndjson'), 'utf8')).toMatch(
      /"outcome":"halted".*"attempts":1|"attempts":1.*"outcome":"halted"/u,
    );

    const { directory: fresh, gateway: closed } = harness({
      barrier: () => false,
    });

    await closed.place('samsung', BUY, TICK);

    expect(readFileSync(join(fresh, 'submissions.ndjson'), 'utf8')).toMatch(
      /"attempts":0/u,
    );
  });

  it('does not sleep out a backoff once the barrier is down', async () => {
    let down = false;
    const slept: number[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-nosleep-'));
    const state = StateStore.open({ directory });

    stores.push(state);

    const broker = fakeBroker();
    const gateway = new OrderGateway({
      broker,
      state,
      sessionId: () => 's-1',
      reporter: createRecordingReporter(),
      reestablishSession: async () => {},
      now: () => NOW_MS,
      newDecisionId: () => 'd-1',
      sleep: async (ms) => {
        slept.push(ms);
      },
      maxAttempts: 4,
      barrier: () => !down,
    });

    broker.placeOrder = async () => {
      down = true;
      throw new DomainError('RATE_LIMITED', 'slow down', {
        retryAfterSeconds: 300,
      });
    };

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'halted',
    });
    expect(slept).toStrictEqual([]);
  });

  it('resolves idle() only after every in-flight submission has settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { broker, gateway } = harness();
    const originalPlace = broker.placeOrder.bind(broker);

    broker.placeOrder = async (command) => {
      await gate;

      return originalPlace(command);
    };

    const placing = gateway.place('samsung', BUY, TICK);
    let idle = false;
    const waiting = gateway.idle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await placing;
    await waiting;
    expect(idle).toBe(true);
    // Nothing in flight: resolves at once.
    await expect(gateway.idle()).resolves.toBeUndefined();
  });

  /**
   * Design §7.2: "10회 실패 시 킬 스위치". Counted per failed *attempt* across
   * decisions, reset by a success, and a rejection is a verdict rather than a
   * failure so it neither counts nor resets. The callback fires once, on the
   * crossing.
   */
  it('reports exhaustion once after ten failed attempts in a row', async () => {
    const exhausted: { code: string; consecutiveFailures: number }[] = [];
    const fault = new DomainError('SERVICE_UNAVAILABLE', 'down');
    const { gateway } = harness({
      answers: [fault],
      maxAttempts: 4,
      onExhausted: (failure) => exhausted.push(failure),
    });

    await gateway.place('samsung', BUY, TICK); // attempts 1-4
    await gateway.place('samsung', BUY, TICK); // 5-8
    expect(exhausted).toStrictEqual([]);
    await gateway.place('samsung', BUY, TICK); // 9-12: fires at 10
    expect(exhausted).toStrictEqual([
      { code: 'SERVICE_UNAVAILABLE', consecutiveFailures: 10 },
    ]);
  });

  it('resets the failure run on a success and ignores rejections', async () => {
    const exhausted: unknown[] = [];
    const fault = new DomainError('SERVICE_UNAVAILABLE', 'down');
    const { gateway, broker } = harness({
      answers: [fault],
      maxAttempts: 9,
      onExhausted: (failure) => exhausted.push(failure),
    });

    await gateway.place('samsung', BUY, TICK); // 9 failures
    broker.placeOrder = async () =>
      ({ id: 'o-1', status: 'OPEN' }) as BrokerOrder;
    await gateway.place('samsung', BUY, TICK); // success: back to 0
    broker.placeOrder = async () => {
      throw new DomainError('INVALID_ORDER', 'no');
    };
    await gateway.place('samsung', BUY, TICK); // rejection: not counted
    broker.placeOrder = async () => {
      throw fault;
    };
    await gateway.place('samsung', BUY, TICK); // 9 more, still under 10

    expect(exhausted).toStrictEqual([]);
  });
});

/** Design §7.2: exponential backoff, "최대 5분". The server's `Retry-After` is honoured up to that cap. */
describe('OrderGateway backoff cap', () => {
  it('caps a Retry-After above five minutes at the cap', async () => {
    const slept: number[] = [];
    const directory = mkdtempSync(join(tmpdir(), 'moi-gateway-cap-'));
    const state = StateStore.open({ directory });

    stores.push(state);

    const gateway = new OrderGateway({
      broker: fakeBroker([
        new DomainError('RATE_LIMITED', 'slow down', {
          retryAfterSeconds: 3_600,
        }),
        { id: 'o-1', status: 'OPEN' } as BrokerOrder,
      ]),
      state,
      sessionId: () => 's-1',
      reporter: createRecordingReporter(),
      reestablishSession: async () => {},
      now: () => NOW_MS,
      newDecisionId: () => 'd-1',
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await gateway.place('samsung', BUY, TICK);

    expect(slept).toStrictEqual([MAX_BACKOFF_MS]);
  });
});
