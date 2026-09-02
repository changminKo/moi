import type { InstrumentRef } from '@moi/strategy-sdk/strategy';
import { describe, expect, it } from 'vitest';
import { QuoteTicker } from './quote-ticker.js';

const SAMSUNG: InstrumentRef = { market: 'KR', symbol: '005930' };

interface QuoteFields {
  readonly price?: unknown;
  readonly recoveryEpoch?: unknown;
  readonly marketDataVersion?: unknown;
  readonly bids?: unknown;
  readonly asks?: unknown;
  readonly currency?: unknown;
}

function quote(fields: QuoteFields = {}): Record<string, unknown> {
  return {
    market: 'KR',
    symbol: '005930',
    price: '70000',
    asOf: '2026-09-02T00:00:00.000Z',
    health: 'HEALTHY',
    recoveryEpoch: '1',
    marketDataVersion: '10',
    currency: 'KRW',
    bids: [{ price: '69900', volume: '10' }],
    asks: [{ price: '70000', volume: '10' }],
    ...fields,
  };
}

/** A ticker whose clock the test moves by hand. */
const clocks = new WeakMap<QuoteTicker, { ms: number }>();

function ticker(atMs = 1_000, gapAfterMs = 5_000): QuoteTicker {
  const clock = { ms: atMs };
  const instance = new QuoteTicker({ gapAfterMs, now: () => clock.ms });

  clocks.set(instance, clock);

  return instance;
}

function advance(instance: QuoteTicker, ms: number): void {
  (clocks.get(instance) as { ms: number }).ms = ms;
}

describe('deriving a tick from a quote projection', () => {
  it('reports the projection price and says where the projection came from', () => {
    const tick = ticker().observe(SAMSUNG, quote(), 'stream-quote');

    expect(tick).toStrictEqual({
      market: 'KR',
      symbol: '005930',
      price: '70000',
      priceSource: 'stream-quote',
      bestBid: '69900',
      bestAsk: '70000',
      asOf: '1970-01-01T00:00:01.000Z',
      marketDataVersion: '10',
      gapBefore: true,
    });
  });

  /**
   * `asOf` is the runner's receive time and the SDK's contract says so. The
   * payload's own `asOf` is the instant the API projected the quote, which is a
   * different fact.
   */
  it('timestamps a tick with the runner clock, not the payload', () => {
    const tick = ticker(4_242).observe(
      SAMSUNG,
      quote({ price: '1' }),
      'rest-snapshot',
    );

    expect(tick?.asOf).toBe(new Date(4_242).toISOString());
  });

  it('produces nothing from a slot that holds no price', () => {
    expect(
      ticker().observe(SAMSUNG, quote({ price: null }), 'stream-quote'),
    ).toBeNull();
  });

  it('refuses a payload whose counters are not whole numbers', () => {
    expect(() =>
      ticker().observe(
        SAMSUNG,
        quote({ marketDataVersion: 10 }),
        'stream-quote',
      ),
    ).toThrow(/marketDataVersion must be a whole number/u);
  });
});

describe('one observation, one tick', () => {
  it('drops a frame that does not advance the version', () => {
    const instance = ticker();

    expect(instance.observe(SAMSUNG, quote(), 'stream-quote')).not.toBeNull();
    expect(instance.observe(SAMSUNG, quote(), 'stream-quote')).toBeNull();
    expect(
      instance.observe(
        SAMSUNG,
        quote({ marketDataVersion: '9' }),
        'stream-quote',
      ),
    ).toBeNull();
  });

  it('takes a new recovery epoch even when the version went backwards', () => {
    const instance = ticker();

    instance.observe(
      SAMSUNG,
      quote({ marketDataVersion: '900' }),
      'stream-quote',
    );

    const tick = instance.observe(
      SAMSUNG,
      quote({ recoveryEpoch: '2', marketDataVersion: '3' }),
      'stream-quote',
    );

    expect(tick?.marketDataVersion).toBe('3');
    expect(tick?.gapBefore).toBe(true);
  });

  /**
   * The REST baseline and the stream both feed one ticker, so the same
   * observation reaching the runner down both paths is one tick, not two. This
   * is the property that lets the reconnect re-baseline run unconditionally.
   */
  it('does not tick twice when both paths carry the same observation', () => {
    const instance = ticker();

    expect(instance.observe(SAMSUNG, quote(), 'stream-quote')).not.toBeNull();
    expect(instance.observe(SAMSUNG, quote(), 'rest-snapshot')).toBeNull();
  });
});

