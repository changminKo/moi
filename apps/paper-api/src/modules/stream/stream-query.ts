import type { Market } from '@moi/trading-core';
import { STREAM_MAX_QUOTE_SUBSCRIPTIONS } from './stream-session.js';

const AFTER_SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
const SYMBOL = /^[A-Z0-9.]{1,12}$/;
const MARKETS: ReadonlySet<string> = new Set(['KR', 'US']);

export class StreamQueryError extends Error {
  readonly statusCode = 400;
  readonly code = 'BAD_REQUEST';
}

export interface StreamQuery {
  readonly afterSequence?: string;
  readonly quoteSymbols: readonly { market: Market; symbol: string }[];
}

function single(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1)
    throw new StreamQueryError(`duplicate query key ${key}`);
  return values[0];
}

/**
 * The client→server protocol is the query string alone (§7.5). Parsing and
 * validation finish before any 101 is written; failures never upgrade.
 */
export function parseStreamQuery(
  url: URL,
  allowList?: ReadonlySet<string>,
): StreamQuery {
  const after = single(url, 'afterSequence');
  if (after !== undefined && !AFTER_SEQUENCE.test(after))
    throw new StreamQueryError('afterSequence must be a decimal sequence');
  const rawSymbols = single(url, 'quoteSymbols');
  const quoteSymbols: { market: Market; symbol: string }[] = [];
  if (rawSymbols !== undefined) {
    const seen = new Set<string>();
    for (const item of rawSymbols.split(',')) {
      const [market, symbol, ...rest] = item.split(':');
      if (
        rest.length > 0 ||
        market === undefined ||
        symbol === undefined ||
        !MARKETS.has(market) ||
        !SYMBOL.test(symbol)
      )
        throw new StreamQueryError(`invalid quote symbol ${item}`);
      const key = `${market}:${symbol}`;
      if (seen.has(key))
        throw new StreamQueryError(`duplicate quote symbol ${key}`);
      if (allowList !== undefined && !allowList.has(key))
        throw new StreamQueryError(`quote symbol ${key} is not tradable`);
      seen.add(key);
      quoteSymbols.push({ market: market as Market, symbol });
    }
    if (quoteSymbols.length > STREAM_MAX_QUOTE_SUBSCRIPTIONS)
      throw new StreamQueryError('too many quote symbols');
  }
  return after === undefined
    ? { quoteSymbols }
    : { afterSequence: after, quoteSymbols };
}
