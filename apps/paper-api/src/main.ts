import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DomainError } from '@skipjack/trading-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { migrateToLatest } from './db/migrate.js';
import { UnitOfWork } from './db/unit-of-work.js';
import { registerAdminRoutes } from './modules/admin/admin-routes.js';
import { registerHealthRoutes } from './modules/health/health-routes.js';
import { OrderPlacementService } from './modules/orders/order-placement-service.js';
import { registerOrderRoutes } from './modules/orders/order-routes.js';
import { OrderService } from './modules/orders/order-service.js';
import { registerPortfolioRoutes } from './modules/portfolio/portfolio-routes.js';
import { registerSessionRoutes } from './modules/session/session-routes.js';
import {
  createUnitOfWorkSessionStore,
  SessionService,
} from './modules/session/session-service.js';
import { SESSION_COOKIE } from './modules/session/session-token.js';
import { requireCsrf } from './plugins/csrf.js';
import { cookieValue } from './plugins/session-auth.js';
import { IncidentService } from './safety/incident-service.js';
import { startServer } from './server.js';

export async function startProductionServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  try {
    await migrateToLatest(database);
    const unitOfWork = new UnitOfWork(database, {
      backoff: async (attempt) => {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, Math.min(10 * 2 ** (attempt - 1), 100)),
        );
      },
    });
    const sessionService = new SessionService({
      keys: config.sessionHashKeys,
      csrfSecret: config.csrfSecret,
      store: createUnitOfWorkSessionStore(unitOfWork),
      secureCookie: config.nodeEnv !== 'test',
    });
    const principal = async (request: unknown) => {
      const token = cookieValue(request as FastifyRequest, SESSION_COOKIE);
      if (token === undefined) {
        throw Object.assign(new Error('session is required'), {
          code: 'SESSION_EXPIRED',
          statusCode: 401,
        });
      }
      return (await sessionService.authenticate(token)).session;
    };
    const fakeMarketData = process.env.MARKET_DATA_ADAPTER === 'fake';
    let cancelOnly = !fakeMarketData;
    const appendAdminAudit = async (eventType: string, payload: unknown) => {
      await unitOfWork.run((tx) =>
        tx.audit.append({
          id: randomUUID(),
          eventType,
          payload,
          occurredAt: new Date(),
        }),
      );
    };
    const incidents = new IncidentService({
      appendAudit: ({ eventType, payload }) =>
        appendAdminAudit(eventType, payload),
    });
    const placement = new OrderPlacementService({
      unitOfWork,
      engine: () => ({
        placeImmediateOrder: async (order) => order,
        registerConditionalOrder: () => undefined,
      }),
    });
    const orderService = new OrderService({
      placement,
      capabilities: () =>
        cancelOnly
          ? new Set(['CANCEL'])
          : new Set(['PLACE', 'AMEND', 'CANCEL']),
      execute: async (command) => {
        if (command.action !== 'cancel' || command.orderId === undefined) {
          throw new DomainError(
            'ORDER_STATE_CONFLICT',
            'only cancellation is available through this command path',
          );
        }
        return await unitOfWork.run(async (tx) => {
          const session = await tx.sessions.lock(command.sessionId);
          if (session === undefined || session.status !== 'ACTIVE') {
            throw new DomainError(
              'ACCOUNT_READ_ONLY',
              'the session cannot accept cancellation',
            );
          }
          const order = await tx.orders.lock(command.orderId as string);
          if (order === undefined || order.sessionId !== command.sessionId) {
            throw new DomainError('INVALID_ORDER', 'order was not found');
          }
          if (
            ['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(
              order.status,
            )
          ) {
            return { id: order.id, status: order.status };
          }
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
      },
    });
    return await startServer(config, {
      clock: { now: () => Date.now() },
      registerRoutes: async (app) => {
        app.addHook('preHandler', async (request) => {
          if (
            !request.url.startsWith('/api/v1/') ||
            request.url.startsWith('/api/v1/sessions/anonymous') ||
            !['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
          ) {
            return;
          }
          const session = await principal(request);
          requireCsrf(request, session, {
            secret: config.csrfSecret,
            origin: config.publicOrigin,
          });
        });
        await registerHealthRoutes(app, {
          db: async () => {
            await sql`select 1`.execute(database);
            return true;
          },
          audit: async () => {
            await sql`select 1 from audit_events limit 1`.execute(database);
            return true;
          },
          marketData: () =>
            fakeMarketData
              ? { state: cancelOnly ? 'DEGRADED' : 'HEALTHY', reasons: [] }
              : {
                  state: 'DEGRADED',
                  reasons: ['MARKET_DATA_UNAVAILABLE'],
                },
          trading: () => ({
            placement: !cancelOnly,
            cancellation: true,
            fx: !cancelOnly,
            reasons: cancelOnly ? ['CANCEL_ONLY'] : [],
          }),
        });
        await registerSessionRoutes(app, sessionService);
        await registerPortfolioRoutes(app, { principal, unitOfWork });
        await registerOrderRoutes(app, { principal, service: orderService });
        if (config.adminApiKey !== undefined) {
          await registerAdminRoutes(app, {
            apiKey: config.adminApiKey,
            audit: (event, input) => appendAdminAudit(event, input),
            auditAvailable: () => true,
            activateIncident: async (input) => {
              const body = input as {
                scope: { type: 'GLOBAL'; id: string };
                denied: readonly (
                  | 'PLACE'
                  | 'AMEND'
                  | 'CANCEL'
                  | 'MATCH'
                  | 'TRIGGER'
                  | 'RECOVER'
                )[];
                causeCode: string;
                recoveryEpoch?: bigint | null;
              };
              const incident = await incidents.activate(body);
              cancelOnly = true;
              return incident;
            },
            resolveIncidentCas: async (input) => {
              const body = input as {
                incidentId: string;
                expectedVersion: string | number | bigint;
                recoveryEpoch?: string | number | bigint | null;
              };
              const resolved = await incidents.resolveCas({
                incidentId: body.incidentId,
                version: BigInt(body.expectedVersion),
                recoveryEpoch:
                  body.recoveryEpoch == null
                    ? null
                    : BigInt(body.recoveryEpoch),
              });
              cancelOnly = (await incidents.active()).length > 0;
              return resolved !== undefined;
            },
            cancelAll: async () => {
              const result = await sql<{ id: string }>`
                update orders
                set status = 'CANCELLED', updated_at = now(), version = version + 1
                where status not in ('FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')
                returning id
              `.execute(database);
              return { cancelled: result.rows.length };
            },
          });
        }
      },
      shutdownCoordinator: {
        drain: async () => {
          await database.destroy();
        },
      },
    });
  } catch (error) {
    await database.destroy();
    throw error;
  }
}

const invokedAsProgram =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsProgram) {
  await startProductionServer().catch((error: unknown) => {
    console.error('[paper-api] startup failed', error);
    process.exitCode = 1;
  });
}
