import { randomUUID } from 'node:crypto';
import type { Market } from '@skipjack/trading-core';
import { createFeeModel, DomainError } from '@skipjack/trading-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { buildApp } from '../app.js';
import type { AppConfig } from '../config.js';
import { createDatabase, type Database } from '../db/database.js';
import { migrateToLatest } from '../db/migrate.js';
import { type TradingTransaction, UnitOfWork } from '../db/unit-of-work.js';
import { PaperEngine } from '../engine/paper-engine.js';
import { ShutdownCoordinator } from '../lifecycle/shutdown-coordinator.js';
import { StartupCoordinator } from '../lifecycle/startup-coordinator.js';
import { MarketHealthMachine } from '../market-data/health-machine.js';
import { MarketStateStore } from '../market-data/market-state-store.js';
import { registerAdminRoutes } from '../modules/admin/admin-routes.js';
import { registerFxRoutes } from '../modules/fx/fx-routes.js';
import { FxService } from '../modules/fx/fx-service.js';
import { registerHealthRoutes } from '../modules/health/health-routes.js';
import { registerInstrumentRoutes } from '../modules/instruments/instrument-routes.js';
import { InstrumentService } from '../modules/instruments/instrument-service.js';
import { OrderPlacementService } from '../modules/orders/order-placement-service.js';
import { registerOrderRoutes } from '../modules/orders/order-routes.js';
import { OrderService } from '../modules/orders/order-service.js';
import { registerPortfolioRoutes } from '../modules/portfolio/portfolio-routes.js';
import { registerSessionRoutes } from '../modules/session/session-routes.js';
import {
  createUnitOfWorkSessionStore,
  SessionService,
} from '../modules/session/session-service.js';
import { SESSION_COOKIE } from '../modules/session/session-token.js';
import {
  claimPendingOutbox,
  markOutboxPublished,
  OutboxPublisher,
  prunePublishedOutbox,
} from '../modules/stream/outbox-publisher.js';
import { OutboxPublisherLoop } from '../modules/stream/outbox-publisher-loop.js';
import { StreamHeartbeatLoop } from '../modules/stream/stream-heartbeat-loop.js';
import { StreamHub } from '../modules/stream/stream-hub.js';
import { registerStreamRoutes } from '../modules/stream/stream-routes.js';
import {
  createStreamUpgradeHandler,
  type StreamUpgradeHandler,
} from '../modules/stream/stream-upgrade.js';
import { MetricsRegistry } from '../observability/metrics.js';
import { requireCsrf } from '../plugins/csrf.js';
import { LayeredRateLimiter } from '../plugins/rate-limits.js';
import { cookieValue } from '../plugins/session-auth.js';
import type { Capability, SafetyIncident } from '../safety/capabilities.js';
import { createDbIncidentRepository } from '../safety/incident-db-repository.js';
import { IncidentService } from '../safety/incident-service.js';
import { AdmissionLatch } from './admission-latch.js';
import { createFillPersistence } from './fill-persistence.js';
import { leaseAuditPort } from './lease-audit.js';
import { LeaseRegistry } from './lease-registry.js';
import { verifyLedgerInvariants } from './ledger-invariants.js';
import { MarketRuntime } from './market-runtime.js';
import { createOutboxEventSource } from './outbox-event-source.js';
import type { FakeProviderBundle, ProviderBundle } from './provider-bundle.js';
import { ReconnectSupervisor } from './reconnect-supervisor.js';
import { RequestAdmissionGate } from './request-admission-gate.js';
import { type RuntimeState, RuntimeStateMachine } from './runtime-state.js';
import { TradingCapabilities } from './trading-capabilities.js';

export type RuntimePhaseSpy = (phase: RuntimeState) => void;
type LogFn = (event: string, fields: Record<string, unknown>) => void;
type ShutdownSpy = (step: string) => () => void;

const MARKETS: readonly Market[] = ['KR', 'US'];
/**
 * After losing a lease the process yields for longer than one lease poll
 * interval before re-acquiring, so a successor already polling (§6.5, §10.2-10)
 * wins the bundle instead of the loser flapping back into leadership.
 */
const REELECTION_YIELD_MS = 1_000;
const MARKET_DENIED: readonly Capability[] = [
  'PLACE',
  'AMEND',
  'MATCH',
  'TRIGGER',
];
const MANUAL_CAUSES = new Set([
  'STARTUP_INVARIANT_OR_AUDIT_FAILURE',
  'RECOVERY_RETRY_EXHAUSTED',
]);
const HEALTH_LABEL: Record<string, string> = {
  HEALTHY: 'NORMAL',
  DEGRADED: 'DEGRADED',
  RECOVERING: 'RECOVERING',
};

export interface ProductionRuntimeOptions {
  readonly config: AppConfig;
  readonly bundle: ProviderBundle;
  readonly leaderId?: string;
  /** Register SIGTERM/SIGINT handlers (default true; tests pass false). */
  readonly signals?: boolean;
  readonly log?: LogFn;
  readonly phaseSpy?: RuntimePhaseSpy;
  readonly verifyInvariants?: (db: Database) => Promise<void>;
  readonly symbols?: Readonly<Record<Market, readonly string[]>>;
}

