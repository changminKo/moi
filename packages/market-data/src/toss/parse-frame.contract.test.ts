/**
 * The contract test for the Toss frame parser.
 *
 * Two things are under test here, and they are deliberately in one file:
 * the parser's behaviour, and the pinned bytes it was written against. A
 * parser that is correct about a contract nobody pinned is not a contract
 * test, so the provenance assertions below fail the suite the moment the
 * recorded spec, its advertised version, or a fixture's declared contract
 * version drifts away from what these expectations were derived from.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import asyncapi from '../../contracts/toss/asyncapi.json' with { type: 'json' };
import openapi from '../../contracts/toss/openapi.json' with { type: 'json' };
import provenance from '../../contracts/toss/provenance.json' with {
  type: 'json',
};
import errorFixture from '../../fixtures/toss/error-server-shutdown.json' with {
  type: 'json',
};
import orderBookFixtureFile from '../../fixtures/toss/orderbook-kr-005930.json' with {
  type: 'json',
};
import subscriptionsFixture from '../../fixtures/toss/subscriptions.json' with {
  type: 'json',
};
import tradeFixtureFile from '../../fixtures/toss/trade-us-aapl.json' with {
  type: 'json',
};
import { MARKET_EVENT_FIELDS, MarketDataError } from '../types.js';
import { parseTossFrame, toMarketEvent } from './parse-frame.js';

const RECEIVED_AT = '2026-08-24T06:01:08.000Z';

type JsonRecord = Record<string, unknown>;

/**
 * Fixtures are overridden through a plain merge rather than through a builder
 * so a test can inject a value the *type* forbids — a JSON number where the
 * contract says decimal string is exactly the case the parser must reject.
 */
const tradeFixture = (dataOverrides: JsonRecord = {}): JsonRecord => ({
  ...(tradeFixtureFile.frame as JsonRecord),
  data: { ...tradeFixtureFile.frame.data, ...dataOverrides },
});

const orderBookFixture = (dataOverrides: JsonRecord = {}): JsonRecord => ({
  ...(orderBookFixtureFile.frame as JsonRecord),
  data: { ...orderBookFixtureFile.frame.data, ...dataOverrides },
});

const contractEntry = (file: string) => {
  const entry = provenance.contracts.find((each) => each.file === file);
  if (entry === undefined) {
    throw new Error(`provenance.json does not record ${file}`);
  }
  return entry;
};

describe('pinned contract provenance', () => {
  it.each([
    ['asyncapi.json', asyncapi.info.version, asyncapi.asyncapi],
    ['openapi.json', openapi.info.version, openapi.openapi],
  ])(
    'records the retrieved bytes and advertised version of %s',
    (file, advertisedVersion, specVersion) => {
      const entry = contractEntry(file);
      const bytes = readFileSync(
        new URL(`../../contracts/toss/${file}`, import.meta.url),
      );

      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.sha256,
      );
      expect(entry.advertisedVersion).toBe(advertisedVersion);
      expect(entry.specVersion).toBe(specVersion);
      expect(entry.url).toMatch(/^https:\/\/openapi\.tossinvest\.com\//u);
      expect(provenance.retrievedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u,
      );
    },
  );

  it('pins every fixture to the recorded AsyncAPI version', () => {
    const fixtures = [
      subscriptionsFixture,
      tradeFixtureFile,
      orderBookFixtureFile,
      errorFixture,
    ];

    for (const fixture of fixtures) {
      expect(fixture.contract.spec).toBe('asyncapi.json');
      expect(fixture.contract.advertisedVersion).toBe(
        contractEntry('asyncapi.json').advertisedVersion,
      );
      expect(fixture.fixtureVersion).toBe(1);
    }
  });

  it('keeps fixtures free of credentials and account identifiers', () => {
    const fixtures = [
      subscriptionsFixture,
      tradeFixtureFile,
      orderBookFixtureFile,
      errorFixture,
    ];

    for (const fixture of fixtures) {
      const serialized = JSON.stringify(fixture.frame);
      expect(serialized).not.toMatch(/authorization|bearer|accountseq/iu);
      expect(serialized).not.toMatch(/personal:order/u);
    }
  });
});

