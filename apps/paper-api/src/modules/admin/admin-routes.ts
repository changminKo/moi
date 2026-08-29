import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
export interface AdminDependencies {
  apiKey: string;
  allowedIps?: ReadonlySet<string>;
  audit: (event: string, input?: unknown) => Promise<void>;
  auditAvailable?: () => boolean | Promise<boolean>;
  activateIncident?: (
    input: unknown,
  ) => Promise<{ incidentId: string; version: bigint }>;
  resolveIncidentCas?: (input: unknown) => Promise<boolean>;
  publishWhitelistVersion?: (input: unknown) => Promise<unknown>;
  cancelAll?: (input: unknown) => Promise<unknown>;
}
function auth(request: FastifyRequest, deps: AdminDependencies): boolean {
  if (deps.allowedIps && !deps.allowedIps.has(request.ip)) return false;
  const actual = String(request.headers.authorization ?? '').replace(
    /^Bearer\s+/i,
    '',
  );
  const a = Buffer.from(actual);
  const b = Buffer.from(deps.apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminDependencies,
): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/admin/')) return;
    if (!auth(request, deps))
      return reply.code(401).send({
        code: 'UNAUTHORIZED',
        message: 'Admin authentication required',
        retryable: false,
        requestId: request.id,
      });
  });
  app.post('/admin/incidents', async (request, reply) => {
    if (!deps.activateIncident)
      return reply.code(503).send({
        code: 'UNAVAILABLE',
        message: 'Incident service unavailable',
        retryable: true,
        requestId: request.id,
      });
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.reason !== 'string' || !request.headers['idempotency-key'])
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'reason and Idempotency-Key are required',
        retryable: false,
        requestId: request.id,
      });
    if (deps.auditAvailable && !(await deps.auditAvailable()))
      return reply.code(503).send({
        code: 'AUDIT_UNAVAILABLE',
        message: 'Audit service unavailable',
        retryable: true,
        requestId: request.id,
      });
    const result = await deps.activateIncident({
      ...body,
      actor: 'admin',
      requestId: request.id,
    });
    await deps.audit('INCIDENT_ACTIVATED', { requestId: request.id });
    return reply.code(201).send({
      incidentId: result.incidentId,
      version: result.version.toString(),
      requestId: request.id,
    });
  });
  app.post('/admin/incidents/:id/resolve', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || body.expectedVersion === undefined || !deps.resolveIncidentCas)
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: 'expectedVersion is required',
        retryable: false,
        requestId: request.id,
      });
    const ok = await deps.resolveIncidentCas({
      ...body,
      incidentId: (request.params as { id: string }).id,
    });
    if (!ok)
      return reply.code(409).send({
        code: 'VERSION_CONFLICT',
        message: 'Incident version changed',
        retryable: false,
        requestId: request.id,
      });
    await deps.audit('INCIDENT_RESOLVED', { requestId: request.id });
    return { ok: true, requestId: request.id };
  });
  app.post('/admin/whitelist', async (request, reply) => {
    if (!deps.publishWhitelistVersion)
      return reply.code(503).send({
        code: 'UNAVAILABLE',
        message: 'Whitelist service unavailable',
        retryable: true,
        requestId: request.id,
      });
    const result = await deps.publishWhitelistVersion(request.body);
    await deps.audit('WHITELIST_PUBLISHED', { requestId: request.id });
    return { result, requestId: request.id };
  });
  app.post('/admin/cancel-all', async (request, reply) => {
    if (!deps.cancelAll)
      return reply.code(503).send({
        code: 'UNAVAILABLE',
        message: 'Cancel service unavailable',
        retryable: true,
        requestId: request.id,
      });
    const result = await deps.cancelAll({
      requestId: request.id,
      body: request.body,
    });
    await deps.audit('CANCEL_ALL', { requestId: request.id });
    return { result, requestId: request.id };
  });
}
