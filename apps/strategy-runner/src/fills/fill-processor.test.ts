import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Broker, BrokerOrder, BrokerPortfolio } from '@moi/strategy-sdk';
import type {
  FillEvent,
  Strategy,
  StrategyDecision,
} from '@moi/strategy-sdk/strategy';
import { defineParameterSchema } from '@moi/strategy-sdk/strategy';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamAccountEvent } from '../feed/stream-client.js';
import { deriveIdempotencyKey } from '../gateway/idempotency.js';
import { OrderGateway } from '../gateway/order-gateway.js';
import { createRecordingReporter } from '../reporter.js';
import { RunnerContext } from '../runner/runner-context.js';
import { StrategyHost } from '../runner/strategy-host.js';
import { StateStore } from '../state/state-store.js';
import { FillProcessor, fillDecisionId } from './fill-processor.js';

const NOW_MS = Date.parse('2026-09-02T02:00:00.000Z');

/** Every `placeOrder`, and one order per idempotency key — as the ledger does. */
class RecordingBroker implements Broker {
  readonly submitted: { key: string }[] = [];
  readonly #orders = new Map<string, BrokerOrder>();
  #next = 0;

  async placeOrder(command: {
    readonly idempotencyKey: string;
  }): Promise<BrokerOrder> {
    this.submitted.push({ key: command.idempotencyKey });

    const existing = this.#orders.get(command.idempotencyKey);

    if (existing !== undefined) {
      return existing;
    }

    this.#next += 1;

    const order: BrokerOrder = Object.freeze({
      id: `order-${this.#next}`,
      status: 'RECEIVED' as const,
    });

    this.#orders.set(command.idempotencyKey, order);

    return order;
  }

  async cancelOrder(): Promise<BrokerOrder> {
    throw new Error('not used');
  }

  async exchange(): Promise<never> {
    throw new Error('not used');
  }

  async getPortfolio(): Promise<BrokerPortfolio> {
    throw new Error('not used');
  }
}

interface StubFill {
  readonly id: string;
  readonly quantity: string;
  readonly price: string;
  readonly fee: string;
}

function portfolioWith(
  options: {
    readonly side?: 'BUY' | 'SELL';
    readonly fills?: readonly StubFill[];
    readonly filledQuantity?: string;
    readonly positionTotal?: string;
    readonly averageCost?: string;
    readonly accountSequence?: string;
  } = {},
): BrokerPortfolio {
  const fills = options.fills ?? [
    { id: 'fill-1', quantity: '10', price: '1000', fee: '5' },
  ];

  return Object.freeze({
    sessionId: 'session-1',
    wallets: [],
    positions:
      options.positionTotal === undefined
        ? []
        : [
            {
              market: 'KR' as const,
              symbol: '005930',
              total: options.positionTotal,
              available: options.positionTotal,
              reserved: '0',
              averageCost: options.averageCost ?? '1000',
            },
          ],
    activeOrders: [
      {
        id: 'order-a',
        market: 'KR' as const,
        symbol: '005930',
        type: 'MARKET' as const,
        side: options.side ?? ('BUY' as const),
        quantity: '10',
        filledQuantity:
          options.filledQuantity ??
          String(fills.reduce((sum, each) => sum + Number(each.quantity), 0)),
        status: 'FILLED' as const,
        fills: fills.map((each) => ({
          ...each,
          symbol: '005930',
          recoveryFill: false,
        })),
        siblingOrderIds: [],
      },
    ],
    accountSequence: options.accountSequence ?? '9',
  }) as unknown as BrokerPortfolio;
}

const fillEvent = (
  accountSequence: string,
  overrides: Partial<StreamAccountEvent> = {},
): StreamAccountEvent =>
  Object.freeze({
    eventId: `event-${accountSequence}`,
    accountSequence,
    eventType: 'ORDER_FILLED',
    payload: { orderId: 'order-a', status: 'FILLED', filledQuantity: '10' },
    ...overrides,
  });

