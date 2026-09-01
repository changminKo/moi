import type { InstrumentRef } from '@moi/strategy-sdk/strategy';
import { describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import {
  type FetchLike,
  PaperApiClient,
} from '../transport/paper-api-client.js';
import { type FeedCursors, RestQuoteFeed } from './rest-quote-feed.js';

const SAMSUNG = { market: 'KR', symbol: '005930' } as const;
const HYNIX = { market: 'KR', symbol: '000660' } as const;

interface Quote {
  readonly price?: string | null;
  readonly recoveryEpoch?: string;
  readonly marketDataVersion?: string;
  readonly bids?: readonly { price: string; volume: string }[];
  readonly asks?: readonly { price: string; volume: string }[];
  readonly status?: number;
}

/** A quote endpoint whose answer per symbol is taken from a queue. */
function quotes(byPath: Readonly<Record<string, readonly Quote[]>>): {
  readonly fetch: FetchLike;
  readonly paths: string[];
} {
  // Advanced by index over the caller's own array rather than by shifting a
  // copy, so a test can replace the answer mid-run and the last entry repeats
  // for every further poll.
  const cursors = new Map<string, number>();
  const paths: string[] = [];

  return {
    paths,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      const symbol = path.split('/')[6] ?? '';

      paths.push(path);

      const list = byPath[symbol] ?? [];
      const at = cursors.get(symbol) ?? 0;
      const quote = list[Math.min(at, list.length - 1)];

      cursors.set(symbol, at + 1);

      if (quote === undefined) {
        throw new Error(`no stubbed quote for ${symbol}`);
      }

      return {
        status: quote.status ?? 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            market: 'KR',
            symbol,
            price: quote.price ?? null,
            asOf: '2026-09-02T00:00:00.000Z',
            health: 'HEALTHY',
            recoveryEpoch: quote.recoveryEpoch ?? '1',
            marketDataVersion: quote.marketDataVersion ?? '1',
            ...(quote.bids === undefined ? {} : { bids: quote.bids }),
            ...(quote.asks === undefined ? {} : { asks: quote.asks }),
          }),
      };
    },
  };
}

function feedOver(
  byPath: Readonly<Record<string, readonly Quote[]>>,
  options: {
    readonly instruments?: readonly InstrumentRef[];
    readonly gapAfterMs?: number;
    readonly cursors?: FeedCursors;
    readonly clock?: () => number;
  } = {},
) {
  const stub = quotes(byPath);
  const reporter = createRecordingReporter();
  const feed = new RestQuoteFeed({
    api: new PaperApiClient({
      origin: 'http://127.0.0.1:3001',
      credentials: () => null,
      fetch: stub.fetch,
    }),
    instruments: options.instruments ?? [SAMSUNG],
    gapAfterMs: options.gapAfterMs ?? 5_000,
    reporter,
    now: options.clock ?? (() => 1_000_000),
    ...(options.cursors === undefined ? {} : { cursors: options.cursors }),
  });

  return { feed, paths: stub.paths, reporter };
}

