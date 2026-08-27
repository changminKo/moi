import { connect } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../observability/metrics.js';
import {
  HEALTH_PATHS,
  RequestAdmissionGate,
} from './request-admission-gate.js';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((app) => app.close()));
  apps.length = 0;
});

async function build(options: { deferred?: Deferred; throws?: boolean } = {}) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const metrics = new MetricsRegistry();
  const gate = new RequestAdmissionGate({ metrics });
  gate.register(app);
  const handler = vi.fn(async () => {
    if (options.deferred) await options.deferred.promise;
    if (options.throws) throw new Error('boom');
    return { ok: true };
  });
  const unitOfWork = vi.fn();
  app.post('/api/v1/orders', async () => {
    unitOfWork();
    return handler();
  });
  app.get('/api/v1/portfolio', async () => handler());
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) =>
    gate.closed
      ? reply.code(503).send({ code: 'NOT_READY', details: { draining: true } })
      : { status: 'ready' },
  );
  app.get('/api/v1/health/trading', async () => ({ placement: false }));
  await app.ready();
  return { app, gate, handler, unitOfWork, metrics };
}

describe('RequestAdmissionGate', () => {
  it('G1: admits requests while open and settles the counter after the response', async () => {
    const { app, gate } = await build();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio',
    });
    expect(response.statusCode).toBe(200);
    expect(gate.inFlight).toBe(0);
  });

  it('G2: rejects new business requests after close while an admitted one keeps draining', async () => {
    const deferred = new Deferred();
    const { app, gate, handler, unitOfWork } = await build({ deferred });
    const first = app.inject({ method: 'POST', url: '/api/v1/orders' });
    await vi.waitFor(() => expect(gate.inFlight).toBe(1));
    gate.close();
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
    });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers['retry-after']).toBe('1');
    expect(rejected.json()).toMatchObject({
      code: 'NOT_READY',
      retryable: true,
      message: 'Server is draining',
    });
    expect(rejected.json().requestId).toBeTypeOf('string');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(unitOfWork).toHaveBeenCalledTimes(1);
    expect(gate.inFlight).toBe(1);
    const drain = gate.drain(Date.now() + 5_000);
    deferred.resolve();
    expect((await first).statusCode).toBe(200);
    await drain;
    expect(gate.inFlight).toBe(0);
  });

  it('G3: health paths bypass the gate after close and never touch the counter', async () => {
    const { app, gate } = await build();
    gate.close();
    expect(
      (await app.inject({ method: 'GET', url: '/health/live' })).statusCode,
    ).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().details).toEqual({ draining: true });
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/health/trading' }))
        .statusCode,
    ).toBe(200);
    expect(gate.inFlight).toBe(0);
    expect(HEALTH_PATHS).toEqual(
      new Set([
        '/health/live',
        '/health/ready',
        '/health/market-data',
        '/api/v1/health/trading',
        '/metrics',
      ]),
    );
  });

  it('G4: a throwing handler decrements exactly once across onError and onResponse', async () => {
    const { app, gate } = await build({ throws: true });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio',
    });
    expect(response.statusCode).toBe(500);
    expect(gate.inFlight).toBe(0);
  });

  it('G5: a client abort settles through onRequestAbort once and later completion adds nothing', async () => {
    const deferred = new Deferred();
    const { app, gate } = await build({ deferred });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = new URL(address);
    const socket = connect(Number(port), '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('GET /api/v1/portfolio HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await vi.waitFor(() => expect(gate.inFlight).toBe(1));
    socket.destroy();
    await vi.waitFor(() => expect(gate.inFlight).toBe(0));
    const drained = gate.drain(Date.now() + 1_000);
    await expect(drained).resolves.toBeUndefined();
    deferred.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gate.inFlight).toBe(0);
  });

  it('G5b: abort followed by a throwing handler still decrements only once', async () => {
    const deferred = new Deferred();
    const { app, gate } = await build({ deferred, throws: true });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = new URL(address);
    const socket = connect(Number(port), '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('GET /api/v1/portfolio HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await vi.waitFor(() => expect(gate.inFlight).toBe(1));
    socket.destroy();
    await vi.waitFor(() => expect(gate.inFlight).toBe(0));
    deferred.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(gate.inFlight).toBe(0);
  });

  it('G6: onRequest is a synchronous callback-style hook with no await between check and increment', async () => {
    const { app, gate } = await build();
    const hook = gate.onRequestHook;
    expect(hook.constructor.name).toBe('Function');
    expect(hook.length).toBe(3);
    expect(hook.toString()).not.toMatch(/\bawait\b/);
    // close before the hook runs → 503, never counted
    gate.close();
    const rejected = await app.inject({
      method: 'GET',
      url: '/api/v1/portfolio',
    });
    expect(rejected.statusCode).toBe(503);
    expect(gate.inFlight).toBe(0);
    // reopen: admitted and counted, then settled
    gate.open();
    const ok = await app.inject({ method: 'GET', url: '/api/v1/portfolio' });
    expect(ok.statusCode).toBe(200);
    expect(gate.inFlight).toBe(0);
  });

  it('G7: rejected responses do not touch the counter and all four hooks are registered once at root scope', async () => {
    const { app, gate, metrics } = await build();
    gate.close();
    await app.inject({ method: 'GET', url: '/api/v1/portfolio' });
    expect(gate.inFlight).toBe(0);
    expect(metrics.metrics()).toContain('http_admission_rejected_total 1');
    const hooksSymbol = Object.getOwnPropertySymbols(app).find(
      (symbol) => symbol.description === 'fastify.hooks',
    );
    expect(hooksSymbol).toBeDefined();
    const hooks = (app as unknown as Record<symbol, Record<string, unknown[]>>)[
      hooksSymbol as symbol
    ];
    for (const name of [
      'onRequest',
      'onResponse',
      'onError',
      'onRequestAbort',
    ]) {
      const registered = hooks?.[name] ?? [];
      const ours = registered.filter(
        (fn) => (fn as { gateHook?: boolean }).gateHook === true,
      );
      expect(ours, name).toHaveLength(1);
    }
  });

  it('drain records the remaining count when the deadline passes', async () => {
    const deferred = new Deferred();
    const { app, gate, metrics } = await build({ deferred });
    const pending = app.inject({ method: 'GET', url: '/api/v1/portfolio' });
    await vi.waitFor(() => expect(gate.inFlight).toBe(1));
    gate.close();
    await gate.drain(Date.now() + 120);
    expect(metrics.metrics()).toContain('http_admission_drain_remaining 1');
    deferred.resolve();
    await pending;
  });
});