/** UnitOfWork that counts in-flight transactions so shutdown can drain them (§6.6-3). */
class CountingUnitOfWork extends UnitOfWork {
  #inFlight = 0;
  get inFlight(): number {
    return this.#inFlight;
  }
  override async run<T>(
    work: (tx: TradingTransaction) => Promise<T>,
  ): Promise<T> {
    this.#inFlight += 1;
    try {
      return await super.run(work);
    } finally {
      this.#inFlight -= 1;
    }
  }
  /** Counts a non-UnitOfWork ledger transaction (fills, FX) toward the drain. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.#inFlight += 1;
    try {
      return await work();
    } finally {
      this.#inFlight -= 1;
    }
  }
  async drain(deadline: number): Promise<number> {
    while (this.#inFlight > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    return this.#inFlight;
  }
}

/** Static virtual FX table for the paper ledger (fee-free, §2.1 virtual FX). */
const FX_RATES: Readonly<Record<string, string>> = {
  'KRW:USD': '0.0007',
  'USD:KRW': '1428.57',
};

function defaultLog(event: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      level: 'info',
      event,
      ...fields,
      at: new Date().toISOString(),
    }),
  );
}

async function defaultVerifyInvariants(db: Database): Promise<void> {
  await verifyLedgerInvariants(db);
}

/**
 * The single production composition root (§4). Owns the lifecycle state
 * machine, the lease bundle, both market runtimes, the single-owner outbox
 * publisher, the user-stream bridge, and the shutdown sequence.
 */
export class ProductionRuntime {
  readonly leaderId: string;
  readonly state: RuntimeStateMachine;
  readonly metrics = new MetricsRegistry();
  readonly hub: StreamHub;
  readonly publisher: OutboxPublisherLoop;
  readonly leases: LeaseRegistry;
  readonly markets = new Map<Market, MarketRuntime>();
  readonly listening: Promise<void>;
  /** Test seam: records the order of shutdown steps. */
  shutdownSpy: ShutdownSpy | undefined;
  port = 0;

  readonly #o: ProductionRuntimeOptions;
  readonly #log: LogFn;
  readonly #db: Database;
  readonly #uow: CountingUnitOfWork;
  readonly #admission = new AdmissionLatch();
  readonly #matching = new Map<Market, AdmissionLatch>();
  readonly #incidents: IncidentService;
  readonly #capabilities: TradingCapabilities;
  readonly #gate: RequestAdmissionGate;
  readonly #heartbeat: StreamHeartbeatLoop;
  readonly #controller = new AbortController();
  readonly #processSupervisor: ReconnectSupervisor;
  readonly #engines = new Map<Market, PaperEngine>();
  readonly #stores = new Map<Market, MarketStateStore>();
  #resolveListening: () => void = () => undefined;
  #app: FastifyInstance | undefined;
  #bridge: StreamUpgradeHandler | undefined;
  #activeIncidents: readonly SafetyIncident[] = [];
  #reelecting: Promise<void> | null = null;
  #stopping: Promise<{ forced: boolean }> | null = null;
  #draining = false;
  #acquiring: Promise<void> | null = null;
  readonly #pendingAudits = new Set<Promise<void>>();
  #databaseDestroyed = false;

