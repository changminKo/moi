/**
 * The executable Broker contract, published as `@skipjack/strategy-sdk/testing`.
 *
 * This is a source module rather than a test file so an implementation outside
 * this package can import and run it. It declares no vendor, server, or browser
 * type, and its signature carries no test-runner type, so R4's declaration
 * surface is unaffected.
 */
import {
  type Currency,
  canonicalDecimal,
  DomainError,
  type OrderSnapshot,
  type OrderStatus,
  type OrderType,
  transitionOrder,
  type WalletSnapshot,
} from '@skipjack/trading-core';
import { beforeEach, expect, it } from 'vitest';
import {
  type Broker,
  type CancelOrderCommand,
  type ExchangeCommand,
  type ExchangeReceipt,
  PLACE_ORDER_PRICE_RULES,
  type PlaceLimitOrderCommand,
  type PlaceMarketOrderCommand,
  type PlaceOcoOrderCommand,
  type PlaceOrderCommand,
  type PlaceStopOrderCommand,
  type PlaceTakeProfitOrderCommand,
  type PortfolioSnapshot,
  readCancelOrderCommand,
  readExchangeCommand,
  readPlaceOrderCommand,
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

/**
 * One fixture per member of the published `PlaceOrderCommand` union, each typed
 * as *its own* member interface rather than as the union, so a field added to
 * `PlaceOrderCommandBase` is a compile error in all five until every one of them
 * supplies it — which is what ties the exhaustiveness below to the command
 * shapes rather than to a list someone remembered to extend.
 */
const marketBuy = (idempotencyKey: string): PlaceMarketOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'MARKET',
  quantity: '3',
});

const limitBuy = (idempotencyKey: string): PlaceLimitOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'LIMIT',
  quantity: '2',
  limitPrice: '190.25',
});

const stopBuy = (idempotencyKey: string): PlaceStopOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'STOP',
  quantity: '1',
  triggerPrice: '188.00',
});

const takeProfitSell = (
  idempotencyKey: string,
): PlaceTakeProfitOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'SELL',
  type: 'TAKE_PROFIT',
  quantity: '1',
  triggerPrice: '210.00',
});

/**
 * `OCO` is the one place shape that *supplies* every caller field the place
 * boundary reads: both prices as well as the seven required fields. The other
 * four leave one or both prices absent, which the boundary still reads — so all
 * five are driven over the same nine fields, and on those four the optional
 * prices drift from absent to supplied.
 */
const ocoBuy = (idempotencyKey: string): PlaceOcoOrderCommand => ({
  sessionId: CONTRACT_SESSION_ID,
  idempotencyKey,
  market: 'US',
  symbol: 'AAPL',
  side: 'BUY',
  type: 'OCO',
  quantity: '2',
  limitPrice: '190.25',
  triggerPrice: '180.00',
});

const cancelOpenOrder = (
  sessionId: string,
  orderId: string,
  idempotencyKey: string,
): CancelOrderCommand => ({ sessionId, idempotencyKey, orderId });

const exchangeQuote = (
  sessionId: string,
  quoteId: string,
  idempotencyKey: string,
): ExchangeCommand => ({ sessionId, idempotencyKey, quoteId });

/**
 * Every caller-supplied field of a command shape, *discovered* rather than
 * listed: the published reader for the shape is driven with a recording `Proxy`
 * over a valid command, and the fields it reads are the fields a caller can
 * supply. A field added to a command shape and read at the boundary is therefore
 * bound by the read-count properties below with no fixture to update.
 *
 * The coverage assertion is the other half, and it is a tripwire rather than a
 * free extension: it compares this discovered set against the shape's own keys,
 * so a newly read field *fails* that assertion until the fixture supplies it. A
 * new required field cannot be missed either way, because the fixtures are typed
 * as the published command interfaces and `tsc` refuses them first.
 */
const discoverCommandFields = (
  read: (command: unknown) => unknown,
  base: object,
): readonly string[] => {
  const fields: string[] = [];
  const probe = new Proxy({ ...base } as Record<string, unknown>, {
    get: (target, key, receiver) => {
      if (typeof key === 'string' && !fields.includes(key)) {
        fields.push(key);
      }

      return Reflect.get(target, key, receiver);
    },
  });

  read(probe);

  return fields;
};

