import { describe, expect, it } from 'vitest';
import { matchesInstrument } from './hangul-match.js';

const samsung = { symbol: '005930', name: '삼성전자' };
const apple = { symbol: 'AAPL', name: 'Apple' };

describe('matchesInstrument', () => {
  it.each([
    ['삼성', samsung, true],
    ['삼서', samsung, true],
    ['ㅅㅅㅈㅈ', samsung, true],
    ['005930', samsung, true],
    ['apple', apple, true],
    ['  ', samsung, true],
    ['banana', samsung, false],
  ])('matches %j with the expected result', (query, instrument, expected) => {
    expect(matchesInstrument(query, instrument)).toBe(expected);
  });
});
