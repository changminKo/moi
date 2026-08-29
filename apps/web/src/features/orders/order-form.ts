export type Side = 'BUY' | 'SELL';
export type OrderDraft =
  | { kind: 'MARKET'; side: Side; quantity: string }
  | { kind: 'LIMIT'; side: Side; quantity: string; limitPrice: string }
  | { kind: 'STOP'; side: Side; quantity: string; stopPrice: string }
  | { kind: 'TAKE_PROFIT'; side: Side; quantity: string; triggerPrice: string }
  | {
      kind: 'OCO';
      side: Side;
      quantity: string;
      takeProfitPrice: string;
      stopPrice: string;
    };

export type OrderRequest = Readonly<Record<string, unknown>>;
export type OrderFieldErrors = Partial<
  Record<
    | 'quantity'
    | 'limitPrice'
    | 'stopPrice'
    | 'triggerPrice'
    | 'takeProfitPrice',
    string
  >
>;
const integer = /^\d+$/;
const decimal = /^\d+(?:\.\d+)?$/;
const validPositiveInteger = (v: string) => integer.test(v) && Number(v) > 0;
const validPositiveDecimal = (v: string) => decimal.test(v) && Number(v) > 0;

export function validateOrderDraft(draft: OrderDraft): OrderFieldErrors {
  const errors: OrderFieldErrors = {};
  if (!validPositiveInteger(draft.quantity))
    errors.quantity = 'Quantity must be a positive whole number';
  if (draft.kind === 'LIMIT' && !validPositiveDecimal(draft.limitPrice))
    errors.limitPrice = 'Limit price is required';
  if (draft.kind === 'STOP' && !validPositiveDecimal(draft.stopPrice))
    errors.stopPrice = 'Stop price is required';
  if (draft.kind === 'TAKE_PROFIT' && !validPositiveDecimal(draft.triggerPrice))
    errors.triggerPrice = 'Trigger price is required';
  if (draft.kind === 'OCO') {
    if (!validPositiveDecimal(draft.takeProfitPrice))
      errors.takeProfitPrice = 'Take-profit price is required';
    if (!validPositiveDecimal(draft.stopPrice))
      errors.stopPrice = 'Stop price is required';
    if (
      draft.takeProfitPrice === draft.stopPrice &&
      validPositiveDecimal(draft.stopPrice)
    )
      errors.stopPrice = 'OCO triggers must differ';
  }
  return errors;
}

export function mapOrderDraft(
  draft: OrderDraft,
  instrument?: { market: 'KR' | 'US'; symbol: string },
): OrderRequest {
  const errors = validateOrderDraft(draft);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  const base = instrument
    ? { market: instrument.market, symbol: instrument.symbol }
    : {};
  switch (draft.kind) {
    case 'MARKET':
      return {
        ...base,
        type: 'MARKET',
        side: draft.side,
        quantity: draft.quantity,
      };
    case 'LIMIT':
      return {
        ...base,
        type: 'LIMIT',
        side: draft.side,
        quantity: draft.quantity,
        limitPrice: draft.limitPrice,
      };
    case 'STOP':
      return {
        ...base,
        type: 'STOP',
        side: draft.side,
        quantity: draft.quantity,
        stopPrice: draft.stopPrice,
      };
    case 'TAKE_PROFIT':
      return {
        ...base,
        type: 'TAKE_PROFIT',
        side: draft.side,
        quantity: draft.quantity,
        stopPrice: draft.triggerPrice,
      };
    case 'OCO':
      return {
        ...base,
        type: 'OCO',
        side: draft.side,
        quantity: draft.quantity,
        legs: [
          {
            ...(instrument ?? {}),
            type: 'LIMIT',
            side: draft.side,
            quantity: draft.quantity,
            limitPrice: draft.takeProfitPrice,
          },
          {
            ...(instrument ?? {}),
            type: 'STOP',
            side: draft.side,
            quantity: draft.quantity,
            stopPrice: draft.stopPrice,
          },
        ],
      };
  }
}
