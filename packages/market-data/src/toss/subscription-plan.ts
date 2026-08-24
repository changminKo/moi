import type { Market } from '@skipjack/trading-core';
import type { SubscriptionDeclaration } from '../types.js';

/** The bounded universe this adapter is permitted to subscribe to. */
export const TOSS_SYMBOL_WHITELIST = [
  'AAPL',
  'AMZN',
  'AVGO',
  'COST',
  'CSCO',
  'GOOGL',
  'INTC',
  'META',
  'MSFT',
  'NFLX',
  'NVDA',
  'QCOM',
  'TSLA',
  'AMD',
  'ADBE',
  'ADI',
  'AMAT',
  'ASML',
  'CMCSA',
  'CRWD',
  'GILD',
  'HON',
  'INTU',
  'ISRG',
  'LIN',
  'LRCX',
  'MAR',
  'MELI',
  'MU',
  'PANW',
  'PEP',
  'PLTR',
  'PYPL',
  'SBUX',
  'TMUS',
  'TXN',
  'V',
  'VRTX',
  'WMT',
  'XOM',
] as const;

export interface SubscriptionPlan {
  readonly market: Market;
  readonly declaration: readonly SubscriptionDeclaration[];
  readonly topicCount: number;
}

export function buildSubscriptionPlan(
  market: Market,
  symbols: readonly string[],
): SubscriptionPlan {
  const unique = [...new Set(symbols)];
  if (unique.length !== symbols.length || unique.length > 40) {
    throw new Error(
      'Toss subscription symbols must be unique and contain at most 40 symbols',
    );
  }
  const invalid = unique.filter(
    (s) => !(TOSS_SYMBOL_WHITELIST as readonly string[]).includes(s),
  );
  if (invalid.length > 0)
    throw new Error(`Unsupported Toss symbols: ${invalid.join(',')}`);
  const declaration = [
    { channel: 'trade' as const, market, symbols: unique },
    { channel: 'orderBook' as const, market, symbols: unique },
  ];
  return { market, declaration, topicCount: unique.length * 2 };
}