  constructor(options: ProductionRuntimeOptions) {
    this.#o = options;
    this.#log = options.log ?? defaultLog;
    this.leaderId = options.leaderId ?? randomUUID();
    this.listening = new Promise<void>((resolve) => {
      this.#resolveListening = resolve;
    });
    this.#db = createDatabase(options.config.databaseUrl);
    this.#uow = new CountingUnitOfWork(this.#db, {
      backoff: async (attempt) => {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(10 * 2 ** (attempt - 1), 100)),
        );
      },
    });
    this.#incidents = new IncidentService({
      repository: createDbIncidentRepository(this.#db, {
        manualCauseCodes: MANUAL_CAUSES,
      }),
      appendAudit: ({ eventType, payload }) => this.#audit(eventType, payload),
    });
    this.#capabilities = new TradingCapabilities({
      latch: this.#admission,
      activeIncidents: () => this.#activeIncidents,
    });
    this.#gate = new RequestAdmissionGate({
      metrics: this.metrics,
      log: this.#log,
    });
    this.hub = new StreamHub({ metrics: this.metrics, log: this.#log });
    this.#heartbeat = new StreamHeartbeatLoop({ hub: this.hub });
    for (const market of MARKETS)
      this.#matching.set(market, new AdmissionLatch());
    const publisher = new OutboxPublisher({
      claim: (limit) => {
        this.claimOutboxForTest();
        return this.#db
          .transaction()
          .execute((trx) => claimPendingOutbox(trx, limit));
      },
      markPublished: (id) =>
        this.#db.transaction().execute((trx) => markOutboxPublished(trx, id)),
      publish: (event) => this.hub.deliver(event.sessionId, event),
      metrics: this.metrics,
    });
    this.publisher = new OutboxPublisherLoop({
      publisher,
      prune: () =>
        this.#db.transaction().execute((trx) => prunePublishedOutbox(trx)),
      metrics: this.metrics,
      log: this.#log,
      pendingCount: async () =>
        Number(
          (
            await sql<{
              n: number;
            }>`select count(*)::int as n from outbox_events where published_at is null`.execute(
              this.#db,
            )
          ).rows[0]?.n ?? 0,
        ),
    });
    this.state = new RuntimeStateMachine(
      {
        openLatches: () => {
          this.#admission.open();
          for (const latch of this.#matching.values()) latch.open();
        },
        closeLatches: () => {
          this.#admission.close();
          for (const latch of this.#matching.values()) latch.close();
        },
        publisher: this.publisher,
      },
      {
        onTransition: (from, to) => {
          this.metrics.gauge('runtime_state', 0, { state: from });
          this.metrics.gauge('runtime_state', 1, { state: to });
          this.#log('runtime.state', { from, to, leaderId: this.leaderId });
          options.phaseSpy?.(to);
          const audit = this.#audit('RUNTIME_STATE_CHANGED', {
            from,
            to,
            leaderId: this.leaderId,
          })
            .catch(() => undefined)
            .finally(() => this.#pendingAudits.delete(audit));
          this.#pendingAudits.add(audit);
        },
      },
    );
    this.leases = new LeaseRegistry({
      connectionString: options.config.databaseUrl,
      leaderId: this.leaderId,
      audit: leaseAuditPort,
      onLostHeld: (market) => {
        void this.reelect({ lostMarket: market }).catch((error: unknown) => {
          this.#log('runtime.reelect_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      phase: () =>
        this.state.current === 'SERVING'
          ? 'SERVING'
          : this.state.current === 'RECOVERING'
            ? 'RECOVERING'
            : 'ACQUIRING',
      log: this.#log,
      metrics: this.metrics,
    });
    this.#processSupervisor = new ReconnectSupervisor({
      delayMs: () => 250,
      onExhausted: async () => {
        try {
          await this.#incidents.activate({
            scope: { type: 'GLOBAL', id: '*' },
            denied: MARKET_DENIED,
            causeCode: 'RECOVERY_RETRY_EXHAUSTED',
          });
          await this.#refreshIncidents();
        } catch (error) {
          // The database may be what is down; stay alive in CANCEL_ONLY.
          this.#log('runtime.incident_write_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    });
    for (const market of MARKETS) this.#buildMarket(market);
    options.phaseSpy?.('BOOTING');
  }

  /** The market's paper engine (test/diagnostic access). */
  engineFor(market: Market): PaperEngine {
    const engine = this.#engines.get(market);
    if (engine === undefined) throw new Error(`missing ${market} paper engine`);
    return engine;
  }

  /** Test seam: invoked synchronously on every outbox claim. */
  claimOutboxForTest(): void {
    /* spy hook */
  }

  get incidents(): IncidentService {
    return this.#incidents;
  }

  async start(): Promise<{ app: FastifyInstance; port: number }> {
    const { config } = this.#o;
    try {
      await migrateToLatest(this.#db);
      const app = await this.#buildApp();
      this.#app = app;
      this.#gate.open();
      await app.listen({ host: config.host, port: config.port });
      const address = app.server.address();
      this.port =
        typeof address === 'object' && address ? address.port : config.port;
      this.#heartbeat.start();
      this.#resolveListening();
      if (this.#o.signals !== false) {
        const onSignal = (): void => {
          void this.stop().then(() => process.exit(0));
        };
        process.once('SIGTERM', onSignal);
        process.once('SIGINT', onSignal);
      }
      const startup = new StartupCoordinator({
        admission: this.#admission,
        restore: async () => {
          this.state.transition('RESTORING');
          await this.#refreshIncidents();
          const restored = await this.#restoreOpenOrders();
          this.#log('runtime.restored', {
            leaderId: this.leaderId,
            ...restored,
          });
          return restored;
        },
        verifyInvariants: async () => {
          await (this.#o.verifyInvariants ?? defaultVerifyInvariants)(this.#db);
        },
        acquireLeases: async (signal) => {
          this.state.transition('ACQUIRING_LEASES');
          await this.#acquireBundle(signal);
        },
        recover: async (market, signal) => {
          if (this.state.current !== 'RECOVERING')
            this.state.transition('RECOVERING');
          await this.markets.get(market)?.connect(signal);
        },
        incidents: {
          activate: async ({ causeCode }) => {
            await this.#incidents.activate({
              scope: { type: 'GLOBAL', id: '*' },
              denied: [...MARKET_DENIED, 'RECOVER'],
              causeCode,
            });
            await this.#refreshIncidents();
          },
        },
        signal: this.#controller.signal,
      });
      try {
        await this.#openWithLatches(startup);
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError')
          return { app, port: this.port };
        this.state.transition('FAILED_CLOSED');
        throw error;
      }
      if (this.#controller.signal.aborted) return { app, port: this.port };
      this.state.enterServing();
      return { app, port: this.port };
    } catch (error) {
      if (
        this.state.current !== 'FAILED_CLOSED' &&
        this.state.current !== 'STOPPED'
      ) {
        this.#log('runtime.start_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  /** §6.5 global re-election; concurrent calls join the in-flight one. */
  reelect(reason: { lostMarket: Market }): Promise<void> {
    if (this.#reelecting) return this.#reelecting;
    if (this.#stopping) return Promise.resolve();
    this.#reelecting = this.#runReelection(reason).finally(() => {
      this.#reelecting = null;
    });
    return this.#reelecting;
  }

  stop(): Promise<{ forced: boolean }> {
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#runStop();
    return this.#stopping;
  }

  // ---------------------------------------------------------------------------

  async #openWithLatches(startup: StartupCoordinator): Promise<void> {
    // StartupCoordinator opens the admission latch itself; enterServing() is the
    // single synchronous place where latches, gate and publisher flip together,
    // so we close them again right after and let enterServing reopen them.
    await startup.open(this.#controller.signal);
    this.#admission.close();
    for (const latch of this.#matching.values()) latch.close();
  }

  async #acquireBundle(signal: AbortSignal): Promise<void> {
    if (this.#acquiring) return this.#acquiring;
    this.#acquiring = (async () => {
      for (;;) {
        if (signal.aborted || this.#stopping)
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        try {
          await this.leases.acquireAll(signal);
          this.#processSupervisor.reset();
          for (const market of MARKETS)
            this.metrics.gauge('leader_lease_held', 1, { market });
          return;
        } catch (error) {
          if (
            (error as { name?: string })?.name === 'AbortError' ||
            signal.aborted
          )
            throw error;
          this.#log('lease.acquire_failed', {
            error: error instanceof Error ? error.message : String(error),
          });
          const exhausted = this.#processSupervisor.recordFailure();
          if (exhausted) throw error;
          await new Promise<void>((resolve) => {
            this.#processSupervisor.schedule(
              async () => {
                resolve();
                return true;
              },
              { immediate: true },
            );
          });
        }
      }
    })().finally(() => {
      this.#acquiring = null;
    });
    return this.#acquiring;
  }

  async #runReelection(reason: { lostMarket: Market }): Promise<void> {
    const surviving = MARKETS.find((m) => m !== reason.lostMarket) as Market;
    const pendingPoll = this.state.leaveServing('RE_ELECTING');
    this.#log('runtime.reelect', {
      lostMarket: reason.lostMarket,
      survivingMarket: surviving,
      leaderId: this.leaderId,
    });
    await pendingPoll?.catch(() => undefined);
    for (const runtime of this.markets.values()) runtime.abort();
    for (const market of MARKETS)
      await this.#o.bundle
        .streamFor(market)
        .close()
        .catch(() => undefined);
    // Each step runs regardless of the previous one failing (§6.5); the
    // database itself may be unreachable while we tear down.
    const safely = async (step: string, work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        this.#log('runtime.reelect_step_failed', {
          step,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    // Release the surviving lease right after the sockets close and before any
    // incident write: the successor must never see this process holding one
    // market while the DB round-trips for incidents complete (§6.5-5).
    await safely('abort_pending', () => this.leases.abortPending());
    await safely('release_all', () => this.leases.releaseAll());
    await safely('lost_incident', async () =>
      this.markets.get(reason.lostMarket)?.health.onClose('LEADER_LEASE_LOST'),
    );
    await safely('bundle_incident', async () =>
      this.markets.get(surviving)?.health.onClose('LEADER_BUNDLE_BROKEN'),
    );
    await safely('refresh_incidents', () => this.#refreshIncidents());
    if (this.#stopping) return;
    this.state.transition('ACQUIRING_LEASES');
    try {
      await new Promise<void>((resolveYield) => {
        const timer = setTimeout(resolveYield, REELECTION_YIELD_MS);
        this.#controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolveYield();
          },
          { once: true },
        );
      });
      if (this.#controller.signal.aborted || this.#stopping) return;
      await this.#acquireBundle(this.#controller.signal);
      if (this.#controller.signal.aborted) return;
      this.state.transition('RECOVERING');
      await Promise.all(
        MARKETS.map((market) =>
          this.markets.get(market)?.connect(this.#controller.signal),
        ),
      );
      if (this.#controller.signal.aborted) return;
      this.state.enterServing();
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return;
      this.#log('runtime.reelect_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #runStop(): Promise<{ forced: boolean }> {
    const spy = (step: string): (() => void) =>
      this.shutdownSpy?.(step) ?? (() => undefined);
    const deadlineMs = this.#o.config.shutdownDrainDeadlineMs;
    let deadline = Date.now() + deadlineMs;
    let pendingPoll: Promise<unknown> | null = null;
    const coordinator = new ShutdownCoordinator({
      deadlineMs,
      cancelOnly: () => {
        spy('cancelOnly')();
        this.#draining = true;
        pendingPoll = this.state.leaveServing('DRAINING');
        deadline = Date.now() + deadlineMs;
        void this.#audit('RUNTIME_DRAINING', {
          leaderId: this.leaderId,
          leftFrom: this.state.leftFrom,
        }).catch(() => undefined);
      },
      admission: {
        close: () => {
          spy('gate.close')();
          this.#gate.close();
        },
      },
      drainInflight: async (until) => {
        spy('gate.drain')();
        await this.#gate.drain(until);
        spy('uow.drain')();
        await this.#uow.drain(until);
      },
      drainOutbox: async (until) => {
        spy('pendingPoll')();
        await pendingPoll?.catch(() => undefined);
        if (this.state.leftFrom === 'SERVING') {
          spy('shutdownDrain')();
          await this.publisher.shutdownDrain(until);
        } else {
          this.#log('outbox.drain', {
            skipped: true,
            leftFrom: this.state.leftFrom,
          });
        }
      },
      closeSockets: async () => {
        spy('closeSockets')();
        this.#controller.abort();
        for (const runtime of this.markets.values()) runtime.abort();
        for (const market of MARKETS)
          await this.#o.bundle
            .streamFor(market)
            .close()
            .catch(() => undefined);
        this.#heartbeat.stop();
        this.#bridge?.detach();
        await this.#bridge?.closeAll(1012, 'SERVICE_RESTART');
      },
      releaseLeases: async () => {
        spy('abortPending')();
        await this.leases.abortPending();
        spy('releaseAll')();
        await this.leases.releaseAll();
        for (const market of MARKETS)
          this.metrics.gauge('leader_lease_held', 0, { market });
      },
    });
    await coordinator.drain();
    const forced = Date.now() > deadline;
    if (forced) this.metrics.counter('shutdown_forced_total');
    this.state.transition('STOPPED');
    await Promise.all([...this.#pendingAudits]);
    await this.#audit('RUNTIME_STOPPED', {
      leaderId: this.leaderId,
      forced,
    }).catch(() => undefined);
    await this.#app?.close();
    await this.#o.bundle.close().catch(() => undefined);
    this.#databaseDestroyed = true;
    await this.#db.destroy();
    return { forced };
  }

  #buildMarket(market: Market): void {
    const store = new MarketStateStore();
    this.#stores.set(market, store);
    const persistFill = createFillPersistence({
      db: this.#db,
      log: this.#log,
      onTransaction: (work) => this.#uow.track(work),
    });
    const engine = new PaperEngine({
      feeModel: createFeeModel({
        version: `runtime-${market}`,
        market,
        currency: market === 'US' ? 'USD' : 'KRW',
        commissionRate: '0',
        sellTaxRate: '0',
        roundingDecimals: 2,
        roundingMode: 'HALF_UP',
      }),
      isGateExclusive: () => this.#matching.get(market)?.isClosed === true,
      currentFencingToken: (m) => {
        try {
          return this.leases.held(m).fencingToken;
        } catch {
          return -1n;
        }
      },
      onFill: persistFill,
    });
    this.#engines.set(market, engine);
    const health = new MarketHealthMachine({
      market,
      incidents: {
        activate: async ({ causeCode, recoveryEpoch }) => {
          const incident = await this.#incidents.activate({
            scope: { type: 'MARKET', id: market },
            denied: MARKET_DENIED,
            causeCode,
            recoveryEpoch,
          });
          await this.#refreshIncidents();
          return { incidentId: incident.incidentId, version: incident.version };
        },
        resolveCas: async ({ incidentId, version }) => {
          // The health machine activates with a null epoch and resolves with the
          // recovered epoch; the service's CAS compares the stored epoch, so the
          // version check carries the optimistic-lock semantics here.
          const current = (await this.#incidents.active()).find(
            (i) => i.incidentId === incidentId,
          );
          if (current === undefined) return true;
          const resolved = await this.#incidents.resolveCas({
            incidentId,
            version,
            recoveryEpoch: current.recoveryEpoch,
          });
          await this.#refreshIncidents();
          return resolved !== undefined;
        },
      },
    });
    const symbols = (this.#o.symbols ?? this.#o.bundle.symbols)[market];
    const runtime = new MarketRuntime({
      market,
      stream: this.#o.bundle.streamFor(market),
      snapshots: this.#o.bundle.snapshots,
      ...(this.#o.bundle.tokenProvider
        ? { tokenProvider: this.#o.bundle.tokenProvider }
        : {}),
      stateStore: store,
      health,
      engine,
      hub: this.hub,
      incidents: {
        activate: async (input) => {
          await this.#incidents.activate({
            scope: input.symbol
              ? { type: 'SYMBOL', id: `${market}:${input.symbol}` }
              : { type: 'MARKET', id: market },
            denied: MARKET_DENIED,
            causeCode: input.causeCode,
            recoveryEpoch: input.recoveryEpoch,
          });
          await this.#refreshIncidents();
        },
      },
      leases: this.leases,
      symbols,
      subscriptions: [
        { channel: 'orderBook', market, symbols },
        { channel: 'trade', market, symbols },
      ],
      stabilityMs: this.#o.config.recoveryStabilityMs,
      metrics: this.metrics,
      log: this.#log,
    });
    this.markets.set(market, runtime);
  }

  async #buildApp(): Promise<FastifyInstance> {
    const { config } = this.#o;
    const sessionService = new SessionService({
      keys: config.sessionHashKeys,
      csrfSecret: config.csrfSecret,
      store: createUnitOfWorkSessionStore(this.#uow),
      secureCookie: config.nodeEnv !== 'test',
    });
    const principal = async (request: unknown) => {
      const token = cookieValue(request as FastifyRequest, SESSION_COOKIE);
      if (token === undefined)
        throw Object.assign(new Error('session is required'), {
          code: 'SESSION_EXPIRED',
          statusCode: 401,
        });
      return (await sessionService.authenticate(token)).session;
    };
    const placement = new OrderPlacementService({
      unitOfWork: this.#uow,
      engine: (market) => this.#engines.get(market),
    });
    const orderService = new OrderService({
      placement,
      capabilities: (_sessionId, market) => this.#capabilities.for(market),
      execute: (command) => this.#executeCancel(command),
    });
    const limiter = new LayeredRateLimiter();
    const source = createOutboxEventSource(this.#db);
    const tradable = new Set(
      MARKETS.flatMap((m) =>
        (this.#o.symbols ?? this.#o.bundle.symbols)[m].map((s) => `${m}:${s}`),
      ),
    );
    const app = await buildApp(config, {
      clock: { now: () => Date.now() },
      registerIngress: (instance) => this.#gate.register(instance),
      registerRoutes: async (instance) => {
        instance.addHook('preHandler', async (request) => {
          if (
            !request.url.startsWith('/api/v1/') ||
            request.url.startsWith('/api/v1/sessions/anonymous') ||
            !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
          )
            return;
          const session = await principal(request);
          requireCsrf(request, session, {
            secret: config.csrfSecret,
            origin: config.publicOrigin,
          });
        });
        await registerHealthRoutes(instance, {
          db: async () => {
            await sql`select 1`.execute(this.#db);
            return true;
          },
          audit: async () => {
            await sql`select 1 from audit_events limit 1`.execute(this.#db);
            return true;
          },
          draining: () => this.#draining,
          marketData: () => this.#marketDataHealth(),
          trading: () =>
            this.#capabilities.tradingHealth(this.#runtimeReasons()),
          metrics: this.metrics,
        });
        await registerSessionRoutes(instance, sessionService);
        await registerPortfolioRoutes(instance, {
          principal,
          unitOfWork: this.#uow,
        });
        await registerOrderRoutes(instance, {
          principal,
          service: orderService,
        });
        await registerInstrumentRoutes(
          instance,
          this.#instrumentService(),
          (market, symbol) => this.#quote(market, symbol),
        );
        await registerFxRoutes(instance, this.#fxService(), {
          principal,
          canFx: () =>
            this.#capabilities.tradingHealth(this.#runtimeReasons()).fx,
        });
        await registerStreamRoutes(instance, {
          principal,
          source,
          quoteSymbols: tradable,
          limiter,
        });
        if (config.adminApiKey !== undefined) {
          await registerAdminRoutes(instance, {
            apiKey: config.adminApiKey,
            audit: (event, input) => this.#audit(event, input),
            auditAvailable: () => true,
            activateIncident: async (input) => {
              const incident = await this.#incidents.activate(input as never);
              await this.#refreshIncidents();
              return incident;
            },
            resolveIncidentCas: async (input) => {
              const body = input as {
                incidentId: string;
                expectedVersion: string | number | bigint;
                recoveryEpoch?: string | number | bigint | null;
              };
              const resolved = await this.#incidents.resolveCas({
                incidentId: body.incidentId,
                version: BigInt(body.expectedVersion),
                recoveryEpoch:
                  body.recoveryEpoch == null
                    ? null
                    : BigInt(body.recoveryEpoch),
              });
              await this.#refreshIncidents();
              for (const runtime of this.markets.values())
                if (runtime.supervisor.exhausted) runtime.resumeRetries();
              return resolved !== undefined;
            },
            cancelAll: async () => {
              const result = await sql<{ id: string }>`
                update orders set status = 'CANCELLED', updated_at = now(), version = version + 1
                where status not in ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED') returning id
              `.execute(this.#db);
              return { cancelled: result.rows.length };
            },
          });
        }
      },
    });
    await app.ready();
    this.#bridge = createStreamUpgradeHandler({
      server: app.server,
      publicOrigin: config.publicOrigin,
      sessionService,
      limiter,
      hub: this.hub,
      gate: this.state.gate(),
      source,
      tradableSymbols: tradable,
      metrics: this.metrics,
      log: this.#log,
    });
    this.#bridge.attach();
    return app;
  }

  #instrumentService(): InstrumentService {
    const symbols = this.#o.symbols ?? this.#o.bundle.symbols;
    return new InstrumentService({
      catalog: MARKETS.flatMap((market) =>
        symbols[market].map((symbol) => ({
          market,
          symbol,
          name: symbol,
          tradable: true,
          currency: market === 'US' ? ('USD' as const) : ('KRW' as const),
        })),
      ),
    });
  }

  /** Current book-derived quote from this leader's market state (never invented). */
  #quote(market: Market, symbol: string): Record<string, unknown> {
    const store = this.#stores.get(market);
    const book = store?.get(symbol) as
      | { asks?: { price: string }[]; bids?: { price: string }[] }
      | undefined;
    const health = this.markets.get(market)?.health.state ?? 'RECOVERING';
    return {
      market,
      symbol,
      price: book?.asks?.[0]?.price ?? book?.bids?.[0]?.price ?? null,
      asOf: new Date().toISOString(),
      health,
      recoveryEpoch: store?.recoveryEpoch.toString() ?? '0',
      marketDataVersion: store?.currentVersion.toString() ?? '0',
    };
  }

  #fxService(): FxService {
    return new FxService({
      rate: (from, to) => FX_RATES[`${from}:${to}`] ?? '0.0007',
      loadWallets: async (sessionId) => {
        const rows = await sql<{ currency: 'KRW' | 'USD'; available: string }>`
          select currency, available::text as available from wallets where session_id = ${sessionId}::uuid
        `.execute(this.#db);
        return new Map(rows.rows.map((row) => [row.currency, row.available]));
      },
      onExchange: (quote, receipt) =>
        this.#uow.track(() =>
          this.#db.transaction().execute(async (trx) => {
            const debit = await sql<{ id: string }>`
              update wallets set total = total - ${quote.sourceAmount}::numeric,
                available = available - ${quote.sourceAmount}::numeric, version = version + 1
              where session_id = ${quote.sessionId}::uuid and currency = ${quote.from}
                and available >= ${quote.sourceAmount}::numeric
              returning id
            `.execute(trx);
            if (debit.rows.length !== 1)
              throw new DomainError(
                'INSUFFICIENT_AVAILABLE_CASH',
                'insufficient balance for the conversion',
              );
            await sql`
              update wallets set total = total + ${quote.targetAmount}::numeric,
                available = available + ${quote.targetAmount}::numeric, version = version + 1
              where session_id = ${quote.sessionId}::uuid and currency = ${quote.to}
            `.execute(trx);
            const payload = {
              quoteId: quote.id,
              from: quote.from,
              to: quote.to,
              sourceAmount: quote.sourceAmount,
              targetAmount: quote.targetAmount,
              exchangedAt: receipt.exchangedAt,
            };
            await sql`
              insert into audit_events (id, session_reference, order_id, event_type, payload, occurred_at)
              values (${randomUUID()}::uuid, ${quote.sessionId}, null, 'FX_CONVERTED', ${JSON.stringify(payload)}::jsonb, now())
            `.execute(trx);
            const sequence = await sql<{ sequence: string }>`
              with next as (
                select coalesce(max(account_sequence), 0) + 1 as sequence
                from account_sequences where session_id = ${quote.sessionId}::uuid
              )
              insert into account_sequences (id, session_id, account_sequence, mutation_kind)
              select ${randomUUID()}::uuid, ${quote.sessionId}::uuid, sequence, 'FX_CONVERTED' from next
              returning account_sequence::text as sequence
            `.execute(trx);
            await sql`
              insert into outbox_events (id, event_id, session_id, stream_sequence, event_type, payload)
              values (${randomUUID()}::uuid, ${randomUUID()}::uuid, ${quote.sessionId}::uuid, ${sequence.rows[0]?.sequence ?? '1'}, 'FX_CONVERTED', ${JSON.stringify(payload)}::jsonb)
            `.execute(trx);
          }),
        ),
    });
  }

  #runtimeReasons(): string[] {
    const state = this.state.current;
    if (state === 'SERVING') return [];
    if (state === 'DRAINING' || state === 'STOPPED') return ['DRAINING'];
    return [state];
  }

  #marketDataHealth(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const leasePending = !['SERVING', 'RECOVERING'].includes(
      this.state.current,
    );
    for (const market of MARKETS) {
      const runtime = this.markets.get(market);
      let epoch: string | null = null;
      try {
        epoch = this.leases.held(market).epoch.toString();
      } catch {
        epoch = null;
      }
      if (leasePending || epoch === null) {
        body[market] = {
          state: 'RECOVERING',
          reasons: ['LEADER_LEASE_PENDING'],
          leaderEpoch: epoch,
        };
        continue;
      }
      const health = runtime?.health;
      const reasons = this.#activeIncidents
        .filter((i) => i.scope.type === 'MARKET' && i.scope.id === market)
        .map((i) => i.causeCode);
      body[market] = {
        state: HEALTH_LABEL[health?.state ?? 'RECOVERING'] ?? 'RECOVERING',
        reasons,
        leaderEpoch: epoch,
      };
    }
    body.runtime = this.state.current;
    this.metrics.gauge(
      'provider_connections_open',
      this.#o.bundle.connectionsOpen(),
    );
    return body;
  }

  async #executeCancel(command: {
    action: 'place' | 'amend' | 'cancel';
    sessionId: string;
    orderId?: string;
  }): Promise<unknown> {
    if (command.action !== 'cancel' || command.orderId === undefined)
      throw new DomainError(
        'ORDER_STATE_CONFLICT',
        'only cancellation is available through this command path',
      );
    const orderId = command.orderId;
    return await this.#uow.run(async (tx) => {
      const session = await tx.sessions.lock(command.sessionId);
      if (session === undefined || session.status !== 'ACTIVE')
        throw new DomainError(
          'ACCOUNT_READ_ONLY',
          'the session cannot accept cancellation',
        );
      const order = await tx.orders.lock(orderId);
      if (order === undefined || order.sessionId !== command.sessionId)
        throw new DomainError('INVALID_ORDER', 'order was not found');
      if (['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(order.status))
        return { id: order.id, status: order.status };
      for (const engine of this.#engines.values())
        await engine.cancelOrder(order.id);
      await tx.orders.update({
        id: order.id,
        expectedVersion: order.version,
        status: 'CANCELLED',
        ...(order.filledQuantity === undefined
          ? {}
          : { filledQuantity: order.filledQuantity }),
      });
      await tx.audit.append({
        id: randomUUID(),
        eventType: 'ORDER_CANCELLED',
        payload: { orderId: order.id },
        occurredAt: new Date(),
        sessionReference: command.sessionId,
        orderId: order.id,
      });
      const sequence = await tx.sequences.allocate({
        sessionId: command.sessionId,
        mutationKind: 'ORDER_CANCELLED',
      });
      await tx.outbox.append({
        id: randomUUID(),
        eventId: randomUUID(),
        sessionId: command.sessionId,
        streamSequence: sequence,
        eventType: 'ORDER_CANCELLED',
        payload: { orderId: order.id },
      });
      return { id: order.id, status: 'CANCELLED' };
    });
  }

  /**
   * §6.1 RESTORING: every non-terminal order recorded by a previous leader is
   * handed to this leader's engine so resting LIMITs keep matching and pending
   * STOP/TAKE_PROFIT orders keep watching, each with its persisted fill state.
   */
  async #restoreOpenOrders(): Promise<{
    open: number;
    pendingTrigger: number;
  }> {
    const rows = await sql<{
      id: string;
      session_id: string;
      market_code: Market;
      symbol: string;
      order_type: 'MARKET' | 'LIMIT' | 'STOP' | 'TAKE_PROFIT' | 'OCO';
      side: 'BUY' | 'SELL';
      limit_price: string | null;
      stop_price: string | null;
      quantity: string;
      filled_quantity: string;
      status: string;
      version: string;
    }>`
      select id::text, session_id::text, market_code, symbol, order_type, side,
        limit_price::text, stop_price::text, quantity::text, filled_quantity::text, status, version::text
      from orders
      where status in ('RECEIVED', 'OPEN', 'PARTIALLY_FILLED', 'TRIGGERED', 'PENDING_TRIGGER')
        and order_type <> 'OCO'
      order by created_at, id
    `.execute(this.#db);
    let open = 0;
    let pendingTrigger = 0;
    for (const row of rows.rows) {
      const engine = this.#engines.get(row.market_code);
      if (engine === undefined) continue;
      const base = {
        id: row.id,
        sessionId: row.session_id,
        market: row.market_code,
        symbol: row.symbol,
        currency: (row.market_code === 'US' ? 'USD' : 'KRW') as 'USD' | 'KRW',
        side: row.side,
        quantity: row.quantity,
        filledQuantity: row.filled_quantity,
        version: BigInt(row.version),
      };
      const conditionalType =
        row.order_type === 'STOP' || row.order_type === 'TAKE_PROFIT'
          ? row.order_type
          : undefined;
      if (conditionalType !== undefined && row.status !== 'TRIGGERED') {
        // Single STOP/TAKE_PROFIT rows are persisted as OPEN (OCO legs as
        // PENDING_TRIGGER); both are still waiting for their trigger price.
        if (row.stop_price === null) continue;
        engine.restoreOrder({
          ...base,
          type: conditionalType,
          stopPrice: row.stop_price,
          status: 'PENDING_TRIGGER',
        });
        pendingTrigger += 1;
        continue;
      }
      if (row.status === 'PENDING_TRIGGER') continue;
      const type = row.order_type === 'LIMIT' ? 'LIMIT' : 'MARKET';
      engine.restoreOrder({
        ...base,
        type,
        ...(type === 'LIMIT' && row.limit_price !== null
          ? { limitPrice: row.limit_price }
          : {}),
        status: row.status === 'PARTIALLY_FILLED' ? 'PARTIALLY_FILLED' : 'OPEN',
      });
      open += 1;
    }
    return { open, pendingTrigger };
  }

  async #refreshIncidents(): Promise<void> {
    if (this.#databaseDestroyed) return;
    this.#activeIncidents = await this.#incidents.active();
  }

  async #audit(eventType: string, payload: unknown): Promise<void> {
    // Late asynchronous audits (health events, transitions) after stop() must
    // not touch the destroyed driver.
    if (this.#databaseDestroyed) return;
    await sql`
      insert into audit_events (id, session_reference, order_id, event_type, payload, occurred_at)
      values (${randomUUID()}::uuid, null, null, ${eventType}, ${JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}::jsonb, now())
    `.execute(this.#db);
  }
}

export type { FakeProviderBundle };
