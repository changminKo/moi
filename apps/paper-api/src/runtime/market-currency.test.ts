import { createFeeModel, currencyFor, type Market } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEE_SCHEDULES } from '../config.js';
import { fillRecord } from '../modules/portfolio/fill-schemas.js';
import { feeModelFor } from './fee-schedule.js';

/**
 * Which currency a market settles in used to be answered independently in five
 * places, each spelling out `market === 'KR' ? 'KRW' : 'USD'` again:
 *
 * | where | what it decides |
 * |---|---|
 * | `fill-settlement.ts` | which wallet a fill locks and settles against |
 * | `fill-schemas.ts` | the currency on the event payload and `GET /api/v1/fills` |
 * | `order-placement-service.ts` (private) | the currency a cash reservation is held in |
 * | `fee-schedule.ts` | `FeeModel.currency` for the engine |
 * | `production-runtime.ts` | an order restored into the engine at startup |
 *
 * They now all call `currencyFor` from `@moi/trading-core`. The expectations
 * below are the ones this file asserted before the fold, unchanged — that is
 * what makes "the refactor changed no behaviour" something the suite proves
 * rather than something the diff looks like. Two of the five had no importable
 * seam even then, so they are checked through what does observe them: the fee
 * model the engine is handed, and the fill record the event and the REST page
 * are built from. The settlement and reservation call sites are SQL, and are
 * held by the type checker plus the integration suites that exercise them.
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

describe('the one place that says which currency a market settles in', () => {
  it.each(MARKETS)('answers %s with the currency it always did', (market) => {
    expect(currencyFor(market)).toBe(EXPECTED[market]);
  });

  it.each(MARKETS)('the %s fee model is denominated the same way', (market) => {
    expect(feeModelFor(DEFAULT_FEE_SCHEDULES, market).currency).toBe(
      EXPECTED[market],
    );
  });

  it.each(MARKETS)('a %s fill record reports the same currency', (market) => {
    expect(
      fillRecord(
        {
          id: 'f-1',
          fillSequence: '1',
          price: '100',
          quantity: '1',
          fee: '0',
        },
        {
          orderId: 'o-1',
          market,
          symbol: 'X',
          side: 'BUY',
          accountSequence: '1',
          isRecoveryFill: false,
        },
      ).feeCurrency,
    ).toBe(EXPECTED[market]);
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
