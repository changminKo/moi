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
import { OrderGateway } from './order-gateway.js';

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

    expect(state.dailyNotional('2026-09-02')).toBe('70000');
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
