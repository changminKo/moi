import type { OrderBookSnapshot } from '@skipjack/trading-core';
import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import buildConfig from '../tsconfig.json' with { type: 'json' };
import {
  type MarketDataConformanceHarness,
  runMarketDataConformance,
} from './adapter-conformance.js';
import { FakeMarketData } from './fake-market-data.js';
import { MarketDataError } from './types.js';

const AAPL_BOOK: OrderBookSnapshot = {
  symbol: 'AAPL',
  market: 'US',
  currency: 'USD',
  bids: [{ price: '210.00', volume: '5' }],
  asks: [{ price: '210.20', volume: '4' }],
};

// A fixed clock: the fake stamps `receivedAt` from it, so every assertion below
// reads an exact string instead of "some ISO timestamp".
const fixedClock = (): (() => string) => {
  let tick = 0;
  return () => {
    tick += 1;
    return `2026-08-22T00:00:0${tick}.000Z`;
  };
};

const createFake = (): FakeMarketData =>
  new FakeMarketData({ now: fixedClock() });

// The same suite Task 3 points at a recorded Toss replay: everything it needs
// is a provider-neutral verb, so nothing here knows what a Toss frame is.
const createHarness = async (): Promise<MarketDataConformanceHarness> => {
  const fake = createFake();
  // Seeded on purpose: the fake now *has* a baseline it could replay, so the
  // contract's "a declaration is not a snapshot request" case fails on an
  // implementation that replays one instead of passing vacuously.
  fake.seedOrderBook({
    market: 'US',
    symbol: 'AAPL',
    book: AAPL_BOOK,
    sourceTimestamp: null,
  });
  await fake.connect();

  return {
    stream: fake,
    deliverTrade: (input) => fake.emitTrade(input),
    deliverOrderBook: (input) => fake.emitOrderBook(input),
    deliverOutOfOrder: (inputs) => fake.emitOutOfOrder(inputs),
    dropNext: (count) => fake.dropNext(count),
    deliverTransportClose: (reason) => fake.emitTransportClosed(reason),
    rejectTopics: (topics) => fake.rejectTopics(topics),
    failNextPongs: (count) => fake.failNextPongs(count),
    orderBookFor: () => AAPL_BOOK,
  };
};

describe('FakeMarketData', () => {
  runMarketDataConformance(createHarness);

  it('does not invent provider sequence or initial snapshot', async () => {
    const fake = createFake();
    await fake.connect();
    await fake.declare([{ channel: 'trade', market: 'US', symbols: ['AAPL'] }]);

    expect(fake.receivedEvents()).toEqual([]);

    fake.emitTrade({
      market: 'US',
      symbol: 'AAPL',
      price: '210.10',
      volume: '3',
      sourceTimestamp: null,
    });

    expect(await fake.next()).toMatchObject({ kind: 'trade', symbol: 'AAPL' });
  });

  it('replays a seeded baseline only when initial snapshots are enabled', async () => {
    const withSnapshot = new FakeMarketData({
      now: fixedClock(),
      initialSnapshot: 'ON_DECLARE',
    });
    withSnapshot.seedOrderBook({
      market: 'US',
      symbol: 'AAPL',
      book: AAPL_BOOK,
      sourceTimestamp: null,
    });
    await withSnapshot.connect();
    await withSnapshot.declare([
      { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
    ]);

    expect(await withSnapshot.next()).toMatchObject({
      kind: 'orderBook',
      symbol: 'AAPL',
      book: AAPL_BOOK,
    });
  });

  it('never replays a seeded baseline in the default no-snapshot mode', async () => {
    const fake = createFake();
    fake.seedOrderBook({
      market: 'US',
      symbol: 'AAPL',
      book: AAPL_BOOK,
      sourceTimestamp: null,
    });
    await fake.connect();
    await fake.declare([
      { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
    ]);

    expect(fake.receivedEvents()).toEqual([]);
  });

  it('emits nothing on declare for a symbol that was never seeded', async () => {
    const withSnapshot = new FakeMarketData({
      now: fixedClock(),
      initialSnapshot: 'ON_DECLARE',
    });
    await withSnapshot.connect();
    await withSnapshot.declare([
      { channel: 'orderBook', market: 'US', symbols: ['AAPL'] },
    ]);

    expect(withSnapshot.receivedEvents()).toEqual([]);
  });

  it('refuses to emit before the transport is connected', () => {
    const fake = createFake();

    expect(() =>
      fake.emitTrade({
        market: 'US',
        symbol: 'AAPL',
        price: '210.10',
        volume: '3',
        sourceTimestamp: null,
      }),
    ).toThrow(MarketDataError);
  });

  it('rejects a price that arrived as a number instead of a decimal string', async () => {
    const fake = createFake();
    await fake.connect();

    expect(() =>
      fake.emitTrade({
        market: 'US',
        symbol: 'AAPL',
        // biome-ignore lint/suspicious/noExplicitAny: pins the no-coercion rule
        price: 210.1 as any,
        volume: '3',
        sourceTimestamp: null,
      }),
    ).toThrow(MarketDataError);
  });
});

describe('published surface', () => {
  it('publishes the reusable conformance suite through a subpath export', () => {
    expect(manifest.exports).toMatchObject({
      '.': { default: './dist/index.js' },
      './testing': { default: './dist/testing.js' },
    });
  });

  // The suite drives a test runner, so it stays off the main entry: the paper
  // engine imports `.` at runtime and must never pull vitest in with it.
  it('keeps the test runner out of the main entry', async () => {
    const entry = await import('./index.js');

    expect(Object.keys(entry)).not.toContain('runMarketDataConformance');
    expect(typeof entry.FakeMarketData).toBe('function');
  });

  it('keeps compiled test files out of the build', () => {
    expect(buildConfig.exclude).toContain('src/**/*.test.ts');
  });
});