describe('RestQuoteFeed tick derivation', () => {
  it('reports the projection price as a rest-snapshot tick', async () => {
    const { feed } = feedOver({
      '005930': [
        {
          price: '70000',
          marketDataVersion: '12',
          bids: [{ price: '69900', volume: '10' }],
          asks: [{ price: '70100', volume: '10' }],
        },
      ],
    });

    await expect(feed.poll()).resolves.toStrictEqual([
      {
        market: 'KR',
        symbol: '005930',
        price: '70000',
        priceSource: 'rest-snapshot',
        bestBid: '69900',
        bestAsk: '70100',
        asOf: '1970-01-01T00:16:40.000Z',
        marketDataVersion: '12',
        gapBefore: true,
      },
    ]);
  });

  /**
   * The runner does not compute a mid-price in phase B. `projectQuote` has
   * already decided what the instrument costs, and deriving a second answer from
   * the book in the same payload would make the runner and the API disagree.
   */
  it('never reports a book-mid price', async () => {
    const { feed } = feedOver({
      '005930': [
        {
          price: '70000',
          bids: [{ price: '69900', volume: '1' }],
          asks: [{ price: '70100', volume: '1' }],
        },
      ],
    });

    const [tick] = await feed.poll();

    expect(tick?.priceSource).toBe('rest-snapshot');
    expect(tick?.price).toBe('70000');
  });

  it('reports no book touch when the payload carries no book', async () => {
    const { feed } = feedOver({ '005930': [{ price: '70000' }] });
    const [tick] = await feed.poll();

    expect(tick).toMatchObject({ bestBid: null, bestAsk: null });
  });

  it('produces no tick for a symbol whose slot holds no price yet', async () => {
    const { feed } = feedOver({ '005930': [{ price: null }] });

    await expect(feed.poll()).resolves.toStrictEqual([]);
  });

  it('polls each configured instrument once per pass', async () => {
    const { feed, paths } = feedOver(
      { '005930': [{ price: '70000' }], '000660': [{ price: '150000' }] },
      { instruments: [SAMSUNG, HYNIX] },
    );

    await expect(feed.poll()).resolves.toHaveLength(2);
    expect(paths).toStrictEqual([
      '/api/v1/markets/KR/symbols/005930/quote',
      '/api/v1/markets/KR/symbols/000660/quote',
    ]);
  });

  it('keeps polling the other instruments when one fails', async () => {
    const { feed, reporter } = feedOver(
      {
        '005930': [{ status: 503 }],
        '000660': [{ price: '150000' }],
      },
      { instruments: [SAMSUNG, HYNIX] },
    );

    await expect(feed.poll()).resolves.toHaveLength(1);
    expect(reporter.lines.join('\n')).toMatch(/a quote poll failed/u);
  });
});

describe('RestQuoteFeed ordering', () => {
  it('emits only when the market-data version advances', async () => {
    const { feed } = feedOver({
      '005930': [
        { price: '70000', marketDataVersion: '5' },
        { price: '70100', marketDataVersion: '5' },
        { price: '70200', marketDataVersion: '6' },
      ],
    });

    expect((await feed.poll()).map((tick) => tick.price)).toStrictEqual([
      '70000',
    ]);
    expect(await feed.poll()).toStrictEqual([]);
    expect((await feed.poll()).map((tick) => tick.price)).toStrictEqual([
      '70200',
    ]);
  });

  /** §5.2: a frame that goes backwards is dropped before a strategy sees it. */
  it('drops a frame whose version went backwards', async () => {
    const { feed } = feedOver({
      '005930': [
        { price: '70000', marketDataVersion: '9' },
        { price: '69000', marketDataVersion: '8' },
      ],
    });

    await feed.poll();

    expect(await feed.poll()).toStrictEqual([]);
  });

  it('orders by recovery epoch before market-data version', async () => {
    const { feed } = feedOver({
      '005930': [
        { price: '70000', recoveryEpoch: '1', marketDataVersion: '900' },
        // A recovery restarts the version counter; the frame is newer even
        // though its version is smaller.
        { price: '71000', recoveryEpoch: '2', marketDataVersion: '3' },
      ],
    });

    await feed.poll();

    expect((await feed.poll()).map((tick) => tick.price)).toStrictEqual([
      '71000',
    ]);
  });
});

