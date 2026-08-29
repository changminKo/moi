import { z } from 'zod';
export const fxQuoteSchema = z
  .object({
    from: z.enum(['KRW', 'USD']),
    to: z.enum(['KRW', 'USD']),
    amount: z.string().regex(/^\d+(?:\.\d+)?$/),
  })
  .refine((v) => v.from !== v.to, 'Currencies must differ');
export type FxQuoteInput = z.infer<typeof fxQuoteSchema>;
