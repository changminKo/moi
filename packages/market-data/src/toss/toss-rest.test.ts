import type { Market } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import openapi from '../../contracts/toss/openapi.json' with { type: 'json' };
import { TossRestClient } from './toss-rest.js';

describe('TossRestClient', () => {
  it('is the REST implementation of the normalized ports', () => {
    expect(TossRestClient).toBeDefined();
  });
});

/**
 * The calendar examples the pinned contract ships, read off the JSON rather
 * than copied: when the contract is re-pinned these cases move with it.
 */
interface ContractExamples {
  readonly paths: Record<
    string,
    {
      readonly get: {
        readonly responses: Record<
          string,
          {
            readonly content: Record<
              string,
              {
                readonly examples: Record<string, { readonly value: unknown }>;
              }
            >;
          }
        >;
      };
    }
  >;
}

function contractExample(market: Market, name: string): unknown {
  const path = (openapi as unknown as ContractExamples).paths[
    `/api/v1/market-calendar/${market}`
  ];
  const example =
    path?.get.responses['200']?.content['application/json']?.examples[name];
  if (!example) throw new Error(`missing contract example ${market}/${name}`);
  return structuredClone(example.value);
}

/**
 * A client whose only answer is `body`; the URL it asked for and every decode
 * event it reported are captured.
 */
