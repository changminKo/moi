/**
 * The route registration the e2e harness hands to `buildApp`, lifted out of
 * `start-system.ts` so that file stays inside the 800-line budget (Codex
 * review of #25). Behaviour is unchanged: this is the same closure, with the
 * things it used to read from module scope arrived at through `deps`.
 *
 * It is a factory over `AppConfig` because the harness runs the same system
 * behind two listeners — one per deployment shape — and the CSRF rule
 * compares against the listener's own origin and secret (#25).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { AppConfig } from '../../paper-api/src/config.js';
import type { UnitOfWork } from '../../paper-api/src/db/unit-of-work.js';
import { registerFxRoutes } from '../../paper-api/src/modules/fx/fx-routes.js';
import type { FxService } from '../../paper-api/src/modules/fx/fx-service.js';
import { registerHealthRoutes } from '../../paper-api/src/modules/health/health-routes.js';
import { registerInstrumentRoutes } from '../../paper-api/src/modules/instruments/instrument-routes.js';
import { InstrumentService } from '../../paper-api/src/modules/instruments/instrument-service.js';
import { registerOrderRoutes } from '../../paper-api/src/modules/orders/order-routes.js';
import type { OrderService } from '../../paper-api/src/modules/orders/order-service.js';
import { registerPortfolioRoutes } from '../../paper-api/src/modules/portfolio/portfolio-routes.js';
import { registerSessionRoutes } from '../../paper-api/src/modules/session/session-routes.js';
import type {
  SessionPrincipal,
  SessionService,
} from '../../paper-api/src/modules/session/session-service.js';
import { requireCsrf } from '../../paper-api/src/plugins/csrf.js';

export type HarnessMode = 'NORMAL' | 'DEGRADED' | 'RECOVERING' | 'CANCEL_ONLY';
export type HarnessBook = Readonly<{
  bids: readonly { price: string; volume: string }[];
  asks: readonly { price: string; volume: string }[];
}>;

/**
 * The portfolio-snapshot instrumentation the control server reports on. The
 * counters and the barrier stay with the control API in `start-system.ts`;
 * these are the two moments the request lifecycle touches them.
 */
export type SnapshotProbe = Readonly<{
  /** A snapshot request was admitted: count it and wait for any held barrier. */
  enter: () => Promise<void>;
  /** It finished. */
  leave: () => void;
}>;

export type HarnessRouteDeps = Readonly<{
  pool: Pool;
  sessionService: SessionService;
  unitOfWork: UnitOfWork;
  orderService: OrderService;
  fxService: FxService;
  principal: (request: unknown) => Promise<SessionPrincipal>;
  /** Read per request: the control API moves the harness between modes. */
  mode: () => HarnessMode;
  /** Read per request: bumped whenever the control API publishes a book. */
  marketVersion: () => bigint;
  /** The live book map, shared with the control API by reference. */
  books: Map<string, HarnessBook>;
  health: () => Record<string, unknown>;
  snapshots: SnapshotProbe;
}>;

const isSnapshotRead = (request: FastifyRequest) =>
  request.method === 'GET' && request.url.startsWith('/api/v1/portfolio');

export function harnessRoutes(
  deps: HarnessRouteDeps,
): (instanceConfig: AppConfig) => (app: FastifyInstance) => Promise<void> {
  return (instanceConfig) => async (app) => {
    app.addHook('preHandler', async (request) => {
      if (isSnapshotRead(request)) await deps.snapshots.enter();
      if (
        request.method === 'POST' &&
        request.url.startsWith('/api/v1/sessions/anonymous')
      )
        return;
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
      // The production CSRF rule itself, not a copy of its condition (Codex
      // review of #25): each listener passes its own origin and secret, so
      // the cross-origin listener rejects the single-origin page's requests
      // the way production would.
      requireCsrf(request, await deps.principal(request), {
        secret: instanceConfig.csrfSecret,
        origin: instanceConfig.publicOrigin,
      });
    });
    app.addHook('onResponse', async (request) => {
      if (isSnapshotRead(request)) deps.snapshots.leave();
    });
    await registerSessionRoutes(app, deps.sessionService);
    await registerHealthRoutes(app, {
      db: async () => {
        await deps.pool.query('select 1');
        return true;
      },
      audit: () => true,
      marketData: () => ({ mode: deps.mode() }),
      trading: () => deps.health(),
    });
    await registerInstrumentRoutes(
      app,
      new InstrumentService({
        catalog: [
          {
            market: 'KR',
            symbol: '005930',
            name: 'Samsung Electronics',
            tradable: true,
            currency: 'KRW',
          },
          {
            market: 'US',
            symbol: 'AAPL',
            name: 'Apple',
            tradable: true,
            currency: 'USD',
          },
        ],
      }),
      // Mirrors `ProductionRuntime.#quote` field for field, including the
      // book: a harness that answers in a shape production never serves
      // cannot catch a wire/type mismatch, and this one used to answer
      // `bids`/`asks` spelled `size` — the web's spelling, not the wire's —
      // which is precisely why e2e stayed green through the crash.
      (market, symbol) => {
        const mode = deps.mode();
        const current = deps.books.get(`${market}:${symbol}`) ?? {
          bids: [{ price: market === 'KR' ? '69900' : '199', volume: '10' }],
          asks: [{ price: market === 'KR' ? '70000' : '200', volume: '10' }],
        };
        return {
          market,
          symbol,
          price: current.asks[0]?.price ?? null,
          asOf: new Date().toISOString(),
          health: mode === 'NORMAL' ? 'HEALTHY' : mode,
          recoveryEpoch: mode === 'NORMAL' ? '2' : '1',
          marketDataVersion: deps.marketVersion().toString(),
          currency: market === 'KR' ? 'KRW' : 'USD',
          bids: current.bids,
          asks: current.asks,
        };
      },
    );
    await registerPortfolioRoutes(app, {
      principal: deps.principal,
      unitOfWork: deps.unitOfWork,
    });
    await registerFxRoutes(app, deps.fxService, {
      principal: deps.principal,
      canFx: () => deps.mode() !== 'CANCEL_ONLY',
    });
    await registerOrderRoutes(app, {
      principal: deps.principal,
      service: deps.orderService,
    });
  };
}