interface DriftingCommand {
  readonly command: unknown;
  /** How many times each field has been read so far. */
  readonly reads: () => Readonly<Record<string, number>>;
}

/**
 * A command whose every field is a prototype accessor answering with the base
 * value once and with something else from the second read onwards. The drifted
 * value is derived from the first one rather than chosen per field, because what
 * these properties assert is the *number* of reads: any second read is already a
 * divergence between the command the rules were applied to and the command an
 * effect was built from, whether or not that particular field's drift happens to
 * be observable through the four `Broker` methods.
 *
 * The accessors sit on the prototype because an own `get` is flattened by a
 * spread, which would hide the very extra read this is looking for. A field the
 * base does not carry drifts from *absent* to supplied, which is the sharp case
 * for an optional price and is exercised by four of the five place shapes: a
 * `MARKET` order that validated carrying no price at all must not reach the wire
 * carrying one, and a `STOP` must not gain a `limitPrice` the rules refused.
 *
 * What is counted is a property *read*. A presence probe — `Object.hasOwn`, or
 * `in` — reaches a descriptor rather than the accessor, so it is not counted and
 * an implementation that probes twice is not failed. That is deliberate: the
 * property binds the values that reach an effect, and probing presence is a
 * legitimate thing for a boundary to do (this package's own `readOptionalField`
 * does it). The unbound residue is an implementation whose *second* presence
 * probe answers differently from its first, which needs a `Proxy` trap rather
 * than an accessor.
 */
const driftEveryField = (
  fields: readonly string[],
  base: Readonly<Record<string, unknown>>,
): DriftingCommand => {
  const counts = new Map<string, number>();
  const prototype: Record<string, unknown> = {};

  for (const field of fields) {
    const first = base[field];
    const drifted = `${String(first)}-drifted`;

    Object.defineProperty(prototype, field, {
      enumerable: true,
      get: () => {
        const seen = counts.get(field) ?? 0;
        counts.set(field, seen + 1);

        return seen === 0 ? first : drifted;
      },
    });
  }

  return {
    command: Object.create(prototype),
    reads: () =>
      Object.fromEntries(
        fields.map((field) => [field, counts.get(field) ?? 0]),
      ),
  };
};

/**
 * One entry per `Broker` method that takes a command object. `getPortfolio`
 * takes a `string`, so it has no field a caller can make drift and no entry
 * here; every other method does, and the `Record` is keyed by the method union
 * so adding a method to `Broker` fails this build until it is covered.
 */
type CommandMethod = Exclude<keyof Broker, 'getPortfolio'>;

interface CommandShape {
  /**
   * How the property names the command this shape drives. A method whose
   * command type is not a union has one shape and names it plainly, so its
   * property keeps the name it already had.
   */
  readonly label: string;
  /** This shape's fields, discovered from the method's published reader. */
  readonly fields: () => readonly string[];
  /** The first read of every field. */
  readonly base: (harness: BrokerContractHarness) => Record<string, unknown>;
  /**
   * Drives the method and asserts the effect the *first* read earns, so the
   * read counts below are counts from a call that also behaved correctly.
   */
  readonly act: (
    broker: Broker,
    command: unknown,
    harness: BrokerContractHarness,
  ) => Promise<void>;
}

interface CommandBoundary {
  /**
   * Every shape a caller can send to this method, each driven separately. A
   * single shape binds a field only where that shape reaches it: a second read
   * behind `if (command.type === 'STOP')` is invisible to a suite that only ever
   * drives an `OCO`, even though the read counts on `OCO` are perfect.
   */
  readonly shapes: readonly CommandShape[];
  /** The keys the widest shape of this command declares. */
  readonly declaredFields: () => readonly string[];
}

/**
 * The place shapes, with the status each one's *first* read earns: a `MARKET`
 * order fills on arrival, so it is terminal and gone from `activeOrders`, while
 * every other type rests `OPEN`. Every second read is invalid whichever shape it
 * lands on — a drifted `type` is not an order type at all, a drifted `sessionId`
 * names another account, and a drifted price is forbidden on the types that
 * carry none — so an implementation that re-reads is refused rather than merely
 * wrong.
 */
