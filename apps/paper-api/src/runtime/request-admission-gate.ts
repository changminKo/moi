import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { MetricsRegistry } from '../observability/metrics.js';

/** Paths that stay observable while the gate is closed and never count as in-flight. */
export const HEALTH_PATHS: ReadonlySet<string> = new Set([
  '/health/live',
  '/health/ready',
  '/health/market-data',
  '/api/v1/health/trading',
  '/metrics',
]);

const DRAIN_POLL_MS = 50;
const RETRY_AFTER_SECONDS = 1;

type LogFn = (event: string, fields: Record<string, unknown>) => void;

export interface RequestAdmissionGateDeps {
  readonly metrics?: MetricsRegistry;
  readonly log?: LogFn;
}

type AdmittedRequest = FastifyRequest & { admitted?: boolean };

type OnRequestHook = ((
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) => void) & { gateHook?: true };

function pathOf(request: FastifyRequest): string {
  const url = request.raw.url ?? request.url ?? '/';
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
}

/**
 * HTTP ingress fence (§6.6). The closed-check and the in-flight increment
 * happen in one synchronous callback-style `onRequest` hook, so `close()` can
 * never slip between them. Exactly one of `onResponse`, `onError`, or
 * `onRequestAbort` consumes the `admitted` flag and decrements once.
 */
export class RequestAdmissionGate {
  readonly #metrics: MetricsRegistry | undefined;
  readonly #log: LogFn | undefined;
  #closed = false;
  #inFlight = 0;
  readonly onRequestHook: OnRequestHook;

  constructor(deps: RequestAdmissionGateDeps = {}) {
    this.#metrics = deps.metrics;
    this.#log = deps.log;
    const hook: OnRequestHook = (request, reply, done) => {
      if (HEALTH_PATHS.has(pathOf(request))) {
        done();
        return;
      }
      if (this.#closed) {
        this.#metrics?.counter('http_admission_rejected_total');
        this.#log?.('http.admission_rejected', {
          requestId: request.id,
          path: pathOf(request),
        });
        reply
          .code(503)
          .header('Retry-After', String(RETRY_AFTER_SECONDS))
          .send({
            code: 'NOT_READY',
            message: 'Server is draining',
            retryable: true,
            requestId: request.id,
          });
        return;
      }
      this.#inFlight += 1;
      (request as AdmittedRequest).admitted = true;
      this.#metrics?.gauge('http_admission_inflight', this.#inFlight);
      done();
    };
    hook.gateHook = true;
    this.onRequestHook = hook;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  register(app: FastifyInstance): void {
    const settle = Object.assign(
      (request: FastifyRequest): void => this.#settle(request),
      { gateHook: true as const },
    );
    const onResponse = Object.assign(
      (
        request: FastifyRequest,
        _reply: FastifyReply,
        done: HookHandlerDoneFunction,
      ) => {
        settle(request);
        done();
      },
      { gateHook: true as const },
    );
    const onError = Object.assign(
      (
        request: FastifyRequest,
        _reply: FastifyReply,
        _error: FastifyError,
        done: HookHandlerDoneFunction,
      ) => {
        settle(request);
        done();
      },
      { gateHook: true as const },
    );
    const onRequestAbort = Object.assign(
      (request: FastifyRequest, done: HookHandlerDoneFunction) => {
        settle(request);
        done();
      },
      { gateHook: true as const },
    );
    app.addHook('onRequest', this.onRequestHook);
    app.addHook('onResponse', onResponse);
    app.addHook('onError', onError);
    app.addHook('onRequestAbort', onRequestAbort);
  }

  close(): void {
    this.#closed = true;
  }

  open(): void {
    this.#closed = false;
  }

  async drain(deadline: number): Promise<void> {
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    if (this.#inFlight > 0) {
      this.#metrics?.gauge('http_admission_drain_remaining', this.#inFlight);
    }
  }

  #settle(request: FastifyRequest): void {
    const admitted = request as AdmittedRequest;
    if (!admitted.admitted) return;
    admitted.admitted = false;
    this.#inFlight -= 1;
    this.#metrics?.gauge('http_admission_inflight', this.#inFlight);
  }
}
