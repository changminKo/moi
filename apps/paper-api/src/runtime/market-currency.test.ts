import { createFeeModel, type Market } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_SCHEDULES } from '../config.js';
import { currencyFor as currencyForFillRecord } from '../modules/portfolio/fill-schemas.js';
import { feeModelFor } from './fee-schedule.js';
import { currencyFor as currencyForSettlement } from './fill-settlement.js';

/**
 * Which currency a market settles in is answered independently in several
 * places, and they are about to be folded into one. These pin what each of
 * them answers *before* the fold, so that "the refactor changed no behaviour"
 * is a thing the suite proves rather than a thing the diff looks like.
 *
 * Today's copies, all `market === 'KR' ? 'KRW' : 'USD'` written out again:
 *
 * | where | what it decides |
 * |---|---|
 * | `fill-settlement.ts` `currencyFor` | which wallet a fill locks and settles against |
 * | `fill-schemas.ts` `currencyFor` | `FillRecord.feeCurrency` on the event and `GET /api/v1/fills` |
 * | `order-placement-service.ts` (private) | the currency a cash reservation is held in |
 * | `fee-schedule.ts` | `FeeModel.currency` for the engine |
 * | `production-runtime.ts` | the currency of an order restored into the engine at startup |
 *
 * The last two of those are not importable — one is a module-private const,
 * the other is inline inside a private method — so they are pinned here
 * through the seams that do observe them, and the rest by the type checker
 * once they call the shared function.
 *
 * Why they must agree is not convention. The ledger adds a fee straight onto a
 * notional (`cost = Σ(price × quantity + fee)` in `fill-settlement.ts`) and
 * settles the sum against one wallet. `assertExactMoney` guards the precision
 * of that sum, not its units — two currencies added together produce a number
 * it accepts and the ledger is quietly wrong. `@moi/trading-core`'s fee model
 * already states the same rule as an invariant, which is the last test here.
 */

const MARKETS: readonly Market[] = ['KR', 'US'];
const EXPECTED: Readonly<Record<Market, 'KRW' | 'USD'>> = {
  KR: 'KRW',
  US: 'USD',
};

describe('the currency a market settles in, before it is folded into one place', () => {
  it.each(MARKETS)('settlement picks the %s wallet', (market) => {
    expect(currencyForSettlement(market)).toBe(EXPECTED[market]);
  });

  it.each(MARKETS)('a fill record reports %s the same way', (market) => {
    expect(currencyForFillRecord(market)).toBe(EXPECTED[market]);
    // The pair, not just each against a literal: the fold replaces both with
    // one call, and this is the line that says the replacement is a no-op.
    expect(currencyForFillRecord(market)).toBe(currencyForSettlement(market));
  });

  it.each(MARKETS)('the %s fee model is denominated the same way', (market) => {
    expect(feeModelFor(DEFAULT_FEE_SCHEDULES, market).currency).toBe(
      currencyForSettlement(market),
    );
  });

  it.each(MARKETS)(
    'trading-core refuses a %s fee model denominated in the other currency',
    (market) => {
      // Not a copy to fold in — the rule itself, already enforced one layer
      // down. It is pinned here because it is the reason the copies above have
      // to agree, and because a fold that broke it would fail loudly instead
      // of settling the wrong wallet in silence.
      expect(() =>
        createFeeModel({
          version: 'fees-v1',
          market,
          currency: market === 'KR' ? 'USD' : 'KRW',
          commissionRate: '0',
          sellTaxRate: '0',
          roundingDecimals: 2,
          roundingMode: 'HALF_UP',
        }),
      ).toThrow(/currency must match its market/i);
    },
  );
});
