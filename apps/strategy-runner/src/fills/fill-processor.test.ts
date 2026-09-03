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
import { DomainError } from '@moi/trading-core';
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

/**
 * One entry of the `fills` array the `ORDER_FILLED` payload has carried since
 * `#43`, built the way `fillRecord` builds it.
 */
interface WireFill {
  readonly id: string;
  readonly quantity?: string;
  readonly price?: string;
  readonly fee?: string;
  readonly side?: 'BUY' | 'SELL';
  readonly accountSequence?: string | null;
}

function wireFill(fill: WireFill, sequence: string): Record<string, unknown> {
  return {
    id: fill.id,
    fillSequence: `9${fill.id.replace(/\D/gu, '') || '0'}`,
    accountSequence:
      fill.accountSequence === undefined ? sequence : fill.accountSequence,
    orderId: 'order-a',
    market: 'KR',
    symbol: '005930',
    side: fill.side ?? 'BUY',
    quantity: fill.quantity ?? '10',
    price: fill.price ?? '1000',
    fee: fill.fee ?? '5',
    currency: 'KRW',
    isRecoveryFill: false,
    occurredAt: '2026-09-02T02:00:00.000Z',
  };
}

/**
 * The ledger's own view. Since `#43` this is needed only to re-base a position
 * the runner has no basis for; the ordinary path never reads it, which
 * `portfolioReads` below is here to prove.
 */
function portfolioWith(
  options: {
    readonly positionTotal?: string;
    readonly averageCost?: string;
    readonly accountSequence?: string;
  } = {},
): BrokerPortfolio {
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
    activeOrders: [],
    accountSequence: options.accountSequence ?? '9',
  }) as unknown as BrokerPortfolio;
}

