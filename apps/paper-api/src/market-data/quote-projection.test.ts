import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  projectQuote,
  QUOTE_PROJECTION_FIELDS,
  type QuoteProjectionInput,
} from './quote-projection.js';
import type { SymbolQuoteState } from './symbol-quote-state.js';

const BOOK = {
  market: 'US' as const,
  symbol: 'AAPL',
  currency: 'USD' as const,
  bids: [{ price: '316.44', volume: '80' }],
  asks: [{ price: '316.65', volume: '40' }],
};

const AT = new Date('2026-09-01T14:02:03.000Z');

const input = (
  state: SymbolQuoteState | undefined,
  overrides: Partial<QuoteProjectionInput> = {},
): QuoteProjectionInput => ({
  market: 'US',
  symbol: 'AAPL',
  state,
  health: 'HEALTHY',
  recoveryEpoch: 17n,
  marketDataVersion: 87_850n,
  now: () => AT,
  ...overrides,
});

describe('projectQuote', () => {
  it('states the price, the instant and the book in one object', () => {
    expect(projectQuote(input({ book: BOOK }))).toEqual({
      market: 'US',
      symbol: 'AAPL',
      price: '316.65',
      asOf: '2026-09-01T14:02:03.000Z',
      health: 'HEALTHY',
      recoveryEpoch: '17',
      marketDataVersion: '87850',
      currency: 'USD',
      bids: BOOK.bids,
      asks: BOOK.asks,
    });
  });

  it('prefers the last trade over the book for the displayed price (§16.33)', () => {
    const state: SymbolQuoteState = {
      book: BOOK,
      lastTrade: { price: '316.50', sourceTimestamp: null },
    };

    expect(projectQuote(input(state)).price).toBe('316.50');
  });

  it('states a null price for an empty slot instead of inventing one', () => {
    expect(projectQuote(input(undefined)).price).toBeNull();
  });

  it('omits the book-derived fields entirely when there is no book', () => {
    const projected = projectQuote(
      input({
        lastTrade: { price: '316.50', sourceTimestamp: null },
      }),
    );

    // Omitted, not emptied: a consumer merging this onto a snapshot must not
    // read it as "the depth is now gone".
    expect('bids' in projected).toBe(false);
    expect('asks' in projected).toBe(false);
    expect('currency' in projected).toBe(false);
  });

  it('stringifies the version fields — never a JSON number', () => {
    const projected = projectQuote(input({ book: BOOK }));

    expect(projected.recoveryEpoch).toBe('17');
    expect(projected.marketDataVersion).toBe('87850');
    expect(typeof projected.price).toBe('string');
  });

  it('carries the health it is given', () => {
    expect(
      projectQuote(input({ book: BOOK }, { health: 'DEGRADED' })).health,
    ).toBe('DEGRADED');
  });

  it('produces no field outside the documented set', () => {
    expect(
      Object.keys(projectQuote(input({ book: BOOK }))).every((key) =>
        (QUOTE_PROJECTION_FIELDS as readonly string[]).includes(key),
      ),
    ).toBe(true);
  });
});

describe('docs/api/quote-contract.md', () => {
  const contract = readFileSync(
    resolve(import.meta.dirname, '../../../../docs/api/quote-contract.md'),
    'utf8',
  );

  it('documents exactly the fields the projection states', () => {
    const documented = [...contract.matchAll(/^\| `([a-zA-Z]+)` \| /gm)].map(
      (match) => match[1] as string,
    );

    expect(documented.sort()).toEqual([...QUOTE_PROJECTION_FIELDS].sort());
  });

  it('states the two rules that the crash came from', () => {
    // `volume`, not `size`, and omitted rather than emptied. Both are load
    // bearing for the browser and both were unwritten before §16.36.
    expect(contract).toContain('The quantity field is `volume`');
    expect(contract).toContain('are omitted, not emptied,');
  });
});
