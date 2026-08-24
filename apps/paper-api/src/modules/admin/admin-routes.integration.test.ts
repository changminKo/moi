import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerAdminRoutes } from './admin-routes.js';

describe('admin routes', () => {
  it('protects commands and requires audit plus expected version for CAS', async () => {
    const calls: string[] = [];
    const app = Fastify();
    await registerAdminRoutes(app, {
      apiKey: 'secret-key',
      allowedIps: new Set(['127.0.0.1']),
      audit: async (event) => {
        calls.push(event);
      },
      activateIncident: async () => ({ incidentId: 'inc-1', version: 1n }),
      resolveIncidentCas: async () => true,
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/admin/incidents',
      remoteAddress: '127.0.0.1',
      payload: { reason: 'test' },
    });
    expect(denied.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/admin/incidents',
      remoteAddress: '127.0.0.1',
      headers: {
        authorization: 'Bearer secret-key',
        'idempotency-key': 'admin-1',
      },
      payload: { reason: 'test' },
    });
    expect(ok.statusCode).toBe(201);
    expect(calls).toEqual(['INCIDENT_ACTIVATED']);
    await app.close();
  });
});
