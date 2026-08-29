import { describe, expect, it } from 'vitest';
import { parseStreamQuery, StreamQueryError } from './stream-query.js';

const url = (query: string) =>
  new URL(`http://placeholder/api/v1/stream${query}`);

describe('parseStreamQuery', () => {
  it('accepts an empty query', () => {
    expect(parseStreamQuery(url(''))).toEqual({ quoteSymbols: [] });
  });
  it('accepts a decimal afterSequence within bigint range', () => {
    expect(parseStreamQuery(url('?afterSequence=0'))).toEqual({
      afterSequence: '0',
      quoteSymbols: [],
    });
    expect(parseStreamQuery(url('?afterSequence=2'))).toEqual({
      afterSequence: '2',
      quoteSymbols: [],
    });
    expect(
      parseStreamQuery(url(`?afterSequence=${'9'.repeat(19)}`)).afterSequence,
    ).toBe('9'.repeat(19));
  });
  it.each(['-1', '1.5', '%201', 'abc', '0'.repeat(2), '1'.repeat(20), ''])(
    'rejects afterSequence %j with 400',
    (value) => {
      expect(() => parseStreamQuery(url(`?afterSequence=${value}`))).toThrow(
        StreamQueryError,
      );
      try {
        parseStreamQuery(url(`?afterSequence=${value}`));
      } catch (error) {
        expect((error as StreamQueryError).statusCode).toBe(400);
        expect((error as StreamQueryError).code).toBe('BAD_REQUEST');
      }
    },
  );
  it('rejects duplicate keys', () => {
    expect(() =>
      parseStreamQuery(url('?afterSequence=1&afterSequence=2')),
    ).toThrow(StreamQueryError);
    expect(() =>
      parseStreamQuery(url('?quoteSymbols=US:AAPL&quoteSymbols=KR:005930')),
    ).toThrow(StreamQueryError);
  });
  it('parses canonical quote symbols', () => {
    expect(parseStreamQuery(url('?quoteSymbols=US:AAPL,KR:005930'))).toEqual({
      quoteSymbols: [
        { market: 'US', symbol: 'AAPL' },
        { market: 'KR', symbol: '005930' },
      ],
    });
  });
  it.each([
    'aapl',
    'US:aapl',
    'US:AAPL,US:AAPL',
    'US:AAPL,',
    ',US:AAPL',
    'JP:7203',
    'US:AAPL,US:MSFT,US:GOOG,US:AMZN,US:TSLA,US:NVDA',
    'US:A.B.C.D.E.F.G.H.I.J.K.L.M',
  ])('rejects quoteSymbols %j with 400', (value) => {
    expect(() => parseStreamQuery(url(`?quoteSymbols=${value}`))).toThrow(
      StreamQueryError,
    );
  });
  it('rejects requested symbols outside the allow list when one is supplied', () => {
    expect(() =>
      parseStreamQuery(url('?quoteSymbols=US:ZZZZ'), new Set(['US:AAPL'])),
    ).toThrow(StreamQueryError);
    expect(
      parseStreamQuery(url('?quoteSymbols=US:AAPL'), new Set(['US:AAPL']))
        .quoteSymbols,
    ).toHaveLength(1);
  });
  it('ignores unknown keys', () => {
    expect(parseStreamQuery(url('?foo=bar'))).toEqual({ quoteSymbols: [] });
  });
});