const fillEvent = (
  accountSequence: string,
  fills: readonly WireFill[] = [{ id: 'fill-1' }],
  overrides: Partial<StreamAccountEvent> = {},
): StreamAccountEvent =>
  Object.freeze({
    eventId: `event-${accountSequence}`,
    accountSequence,
    eventType: 'ORDER_FILLED',
    payload: {
      orderId: 'order-a',
      status: 'FILLED',
      filledQuantity: '10',
      fills: fills.map((fill) => wireFill(fill, accountSequence)),
    },
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

const TICKISH = Object.freeze({
  market: 'KR',
  symbol: '005930',
  price: '1000',
  priceSource: 'rest-snapshot',
  bestBid: null,
  bestAsk: null,
  asOf: new Date(NOW_MS).toISOString(),
  marketDataVersion: '0',
  gapBefore: false,
} as const);

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
    /** Counts every time the processor actually reached for the ledger. */
    readonly portfolioReads?: { count: number };
    /** Phase D: what an unexplainable fill trips. */
    readonly killSwitch?: {
      engage: (...args: unknown[]) => Promise<void>;
    };
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
    portfolio: async () => {
      if (options.portfolioReads !== undefined) {
        options.portfolioReads.count += 1;
      }

      return options.portfolio ?? portfolioWith();
    },
    now: () => NOW_MS,
    ...(options.killSwitch === undefined
      ? {}
      : { killSwitch: options.killSwitch }),
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
      fillEvent('12', [], { eventType: 'ORDER_ACCEPTED', payload: {} }),
    );

    expect(state.fills.cursor).toBe('12');
    expect(state.fills.realizedPnl()).toBe('0');
  });

  /**
   * A fill the runner cannot account for must **stop** it, not be skipped past.
   *
   * The three shapes below are all "this event says a fill happened and the
   * runner cannot say which fill": a record naming a different event than the
   * one carrying it, a record it cannot read, and an event with no records at
   * all. Skipping any of them and committing the event anyway advances the
   * cursor past a fill that then reaches no strategy, ever — and unlike a crash,
   * nothing replays it. That is the "lost fill" half of §11's criterion,
   * arrived at by the runner's own choice rather than by a failure.
   *
   * So they fail closed (AGENTS.md rule 6). The cursor stays put, the stream
   * replays the event on the next connect, and the runner keeps failing loudly
   * until a person fixes the ledger — at which point the replay delivers the
   * fill rather than having lost it. Wedging *is* the desired behaviour here:
   * an event that proves the ledger assembled a payload wrongly is not a state
   * to keep trading through.
   */
  const unaccountable = async (
    what: RegExp,
    event: StreamAccountEvent,
  ): Promise<void> => {
    const engaged: unknown[][] = [];
    const { processor, state, reporter } = build(scratch(), {
      killSwitch: {
        engage: async (...args) => {
          engaged.push(args);
        },
      },
    });

    await expect(processor.process(event)).rejects.toThrow(DomainError);

    expect(state.fills.cursor).toBeNull();
    expect(state.fills.hasEvent(event.eventId)).toBe(false);
    expect(reporter.lines.join('\n')).toMatch(what);
    // §16.46 closed: the wedge also brings the submission barrier down (phase D).
    expect(engaged).toHaveLength(1);
    expect(engaged[0]?.[0]).toBe('fill-wedge');
    // The reason is the thrown message, not the reported sentence: a fact
    // about the record, for the embed's own line.
    expect(engaged[0]?.[1]).toEqual(expect.stringMatching(/\S/u));
    expect(engaged[0]?.[2]).toStrictEqual({
      accountSequence: event.accountSequence,
      eventType: event.eventType,
    });
  };

  /** The wedge's diagnosis survives a trigger that throws: the original error is what leaves. */
  it('keeps the wedge error even when the kill switch throws', async () => {
    const { processor, state } = build(scratch(), {
      killSwitch: {
        engage: (() => {
          throw new Error('disk gone');
        }) as unknown as (...args: unknown[]) => Promise<void>,
      },
    });

    await expect(
      processor.process(
        fillEvent('12', [{ id: 'fill-1', accountSequence: '11' }]),
      ),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' });
    expect(state.fills.cursor).toBeNull();
  });

  it('processes an ordinary fill without touching the kill switch', async () => {
    const engaged: unknown[] = [];
    const { processor } = build(scratch(), {
      killSwitch: {
        engage: async (...args) => {
          engaged.push(args);
        },
      },
    });

    await processor.process(fillEvent('12'));

    expect(engaged).toStrictEqual([]);
  });

  it('stops on a fill record that names a different account sequence', async () => {
    await unaccountable(
      /named a different account sequence/u,
      fillEvent('12', [{ id: 'fill-1', accountSequence: '11' }]),
    );
  });

  /**
   * And it stops on the *whole* event, not just the bad record. A payload with
   * one unreadable fill beside a good one is a payload the runner cannot trust
   * to be complete, and committing the good half would claim the event was
   * processed.
   */
  it('stops on a malformed fill record, taking the rest of the event with it', async () => {
    await unaccountable(
      /a fill record could not be read/u,
      fillEvent('12', [{ id: 'fill-1', price: 'not-money' }, { id: 'fill-2' }]),
    );
  });

  /**
   * Every `ORDER_FILLED` producer in the paper API carries `fills` — the
   * matching path and the STOP/TAKE_PROFIT trigger path both build it through
   * `fillRecord()` (#43). One without it means something upstream changed
   * shape, and the runner must not carry on believing it saw the whole event.
   */
  it('stops when a fill event carries no fill records at all', async () => {
    await unaccountable(
      /carried no fill records/u,
      fillEvent('12', [], {
        payload: { orderId: 'order-a', filledQuantity: '10' },
      }),
    );
  });

  /**
   * The workaround `#43` removed. Resolving a fill used to cost a portfolio
   * read on every account event; now the event describes itself and the
   * ordinary path touches the network not at all.
   */
  it('reads no portfolio at all on the ordinary path', async () => {
    const reads = { count: 0 };
    const { processor, state } = build(scratch(), { portfolioReads: reads });

    await processor.process(fillEvent('12'));

    expect(state.fills.hasFill('fill-1')).toBe(true);
    expect(reads.count).toBe(0);
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
    await processor.process(
      fillEvent('11', [{ id: 'fill-late' }], { eventId: 'event-late' }),
    );

    expect(seen).toHaveLength(1);
  });

  it('does not deliver a fill a previous event already committed', async () => {
    const seen: FillEvent[] = [];
    const { processor } = build(scratch(), { seen });

    await processor.process(fillEvent('12', [{ id: 'fill-1', quantity: '4' }]));
    // The ledger re-publishing a fill it already announced, beside a new one.
    await processor.process(
      fillEvent(
        '13',
        [
          { id: 'fill-1', quantity: '4' },
          { id: 'fill-2', quantity: '6' },
        ],
        { eventId: 'event-13' },
      ),
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

  /**
   * #88: the replay recomputes the same ids, so a strategy whose `onFill` is
   * not deterministic answers the replayed fill with a decision the log does
   * not hold under that id. Submitting the recorded one would place an order
   * the strategy no longer wants; submitting the new one would meet the
   * ledger's `IDEMPOTENCY_CONFLICT`. Neither is a state to trade through: the
   * runner wedges on the event, as it does for a fill it cannot explain, and
   * the wedge trips the kill switch.
   */
  const replayAfterCrash = (
    answer: () => readonly StrategyDecision[],
    recorded: readonly StrategyDecision[] = [ENTRY],
  ) => {
    const directory = scratch();
    const broker = new RecordingBroker();
    const first = build(directory, { broker });

    for (const [index, decision] of recorded.entries()) {
      first.gateway.record('samsung', decision, TICKISH, {
        decisionId: fillDecisionId('12', 'samsung', index),
      });
    }

    first.state.close();
    stores.length = 0;

    const engaged: unknown[][] = [];
    const second = build(directory, {
      broker,
      answer,
      killSwitch: {
        engage: async (...args) => {
          engaged.push(args);
        },
      },
    });

    return { ...second, broker, engaged };
  };

  const expectDivergenceWedge = async (
    run: ReturnType<typeof replayAfterCrash>,
  ): Promise<void> => {
    await expect(run.processor.process(fillEvent('12'))).rejects.toMatchObject({
      code: 'INVARIANT_VIOLATION',
      message: expect.stringMatching(/onFill diverged on replay/u),
    });

    expect(run.state.fills.cursor).toBeNull();
    expect(run.broker.submitted).toStrictEqual([]);
    expect(run.engaged).toHaveLength(1);
    expect(run.engaged[0]?.[0]).toBe('fill-wedge');
    expect(run.engaged[0]?.[1]).toMatch(/onFill diverged on replay/u);
    expect(run.reporter.lines.join('\n')).toMatch(
      /answered a replayed fill differently/u,
    );
  };

  it('wedges when the replayed onFill wants a different order', async () => {
    const run = replayAfterCrash(() => [
      { ...ENTRY, intent: { ...ENTRY.intent, quantity: '2' } },
    ]);

    await expectDivergenceWedge(run);
    // The recorded decision is untouched: one line, the original intent.
    expect(
      run.state.pendingDecisions().map((each) => each.intent?.quantity),
    ).toStrictEqual(['1']);
  });

  it('wedges when the replayed onFill answers nothing where it had placed', async () => {
    await expectDivergenceWedge(replayAfterCrash(() => []));
  });

  it('wedges when the replayed onFill answers more than it had', async () => {
    await expectDivergenceWedge(replayAfterCrash(() => [ENTRY, ENTRY]));
  });

  it('wedges when a noop replaces a recorded place', async () => {
    await expectDivergenceWedge(
      replayAfterCrash(
        () => [{ kind: 'noop', reason: 'changed my mind' }, ENTRY],
        [ENTRY, ENTRY],
      ),
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

    const closing = build(directory);

    await closing.processor.process(
      fillEvent(
        '2',
        [
          {
            id: 'fill-2',
            side: 'SELL',
            quantity: '10',
            price: '1200',
            fee: '7',
          },
        ],
        { eventId: 'event-2' },
      ),
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
    const reads = { count: 0 };
    const { processor, state, reporter } = build(scratch(), {
      portfolio: portfolioWith({ positionTotal: '5', averageCost: '900' }),
      portfolioReads: reads,
    });

    await processor.process(
      fillEvent('3', [
        { id: 'fill-9', side: 'SELL', quantity: '10', price: '1200', fee: '0' },
      ]),
    );

    // The one path that still needs the ledger, and it reads it once.
    expect(reads.count).toBe(1);

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