describe('the book a frame does not restate', () => {
  /**
   * Quote-contract rule 3: `currency`, `bids` and `asks` are omitted, not
   * emptied, when the slot holds no book — so a consumer treats an absent side
   * as unchanged. Blanking it here would hand a strategy `bestAsk: null` on a
   * symbol whose book is perfectly good.
   */
  it('keeps the last book when a frame omits it', () => {
    const instance = ticker();

    instance.observe(SAMSUNG, quote(), 'stream-quote');

    const patch = quote({ marketDataVersion: '11' });

    delete patch.bids;
    delete patch.asks;
    delete patch.currency;

    const tick = instance.observe(SAMSUNG, patch, 'stream-quote');

    expect(tick?.bestBid).toBe('69900');
    expect(tick?.bestAsk).toBe('70000');
  });

  it('replaces the book when a frame does restate it', () => {
    const instance = ticker();

    instance.observe(SAMSUNG, quote(), 'stream-quote');

    const tick = instance.observe(
      SAMSUNG,
      quote({
        marketDataVersion: '11',
        bids: [{ price: '70100', volume: '5' }],
        asks: [],
      }),
      'stream-quote',
    );

    expect(tick?.bestBid).toBe('70100');
    expect(tick?.bestAsk).toBeNull();
  });

  /** A recovery epoch re-derives the market's state; the book before it is gone. */
  it('forgets the book across a recovery epoch', () => {
    const instance = ticker();

    instance.observe(SAMSUNG, quote(), 'stream-quote');

    const patch = quote({ recoveryEpoch: '2', marketDataVersion: '11' });

    delete patch.bids;
    delete patch.asks;

    expect(
      instance.observe(SAMSUNG, patch, 'stream-quote')?.bestBid,
    ).toBeNull();
  });
});

describe('when a gap is declared', () => {
  it('marks the first observation of an instrument', () => {
    expect(ticker().observe(SAMSUNG, quote(), 'stream-quote')?.gapBefore).toBe(
      true,
    );
  });

  it('does not mark a series the runner kept watching', () => {
    const instance = ticker(1_000, 5_000);

    instance.observe(SAMSUNG, quote(), 'stream-quote');
    advance(instance, 3_000);

    expect(
      instance.observe(
        SAMSUNG,
        quote({ marketDataVersion: '11' }),
        'stream-quote',
      )?.gapBefore,
    ).toBe(false);
  });

  it('marks an observation the runner was away too long for', () => {
    const instance = ticker(1_000, 5_000);

    instance.observe(SAMSUNG, quote(), 'stream-quote');
    advance(instance, 10_000);

    expect(
      instance.observe(
        SAMSUNG,
        quote({ marketDataVersion: '11' }),
        'stream-quote',
      )?.gapBefore,
    ).toBe(true);
  });

  /**
   * A quiet market is being watched, not missed. The clock advances on every
   * observation, whether or not the price moved, so an hour of calm does not
   * arrive as a discontinuity.
   */
  it('treats a quiet market as observed', () => {
    const instance = ticker(1_000, 5_000);

    instance.observe(SAMSUNG, quote(), 'stream-quote');

    for (let at = 4_000; at <= 40_000; at += 3_000) {
      advance(instance, at);
      instance.observe(SAMSUNG, quote(), 'stream-quote');
    }

    advance(instance, 42_000);

    expect(
      instance.observe(
        SAMSUNG,
        quote({ marketDataVersion: '11' }),
        'stream-quote',
      )?.gapBefore,
    ).toBe(false);
  });

  it('restores cursors so a restart can tell a short break from a gap', () => {
    const instance = ticker(1_000, 5_000);

    instance.observe(SAMSUNG, quote(), 'stream-quote');

    const saved = instance.cursors();
    const restored = new QuoteTicker({
      gapAfterMs: 5_000,
      now: () => 3_000,
      cursors: saved,
    });

    expect(
      restored.observe(
        SAMSUNG,
        quote({ marketDataVersion: '11' }),
        'stream-quote',
      )?.gapBefore,
    ).toBe(false);
  });
});
