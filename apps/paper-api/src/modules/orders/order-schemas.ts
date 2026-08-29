import { z } from 'zod';

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/, 'must be a decimal string');
const common = {
  market: z.enum(['KR', 'US']),
  symbol: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  quantity: decimal,
};
export const placeOrderSchema = z
  .object({
    ...common,
    type: z.enum(['MARKET', 'LIMIT', 'STOP', 'TAKE_PROFIT', 'OCO']),
    limitPrice: decimal.optional(),
    stopPrice: decimal.optional(),
    timeInForce: z.enum(['DAY', 'GTC', 'IOC']).optional(),
    legs: z
      .array(
        z.object({
          ...common,
          type: z.enum(['LIMIT', 'STOP', 'TAKE_PROFIT']),
          limitPrice: decimal.optional(),
          stopPrice: decimal.optional(),
        }),
      )
      .length(2)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === 'MARKET' && (v.limitPrice || v.stopPrice))
      ctx.addIssue({
        code: 'custom',
        message: 'market orders do not accept prices',
      });
    if (v.type === 'LIMIT' && !v.limitPrice)
      ctx.addIssue({ code: 'custom', message: 'limitPrice is required' });
    if ((v.type === 'STOP' || v.type === 'TAKE_PROFIT') && !v.stopPrice)
      ctx.addIssue({ code: 'custom', message: 'stopPrice is required' });
    if (v.type === 'OCO' && !v.legs)
      ctx.addIssue({ code: 'custom', message: 'OCO requires two legs' });
  });
export const amendOrderSchema = z
  .object({
    quantity: decimal.optional(),
    limitPrice: decimal.optional(),
    stopPrice: decimal.optional(),
    timeInForce: z.enum(['DAY', 'GTC', 'IOC']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'amendment cannot be empty');
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
export type AmendOrderInput = z.infer<typeof amendOrderSchema>;