describe('RestQuoteFeed gap detection', () => {
  const cursorAt = (observedAtMs: number, epoch = '1'): FeedCursors => ({
    'KR:005930': {
      recoveryEpoch: epoch,
      marketDataVersion: '1',
      observedAtMs,
    },
  });

  it('marks the very first tick for an instrument as a gap', async () => {
    const { feed } = feedOver({ '005930': [{ price: '70000' }] });
    const [tick] = await feed.poll();

    expect(tick?.gapBefore).toBe(true);
  });

  it('does not mark a tick as a gap while polling continues', async () => {
    let clock = 1_000_000;
    const { feed } = feedOver(
      {
        '005930': [
          { price: '70000', marketDataVersion: '1' },
          { price: '70100', marketDataVersion: '2' },
        ],
      },
      { clock: () => clock },
    );

    await feed.poll();
    clock += 1_000;

    expect((await feed.poll())[0]?.gapBefore).toBe(false);
  });

  /**
   * The reason `gapBefore` is a duration rather than "the process restarted":
   * a two-second container replacement at a one-second poll is not a
   * discontinuity, and marking it as one would discard the very window
   * `snapshot()`/`onStart` restored.
   */
  it('treats a short restart as continuous, using the persisted cursor', async () => {
    const { feed } = feedOver(
      { '005930': [{ price: '70100', marketDataVersion: '2' }] },
      { clock: () => 1_002_000, cursors: cursorAt(1_000_000) },
    );

    expect((await feed.poll())[0]?.gapBefore).toBe(false);
  });

  it('treats a long absence as a gap, however it was caused', async () => {
    const { feed } = feedOver(
      { '005930': [{ price: '70100', marketDataVersion: '2' }] },
      { clock: () => 1_060_000, cursors: cursorAt(1_000_000) },
    );

    expect((await feed.poll())[0]?.gapBefore).toBe(true);
  });

  /**
   * A calm market is being observed continuously even though it produces no
   * ticks. Measuring the gap from the last *emitted* tick would turn a quiet
   * hour into a discontinuity and reset every window for no reason.
   */
  it('does not turn a quiet market into a gap', async () => {
    let clock = 1_000_000;
    // One unchanging quote for thirty polls, then a move. The queue helper holds
    // its last entry, so the same version is answered until it is replaced.
    const quiet: Quote[] = [{ price: '70000', marketDataVersion: '1' }];
    const { feed } = feedOver(
      { '005930': quiet },
      { clock: () => clock, gapAfterMs: 5_000 },
    );

    await feed.poll();

    for (let elapsed = 0; elapsed < 30; elapsed += 1) {
      clock += 1_000;
      expect(await feed.poll()).toStrictEqual([]);
    }

    quiet[0] = { price: '70100', marketDataVersion: '2' };
    clock += 1_000;

    // Thirty-one seconds without a price change, at a gap threshold of five:
    // the runner was watching the whole time, so the series is continuous.
    expect((await feed.poll())[0]?.gapBefore).toBe(false);
  });

  /** A recovery re-derives the market state; the two sides are not one series. */
  it('marks a recovery epoch advance as a gap however recent the last tick', async () => {
    const { feed } = feedOver(
      {
        '005930': [
          { price: '70100', recoveryEpoch: '2', marketDataVersion: '1' },
        ],
      },
      { clock: () => 1_000_100, cursors: cursorAt(1_000_000) },
    );

    expect((await feed.poll())[0]?.gapBefore).toBe(true);
  });

  it('reports an observed gap but not the first tick of a fresh run', async () => {
    const fresh = feedOver({ '005930': [{ price: '70000' }] });

    await fresh.feed.poll();

    expect(fresh.reporter.lines).toStrictEqual([]);

    const resumed = feedOver(
      { '005930': [{ price: '70100', marketDataVersion: '2' }] },
      { clock: () => 1_060_000, cursors: cursorAt(1_000_000) },
    );

    await resumed.feed.poll();

    expect(resumed.reporter.lines.join('\n')).toMatch(
      /a market-data gap was observed .*sinceMs=60000/u,
    );
  });

  it('hands back cursors a restart can resume from', async () => {
    const { feed } = feedOver({
      '005930': [
        { price: '70000', recoveryEpoch: '3', marketDataVersion: '7' },
      ],
    });

    await feed.poll();

    expect(feed.cursors()).toStrictEqual({
      'KR:005930': {
        recoveryEpoch: '3',
        marketDataVersion: '7',
        observedAtMs: 1_000_000,
      },
    });
  });
});
