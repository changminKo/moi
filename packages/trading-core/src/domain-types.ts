export type DecimalString = string;

export type Quantity = DecimalString;

export type Currency = 'KRW' | 'USD';

export type Market = 'KR' | 'US';

export type Side = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT' | 'OCO';

export type OrderStatus =
  | 'RECEIVED'
  | 'PENDING_TRIGGER'
  | 'TRIGGERED'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REJECTED';

/**
 * The currency a market settles in.
 *
 * One derivation, here, because the ledger cannot survive two. A fill's fee is
 * added straight onto its notional — `cost = Σ(price × quantity + fee)` in
 * `fill-settlement.ts` — and the sum is settled against a single wallet.
 * `assertExactMoney` guards the precision of that sum, never its units: add
 * two currencies together and it returns a number the ledger accepts and is
 * quietly wrong about. `createFeeModel` already refuses a fee model whose
 * currency does not match its market; this is the same rule stated once as the
 * value, so the places that need it stop restating it.
 *
 * Not the same thing as the currency a provider quotes in. What Toss prices a
 * symbol in is a fact about Toss (`MARKET_CURRENCIES` in `@moi/market-data`);
 * which wallet we take the money out of is a fact about our ledger. They
 * happen to agree today, and nothing says they must — so they stay apart.
 */
export const currencyFor = (market: Market): Currency =>
  market === 'KR' ? 'KRW' : 'USD';

export interface Money {
  readonly currency: Currency;
  readonly amount: DecimalString;
}