describe('parseTossFrame', () => {
  it('parses a recorded trade frame into provider-shaped decimal strings', () => {
    const frame = parseTossFrame(tradeFixture(), RECEIVED_AT);

    expect(frame).toMatchObject({
      kind: 'trade',
      topic: 'trade:us:AAPL',
      providerMarket: 'us',
      symbol: 'AAPL',
      price: '243.26',
      volume: '8',
      sourceTimestamp: '2026-06-18T23:30:00.000+09:00',
      currency: 'USD',
      receivedAt: RECEIVED_AT,
    });
  });

  it('parses a recorded order-book frame preserving level ordering', () => {
    const frame = parseTossFrame(orderBookFixture(), RECEIVED_AT);

    expect(frame).toMatchObject({
      kind: 'orderBook',
      topic: 'orderbook:kr:005930',
      providerMarket: 'kr',
      symbol: '005930',
      currency: 'KRW',
      asks: [
        { price: '71500', volume: '5' },
        { price: '71600', volume: '12' },
      ],
      bids: [
        { price: '71400', volume: '10' },
        { price: '71300', volume: '7' },
      ],
    });
  });

  it('accepts nullable order-book timestamps and unknown currency enums safely', () => {
    const frame = parseTossFrame(
      orderBookFixture({ timestamp: null, currency: 'UNKNOWN_FUTURE' }),
      RECEIVED_AT,
    );

    expect(frame).toMatchObject({
      kind: 'orderBook',
      sourceTimestamp: null,
      currency: 'UNKNOWN_FUTURE',
    });
  });

  it('treats an omitted order-book timestamp as absent, not as an error', () => {
    const withoutTimestamp = orderBookFixture();
    delete (withoutTimestamp.data as JsonRecord).timestamp;

    expect(parseTossFrame(withoutTimestamp, RECEIVED_AT)).toMatchObject({
      kind: 'orderBook',
      sourceTimestamp: null,
    });
  });

  it('accepts an empty order-book side without inventing depth', () => {
    const frame = parseTossFrame(
      orderBookFixture({ asks: [], bids: [] }),
      RECEIVED_AT,
    );

    expect(frame).toMatchObject({ kind: 'orderBook', asks: [], bids: [] });
  });

  it('rejects malformed decimal fields without coercing number', () => {
    expect(() =>
      parseTossFrame(tradeFixture({ price: 210.1 }), RECEIVED_AT),
    ).toThrow(MarketDataError);
  });

  it.each([
    ['a grouped literal', '1,234.5'],
    ['an exponent', '2.1e2'],
    ['a blank string', ''],
    ['a leading plus', '+210.10'],
    ['a bare dot', '210.'],
    ['a hex literal', '0x10'],
    ['whitespace padding', ' 210.10 '],
    ['a non-numeric word', 'NaN'],
  ])('rejects %s in a decimal field', (_label, price) => {
    expect(() => parseTossFrame(tradeFixture({ price }), RECEIVED_AT)).toThrow(
      MarketDataError,
    );
  });

  it('rejects a decimal longer than the contract allows', () => {
    const tooLong = `1${'0'.repeat(30)}`;

    expect(() =>
      parseTossFrame(tradeFixture({ price: tooLong }), RECEIVED_AT),
    ).toThrow(MarketDataError);
  });

  it('rejects a numeric order-book level price', () => {
    expect(() =>
      parseTossFrame(
        orderBookFixture({ bids: [{ price: 71400, volume: '10' }] }),
        RECEIVED_AT,
      ),
    ).toThrow(MarketDataError);
  });

  it('rejects a trade frame with no timestamp, which the contract requires', () => {
    const withoutTimestamp = tradeFixture();
    delete (withoutTimestamp.data as JsonRecord).timestamp;

    expect(() => parseTossFrame(withoutTimestamp, RECEIVED_AT)).toThrow(
      MarketDataError,
    );
  });

  it('rejects a non-timestamp string in a timestamp field', () => {
    expect(() =>
      parseTossFrame(tradeFixture({ timestamp: 'yesterday' }), RECEIVED_AT),
    ).toThrow(MarketDataError);
  });

  it.each([
    ['a non-object payload', 'PING'],
    ['null', null],
    ['an array', []],
    ['a frame with no type', { topic: 'trade:us:AAPL', data: {} }],
    ['an unknown frame type', { type: 'candle', topic: 'trade:us:AAPL' }],
    ['a data frame with no topic', { type: 'message', data: {} }],
    ['a data frame with no data', { type: 'message', topic: 'trade:us:AAPL' }],
    [
      'a topic naming an unknown channel',
      { type: 'message', topic: 'candle:us:AAPL', data: {} },
    ],
    ['a topic with too few segments', { type: 'message', topic: 'trade:us' }],
    ['an ack with no subscribed list', { type: 'subscriptions', rejected: [] }],
    ['an error frame with no error body', { type: 'error' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseTossFrame(raw, RECEIVED_AT)).toThrow(MarketDataError);
  });

  it('parses a subscription ack with the exact rejected topic keys', () => {
    const frame = parseTossFrame(subscriptionsFixture.frame, RECEIVED_AT);

    expect(frame).toMatchObject({
      kind: 'subscriptionAck',
      requestId: 'req-2',
      subscribed: ['trade:us:AAPL', 'orderbook:kr:005930'],
      rejected: [
        {
          target: 'trade:kr:999999',
          code: 'stock-not-found',
          message: '해당 종목을 찾을 수 없습니다.',
        },
      ],
    });
  });

  it('reports a missing ack request id as null rather than undefined', () => {
    const withoutId = { ...subscriptionsFixture.frame } as JsonRecord;
    delete withoutId.id;

    expect(parseTossFrame(withoutId, RECEIVED_AT)).toMatchObject({
      kind: 'subscriptionAck',
      requestId: null,
    });
  });

  it('keeps an unknown ack rejection code opaque instead of failing the frame', () => {
    const frame = parseTossFrame(
      {
        type: 'subscriptions',
        subscribed: [],
        rejected: [
          {
            target: 'trade:us:AAPL',
            code: 'unknown-future-reason',
            message: 'unspecified',
          },
        ],
      },
      RECEIVED_AT,
    );

    expect(frame).toMatchObject({
      kind: 'subscriptionAck',
      rejected: [{ code: 'unknown-future-reason' }],
    });
  });

  it('parses the server-shutdown error frame', () => {
    expect(parseTossFrame(errorFixture.frame, RECEIVED_AT)).toMatchObject({
      kind: 'error',
      code: 'server-shutdown',
      message: '서버가 재시작됩니다. 재연결해주세요.',
      requestId: null,
      receivedAt: RECEIVED_AT,
    });
  });

  it('keeps an unknown error code opaque instead of failing the frame', () => {
    expect(
      parseTossFrame(
        { type: 'error', error: { code: 'brand-new', message: 'later' } },
        RECEIVED_AT,
      ),
    ).toMatchObject({ kind: 'error', code: 'brand-new' });
  });

  it('parses the keepalive pong frame', () => {
    expect(parseTossFrame({ type: 'pong' }, RECEIVED_AT)).toEqual({
      kind: 'pong',
      receivedAt: RECEIVED_AT,
    });
  });

  it('parses a JSON text frame as well as an already-decoded value', () => {
    expect(
      parseTossFrame(JSON.stringify(tradeFixture()), RECEIVED_AT),
    ).toMatchObject({ kind: 'trade', symbol: 'AAPL' });
  });

  it('rejects a text frame that is not JSON', () => {
    expect(() => parseTossFrame('{not json', RECEIVED_AT)).toThrow(
      MarketDataError,
    );
  });

  it('needs no sequence number and never invents one', () => {
    const frame = parseTossFrame(tradeFixture(), RECEIVED_AT);

    expect(Object.keys(frame)).not.toContain('sequence');
    expect(JSON.stringify(frame)).not.toMatch(/sequence/iu);
  });

  it('ignores a provider sequence field rather than adopting it', () => {
    const frame = parseTossFrame(
      tradeFixture({ sequence: 42 }),
      RECEIVED_AT,
    ) as { unknownFields: Record<string, unknown> };

    expect(frame).not.toHaveProperty('sequence');
    expect(frame.unknownFields).toEqual({ sequence: 42 });
  });

  it('preserves unknown fields without letting them shadow known ones', () => {
    const frame = parseTossFrame(
      tradeFixture({ marketPhase: 'AFTER_HOURS', tickRule: { step: '0.01' } }),
      RECEIVED_AT,
    ) as { price: string; unknownFields: Record<string, unknown> };

    expect(frame.price).toBe('243.26');
    expect(frame.unknownFields).toEqual({
      marketPhase: 'AFTER_HOURS',
      tickRule: { step: '0.01' },
    });
  });

  it('reports no unknown fields for a frame that matches the contract exactly', () => {
    const frame = parseTossFrame(tradeFixture(), RECEIVED_AT) as {
      unknownFields: Record<string, unknown>;
    };

    expect(frame.unknownFields).toEqual({});
  });
});

describe('toMarketEvent', () => {
  it('converts a trade frame to exactly the normalized public fields', () => {
    const event = toMarketEvent(parseTossFrame(tradeFixture(), RECEIVED_AT));

    expect(event).toEqual({
      kind: 'trade',
      market: 'US',
      symbol: 'AAPL',
      price: '243.26',
      volume: '8',
      sourceTimestamp: '2026-06-18T23:30:00.000+09:00',
      receivedAt: RECEIVED_AT,
    });
    expect(Object.keys(event).sort()).toEqual(
      [...MARKET_EVENT_FIELDS.trade].sort(),
    );
  });

  it('converts an order-book frame to exactly the normalized public fields', () => {
    const event = toMarketEvent(
      parseTossFrame(orderBookFixture(), RECEIVED_AT),
    );

    expect(event).toEqual({
      kind: 'orderBook',
      market: 'KR',
      symbol: '005930',
      sourceTimestamp: '2026-06-18T23:30:00.000+09:00',
      receivedAt: RECEIVED_AT,
      book: {
        symbol: '005930',
        market: 'KR',
        currency: 'KRW',
        bids: [
          { price: '71400', volume: '10' },
          { price: '71300', volume: '7' },
        ],
        asks: [
          { price: '71500', volume: '5' },
          { price: '71600', volume: '12' },
        ],
      },
    });
    expect(Object.keys(event).sort()).toEqual(
      [...MARKET_EVENT_FIELDS.orderBook].sort(),
    );
  });

  it('drops unknown provider fields instead of leaking them downstream', () => {
    const event = toMarketEvent(
      parseTossFrame(tradeFixture({ marketPhase: 'AFTER_HOURS' }), RECEIVED_AT),
    );

    expect(JSON.stringify(event)).not.toMatch(/marketPhase|currency/u);
  });

  it('raises an unsupported-data incident for an unknown currency instead of crashing', () => {
    const frame = parseTossFrame(
      orderBookFixture({ currency: 'UNKNOWN_FUTURE' }),
      RECEIVED_AT,
    );

    // The frame parsed: the unknown enum stayed an opaque string. Only the
    // conversion into a normalized event refuses it, and it refuses it as a
    // classified incident the engine can degrade on.
    expect(frame).toMatchObject({ currency: 'UNKNOWN_FUTURE' });
    expect(() => toMarketEvent(frame)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_DATA' }),
    );
  });

  it('raises an unsupported-data incident for an unknown provider market', () => {
    const frame = parseTossFrame(
      { ...tradeFixture(), topic: 'trade:jp:7203' },
      RECEIVED_AT,
    );

    expect(frame).toMatchObject({ providerMarket: 'jp' });
    expect(() => toMarketEvent(frame)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_DATA' }),
    );
  });

  it('raises an unsupported-data incident when the currency contradicts the market', () => {
    const frame = parseTossFrame(
      orderBookFixture({ currency: 'USD' }),
      RECEIVED_AT,
    );

    expect(() => toMarketEvent(frame)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_DATA' }),
    );
  });

  it('refuses to convert a control frame into market data', () => {
    for (const raw of [
      errorFixture.frame,
      { type: 'pong' },
      subscriptionsFixture.frame,
    ]) {
      expect(() => toMarketEvent(parseTossFrame(raw, RECEIVED_AT))).toThrow(
        MarketDataError,
      );
    }
  });
});
