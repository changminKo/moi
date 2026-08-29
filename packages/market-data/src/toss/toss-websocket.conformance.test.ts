import type { Market, OrderBookSnapshot } from '@moi/trading-core';
import {
  CONFORMANCE_MARKET,
  type MarketDataConformanceHarness,
  runMarketDataConformance,
} from '../adapter-conformance.js';
import { FakeTossWsServer } from '../testing/fake-toss/fake-toss-ws-server.js';
import { TossWebSocketMarketData } from './toss-websocket.js';

const CONTRACT_TIMESTAMP = '2026-06-18T23:30:00.000+09:00';
const BOOKS: Record<string, OrderBookSnapshot> = {
  'US:AAPL': {
    market: 'US',
    symbol: 'AAPL',
    currency: 'USD',
    bids: [{ price: '185.65', volume: '180' }],
    asks: [{ price: '185.75', volume: '250' }],
  },
};

/** B1: the real adapter against the contract-derived fake over loopback TCP. */
runMarketDataConformance(
  async (): Promise<MarketDataConformanceHarness> => {
    const server = new FakeTossWsServer();
    await server.start();
    server.allowToken('tok-conformance');
    const stream = new TossWebSocketMarketData({
      url: new URL(server.url),
      market: CONFORMANCE_MARKET,
      tokenProvider: { getAccessToken: async () => 'tok-conformance' },
      controlTimeoutMs: 2_000,
      rateLimitRetryMs: 50,
    });
    await stream.connect(new AbortController().signal);
    return {
      stream,
      // The Toss contract requires a trade timestamp; the harness (not the fake
      // and not the adapter) supplies one when the generic suite passes null.
      deliverTrade: (input) =>
        server.emitTrade({
          ...input,
          sourceTimestamp: input.sourceTimestamp ?? CONTRACT_TIMESTAMP,
        }),
      deliverOrderBook: (input) => server.emitOrderBook(input),
      deliverOutOfOrder: (inputs) => server.emitOutOfOrder(inputs),
      dropNext: (count) => server.dropNext(count),
      deliverTransportClose: (reason) =>
        reason === 'server-shutdown'
          ? server.announceShutdownAndClose()
          : server.closeAll(1001, reason),
      rejectTopics: (topics) =>
        server.rejectTopics(
          topics.map((topic) => {
            const [channel, market, ...rest] = topic.split(':');
            return `${channel === 'orderBook' ? 'orderbook' : channel}:${(market as Market).toLowerCase()}:${rest.join(':')}`;
          }),
        ),
      failNextPongs: (count) => server.failNextPongs(count),
      orderBookFor: (market, symbol) => {
        const book = BOOKS[`${market}:${symbol}`];
        if (!book) throw new Error(`no fixture book for ${market}:${symbol}`);
        return book;
      },
      dispose: async () => {
        await stream.close();
        await server.stop();
      },
    };
  },
  { nullableTradeTimestamp: false },
);
