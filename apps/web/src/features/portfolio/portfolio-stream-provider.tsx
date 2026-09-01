import { createContext, type ReactNode, useContext } from 'react';
import type { PortfolioState } from './portfolio-store';
import { usePortfolioStream } from './use-portfolio-stream';

/**
 * One user-stream socket for the whole app.
 *
 * The stream used to be opened by `portfolio-page.tsx`, which meant fills only
 * existed while the reader was looking at the portfolio — and that a fill
 * arriving on the trade screen was seen by nobody. Hoisting it here is what
 * lets a toast announce a fill from either page, and it costs less than the
 * arrangement it replaces rather than more: navigating between the two pages
 * no longer tears the socket down and reconnects, and every connect replays
 * the outbox with a portfolio snapshot enriched onto every row.
 *
 * A second socket on the trade page was the alternative, and it would have
 * doubled exactly that replay work against the same session.
 */
export type PortfolioStreamValue = PortfolioState &
  Readonly<{ isLoading: boolean }>;

type StreamOptions = Parameters<typeof usePortfolioStream>[0];

const PortfolioStreamContext = createContext<PortfolioStreamValue | undefined>(
  undefined,
);

export function PortfolioStreamProvider({
  children,
  ...options
}: { children: ReactNode } & StreamOptions) {
  const value = usePortfolioStream(options);
  return (
    <PortfolioStreamContext.Provider value={value}>
      {children}
    </PortfolioStreamContext.Provider>
  );
}

export function usePortfolioStreamValue(): PortfolioStreamValue {
  const value = useContext(PortfolioStreamContext);
  if (!value)
    throw new Error(
      'usePortfolioStreamValue must be used inside PortfolioStreamProvider',
    );
  return value;
}