const PLACE_SHAPES: readonly {
  readonly type: OrderType;
  readonly command: (idempotencyKey: string) => PlaceOrderCommand;
  readonly settledStatus: OrderStatus;
}[] = [
  { type: 'MARKET', command: marketBuy, settledStatus: 'FILLED' },
  { type: 'LIMIT', command: limitBuy, settledStatus: 'OPEN' },
  { type: 'STOP', command: stopBuy, settledStatus: 'OPEN' },
  { type: 'TAKE_PROFIT', command: takeProfitSell, settledStatus: 'OPEN' },
  { type: 'OCO', command: ocoBuy, settledStatus: 'OPEN' },
];

const placeShapeBoundary = (
  shape: (typeof PLACE_SHAPES)[number],
): CommandShape => ({
  label: `${shape.type} command`,
  fields: () =>
    discoverCommandFields(
      readPlaceOrderCommand,
      shape.command(`discover-place-${shape.type}`),
    ),
  base: (harness: BrokerContractHarness) => ({
    ...shape.command(`fields-place-${shape.type}`),
    sessionId: harness.sessionId,
  }),
  act: async (
    broker: Broker,
    command: unknown,
    harness: BrokerContractHarness,
  ) => {
    const before = await broker.getPortfolio(harness.sessionId);
    const placed = await broker.placeOrder(command as PlaceOrderCommand);
    const after = await broker.getPortfolio(harness.sessionId);

    expect(placed.status).toBe(shape.settledStatus);

    // A resting order is live exactly once; a filled one is terminal and gone.
    // Either way the placement is a durable effect, which the sequence records —
    // so no shape can satisfy this by quietly doing nothing.
    expect(
      after.activeOrders.filter((order) => order.id === placed.id),
    ).toHaveLength(TERMINAL_STATUSES.has(shape.settledStatus) ? 0 : 1);
    expect(after.accountSequence).not.toBe(before.accountSequence);
  },
});

const COMMAND_BOUNDARIES: Readonly<Record<CommandMethod, CommandBoundary>> = {
  placeOrder: {
    shapes: PLACE_SHAPES.map(placeShapeBoundary),
    declaredFields: () => Object.keys(ocoBuy('declared-place')),
  },
  cancelOrder: {
    shapes: [
      {
        label: 'command',
        fields: () =>
          discoverCommandFields(
            readCancelOrderCommand,
            cancelOpenOrder(
              CONTRACT_SESSION_ID,
              CONTRACT_OPEN_ORDER_ID,
              'discover-cancel',
            ),
          ),
        base: (harness) => ({
          ...cancelOpenOrder(
            harness.sessionId,
            harness.openOrderId,
            'fields-cancel-1',
          ),
        }),
        act: async (broker, command, harness) => {
          const cancelled = await broker.cancelOrder(
            command as CancelOrderCommand,
          );

          // The order that was validated is the order that was cancelled. A
          // second read of `orderId` addresses an order that does not exist —
          // which is the path-traversal shape when the identifier reaches a URL
          // path segment.
          expect(cancelled.id).toBe(harness.openOrderId);
          expect(cancelled.status).toBe('CANCELLED');
        },
      },
    ],
    declaredFields: () =>
      Object.keys(
        cancelOpenOrder(
          CONTRACT_SESSION_ID,
          CONTRACT_OPEN_ORDER_ID,
          'declared-cancel',
        ),
      ),
  },
  exchange: {
    shapes: [
      {
        label: 'command',
        fields: () =>
          discoverCommandFields(
            readExchangeCommand,
            exchangeQuote(
              CONTRACT_SESSION_ID,
              CONTRACT_QUOTE_ID,
              'discover-fx',
            ),
          ),
        base: (harness) => ({
          ...exchangeQuote(
            harness.sessionId,
            harness.exchangeQuoteId,
            'fields-fx-1',
          ),
        }),
        act: async (broker, command, harness) => {
          const receipt = await broker.exchange(command as ExchangeCommand);

          // The quote that was validated is the quote that was consumed.
          expect(receipt.quoteId).toBe(harness.exchangeQuoteId);
          expect(receipt.sessionId).toBe(harness.sessionId);
        },
      },
    ],
    declaredFields: () =>
      Object.keys(
        exchangeQuote(CONTRACT_SESSION_ID, CONTRACT_QUOTE_ID, 'declared-fx'),
      ),
  },
};

