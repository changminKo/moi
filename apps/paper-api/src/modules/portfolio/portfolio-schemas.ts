import { z } from 'zod';

export const portfolioQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type PortfolioQuery = z.infer<typeof portfolioQuerySchema>;

export interface PortfolioSnapshot {
  readonly wallets: readonly Record<string, string>[];
  readonly positions: readonly Record<string, string>[];
  readonly reservations: readonly Record<string, string | boolean | null>[];
  readonly activeOrders: readonly Record<string, unknown>[];
  readonly accountSequence: string;
  readonly market: {
    readonly health: Readonly<Record<string, string>>;
    readonly recoveryFill: Readonly<Record<string, boolean>>;
  };
}

export interface HistoricalOrdersPage {
  readonly items: readonly Record<string, string | null>[];
  readonly nextCursor?: string;
}
