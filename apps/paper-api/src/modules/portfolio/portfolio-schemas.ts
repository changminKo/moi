import { z } from 'zod';

export const portfolioQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type PortfolioQuery = z.infer<typeof portfolioQuerySchema>;

/**
 * What `GET /api/v1/portfolio` returns. `sessionId` is required: a client holds
 * its session in a cookie its transport owns and checks the payload back
 * against it, and an optional field here with a required one there is exactly
 * how the SDK and this API drifted apart before (spec §16.32).
 */
export interface PortfolioSnapshot {
  readonly sessionId: string;
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