/** A strategy whose `onFill` answers with whatever the test told it to. */
function strategyAnswering(
  answer: (fill: FillEvent) => readonly StrategyDecision[],
): Strategy<unknown> {
  const strategy: Strategy<Record<string, never>> = {
    id: 'test-fill-strategy',
    parameterSchema: defineParameterSchema({}),
    subscriptions: () => [{ market: 'KR', symbol: '005930' }],
    onTick: () => [],
    onFill: (fill) => answer(fill),
  };

  return strategy as Strategy<unknown>;
}

const ENTRY: StrategyDecision = Object.freeze({
  kind: 'place',
  reason: 'scale-in',
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

function build(
  directory: string,
  options: {
    readonly answer?: (fill: FillEvent) => readonly StrategyDecision[];
    readonly portfolio?: BrokerPortfolio;
    readonly broker?: RecordingBroker;
    readonly seen?: FillEvent[];
  } = {},
) {
  const reporter = createRecordingReporter();
  const state = StateStore.open({ directory });

  stores.push(state);

  const broker = options.broker ?? new RecordingBroker();
  const gateway = new OrderGateway({
    broker,
    state,
    sessionId: () => 'session-1',
    reporter,
    reestablishSession: async () => {},
    now: () => NOW_MS,
  });
  const host = new StrategyHost({
    configured: {
      name: 'samsung',
      strategy: strategyAnswering((fill) => {
        options.seen?.push(fill);

        return options.answer?.(fill) ?? [];
      }),
      params: {},
      subscriptions: [{ market: 'KR', symbol: '005930' }],
    },
    reporter,
  });
  const processor = new FillProcessor({
    state,
    gateway,
    reporter,
    context: new RunnerContext(() => NOW_MS),
    owner: new Map([['KR:005930', host]]),
    portfolio: async () => options.portfolio ?? portfolioWith(),
    now: () => NOW_MS,
  });

  return { state, broker, gateway, processor, reporter };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-fill-proc-'));

describe('processing one account event', () => {
  it('delivers the fill, commits it, and advances the cursor in one record', async () => {
    const seen: FillEvent[] = [];
    const { processor, state } = build(scratch(), { seen });

    await processor.process(fillEvent('12'));

    expect(seen).toStrictEqual([
      {
        orderId: 'order-a',
        fillId: 'fill-1',
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        quantity: '10',
        price: '1000',
        fee: '5',
        accountSequence: '12',
      },
    ]);
    expect(state.fills.cursor).toBe('12');
    expect(state.fills.hasFill('fill-1')).toBe(true);
    expect(state.fills.position('KR:005930')).toStrictEqual({
      symbol: '005930',
      // The fee joins the cost basis on a buy, exactly as the ledger's own
      // `applyFillToPosition` does it.
      quantity: '10',
      totalCost: '10005',
      realizedPnl: '0',
    });
  });

  it('advances the cursor over an event that is not a fill', async () => {
    const { processor, state } = build(scratch());

    await processor.process(
      fillEvent('12', { eventType: 'ORDER_ACCEPTED', payload: {} }),
    );

    expect(state.fills.cursor).toBe('12');
    expect(state.fills.realizedPnl()).toBe('0');
  });

  it('stops at the quantity the event announced', async () => {
    const { processor, state } = build(scratch(), {
      // The portfolio was read after the event and already holds a later fill.
      portfolio: portfolioWith({
        fills: [
          { id: 'fill-1', quantity: '4', price: '1000', fee: '0' },
          { id: 'fill-2', quantity: '6', price: '1100', fee: '0' },
        ],
      }),
    });

    await processor.process(
      fillEvent('12', {
        payload: {
          orderId: 'order-a',
          status: 'PARTIALLY_FILLED',
          filledQuantity: '4',
        },
      }),
    );

    expect(state.fills.hasFill('fill-1')).toBe(true);
    expect(state.fills.hasFill('fill-2')).toBe(false);
  });
});

/**
 * The property the phase exists for. Two different paths re-deliver an event —
 * a reconnect, where the server replays from `afterSequence`, and a restart,
 * where a new process folds the journal — and neither may produce a second
 * `onFill` or a second order.
 */
describe('exactly once', () => {
  it('ignores an event the journal has already committed', async () => {
    const seen: FillEvent[] = [];
    const { processor, state } = build(scratch(), { seen });

    await processor.process(fillEvent('12'));
    // The reconnect path: the server replays it because `afterSequence` was
    // one behind when the socket came up.
    await processor.process(fillEvent('12'));

    expect(seen).toHaveLength(1);
    expect(state.fills.cursor).toBe('12');
  });

  it('ignores an event below the committed cursor even under a new id', async () => {
    const seen: FillEvent[] = [];
    const { processor } = build(scratch(), { seen });

    await processor.process(fillEvent('12'));
    await processor.process(fillEvent('11', { eventId: 'event-late' }));

    expect(seen).toHaveLength(1);
  });

  it('does not deliver a fill a previous event already committed', async () => {
    const seen: FillEvent[] = [];
    const { processor } = build(scratch(), {
      seen,
      portfolio: portfolioWith({
        fills: [
          { id: 'fill-1', quantity: '4', price: '1000', fee: '0' },
          { id: 'fill-2', quantity: '6', price: '1100', fee: '0' },
        ],
      }),
    });

    await processor.process(
      fillEvent('12', {
        payload: { orderId: 'order-a', filledQuantity: '4' },
      }),
    );
    await processor.process(
      fillEvent('13', {
        eventId: 'event-13',
        payload: { orderId: 'order-a', filledQuantity: '10' },
      }),
    );

    expect(seen.map((fill) => fill.fillId)).toStrictEqual(['fill-1', 'fill-2']);
  });

  /**
   * The crash the phase's done-criterion names: the process dies **after** the
   * decision was recorded and **before** the commit line landed. A new process
   * over the same directory replays the event, recomputes the same
   * `decisionId`, writes no second decision, and submits under the same
   * idempotency key — so the ledger replays the original order.
   */
  it('replays an uncommitted step without placing a second order', async () => {
    const directory = scratch();
    const broker = new RecordingBroker();
    const seen: FillEvent[] = [];
    const first = build(directory, {
      broker,
      seen,
      answer: () => [ENTRY],
    });

    // Step 3 and 4 by hand, so the process can die between 4 and 5.
    const record = first.gateway.record(
      'samsung',
      ENTRY,
      {
        market: 'KR',
        symbol: '005930',
        price: '1000',
        priceSource: 'rest-snapshot',
        bestBid: null,
        bestAsk: null,
        asOf: new Date(NOW_MS).toISOString(),
        marketDataVersion: '0',
        gapBefore: false,
      },
      { decisionId: fillDecisionId('12', 'samsung', 0) },
    );

    expect(record?.decisionId).toBe('fill:12:samsung:0');
    expect(first.state.fills.cursor).toBeNull();

    first.state.close();
    stores.length = 0;

    // The restart. Same directory, same event off the stream's replay.
    const second = build(directory, { broker, seen, answer: () => [ENTRY] });

    await second.processor.process(fillEvent('12'));

    expect(second.state.fills.cursor).toBe('12');
    // One decision line, not two: `appendDecision` is idempotent by the id the
    // replay recomputed.
    expect(second.state.fills.position('KR:005930')?.quantity).toBe('10');
    expect(second.state.pendingDecisions()).toStrictEqual([]);
    // The key is the same both times, so the ledger answers the second
    // submission with the order it already had.
    expect(new Set(broker.submitted.map((each) => each.key)).size).toBe(1);
    expect(broker.submitted[0]?.key).toBe(
      deriveIdempotencyKey('fill:12:samsung:0'),
    );
  });

  it('derives one id per decision, per strategy, per event', () => {
    expect(fillDecisionId('12', 'samsung', 0)).toBe('fill:12:samsung:0');
    expect(fillDecisionId('12', 'samsung', 1)).toBe('fill:12:samsung:1');
    expect(fillDecisionId('13', 'samsung', 0)).toBe('fill:13:samsung:0');
    expect(fillDecisionId('12', 'hynix', 0)).toBe('fill:12:hynix:0');
  });
});

describe('what a fill realises', () => {
  it('is the ledger arithmetic, fees and all', async () => {
    const directory = scratch();
    const opened = build(directory);

    await opened.processor.process(fillEvent('1'));
    opened.state.close();
    stores.length = 0;

    const closing = build(directory, {
      portfolio: portfolioWith({
        side: 'SELL',
        fills: [{ id: 'fill-2', quantity: '10', price: '1200', fee: '7' }],
      }),
    });

    await closing.processor.process(
      fillEvent('2', {
        eventId: 'event-2',
        payload: { orderId: 'order-a', filledQuantity: '10' },
      }),
    );

    // Bought 10 at 1000 with a 5 fee → basis 10005. Sold 10 at 1200 with a 7
    // fee → proceeds after fee 11993. Realised 1988.
    expect(closing.state.fills.realizedPnl()).toBe('1988');
    expect(closing.state.fills.position('KR:005930')).toStrictEqual({
      symbol: '005930',
      quantity: '0',
      totalCost: '0',
      realizedPnl: '1988',
    });
  });

  /**
   * A sell the runner has no basis for — a session with holdings from before
   * the bot, or one whose events it had to skip. It must not guess: the fill is
   * recorded realising nothing, the basis is re-read from the ledger, and it is
   * reported so a person knows the PnL series has a hole in it.
   */
  it('says so rather than inventing a number it cannot know', async () => {
    const { processor, state, reporter } = build(scratch(), {
      portfolio: portfolioWith({
        side: 'SELL',
        fills: [{ id: 'fill-9', quantity: '10', price: '1200', fee: '0' }],
        positionTotal: '5',
        averageCost: '900',
      }),
    });

    await processor.process(fillEvent('3'));

    expect(state.fills.realizedPnl()).toBe('0');
    expect(state.fills.position('KR:005930')).toStrictEqual({
      symbol: '005930',
      quantity: '5',
      totalCost: '4500',
      realizedPnl: '0',
    });
    expect(reporter.lines.join('\n')).toMatch(
      /realised PnL is discontinuous from here/u,
    );
    // The cursor still advanced: a fill the runner cannot account for is not a
    // reason to replay it forever.
    expect(state.fills.cursor).toBe('3');
  });
});

describe('a resync', () => {
  it('adopts the ledger cursor and records that it skipped events', async () => {
    const { processor, state, reporter } = build(scratch(), {
      portfolio: portfolioWith({ accountSequence: '5000' }),
    });

    await processor.process(fillEvent('1'));
    await processor.resync('OUTBOX_GAP');

    expect(state.fills.cursor).toBe('5000');
    expect(state.fills.resynced).toBe(true);
    expect(reporter.lines.join('\n')).toMatch(
      /advanced over events that were never delivered/u,
    );
  });

  it('does nothing when the ledger is not ahead of the cursor', async () => {
    const { processor, state, reporter } = build(scratch(), {
      portfolio: portfolioWith({ accountSequence: '1' }),
    });

    await processor.process(fillEvent('1'));
    await processor.resync('OUTBOX_GAP');

    expect(state.fills.cursor).toBe('1');
    expect(state.fills.resynced).toBe(false);
    expect(reporter.lines.join('\n')).toMatch(
      /the ledger is not ahead of the committed cursor/u,
    );
  });
});

describe('containment', () => {
  it('commits the fill even when the strategy throws on it', async () => {
    const { processor, state, reporter } = build(scratch(), {
      answer: () => {
        throw new Error('strategy is broken');
      },
    });

    await processor.process(fillEvent('12'));

    expect(state.fills.cursor).toBe('12');
    expect(state.fills.hasFill('fill-1')).toBe(true);
    expect(reporter.lines.join('\n')).toMatch(/a strategy threw on a fill/u);
  });

  it('counts a fill on an instrument no strategy owns towards PnL anyway', async () => {
    const directory = scratch();
    const reporter = createRecordingReporter();
    const state = StateStore.open({ directory });

    stores.push(state);

    const processor = new FillProcessor({
      state,
      gateway: new OrderGateway({
        broker: new RecordingBroker(),
        state,
        sessionId: () => 'session-1',
        reporter,
        reestablishSession: async () => {},
        now: () => NOW_MS,
      }),
      reporter,
      context: new RunnerContext(() => NOW_MS),
      owner: new Map(),
      portfolio: async () => portfolioWith(),
      now: () => NOW_MS,
    });

    await processor.process(fillEvent('12'));

    expect(state.fills.hasFill('fill-1')).toBe(true);
    expect(state.fills.position('KR:005930')?.totalCost).toBe('10005');
  });
});