function clientFor(body: unknown): {
  readonly client: TossRestClient;
  readonly urls: string[];
  readonly events: { event: string; fields: Record<string, unknown> }[];
} {
  const urls: string[] = [];
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const client = new TossRestClient({
    baseUrl: 'http://127.0.0.1:1/',
    tokenProvider: { getAccessToken: async () => 'test-token' },
    maxRetries: 0,
    log: (event, fields) => events.push({ event, fields }),
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { client, urls, events };
}

async function decode(market: Market, body: unknown, date = '2026-03-25') {
  const { client } = clientFor(body);
  return client.getCalendarDay(market, date, new AbortController().signal);
}

/** A KR calendar answer carrying one regular-session window. */
function krDay(regularMarket: Record<string, unknown>): unknown {
  return {
    result: { today: { date: '2026-03-25', integrated: { regularMarket } } },
  };
}

describe('TossRestClient.getCalendarDay (#122)', () => {
  it('reads the KR business-day example: the regular session opens the day', async () => {
    const day = await decode('KR', contractExample('KR', 'businessDay'));

    expect(day).toEqual({
      market: 'KR',
      tradingDate: '2026-03-25',
      isTradingDay: true,
      regularSession: {
        opensAt: '2026-03-25T09:00:00+09:00',
        closesAt: '2026-03-25T15:30:00+09:00',
      },
    });
  });

  it('reads the KR holiday example: a null `integrated` is a closed day', async () => {
    const day = await decode(
      'KR',
      contractExample('KR', 'holidayToday'),
      '2026-05-05',
    );

    expect(day).toEqual({
      market: 'KR',
      tradingDate: '2026-05-05',
      isTradingDay: false,
      regularSession: null,
    });
  });

  it('reads the KR partial-holiday example: a shut pre-market leaves the day tradable', async () => {
    const day = await decode(
      'KR',
      contractExample('KR', 'nxtPreMarketHoliday'),
    );

    expect(day).toEqual({
      market: 'KR',
      tradingDate: '2026-03-25',
      isTradingDay: true,
      regularSession: {
        opensAt: '2026-03-25T09:00:00+09:00',
        closesAt: '2026-03-25T15:30:00+09:00',
      },
    });
  });

  it('calls a KR day without a regular session closed, whatever the other sessions do', async () => {
    const body = contractExample('KR', 'nxtPreMarketHoliday') as {
      result: { today: { integrated: { regularMarket: unknown } } };
    };
    body.result.today.integrated.regularMarket = null;

    await expect(decode('KR', body)).resolves.toEqual({
      market: 'KR',
      tradingDate: '2026-03-25',
      isTradingDay: false,
      regularSession: null,
    });
  });

  it('reads the US business-day example, ignoring day/pre/after markets', async () => {
    const day = await decode('US', contractExample('US', 'businessDay'));

    expect(day).toEqual({
      market: 'US',
      tradingDate: '2026-03-25',
      isTradingDay: true,
      regularSession: {
        opensAt: '2026-03-25T22:30:00+09:00',
        closesAt: '2026-03-26T05:00:00+09:00',
      },
    });
  });

  it('reads the US holiday example: four null sessions are a closed day', async () => {
    const day = await decode(
      'US',
      contractExample('US', 'holidayToday'),
      '2026-07-03',
    );

    expect(day).toEqual({
      market: 'US',
      tradingDate: '2026-07-03',
      isTradingDay: false,
      regularSession: null,
    });
  });

  it('asks for the requested date and reports the date the provider answered with', async () => {
    const { client, urls } = clientFor(contractExample('KR', 'businessDay'));

    const day = await client.getCalendarDay(
      'KR',
      '2026-03-24',
      new AbortController().signal,
    );

    expect(urls).toEqual([
      'http://127.0.0.1:1/api/v1/market-calendar/KR?date=2026-03-24',
    ]);
    expect(day.tradingDate).toBe('2026-03-25');
  });

  describe('reads an absent session key as closed, and says so', () => {
    const cases: ReadonlyArray<readonly [string, Market, unknown, string]> = [
      [
        'a KR `today` without `integrated`',
        'KR',
        { result: { today: { date: '2026-03-25' } } },
        'today.integrated',
      ],
      [
        'a KR `integrated` without `regularMarket`',
        'KR',
        { result: { today: { date: '2026-03-25', integrated: {} } } },
        'today.integrated.regularMarket',
      ],
      [
        'a US `today` without `regularMarket`',
        'US',
        { result: { today: { date: '2026-03-25' } } },
        'today.regularMarket',
      ],
    ];

    // The contract requires only `date`, so a provider that omits null fields
    // would otherwise fail every holiday closed (§16.26, §16.57).
    for (const [name, market, body, path] of cases) {
      it(`reports ${name}`, async () => {
        const { client, events } = clientFor(body);

        const day = await client.getCalendarDay(
          market,
          '2026-03-25',
          new AbortController().signal,
        );

        expect(day).toEqual({
          market,
          tradingDate: '2026-03-25',
          isTradingDay: false,
          regularSession: null,
        });
        expect(events).toEqual([
          {
            event: 'calendar.decode_lenient',
            fields: { market, tradingDate: '2026-03-25', missing: path },
          },
        ]);
      });
    }

    it('says nothing when the contract shape is complete', async () => {
      const { client, events } = clientFor(
        contractExample('KR', 'businessDay'),
      );

      await client.getCalendarDay(
        'KR',
        '2026-03-25',
        new AbortController().signal,
      );

      expect(events).toEqual([]);
    });
  });

  describe('fails closed rather than reporting a holiday it did not read', () => {
    const cases: ReadonlyArray<readonly [string, Market, unknown]> = [
      ['an empty result array', 'KR', { result: [] }],
      ['a result without `today`', 'KR', { result: {} }],
      ['a `today` that is not an object', 'KR', { result: { today: null } }],
      ['a `today` that is an array', 'KR', { result: { today: [] } }],
      [
        'a `today` without a date',
        'KR',
        { result: { today: { integrated: null } } },
      ],
      [
        'a `today` whose date is not a string',
        'KR',
        { result: { today: { date: 20260325, integrated: null } } },
      ],
      [
        'a KR `integrated` that is not an object',
        'KR',
        { result: { today: { date: '2026-03-25', integrated: 'x' } } },
      ],
      [
        'a `regularMarket` that is not an object',
        'US',
        { result: { today: { date: '2026-03-25', regularMarket: 5 } } },
      ],
      [
        'a regular session without an end',
        'US',
        {
          result: {
            today: {
              date: '2026-03-25',
              regularMarket: { startTime: '2026-03-25T22:30:00+09:00' },
            },
          },
        },
      ],
      [
        'a regular session whose start is not a timestamp',
        'US',
        {
          result: {
            today: {
              date: '2026-03-25',
              regularMarket: {
                startTime: '09:00',
                endTime: '2026-03-26T05:00:00+09:00',
              },
            },
          },
        },
      ],
      [
        'a regular session whose bounds are numbers',
        'KR',
        {
          result: {
            today: {
              date: '2026-03-25',
              integrated: { regularMarket: { startTime: 9, endTime: 15 } },
            },
          },
        },
      ],
      // `Date.parse` accepts all three; only the first is an instant, and it is
      // read in the *host's* zone, so a UTC container would move the KR session
      // nine hours and sit in PRE_OPEN all day.
      [
        'a start time without a zone offset',
        'KR',
        krDay({
          startTime: '2026-03-25T09:00:00',
          endTime: '2026-03-25T15:30:00+09:00',
        }),
      ],
      [
        'an end time that is only a year',
        'KR',
        krDay({
          startTime: '2026-03-25T09:00:00+09:00',
          endTime: '2026',
        }),
      ],
      [
        'a start time in a human format',
        'KR',
        krDay({
          startTime: 'Mar 25 2026 09:00:00 GMT+0900',
          endTime: '2026-03-25T15:30:00+09:00',
        }),
      ],
      // A window the clock can never be inside reads as PRE_OPEN all day and
      // rejects every MARKET order — a trading day in name only.
      [
        'a session that ends before it starts',
        'KR',
        krDay({
          startTime: '2026-03-25T15:30:00+09:00',
          endTime: '2026-03-25T09:00:00+09:00',
        }),
      ],
      [
        'a session that ends exactly when it starts',
        'KR',
        krDay({
          startTime: '2026-03-25T09:00:00+09:00',
          endTime: '2026-03-25T09:00:00+09:00',
        }),
      ],
    ];

    for (const [name, market, body] of cases) {
      it(`rejects ${name}`, async () => {
        await expect(decode(market, body)).rejects.toMatchObject({
          name: 'MarketDataError',
          code: 'UNSUPPORTED_DATA',
          message: expect.stringContaining('Invalid Toss calendar response'),
        });
      });
    }
  });
});