/**
 * A `LIMIT` command whose fields are prototype accessors that answer differently
 * from the *second* read onwards. A published command type is an `interface`, so
 * this satisfies it; every implementation must therefore read each field once at
 * its boundary and act on that snapshot, or it applies a rule to one command and
 * an effect to another.
 *
 * Every field drifts on read two, not on read three: the defect this property
 * exists to catch is validate-once-then-build-from-a-second-read, so a fixture
 * that repeats its first value once absorbs that extra read for free and blesses
 * exactly the implementation it is meant to fail. `limitBuy` is this command's
 * first read of every field, which is what makes the replay below a replay.
 *
 * All eight fields drift, and a second read of any one of them is observable
 * through the four `Broker` methods alone: `type` decides `OPEN` against
 * `FILLED`, `sessionId` decides whether the account accepts the command at all,
 * `idempotencyKey` decides which key the effect is stored under, and the
 * remaining five decide what the effect *is* — so replaying `limitBuy` under the
 * same key either returns the same snapshot or proves the stored effect was
 * built from a value the rules never saw.
 *
 * What this fixture cannot show is a second read whose drift never reaches an
 * observable effect — `sessionId` is not on the wire of a `placeOrder`, so an
 * adapter that re-reads it diverges from the validated command without changing
 * any outcome. That is why the read-count properties below exist beside this
 * one: they bind every field of *every* shape of every command by counting the
 * reads themselves — fifty-one (method, shape, field) triples, driven separately
 * in each of the two drivers this package ships. This fixture also cannot show a
 * second read that only one shape reaches: `if (command.type === 'STOP')` in
 * front of a re-read is invisible to a `LIMIT`. One-extra-read mutants for the
 * pairs are recorded in the wave-5 report and the shape-guarded ones in the
 * wave-6 report; each fails in the driver that carries it, and every one fails a
 * read-count property.
 */
