/**
 * The executable `MarketDataStream` contract, published as
 * `@skipjack/market-data/testing`.
 *
 * It is a source module rather than a test file so a recorded provider replay
 * outside this package can import and run it. Every fault it needs is a
 * provider-neutral verb on the harness, so the suite never learns what a
 * provider frame looks like, and it drives the adapter only through the port —
 * `events()`, not an inspection hook — so anything it proves is a property of
 * the published surface.
 */
import type { Market, OrderBookSnapshot } from '@skipjack/trading-core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { MarketDataStream } from './ports.js';
import {
  MARKET_EVENT_FIELDS,
  type MarketEvent,
  type SubscriptionDeclaration,
  subscriptionTopicKey,
} from './types.js';

export const CONFORMANCE_MARKET: Market = 'US';
export const CONFORMANCE_SYMBOL = 'AAPL';
export const CONFORMANCE_TRADE_TOPIC = subscriptionTopicKey(
  'trade',
  CONFORMANCE_MARKET,
  CONFORMANCE_SYMBOL,
);
export const CONFORMANCE_ORDER_BOOK_TOPIC = subscriptionTopicKey(
  'orderBook',
  CONFORMANCE_MARKET,
  CONFORMANCE_SYMBOL,
);

const DECLARATION: readonly SubscriptionDeclaration[] = [
  {
    channel: 'trade',
    market: CONFORMANCE_MARKET,
    symbols: [CONFORMANCE_SYMBOL],
  },
  {
    channel: 'orderBook',
    market: CONFORMANCE_MARKET,
    symbols: [CONFORMANCE_SYMBOL],
  },
];

export interface ConformanceTradeInput {
  readonly market: Market;
  readonly symbol: string;
  readonly price: string;
  readonly volume: string;
  readonly sourceTimestamp: string | null;
}

export interface ConformanceOrderBookInput {
  readonly market: Market;
  readonly symbol: string;
  readonly book: OrderBookSnapshot;
  readonly sourceTimestamp: string | null;
}

/**
 * The scripting surface an implementation supplies. For the fake these are
 * direct calls; for a recorded replay they push recorded frames.
 */
export interface MarketDataConformanceHarness {
  readonly stream: MarketDataStream;
  deliverTrade(input: ConformanceTradeInput): void | Promise<void>;
  deliverOrderBook(input: ConformanceOrderBookInput): void | Promise<void>;
  /** Delivers trades in the given arrival order, whatever their timestamps. */
  deliverOutOfOrder(
    inputs: readonly ConformanceTradeInput[],
  ): void | Promise<void>;
  /** Discards the next `count` data messages without any notice. */
  dropNext(count: number): void | Promise<void>;
  deliverTransportClose(reason: string): void | Promise<void>;
  /** Rejects these exact topic keys on the next declaration. */
  rejectTopics(topics: readonly string[]): void | Promise<void>;
  failNextPongs(count: number): void | Promise<void>;
  /** A book this implementation can actually deliver for the symbol. */
  orderBookFor(market: Market, symbol: string): OrderBookSnapshot;
  dispose?(): void | Promise<void>;
}

export type MarketDataConformanceFactory = () =>
  | MarketDataConformanceHarness
  | Promise<MarketDataConformanceHarness>;

const tradeAt = (
  price: string,
  sourceTimestamp: string | null,
): ConformanceTradeInput => ({
  market: CONFORMANCE_MARKET,
  symbol: CONFORMANCE_SYMBOL,
  price,
  volume: '1',
  sourceTimestamp,
});

export interface MarketDataConformanceOptions {
  /**
   * Whether the provider contract lets a trade omit its source timestamp.
   * When false (e.g. Toss requires `timestamp`), the suite asserts that a
   * timestamp-less trade is refused without an event instead of normalized.
   */
  readonly nullableTradeTimestamp?: boolean;
}

