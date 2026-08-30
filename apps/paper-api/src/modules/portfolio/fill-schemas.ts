import type { Currency, DecimalString, Market, Side } from '@moi/trading-core';
import { z } from 'zod';

/** Fee is charged in the market's settlement currency (`currencyFor`). */
const CURRENCY_FOR: Readonly<Record<Market, Currency>> = {
  KR: 'KRW',
  US: 'USD',
};

/**
 * One executed fill, in the shape both the `ORDER_FILLED` event payload and
 * `GET /api/v1/fills` publish. One shape, one builder: the stream and the
 * catch-up endpoint cannot drift into describing the same fill differently.
 *
 * `fillSequence` is the pagination cursor and the ordering key. `accountSequence`
 * names the ORDER_FILLED event the fill was published in, so a client can align
 * a REST page with the stream position it already holds; it is null only for
 * fills written before the fill-history migration.
 */
export interface FillRecord {
  readonly id: string;
  readonly fillSequence: string;
  readonly accountSequence: string | null;
  readonly orderId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: DecimalString;
  readonly price: DecimalString;
  readonly fee: DecimalString;
  readonly feeCurrency: Currency;
  readonly isRecoveryFill: boolean;
  readonly occurredAt: string;
}

export interface FillFacts {
  readonly id: string;
  readonly fillSequence: string;
  readonly price: DecimalString;
  readonly quantity: DecimalString;
  readonly fee: DecimalString;
}

export interface FillContext {
  readonly orderId: string;
  readonly market: Market;
  readonly symbol: string;
  readonly side: Side;
  readonly accountSequence: string | null;
  readonly isRecoveryFill: boolean;
  readonly occurredAt?: string;
}

export function fillRecord(fill: FillFacts, context: FillContext): FillRecord {
  return {
    id: fill.id,
    fillSequence: fill.fillSequence,
    accountSequence: context.accountSequence,
    orderId: context.orderId,
    market: context.market,
    symbol: context.symbol,
    side: context.side,
    quantity: fill.quantity,
    price: fill.price,
    fee: fill.fee,
    feeCurrency: CURRENCY_FOR[context.market],
    isRecoveryFill: context.isRecoveryFill,
    occurredAt: context.occurredAt ?? new Date().toISOString(),
  };
}

/**
 * `after` is an exclusive `fillSequence`. It is a decimal integer string rather
 * than an opaque blob so an operator can read a cursor out of a log, and so a
 * client holding a stream position can turn it into a page request.
 */
export const fillsQuerySchema = z
  .object({
    after: z
      .string()
      .regex(/^\d+$/, 'after must be a fill sequence')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type FillsQuery = z.infer<typeof fillsQuerySchema>;

export interface FillsPage {
  readonly items: readonly FillRecord[];
  readonly nextCursor?: string;
}