const driftingLimitBuy = (idempotencyKey: string): PlaceOrderCommand => {
  const reads = new Map<string, number>();
  const prototype: Record<string, unknown> = {};
  const drift = (field: string, values: readonly string[]): void => {
    Object.defineProperty(prototype, field, {
      enumerable: true,
      get: () => {
        const index = reads.get(field) ?? 0;
        reads.set(field, index + 1);

        return values[Math.min(index, values.length - 1)];
      },
    });
  };

  drift('sessionId', [CONTRACT_SESSION_ID, 'session-drifted']);
  drift('idempotencyKey', [idempotencyKey, `${idempotencyKey}-drifted`]);
  drift('market', ['US', 'KR']);
  drift('symbol', ['AAPL', 'MSFT']);
  drift('side', ['BUY', 'SELL']);
  drift('quantity', ['2', '9']);
  drift('limitPrice', ['190.25', '1e-8']);
  drift('type', ['LIMIT', 'MARKET']);

  return Object.create(prototype) as PlaceOrderCommand;
};

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
    // A LIMIT order stays OPEN, so it appears in `activeOrders` and a second
    // effect shows up as a second entry. A MARKET order fills immediately and
    // would leave that assertion trivially satisfied in both directions.
    const command = limitBuy('replay-key-1');

    const before = await broker.getPortfolio(harness.sessionId);
    const first = await broker.placeOrder(command);
    const afterFirst = await broker.getPortfolio(harness.sessionId);

    const second = await broker.placeOrder(command);
    const afterSecond = await broker.getPortfolio(harness.sessionId);

    expect(second).toStrictEqual(first);
    expect(afterSecond.accountSequence).toBe(afterFirst.accountSequence);
    expect(afterSecond.wallets).toStrictEqual(afterFirst.wallets);

    // The placed order is observable, and it is there exactly once.
    const placed = afterFirst.activeOrders.filter(
      (order) => order.id === first.id,
    );
    expect(placed).toHaveLength(1);
    expect(before.activeOrders).not.toContainEqual(placed[0]);
    expect(
      afterSecond.activeOrders.filter((order) => order.id === first.id),
    ).toHaveLength(1);
    expect(afterSecond.activeOrders).toStrictEqual(afterFirst.activeOrders);
  });

  // Snapshot-at-the-boundary, as a contract property rather than an
  // implementation detail: a command's fields may be accessors, so an
  // implementation that re-reads them validates one order and places another.
  it('acts on the command it validated rather than re-reading it', async () => {
    const placed = await broker.placeOrder(driftingLimitBuy('drift-key-1'));
    const after = await broker.getPortfolio(harness.sessionId);

    // A LIMIT order stays OPEN; the second read says MARKET, which fills. A
    // second read of `sessionId` names an account that is not this one, so an
    // implementation that re-reads it is refused rather than merely wrong.
    expect(placed.status).toBe('OPEN');
    expect(
      after.activeOrders.filter((order) => order.id === placed.id),
    ).toHaveLength(1);

    // The key the effect is stored under has to be the key that was validated.
    // `limitBuy` is the drifting command's first read of every field, so for an
    // implementation that acts on its snapshot this is a replay: same snapshot
    // back, no second effect. An implementation that stored the effect under a
    // second read of `idempotencyKey` has nothing under this key and places
    // another order instead.
    const replayed = await broker.placeOrder(limitBuy('drift-key-1'));
    const afterReplay = await broker.getPortfolio(harness.sessionId);

    expect(replayed).toStrictEqual(placed);
    expect(afterReplay.accountSequence).toBe(after.accountSequence);
    expect(afterReplay.activeOrders).toStrictEqual(after.activeOrders);
  });

  // Exhaustiveness, mechanically. The property above proves the *harm* of a
  // second read on one command shape; these prove the *discipline* on every
  // method that takes a command, every shape that command has, and every field
  // a caller can supply — with the shape list keyed off the published union and
  // the field set discovered from each published reader rather than listed.
  // Per-shape rather than per-method because a read behind a `type` guard is
  // reached by one shape only: an implementation whose counts are perfect on an
  // `OCO` can still re-read a `STOP`'s trigger price.
  for (const [method, boundary] of Object.entries(COMMAND_BOUNDARIES)) {
    for (const shape of boundary.shapes) {
      it(`${method} reads every field of its ${shape.label} exactly once`, async () => {
        const fields = shape.fields();
        const drifting = driftEveryField(fields, shape.base(harness));

        await shape.act(broker, drifting.command, harness);

        // Exactly once, not at most once: a field that is never read was never
        // validated, and a field read twice was validated as one value and acted
        // on as another. One read per field is the only count that is both.
        expect(drifting.reads()).toStrictEqual(
          Object.fromEntries(fields.map((field) => [field, 1])),
        );
      });
    }
  }

  it('covers every caller-supplied field of every command shape', () => {
    // Two independent derivations of the same set: the left side is what the
    // published reader actually reads when driven with that shape, the right
    // side is what the command type declares. A field added to a shape but not
    // read at the boundary, or read at the boundary but absent from the shape,
    // fails here.
    for (const boundary of Object.values(COMMAND_BOUNDARIES)) {
      const declared = [...boundary.declaredFields()].sort();

      for (const shape of boundary.shapes) {
        expect([...shape.fields()].sort()).toStrictEqual(declared);
      }
    }

    // The place shapes are keyed off the runtime mirror of the published union
    // rather than listed, so an `OrderType` added in trading-core fails here
    // until a shape is driven for it — the same tie-in that makes a new `Broker`
    // method a compile error and a new command field a compile error.
    expect(PLACE_SHAPES.map((shape) => shape.type).sort()).toStrictEqual(
      Object.keys(PLACE_ORDER_PRICE_RULES).sort(),
    );

    for (const shape of PLACE_SHAPES) {
      expect(shape.command('shape-check').type).toBe(shape.type);
    }

    // And the count of (method, shape, field) triples the loop above covers,
    // both sides derived: what every shape's reader read, against shapes-the-
    // type-has x fields-the-shape-declares. Neither side can collapse to zero
    // without the assertions above failing first, so a new shape or a new field
    // is covered by construction rather than by remembering to bump a literal.
    const triples = Object.values(COMMAND_BOUNDARIES).reduce(
      (total, boundary) =>
        total +
        boundary.shapes.reduce((sum, shape) => sum + shape.fields().length, 0),
      0,
    );
    expect(triples).toBe(
      Object.values(COMMAND_BOUNDARIES).reduce(
        (total, boundary) =>
          total + boundary.shapes.length * boundary.declaredFields().length,
        0,
      ),
    );
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
    place(input) {
      // The snapshot the rules were applied to. Re-reading `input` would let a
      // command validate as one order and take effect as another.
      const command = readPlaceOrderCommand(input);

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

    cancel(input) {
      const command = readCancelOrderCommand(input);

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

    exchange(input) {
      const command = readExchangeCommand(input);

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
