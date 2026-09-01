import { describe, expect, test } from 'vitest';
import type { QuoteSnapshot } from './api-types';
import { applyQuoteFrame, type QuoteFrame } from './quote-frame';

/**
 * The REST snapshot that paints the panel first. It carries the price, the
 * timestamp and the health, and no book at all — see `#quote` in
 * `production-runtime.ts`.
 */
const SNAPSHOT: QuoteSnapshot = {
  market: 'US',
  symbol: 'AAPL',
  price: '316.50',
  asOf: '2026-08-31T14:02:00.000Z',
  health: 'HEALTHY',
  recoveryEpoch: '17',
  marketDataVersion: '87849',
};

const CAPTURED_PAYLOAD = {
  symbol: 'AAPL',
  market: 'US',
  currency: 'USD',
  bids: [{ price: '316.44', volume: '80' }],
  asks: [{ price: '316.65', volume: '40' }],
};

/** A quote frame captured off the live socket, verbatim. */
const CAPTURED: QuoteFrame = {
  market: 'US',
  symbol: 'AAPL',
  recoveryEpoch: '17',
  marketDataVersion: '87850',
  payload: CAPTURED_PAYLOAD,
};

const frame = (payload: unknown): QuoteFrame => ({ ...CAPTURED, payload });

describe('applyQuoteFrame on the captured wire frame', () => {
  test('adopts the book without inventing or dropping the price', () => {
    const next = applyQuoteFrame(SNAPSHOT, CAPTURED);

    expect(next).toEqual({
      market: 'US',
      symbol: 'AAPL',
      // A book frame does not restate the price, so the snapshot's stands.
      price: '316.50',
      asOf: '2026-08-31T14:02:00.000Z',
      health: 'HEALTHY',
      recoveryEpoch: '17',
      marketDataVersion: '87850',
      // Book-derived, and the panel prices in it, so it must survive the merge.
      currency: 'USD',
      bids: [{ price: '316.44', volume: '80' }],
      asks: [{ price: '316.65', volume: '40' }],
    });
  });

  test('keeps the currency a later bookless frame no longer states', () => {
    const withBook = applyQuoteFrame(SNAPSHOT, CAPTURED);
    const trade = applyQuoteFrame(
      withBook,
      frame({ price: '316.70', asOf: '2026-08-31T14:02:05.000Z' }),
    );

    expect(trade?.currency).toBe('USD');
  });

  test('drops a currency that is not one the product prices in', () => {
    expect(
      applyQuoteFrame(SNAPSHOT, frame({ ...CAPTURED_PAYLOAD, currency: 'JPY' }))
        ?.currency,
    ).toBeUndefined();
  });

  test('takes the version fields from the envelope, not the payload', () => {
    expect(applyQuoteFrame(SNAPSHOT, CAPTURED)?.marketDataVersion).toBe(
      '87850',
    );
  });
});

describe('applyQuoteFrame keeps the price the frame states', () => {
  test('replaces price and asOf when the frame carries them', () => {
    const next = applyQuoteFrame(
      SNAPSHOT,
      frame({
        ...(CAPTURED.payload as object),
        price: '317.10',
        asOf: '2026-08-31T14:02:03.000Z',
      }),
    );

    expect(next?.price).toBe('317.10');
    expect(next?.asOf).toBe('2026-08-31T14:02:03.000Z');
  });

  test('honours an explicit null price rather than holding a stale one', () => {
    expect(applyQuoteFrame(SNAPSHOT, frame({ price: null }))?.price).toBeNull();
  });

  test('rejects a numeric price — the API states money as decimal strings', () => {
    expect(applyQuoteFrame(SNAPSHOT, frame({ price: 317.1 }))?.price).toBe(
      '316.50',
    );
  });

  test('takes a health the frame states and ignores an unknown one', () => {
    expect(
      applyQuoteFrame(SNAPSHOT, frame({ health: 'DEGRADED' }))?.health,
    ).toBe('DEGRADED');
    expect(
      applyQuoteFrame(SNAPSHOT, frame({ health: 'ON_FIRE' }))?.health,
    ).toBe('HEALTHY');
  });
});

describe('applyQuoteFrame rejects what it cannot narrow', () => {
  test.each([
    ['a string payload', 'not an object'],
    ['a null payload', null],
    ['an array payload', []],
    ['a numeric payload', 7],
  ])('ignores %s, keeping the last good quote', (_name, payload) => {
    expect(applyQuoteFrame(SNAPSHOT, frame(payload))).toBeNull();
  });

  test('ignores a book-only frame when no snapshot has landed yet', () => {
    // Nothing states the price or the instant, so there is no coherent quote
    // to show — the panel keeps its empty state rather than a half-built one.
    expect(applyQuoteFrame(null, CAPTURED)).toBeNull();
  });

  test('builds a quote with no snapshot when the frame states price and asOf', () => {
    const next = applyQuoteFrame(
      null,
      frame({ price: '317.10', asOf: '2026-08-31T14:02:03.000Z' }),
    );

    expect(next).toMatchObject({
      market: 'US',
      symbol: 'AAPL',
      price: '317.10',
      asOf: '2026-08-31T14:02:03.000Z',
    });
  });

  test('never inherits another instrument’s price', () => {
    const other: QuoteSnapshot = { ...SNAPSHOT, symbol: 'MSFT' };

    expect(applyQuoteFrame(other, CAPTURED)).toBeNull();
  });
});

describe('applyQuoteFrame narrows the book levels', () => {
  test('drops levels that are not a price and volume pair', () => {
    const next = applyQuoteFrame(
      SNAPSHOT,
      frame({
        bids: [
          { price: '316.44', volume: '80' },
          { price: '316.40' },
          { price: '316.30', volume: 90 },
          { volume: '10' },
          null,
          'nonsense',
        ],
        asks: [],
      }),
    );

    expect(next?.bids).toEqual([{ price: '316.44', volume: '80' }]);
    expect(next?.asks).toEqual([]);
  });

  test('keeps only price and volume, discarding extra level fields', () => {
    const next = applyQuoteFrame(
      SNAPSHOT,
      frame({ asks: [{ price: '316.65', volume: '40', queue: '3' }] }),
    );

    expect(next?.asks).toEqual([{ price: '316.65', volume: '40' }]);
  });

  test('leaves the previous book alone when a side is absent', () => {
    const withBook = applyQuoteFrame(SNAPSHOT, CAPTURED);
    const next = applyQuoteFrame(withBook, frame({ price: '317.10' }));

    expect(next?.asks).toEqual([{ price: '316.65', volume: '40' }]);
    expect(next?.bids).toEqual([{ price: '316.44', volume: '80' }]);
  });

  test('ignores a side that is not an array', () => {
    const withBook = applyQuoteFrame(SNAPSHOT, CAPTURED);
    const next = applyQuoteFrame(withBook, frame({ asks: 'gone' }));

    expect(next?.asks).toEqual([{ price: '316.65', volume: '40' }]);
  });
});
