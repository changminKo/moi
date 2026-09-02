export interface PortfolioSnapshot {
  /**
   * Required, as `GET /api/v1/portfolio` declares it. The client checks the
   * payload back against the session its transport holds, and this type used
   * to omit the field entirely while the server marked it required — the same
   * optional-here-required-there divergence spec §16.32 records, pointing the
   * other way.
   */
  readonly sessionId: string;
  readonly wallets: readonly Record<string, string>[];
  readonly positions: readonly Record<string, string>[];
  readonly reservations: readonly Record<string, string | boolean | null>[];
  readonly activeOrders: readonly Record<string, string | null>[];
  readonly accountSequence: string;
  readonly market: {
    readonly health: Readonly<Record<string, string>>;
    readonly recoveryFill: Readonly<Record<string, boolean>>;
  };
}

export type PortfolioFillViewModel = Readonly<{
  readonly market: string;
  readonly recoveryFill: boolean;
}>;

export function portfolioFillViewModel(
  snapshot: PortfolioSnapshot,
): readonly PortfolioFillViewModel[] {
  return Object.entries(snapshot.market.recoveryFill).map(
    ([market, recoveryFill]) => ({ market, recoveryFill }),
  );
}
