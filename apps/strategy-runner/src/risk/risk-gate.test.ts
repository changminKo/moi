import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { OrderIntent, Tick } from '@moi/strategy-sdk/strategy';
import { afterEach, describe, expect, it } from 'vitest';
import type { RiskLimits } from '../config.js';
import { MarketSessionCache } from '../feed/market-session.js';
import { StateStore } from '../state/state-store.js';
import {
  type FetchLike,
  PaperApiClient,
} from '../transport/paper-api-client.js';
import { notionalOf, RiskGate } from './risk-gate.js';

const NOW_MS = Date.parse('2026-09-02T02:00:00.000Z');

const LIMITS: RiskLimits = {
  symbolAllowList: [{ market: 'KR', symbol: '005930' }],
  maxOrderNotional: '1000000',
  maxDailyNotional: '2000000',
  maxPositionQuantity: '10',
  maxOpenOrders: 3,
  tradingHoursOnly: true,
  maxConsecutiveLosses: 3,
  maxDailyLoss: '1000000',
  maxQuoteAgeMs: 5_000,
};

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

const BUY: OrderIntent = Object.freeze({
  market: 'KR',
  symbol: '005930',
  side: 'BUY',
  type: 'MARKET',
  quantity: '1',
});

const SELL: OrderIntent = Object.freeze({ ...BUY, side: 'SELL' });

const PORTFOLIO: BrokerPortfolio = Object.freeze({
  sessionId: 's-1',
  wallets: [],
  positions: [],
  activeOrders: [],
  accountSequence: '1',
});

const order = (status: string) =>
  ({
    id: `o-${status}`,
    market: 'KR',
    symbol: '005930',
    type: 'LIMIT',
    side: 'BUY',
    quantity: '1',
    filledQuantity: '0',
    status,
    fills: [],
    siblingOrderIds: [],
  }) as unknown as BrokerPortfolio['activeOrders'][number];

const stores: StateStore[] = [];
const directories = new WeakMap<StateStore, string>();

/** The directory a store was opened over, so a test can reopen it. */
const directoryOf = (store: StateStore): string =>
  directories.get(store) as string;

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});

function gateWith(
  options: {
    readonly limits?: Partial<RiskLimits>;
    readonly phase?: string | null;
    readonly nowMs?: number;
  } = {},
) {
  const fetch: FetchLike = async () =>
    options.phase === null
      ? { status: 503, headers: { get: () => null }, text: async () => '' }
      : {
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({ phase: options.phase ?? 'REGULAR' }),
        };
  const api = new PaperApiClient({
    origin: 'http://127.0.0.1:3001',
    credentials: () => null,
    fetch,
  });
  const directory = mkdtempSync(join(tmpdir(), 'moi-risk-'));
  const state = StateStore.open({ directory });

  directories.set(state, directory);
  stores.push(state);

  const now = () => options.nowMs ?? NOW_MS;

  return {
    state,
    gate: new RiskGate({
      limits: { ...LIMITS, ...options.limits },
      sessions: new MarketSessionCache({ api, now }),
      state,
      now,
    }),
  };
}

describe('RiskGate rules that apply to every order', () => {
  it('allows an order inside every limit', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  it('refuses an instrument that is not on the allow-list', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({
        intent: { ...BUY, symbol: '000660' },
        tick: TICK,
        portfolio: PORTFOLIO,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'KR:000660 is not on the symbol allow-list',
    });
  });

  it('refuses an exit for an instrument that is not on the allow-list', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({
        intent: { ...SELL, symbol: '000660' },
        tick: TICK,
        portfolio: PORTFOLIO,
      }),
    ).resolves.toMatchObject({ allowed: false });
  });

  /** §6.3: 장중 한정, from `phase === 'REGULAR'`. */
  it('refuses any order while the market is not in its regular phase', async () => {
    for (const intent of [BUY, SELL]) {
      const { gate } = gateWith({ phase: 'CLOSED' });

      await expect(
        gate.evaluate({ intent, tick: TICK, portfolio: PORTFOLIO }),
      ).resolves.toMatchObject({
        allowed: false,
        reason: 'the KR market is in phase CLOSED, not REGULAR',
      });
    }
  });

  /** An unknown phase is not an open market. */
  it('fails closed when the market phase cannot be determined', async () => {
    const { gate } = gateWith({ phase: null });

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'the KR market phase is unavailable and tradingHoursOnly is set',
    });
  });

  it('does not consult the calendar when tradingHoursOnly is off', async () => {
    const { gate } = gateWith({
      phase: null,
      limits: { tradingHoursOnly: false },
    });

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });
});

