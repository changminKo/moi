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

export interface Money {
  readonly currency: Currency;
  readonly amount: DecimalString;
}
