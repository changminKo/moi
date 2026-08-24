import type {
  HistoricalOrdersPage,
  PortfolioQuery,
  PortfolioSnapshot,
} from './portfolio-schemas.js';

export interface PortfolioReadTransaction {
  readonly snapshot: (sessionId: string) => Promise<PortfolioSnapshot>;
  readonly listOrders: (
    sessionId: string,
    query: PortfolioQuery,
  ) => Promise<HistoricalOrdersPage>;
  readonly getOrder: (
    sessionId: string,
    orderId: string,
  ) => Promise<Record<string, string | null> | undefined>;
}

export interface PortfolioServiceDependencies {
  readonly runSnapshot?: <T>(
    work: (tx: PortfolioReadTransaction) => Promise<T>,
  ) => Promise<T>;
}

export interface PortfolioUnitOfWork {
  readonly run: <T>(
    work: (tx: { readonly portfolio: PortfolioReadTransaction }) => Promise<T>,
  ) => Promise<T>;
}

export function createPortfolioService(
  unitOfWork: PortfolioUnitOfWork,
): PortfolioService {
  return new PortfolioService({
    runSnapshot: (work) => unitOfWork.run((tx) => work(tx.portfolio)),
  });
}

export class PortfolioService {
  readonly #runSnapshot: <T>(
    work: (tx: PortfolioReadTransaction) => Promise<T>,
  ) => Promise<T>;

  constructor(dependencies: PortfolioServiceDependencies = {}) {
    this.#runSnapshot =
      dependencies.runSnapshot ??
      (async () => {
        throw new Error('portfolio read transaction is not configured');
      });
  }

  snapshot(sessionId: string): Promise<PortfolioSnapshot> {
    return this.#runSnapshot((tx) => tx.snapshot(sessionId));
  }

  listOrders(
    sessionId: string,
    query: PortfolioQuery,
  ): Promise<HistoricalOrdersPage> {
    return this.#runSnapshot((tx) => tx.listOrders(sessionId, query));
  }

  getOrder(
    sessionId: string,
    orderId: string,
  ): Promise<Record<string, string | null> | undefined> {
    return this.#runSnapshot((tx) => tx.getOrder(sessionId, orderId));
  }
}