describe('RiskGate limits, which cap entries only', () => {
  it('refuses an entry on a stale quote', async () => {
    const { gate } = gateWith({ nowMs: NOW_MS + 6_000 });

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({ allowed: false, reason: /6000ms old/u });
  });

  it('refuses an entry over the per-order notional limit', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({
        intent: { ...BUY, quantity: '15' },
        tick: TICK,
        portfolio: PORTFOLIO,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: /notional 1050000 is over the per-order limit/u,
    });
  });

  it('refuses an entry that would take the day over its notional limit', async () => {
    const { gate, state } = gateWith();

    state.appendDecision({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'place',
      reason: 'golden-cross',
      intent: BUY,
      notional: '1950000',
    });

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: /2020000 would exceed today's notional limit/u,
    });
  });

  /**
   * The daily total comes out of the decision log, so it is the same total after
   * a restart. §1 row 7 is the record of what a memory counter costs.
   */
  it('remembers the day’s notional across a restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'moi-risk-restart-'));
    const first = StateStore.open({ directory });

    first.appendDecision({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'place',
      reason: 'golden-cross',
      intent: BUY,
      notional: '1950000',
    });
    first.close();

    const state = StateStore.open({ directory });

    stores.push(state);

    const gate = new RiskGate({
      limits: LIMITS,
      sessions: new MarketSessionCache({
        api: new PaperApiClient({
          origin: 'http://127.0.0.1:3001',
          credentials: () => null,
          fetch: async () => ({
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ phase: 'REGULAR' }),
          }),
        }),
        now: () => NOW_MS,
      }),
      state,
      now: () => NOW_MS,
    });

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({ allowed: false, reason: /notional limit/u });
  });

  it('refuses an entry at the open-order limit', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({
        intent: BUY,
        tick: TICK,
        portfolio: {
          ...PORTFOLIO,
          activeOrders: [
            order('OPEN'),
            order('PARTIALLY_FILLED'),
            order('RECEIVED'),
          ],
        },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: /3 orders are already open/u,
    });
  });

  /**
   * `activeOrders` carries terminal orders too (#33). Counting them would make
   * the bot stop trading after three orders had ever been placed.
   */
  it('counts only orders the ledger can still act on', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({
        intent: BUY,
        tick: TICK,
        portfolio: {
          ...PORTFOLIO,
          activeOrders: [
            order('CANCELLED'),
            order('FILLED'),
            order('EXPIRED'),
            order('REJECTED'),
            order('OPEN'),
          ],
        },
      }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  it('refuses an entry that would take the position over its limit', async () => {
    const { gate } = gateWith();

    await expect(
      gate.evaluate({
        intent: { ...BUY, quantity: '4' },
        tick: TICK,
        portfolio: {
          ...PORTFOLIO,
          positions: [
            {
              market: 'KR',
              symbol: '005930',
              total: '7',
              available: '7',
              reserved: '0',
              averageCost: '69000',
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: /holding 11 of KR:005930/u,
    });
  });

  /**
   * The symptom the mixed-side sum produced, at the level an operator sees it:
   * enter at the daily limit, close the whole position, and a legitimate
   * re-entry is still refused for the rest of the day — on a budget the round
   * trip never actually spent.
   */
  it('lets a re-entry through after the position was closed the same day', async () => {
    const { gate, state } = gateWith({
      limits: { maxDailyNotional: '150000' },
    });

    state.appendDecision({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'place',
      reason: 'golden-cross',
      intent: BUY,
      notional: '70000',
    });
    state.appendDecision({
      decisionId: 'd-2',
      at: '2026-09-02T01:30:00.000Z',
      strategy: 'samsung',
      kind: 'place',
      reason: 'dead-cross',
      intent: SELL,
      notional: '70000',
    });

    // Entries total 70000, not 140000, so a second 70000 entry fits under the
    // 150000 limit.
    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  it('still refuses once the entries themselves reach the limit', async () => {
    const { gate, state } = gateWith({
      limits: { maxDailyNotional: '150000' },
    });

    for (const [index, at] of [
      '2026-09-02T01:00:00.000Z',
      '2026-09-02T01:30:00.000Z',
    ].entries()) {
      state.appendDecision({
        decisionId: `d-${index}`,
        at,
        strategy: 'samsung',
        kind: 'place',
        reason: 'golden-cross',
        intent: BUY,
        notional: '70000',
      });
    }

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: /210000 would exceed today's notional limit of 150000/u,
    });
  });
});

describe('RiskGate never traps a position', () => {
  const trapped = {
    ...PORTFOLIO,
    activeOrders: [order('OPEN'), order('OPEN'), order('OPEN'), order('OPEN')],
    positions: [
      {
        market: 'KR' as const,
        symbol: '005930',
        total: '99',
        available: '99',
        reserved: '0',
        averageCost: '69000',
      },
    ],
  };

  /**
   * Every limit here would refuse this order if it were an entry: the open-order
   * cap is exceeded, the position is far over its limit, the quote is ancient,
   * and the notional is enormous. It is an exit, so it is allowed — a limit that
   * blocks the closing order does not cap exposure, it traps it.
   */
  it('allows an exit that every entry limit would refuse', async () => {
    const { gate, state } = gateWith({ nowMs: NOW_MS + 3_600_000 });

    state.appendDecision({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'place',
      reason: 'golden-cross',
      intent: BUY,
      notional: '1999999',
    });

    await expect(
      gate.evaluate({
        intent: { ...SELL, quantity: '99' },
        tick: TICK,
        portfolio: trapped,
      }),
    ).resolves.toStrictEqual({ allowed: true });
  });
});

describe('notionalOf', () => {
  it('measures a market order at the tick price', () => {
    expect(notionalOf({ ...BUY, quantity: '3' }, TICK)).toBe('210000');
  });

  it('measures a priced order at its own price, not the tick', () => {
    expect(
      notionalOf(
        { ...BUY, type: 'LIMIT', limitPrice: '69000', quantity: '2' },
        TICK,
      ),
    ).toBe('138000');
    expect(
      notionalOf(
        { ...BUY, type: 'STOP', stopPrice: '71000', quantity: '2' },
        TICK,
      ),
    ).toBe('142000');
  });

  /** AGENTS.md rule 5: exact, never float. 0.1 × 3 is 0.30000000000000004 in JS. */
  it('multiplies exactly', () => {
    expect(
      notionalOf({ ...BUY, quantity: '3' }, { ...TICK, price: '0.1' }),
    ).toBe('0.3');
  });
});

/**
 * §6.4's two limits, now that phase C's cursor makes realised PnL trustworthy.
 * Both read the fill journal, which is to say the same durable records that
 * hold the cursor — so unlike design §1 row 7's memory counter, there is
 * nothing for a restart to reset.
 */
describe('RiskGate loss limits', () => {
  const losing = (
    state: StateStore,
    sequence: number,
    realizedDelta: string,
    at = '2026-09-02T01:00:00.000Z',
  ): void => {
    state.fills.commit({
      accountSequence: String(sequence),
      at,
      eventId: `event-${sequence}`,
      eventType: 'ORDER_FILLED',
      fills: [
        {
          fillId: `f-${sequence}`,
          orderId: `o-${sequence}`,
          market: 'KR',
          symbol: '005930',
          side: 'SELL',
          quantity: '1',
          price: '70000',
          fee: '0',
          realizedDelta,
        },
      ],
      positions: {},
      decisions: [],
    });
  };

  it('allows an entry while the run of losses is short of the limit', async () => {
    const { gate, state } = gateWith({ limits: { maxConsecutiveLosses: 3 } });

    losing(state, 1, '-100');
    losing(state, 2, '-100');

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  it('refuses an entry once enough closing fills have lost in a row', async () => {
    const { gate, state } = gateWith({ limits: { maxConsecutiveLosses: 3 } });

    losing(state, 1, '-100');
    losing(state, 2, '-100');
    losing(state, 3, '-100');

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({
      allowed: false,
      reason: '3 closing fills in a row lost, at the limit of 3',
    });
  });

  it('refuses an entry once the day has realised the daily loss limit', async () => {
    const { gate, state } = gateWith({
      limits: { maxConsecutiveLosses: 100, maxDailyLoss: '500' },
    });

    losing(state, 1, '-300', '2026-09-02T01:00:00.000Z');
    losing(state, 2, '-200', '2026-09-02T01:30:00.000Z');

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'today has realised -500, at the daily loss limit of 500',
    });
  });

  /** Yesterday's loss is yesterday's. The limit is a per-day budget. */
  it('does not count another UTC day towards today', async () => {
    const { gate, state } = gateWith({
      limits: { maxConsecutiveLosses: 100, maxDailyLoss: '500' },
    });

    losing(state, 1, '-900', '2026-09-01T23:00:00.000Z');

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  /**
   * A profitable day is not a day to stop trading. Comparing a signed PnL
   * against a positive limit without checking the sign would refuse every entry
   * as soon as the bot made money.
   */
  it('does not read a profitable day as a loss', async () => {
    const { gate, state } = gateWith({
      limits: { maxConsecutiveLosses: 100, maxDailyLoss: '500' },
    });

    state.fills.commit({
      accountSequence: '1',
      at: '2026-09-02T01:00:00.000Z',
      eventId: 'event-1',
      eventType: 'ORDER_FILLED',
      fills: [
        {
          fillId: 'f-1',
          orderId: 'o-1',
          market: 'KR',
          symbol: '005930',
          side: 'SELL',
          quantity: '1',
          price: '70000',
          fee: '0',
          realizedDelta: '9000',
        },
      ],
      positions: {},
      decisions: [],
    });

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  /**
   * The same reading phase B applied to every other limit: refusing an exit
   * does not cap exposure, it traps it. A bot stopped by a loss limit that
   * could not then close its position would sit in the trade the limit fired
   * over.
   */
  it('still allows the exit that a tripped limit exists to protect', async () => {
    const { gate, state } = gateWith({
      limits: { maxConsecutiveLosses: 1, maxDailyLoss: '1' },
    });

    losing(state, 1, '-9000');

    await expect(
      gate.evaluate({ intent: SELL, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toStrictEqual({ allowed: true });
  });

  it('survives a restart, because it is a fold over a file', async () => {
    const { gate, state } = gateWith({ limits: { maxConsecutiveLosses: 2 } });

    losing(state, 1, '-100');
    losing(state, 2, '-100');

    await expect(
      gate.evaluate({ intent: BUY, tick: TICK, portfolio: PORTFOLIO }),
    ).resolves.toMatchObject({ allowed: false });

    const reopened = StateStore.open({ directory: directoryOf(state) });

    stores.push(reopened);

    expect(reopened.fills.consecutiveLosses()).toBe(2);
  });
});