export function runMarketDataConformance(
  factory: MarketDataConformanceFactory,
  options: MarketDataConformanceOptions = {},
): void {
  const nullableTradeTimestamp = options.nullableTradeTimestamp ?? true;
  let harness: MarketDataConformanceHarness;
  let controller: AbortController;
  let events: AsyncIterator<MarketEvent>;

  const nextEvent = async (): Promise<MarketEvent> => {
    const result = await events.next();

    if (result.done === true) {
      throw new Error('the event stream ended before the expected event');
    }

    return result.value;
  };

  beforeEach(async () => {
    harness = await factory();
    controller = new AbortController();
    events = harness.stream
      .events(controller.signal)
      [Symbol.asyncIterator]() as AsyncIterator<MarketEvent>;
  });

  afterEach(async () => {
    controller.abort();
    await harness.dispose?.();
  });

  it('acknowledges exactly the declared topic keys', async () => {
    const ack = await harness.stream.declare(DECLARATION);

    expect([...ack.accepted].sort()).toStrictEqual(
      [CONFORMANCE_ORDER_BOOK_TOPIC, CONFORMANCE_TRADE_TOPIC].sort(),
    );
    expect(ack.rejected).toStrictEqual([]);
  });

  // A declaration is not a snapshot request. If an implementation synthesized a
  // baseline, the first event would be an order book rather than this trade.
  it('emits no event for a declaration alone', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.deliverTrade(tradeAt('210.10', null));

    expect(await nextEvent()).toMatchObject({
      kind: 'trade',
      market: CONFORMANCE_MARKET,
      symbol: CONFORMANCE_SYMBOL,
      price: '210.10',
    });
  });

  it('normalizes a trade into the published field set and nothing more', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.deliverTrade(tradeAt('210.10', '2026-08-22T00:00:00.000Z'));

    const event = await nextEvent();

    expect(Object.keys(event).sort()).toStrictEqual(
      [...MARKET_EVENT_FIELDS.trade].sort(),
    );
    expect(event).toMatchObject({
      sourceTimestamp: '2026-08-22T00:00:00.000Z',
    });
    expect(typeof event.receivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(event.receivedAt))).toBe(false);
  });

  it('keeps a missing source timestamp null instead of substituting one', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.deliverTrade(tradeAt('210.10', null));

    if (!nullableTradeTimestamp) {
      // The contract requires a trade timestamp, so the harness had to supply
      // one; the adapter must still not manufacture a null of its own.
      const supplied = await nextEvent();
      expect(supplied).toMatchObject({ kind: 'trade', price: '210.10' });
      expect(
        supplied.kind === 'trade' && supplied.sourceTimestamp,
      ).not.toBeNull();
      return;
    }

    const event = await nextEvent();

    expect(event).toMatchObject({ kind: 'trade', sourceTimestamp: null });
    expect(event.receivedAt).not.toBe(null);
  });

  it('normalizes an order book into the published field set and nothing more', async () => {
    await harness.stream.declare(DECLARATION);
    const book = harness.orderBookFor(CONFORMANCE_MARKET, CONFORMANCE_SYMBOL);
    await harness.deliverOrderBook({
      market: CONFORMANCE_MARKET,
      symbol: CONFORMANCE_SYMBOL,
      book,
      sourceTimestamp: null,
    });

    const event = await nextEvent();

    expect(Object.keys(event).sort()).toStrictEqual(
      [...MARKET_EVENT_FIELDS.orderBook].sort(),
    );
    expect(event).toMatchObject({ kind: 'orderBook', book });
  });

  // The feed is LOSSY. A dropped message must read as absence: the next event
  // is the next *observed* one, never a reconstruction of the missing print.
  it('surfaces a dropped message as absence rather than a synthesized event', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.dropNext(1);
    await harness.deliverTrade(tradeAt('89.00', null));
    await harness.deliverTrade(tradeAt('101.00', null));

    expect(await nextEvent()).toMatchObject({
      kind: 'trade',
      price: '101.00',
    });
  });

  it('preserves arrival order for out-of-order source timestamps', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.deliverOutOfOrder([
      tradeAt('102.00', '2026-08-22T00:00:02.000Z'),
      tradeAt('101.00', '2026-08-22T00:00:01.000Z'),
    ]);

    expect(await nextEvent()).toMatchObject({ price: '102.00' });
    expect(await nextEvent()).toMatchObject({ price: '101.00' });
  });

  it('reports a rejected subscription with its exact topic key', async () => {
    await harness.rejectTopics([CONFORMANCE_ORDER_BOOK_TOPIC]);

    const ack = await harness.stream.declare(DECLARATION);

    expect(ack.accepted).toStrictEqual([CONFORMANCE_TRADE_TOPIC]);
    expect(ack.rejected).toStrictEqual([
      { topic: CONFORMANCE_ORDER_BOOK_TOPIC, reason: expect.any(String) },
    ]);
  });

  it('rejects a ping the transport never answers, then recovers', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.failNextPongs(1);

    await expect(harness.stream.ping()).rejects.toThrow();
    await expect(harness.stream.ping()).resolves.toEqual(expect.any(Number));
  });

  it('ends the stream with a transportClosed event', async () => {
    await harness.stream.declare(DECLARATION);
    await harness.deliverTransportClose('server shutdown');

    const event = await nextEvent();

    expect(Object.keys(event).sort()).toStrictEqual(
      [...MARKET_EVENT_FIELDS.transportClosed].sort(),
    );
    expect(event).toMatchObject({
      kind: 'transportClosed',
      market: CONFORMANCE_MARKET,
      reason: 'server shutdown',
    });
    expect(await events.next()).toMatchObject({ done: true });
  });
}
