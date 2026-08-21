import {
  type Currency,
  canonicalDecimal,
  DomainError,
  type OrderSnapshot,
  type OrderStatus,
  transitionOrder,
  type WalletSnapshot,
} from '@skipjack/trading-core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertPlaceOrderCommand,
  type Broker,
  type CancelOrderCommand,
  type ExchangeCommand,
  type ExchangeReceipt,
  type PlaceOrderCommand,
  type PortfolioSnapshot,
} from './broker.js';

// The suite is driven by more than one implementation, so every fixture is a
// fixed constant: no clock, no randomness, no ambient state.
export const CONTRACT_SESSION_ID = 'session-contract-1';
export const CONTRACT_TERMINAL_ORDER_ID = 'order-terminal';
export const CONTRACT_OPEN_ORDER_ID = 'order-open';
export const CONTRACT_QUOTE_ID = 'quote-krw-usd-1';
export const CONTRACT_INITIAL_KRW = '10000000';
export const CONTRACT_INITIAL_USD = '5000';
export const CONTRACT_EXCHANGE_SOURCE_AMOUNT = '1000000';
export const CONTRACT_EXCHANGE_RATE = '0.00075';
export const CONTRACT_EXCHANGE_TARGET_AMOUNT = '750';
export const CONTRACT_EXCHANGE_EXECUTED_AT = '2026-08-22T00:00:00.000Z';

const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
]);

const subtract = (minuend: string, subtrahend: string): string =>
  canonicalDecimal(minuend, `-${subtrahend}`);

const add = (augend: string, addend: string): string =>
  canonicalDecimal(augend, addend);

const walletFor = (
  snapshot: PortfolioSnapshot,
  currency: Currency,
): WalletSnapshot => {
  const wallet = snapshot.wallets.find(
    (candidate) => candidate.currency === currency,
  );

  if (wallet === undefined) {
    throw new Error(`portfolio snapshot is missing a ${currency} wallet`);
  }

  return wallet;
};

const marketBuy = (idempotencyKey: string): PlaceOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  quantity: '3',
});

const limitBuy = (idempotencyKey: string): PlaceOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'LIMIT',
  quantity: '2',
  limitPrice: '190.25',
});

/**
 * Everything an implementation must expose so the shared suite observes durable
 * effects instead of trusting returned snapshots alone.
 */
export interface BrokerContractHarness {
  readonly broker: Broker;
  readonly sessionId: string;
  /** An order that is already terminal before the suite runs. */
  readonly terminalOrderId: string;
  /** An order that is still cancellable before the suite runs. */
  readonly openOrderId: string;
  /** A quote good for exactly one KRW -> USD conversion. */
  readonly exchangeQuoteId: string;
}

export type BrokerContractFactory = () =>
  | BrokerContractHarness
  | Promise<BrokerContractHarness>;

/**
 * The executable Broker contract. Every implementation must pass it unchanged.
 * The factory has to build a harness over real state transitions; a forwarding
 * mock proves nothing about replay.
 */
