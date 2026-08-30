import type { FillsPage, FillsQuery } from './fill-schemas.js';
import type {
  HistoricalOrdersPage,
  PortfolioQuery,
  PortfolioSnapshot,
} from './portfolio-schemas.js';

/**
 * The repository reads rows; it does not echo its own argument back. Naming the
 * session is the service's job (`snapshot` below), so the read type is the
 * response minus that field — which also keeps the required `sessionId` on
 * `PortfolioSnapshot` from being satisfiable by accident.
 */
export type PortfolioReadSnapshot = Omit<PortfolioSnapshot, 'sessionId'>;

export interface PortfolioReadTransaction {
  readonly snapshot: (sessionId: string) => Promise<PortfolioReadSnapshot>;
  readonly listOrders: (
    sessionId: string,
    query: PortfolioQuery,
  ) => Promise<HistoricalOrdersPage>;
  readonly getOrder: (
    sessionId: string,
    orderId: string,
  ) => Promise<Record<string, string | null> | undefined>;
  readonly listFills: (
    sessionId: string,
    query: FillsQuery,
  ) => Promise<FillsPage>;
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

  /**
   * The payload names the session it belongs to. A client holds its session in
   * a cookie the transport owns, so without this it cannot check that the
   * account it just read is the account it thinks it is — and a portfolio
   * silently belonging to another session is the one mix-up that must never
   * pass quietly. The value is the caller's own id, so naming it discloses
   * nothing the caller did not already hold.
   */
  async snapshot(sessionId: string): Promise<PortfolioSnapshot> {
    const snapshot = await this.#runSnapshot((tx) => tx.snapshot(sessionId));
    return { ...snapshot, sessionId };
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

  listFills(sessionId: string, query: FillsQuery): Promise<FillsPage> {
    return this.#runSnapshot((tx) => tx.listFills(sessionId, query));
  }
}
