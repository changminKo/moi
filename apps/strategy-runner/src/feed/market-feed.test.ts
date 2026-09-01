import type { InstrumentRef, Tick } from '@moi/strategy-sdk/strategy';
import { describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import {
  type FetchLike,
  PaperApiClient,
} from '../transport/paper-api-client.js';
import { MarketFeed } from './market-feed.js';
import { QuoteTicker } from './quote-ticker.js';
import { RestQuoteFeed } from './rest-quote-feed.js';
import type { StreamClient } from './stream-client.js';

const SAMSUNG: InstrumentRef = { market: 'KR', symbol: '005930' };
const HYNIX: InstrumentRef = { market: 'KR', symbol: '000660' };

function projection(
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    market: 'KR',
    symbol: '005930',
    price: '70000',
    asOf: '2026-09-02T00:00:00.000Z',
    health: 'HEALTHY',
    recoveryEpoch: '1',
    marketDataVersion: '1',
    ...fields,
  };
}

function harness(
  options: {
    readonly instruments?: readonly InstrumentRef[];
    readonly maxQuoteAgeMs?: number;
    readonly restVersion?: () => string;
  } = {},
) {
  const clock = { ms: 1_000 };
  const restReads: string[] = [];
  const version = options.restVersion ?? (() => '100');
  const fetch: FetchLike = async (url) => {
    const path = new URL(url).pathname;
    const symbol = path.split('/')[6] ?? '';

    restReads.push(symbol);

    return {
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify(
          projection({ symbol, price: '71000', marketDataVersion: version() }),
        ),
    };
  };
  const reporter = createRecordingReporter();
  const ticker = new QuoteTicker({
    gapAfterMs: 60_000,
    now: () => clock.ms,
  });
  const feed = new MarketFeed({
    instruments: options.instruments ?? [SAMSUNG],
    ticker,
    rest: new RestQuoteFeed({
      api: new PaperApiClient({
        origin: 'http://127.0.0.1:3001',
        credentials: () => null,
        fetch,
      }),
      instruments: options.instruments ?? [SAMSUNG],
      reporter,
      ticker,
    }),
    // The feed never calls it in these tests; the supervisor owns its lifetime.
    stream: null as unknown as StreamClient,
    reporter,
    maxQuoteAgeMs: options.maxQuoteAgeMs ?? 10_000,
  });

  return { feed, ticker, clock, restReads, reporter };
}

const prices = (ticks: readonly Tick[]): readonly string[] =>
  ticks.map((tick) => tick.price);

describe('the composed market feed', () => {
  it('turns a quote frame into a stream-quote tick', async () => {
    const h = harness();

    h.feed.observeFrame('KR', '005930', projection({ marketDataVersion: '5' }));

    const [tick] = await h.feed.drain();

    expect(tick).toMatchObject({
      symbol: '005930',
      price: '70000',
      priceSource: 'stream-quote',
      marketDataVersion: '5',
    });
  });

  it('ignores a frame for an instrument nobody subscribed to', async () => {
    const h = harness();

    h.feed.observeFrame(
      'US',
      'AAPL',
      projection({ market: 'US', symbol: 'AAPL' }),
    );

    // The drain still re-reads the subscribed instrument, which has never been
    // observed. What must not be here is a tick for `US:AAPL`.
    const ticks = await h.feed.drain();

    expect(ticks.map((tick) => `${tick.market}:${tick.symbol}`)).toStrictEqual([
      'KR:005930',
    ]);
  });

  it('contains a malformed frame instead of failing the cycle', async () => {
    const h = harness();

    h.feed.observeFrame(
      'KR',
      '005930',
      projection({ marketDataVersion: 5, price: '70000' }),
    );

    await h.feed.drain();

    expect(h.reporter.lines.join('\n')).toMatch(
      /a quote frame could not be read/u,
    );
  });

  it('drains in arrival order and empties itself', async () => {
    const h = harness({ maxQuoteAgeMs: 10_000_000 });

    h.feed.observeFrame('KR', '005930', projection({ marketDataVersion: '5' }));
    h.feed.observeFrame(
      'KR',
      '005930',
      projection({ marketDataVersion: '6', price: '70100' }),
    );

    expect(prices(await h.feed.drain())).toStrictEqual(['70000', '70100']);
    expect(await h.feed.drain()).toStrictEqual([]);
  });
});

describe('the REST read beside the stream', () => {
  it('reads every instrument when a connection is re-baselined', async () => {
    const h = harness({ instruments: [SAMSUNG, HYNIX] });

    await h.feed.rebaseline();

    expect(h.restReads).toStrictEqual(['005930', '000660']);
    expect(await h.feed.drain()).toHaveLength(2);
  });

  /**
   * A stream that is carrying the instrument answers the freshness rule on its
   * own; re-reading it would be the polling load the subscription exists to
   * remove.
   */
  it('leaves an instrument the stream is keeping fresh alone', async () => {
    const h = harness({ maxQuoteAgeMs: 10_000 });

    h.feed.observeFrame('KR', '005930', projection({ marketDataVersion: '5' }));
    await h.feed.drain();

    h.clock.ms += 4_000;
    h.restReads.length = 0;

    h.feed.observeFrame('KR', '005930', projection({ marketDataVersion: '6' }));
    await h.feed.drain();

    expect(h.restReads).toStrictEqual([]);
  });

  it('re-reads an instrument that has gone quiet for half the freshness limit', async () => {
    const h = harness({ maxQuoteAgeMs: 10_000 });

    h.feed.observeFrame('KR', '005930', projection({ marketDataVersion: '5' }));
    await h.feed.drain();

    h.clock.ms += 6_000;
    h.restReads.length = 0;

    expect(prices(await h.feed.drain())).toStrictEqual(['71000']);
    expect(h.restReads).toStrictEqual(['005930']);
  });

  it('reads an instrument it has never observed', async () => {
    const h = harness();

    await h.feed.drain();

    expect(h.restReads).toStrictEqual(['005930']);
  });

  /**
   * The property that lets the re-baseline run unconditionally: the two paths
   * share one cursor, so a REST read of an observation the stream already
   * delivered is not a second tick.
   */
  it('does not tick twice when the re-baseline sees what the stream saw', async () => {
    const h = harness({ restVersion: () => '5' });

    h.feed.observeFrame('KR', '005930', projection({ marketDataVersion: '5' }));
    await h.feed.rebaseline();

    expect(prices(await h.feed.drain())).toStrictEqual(['70000']);
  });
});