export function runBrokerContract(factory: BrokerContractFactory): void {
  let harness: BrokerContractHarness;
  let broker: Broker;

  beforeEach(async () => {
    harness = await factory();
    broker = harness.broker;
  });

  it('replays an identical idempotency key without a second effect', async () => {
    const command = marketBuy('replay-key-1');

    const first = await broker.placeOrder(command);
    const afterFirst = await broker.getPortfolio(harness.sessionId);

    const second = await broker.placeOrder(command);
    const afterSecond = await broker.getPortfolio(harness.sessionId);

    expect(second).toStrictEqual(first);
    expect(afterSecond.accountSequence).toBe(afterFirst.accountSequence);
    expect(afterSecond.activeOrders).toStrictEqual(afterFirst.activeOrders);
    expect(afterSecond.wallets).toStrictEqual(afterFirst.wallets);
  });

  it('rejects a reused idempotency key that carries a different payload', async () => {
    await broker.placeOrder(marketBuy('replay-key-2'));

    await expect(broker.placeOrder(limitBuy('replay-key-2'))).rejects.toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
  });

  it('rejects cancelling an order that is already terminal', async () => {
    const before = await broker.getPortfolio(harness.sessionId);
    const command: CancelOrderCommand = {
      sessionId: harness.sessionId,
      idempotencyKey: 'cancel-terminal-1',
      orderId: harness.terminalOrderId,
    };

    // Task 3 semantics: a terminal order has no CANCELLED transition, so the
    // command is rejected outright. It is not a silent no-op.
    await expect(broker.cancelOrder(command)).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(broker.cancelOrder(command)).rejects.toThrow(
      expect.objectContaining({ code: 'ORDER_STATE_CONFLICT' }),
    );

    const after = await broker.getPortfolio(harness.sessionId);
    expect(after.accountSequence).toBe(before.accountSequence);
    expect(after.activeOrders).toStrictEqual(before.activeOrders);
  });

  it('cancels a cancellable order so the terminal rejection is state-specific', async () => {
    const cancelled = await broker.cancelOrder({
      sessionId: harness.sessionId,
      idempotencyKey: 'cancel-open-1',
      orderId: harness.openOrderId,
    });

    expect(cancelled.id).toBe(harness.openOrderId);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('rejects a market order that carries a limit price', async () => {
    const invalid = {
      ...marketBuy('invalid-market-1'),
      limitPrice: '190.25',
    } as unknown as PlaceOrderCommand;

    await expect(broker.placeOrder(invalid)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_ORDER' }),
    );
  });

  it('rejects a limit order that omits its limit price', async () => {
    const { limitPrice: _limitPrice, ...rest } = limitBuy('invalid-limit-1');
    const invalid = rest as unknown as PlaceOrderCommand;

    await expect(broker.placeOrder(invalid)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_ORDER' }),
    );
  });

  it('keeps portfolio currencies separate', async () => {
    const before = await broker.getPortfolio(harness.sessionId);
    const command: ExchangeCommand = {
      sessionId: harness.sessionId,
      idempotencyKey: 'exchange-key-1',
      quoteId: harness.exchangeQuoteId,
    };

    const receipt = await broker.exchange(command);
    const after = await broker.getPortfolio(harness.sessionId);

    const currencies = after.wallets.map((wallet) => wallet.currency);
    expect(new Set(currencies).size).toBe(currencies.length);
    expect(currencies).toContain(receipt.from);
    expect(currencies).toContain(receipt.to);

    const sourceBefore = walletFor(before, receipt.from);
    const targetBefore = walletFor(before, receipt.to);
    const source = walletFor(after, receipt.from);
    const target = walletFor(after, receipt.to);

    expect(source.total).toBe(
      subtract(sourceBefore.total, receipt.sourceAmount),
    );
    expect(target.total).toBe(add(targetBefore.total, receipt.targetAmount));

    // No cross-currency aggregation: neither balance absorbs the other leg and
    // no wallet holds the naive sum of both currencies.
    expect(source.total).not.toBe(
      add(sourceBefore.total, receipt.targetAmount),
    );
    expect(target.total).not.toBe(
      add(targetBefore.total, receipt.sourceAmount),
    );

    const mergedTotal = add(sourceBefore.total, targetBefore.total);
    for (const wallet of after.wallets) {
      expect(wallet.total).not.toBe(mergedTotal);
    }
  });
}

/**
 * A deterministic in-memory paper account. It is shared by the fake Broker and
 * by the fake PaperBrokerTransport so both drive identical real state, and it
 * defers to the trading-core state machine instead of restating its rules.
 */
export interface PaperAccountFake {
  place(command: PlaceOrderCommand): OrderSnapshot;
  cancel(command: CancelOrderCommand): OrderSnapshot;
  exchange(command: ExchangeCommand): ExchangeReceipt;
  portfolio(sessionId: string): PortfolioSnapshot;
}

type StoredEffect =
  | {
      readonly kind: 'order';
      readonly hash: string;
      readonly order: OrderSnapshot;
    }
  | {
      readonly kind: 'exchange';
      readonly hash: string;
      readonly receipt: ExchangeReceipt;
    };

export function createPaperAccountFake(): PaperAccountFake {
  let wallets: readonly WalletSnapshot[] = [
    {
      currency: 'KRW',
      total: CONTRACT_INITIAL_KRW,
      available: CONTRACT_INITIAL_KRW,
      reserved: '0',
      version: 1n,
    },
    {
      currency: 'USD',
      total: CONTRACT_INITIAL_USD,
      available: CONTRACT_INITIAL_USD,
      reserved: '0',
      version: 1n,
    },
  ];
  const orders = new Map<string, OrderSnapshot>([
    [
      CONTRACT_TERMINAL_ORDER_ID,
      { id: CONTRACT_TERMINAL_ORDER_ID, status: 'FILLED', version: 3n },
    ],
    [
      CONTRACT_OPEN_ORDER_ID,
      { id: CONTRACT_OPEN_ORDER_ID, status: 'OPEN', version: 2n },
    ],
  ]);
  const effects = new Map<string, StoredEffect>();
  let sequence = 0n;
  let placedOrders = 0;
  let quoteConsumed = false;

  const assertSession = (sessionId: string): void => {
    if (sessionId !== CONTRACT_SESSION_ID) {
      throw new DomainError(
        'ACCOUNT_READ_ONLY',
        `session ${sessionId} is not this account`,
      );
    }
  };

  const replay = (
    idempotencyKey: string,
    hash: string,
  ): StoredEffect | undefined => {
    const stored = effects.get(idempotencyKey);

    if (stored === undefined) {
      return undefined;
    }

    if (stored.hash !== hash) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key ${idempotencyKey} was reused with a different request`,
      );
    }

    return stored;
  };

  const walletAt = (currency: Currency): WalletSnapshot => {
    const wallet = wallets.find((candidate) => candidate.currency === currency);

    if (wallet === undefined) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `account has no ${currency} wallet`,
      );
    }

    return wallet;
  };

  return {
    place(command) {
      assertPlaceOrderCommand(command);
      assertSession(command.sessionId);

      const hash = JSON.stringify([
        'place',
        command.market,
        command.symbol,
        command.side,
        command.type,
        command.quantity,
        command.limitPrice ?? null,
        command.triggerPrice ?? null,
      ]);
      const stored = replay(command.idempotencyKey, hash);

      if (stored !== undefined) {
        if (stored.kind !== 'order') {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `idempotency key ${command.idempotencyKey} was reused with a different request`,
          );
        }

        return stored.order;
      }

      placedOrders += 1;
      const received: OrderSnapshot = {
        id: `order-${placedOrders}`,
        status: 'RECEIVED',
        version: 1n,
      };
      const opened = transitionOrder(received, { type: 'OPENED' });
      const order =
        command.type === 'MARKET'
          ? transitionOrder(opened, { type: 'FILLED' })
          : opened;

      orders.set(order.id, order);
      sequence += 1n;
      effects.set(command.idempotencyKey, { kind: 'order', hash, order });

      return order;
    },

    cancel(command) {
      assertSession(command.sessionId);

      const hash = JSON.stringify(['cancel', command.orderId]);
      const stored = replay(command.idempotencyKey, hash);

      if (stored !== undefined) {
        if (stored.kind !== 'order') {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `idempotency key ${command.idempotencyKey} was reused with a different request`,
          );
        }

        return stored.order;
      }

      const order = orders.get(command.orderId);

      if (order === undefined) {
        throw new DomainError(
          'ORDER_STATE_CONFLICT',
          `order ${command.orderId} does not exist`,
        );
      }

      // Throws ORDER_STATE_CONFLICT for terminal orders; that rule lives in
      // trading-core, not here.
      const cancelled = transitionOrder(order, { type: 'CANCELLED' });

      orders.set(cancelled.id, cancelled);
      sequence += 1n;
      effects.set(command.idempotencyKey, {
        kind: 'order',
        hash,
        order: cancelled,
      });

      return cancelled;
    },

    exchange(command) {
      assertSession(command.sessionId);

      const hash = JSON.stringify(['exchange', command.quoteId]);
      const stored = replay(command.idempotencyKey, hash);

      if (stored !== undefined) {
        if (stored.kind !== 'exchange') {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            `idempotency key ${command.idempotencyKey} was reused with a different request`,
          );
        }

        return stored.receipt;
      }

      if (command.quoteId !== CONTRACT_QUOTE_ID) {
        throw new DomainError(
          'INVALID_ORDER',
          `quote ${command.quoteId} does not exist`,
        );
      }

      if (quoteConsumed) {
        throw new DomainError(
          'INVALID_ORDER',
          `quote ${command.quoteId} was already consumed`,
        );
      }

      const source = walletAt('KRW');
      const target = walletAt('USD');

      wallets = [
        {
          ...source,
          total: subtract(source.total, CONTRACT_EXCHANGE_SOURCE_AMOUNT),
          available: subtract(
            source.available,
            CONTRACT_EXCHANGE_SOURCE_AMOUNT,
          ),
          version: source.version + 1n,
        },
        {
          ...target,
          total: add(target.total, CONTRACT_EXCHANGE_TARGET_AMOUNT),
          available: add(target.available, CONTRACT_EXCHANGE_TARGET_AMOUNT),
          version: target.version + 1n,
        },
      ];
      quoteConsumed = true;
      sequence += 1n;

      const receipt: ExchangeReceipt = {
        id: `conversion-${command.idempotencyKey}`,
        quoteId: command.quoteId,
        sessionId: command.sessionId,
        from: 'KRW',
        to: 'USD',
        sourceAmount: CONTRACT_EXCHANGE_SOURCE_AMOUNT,
        rate: CONTRACT_EXCHANGE_RATE,
        fee: '0',
        targetAmount: CONTRACT_EXCHANGE_TARGET_AMOUNT,
        executedAt: CONTRACT_EXCHANGE_EXECUTED_AT,
      };

      effects.set(command.idempotencyKey, { kind: 'exchange', hash, receipt });

      return receipt;
    },

    portfolio(sessionId) {
      assertSession(sessionId);

      return {
        sessionId,
        wallets,
        positions: [],
        activeOrders: [...orders.values()].filter(
          (order) => !TERMINAL_STATUSES.has(order.status),
        ),
        accountSequence: sequence.toString(),
      };
    },
  };
}

/** The in-memory fake Broker: no transport, no serialization, just the rules. */
export function createFakeBroker(account: PaperAccountFake): Broker {
  return {
    placeOrder: async (command) => account.place(command),
    cancelOrder: async (command) => account.cancel(command),
    exchange: async (command) => account.exchange(command),
    getPortfolio: async (sessionId) => account.portfolio(sessionId),
  };
}

describe('broker contract (deterministic in-memory fake)', () => {
  runBrokerContract(() => ({
    broker: createFakeBroker(createPaperAccountFake()),
    sessionId: CONTRACT_SESSION_ID,
    terminalOrderId: CONTRACT_TERMINAL_ORDER_ID,
    openOrderId: CONTRACT_OPEN_ORDER_ID,
    exchangeQuoteId: CONTRACT_QUOTE_ID,
  }));
});

// --- Type-level contract ----------------------------------------------------
// Compile-time assertions: `tsc` fails if any of these stops being an error,
// which is exactly the regression that would let an impossible order through.
// The calls are inert at runtime; only their types matter.
const acceptsPlaceOrderCommand = (
  command: PlaceOrderCommand,
): PlaceOrderCommand => command;

const orderBase = {
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey: 'type-level',
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  quantity: '1',
} as const;

const marketBase = { ...orderBase, type: 'MARKET' } as const;
const limitBase = { ...orderBase, type: 'LIMIT' } as const;
const stopBase = { ...orderBase, type: 'STOP' } as const;
const ocoBase = { ...orderBase, type: 'OCO' } as const;
const prices = { limitPrice: '190.25', triggerPrice: '180.00' } as const;

// @ts-expect-error a MARKET order cannot carry a limit price.
acceptsPlaceOrderCommand({ ...marketBase, limitPrice: '190.25' });

// @ts-expect-error a MARKET order cannot carry a trigger price.
acceptsPlaceOrderCommand({ ...marketBase, triggerPrice: '190.25' });

// @ts-expect-error a LIMIT order must carry a limit price.
acceptsPlaceOrderCommand({ ...limitBase });

// @ts-expect-error a LIMIT order cannot carry a trigger price.
acceptsPlaceOrderCommand({ ...limitBase, ...prices });

// @ts-expect-error a STOP order must carry a trigger price.
acceptsPlaceOrderCommand({ ...stopBase });

// @ts-expect-error an OCO order must carry both prices.
acceptsPlaceOrderCommand({ ...ocoBase });

// Positive controls: the legal shapes must stay legal.
acceptsPlaceOrderCommand(marketBase);
acceptsPlaceOrderCommand({ ...limitBase, limitPrice: '190.25' });
acceptsPlaceOrderCommand({ ...stopBase, triggerPrice: '180.00' });
acceptsPlaceOrderCommand({ ...ocoBase, ...prices });
