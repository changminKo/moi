import type { FastifyInstance, FastifyRequest } from 'fastify';
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfter?: number;
}
export interface RateLimiterOptions {
  readonly now?: () => number;
  readonly redis?: { readonly available: boolean };
}
type Kind = 'mutation' | 'cancel' | 'session';
export class LayeredRateLimiter {
  readonly #now: () => number;
  readonly #redis: { readonly available: boolean } | undefined;
  readonly #counts = new Map<string, { at: number; count: number }>();
  constructor(options: RateLimiterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#redis = options.redis;
  }
  check(input: {
    kind: Kind;
    sessionId?: string;
    ip: string;
  }): RateLimitResult {
    if (input.kind === 'mutation' && this.#redis && !this.#redis.available)
      return { allowed: false, retryAfter: 1 };
    const [limit, window] =
      input.kind === 'cancel'
        ? [20, 1000]
        : input.kind === 'session'
          ? [5, 60_000]
          : [10, 1000];
    const key = `${input.kind}:${input.sessionId ?? input.ip}`;
    const now = this.#now();
    const current = this.#counts.get(key);
    if (!current || now - current.at >= window) {
      this.#counts.set(key, { at: now, count: 1 });
      return { allowed: true };
    }
    if (current.count >= limit)
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((window - (now - current.at)) / 1000),
        ),
      };
    current.count += 1;
    return { allowed: true };
  }
  checkWebsocketConnection(sessionId: string): RateLimitResult {
    return this.#checkFixed(`ws:${sessionId}`, 5, 1000);
  }
  checkSubscription(sessionId: string, current: number): RateLimitResult {
    void sessionId;
    return current >= 5 ? { allowed: false, retryAfter: 1 } : { allowed: true };
  }
  checkSessionLeg(current: number): RateLimitResult {
    return current >= 50
      ? { allowed: false, retryAfter: 1 }
      : { allowed: true };
  }
  reserveLeg(): RateLimitResult {
    return this.#checkFixed('global-legs', 10_000, 1000);
  }
  #checkFixed(key: string, limit: number, window: number): RateLimitResult {
    const now = this.#now();
    const current = this.#counts.get(key);
    if (!current || now - current.at >= window) {
      this.#counts.set(key, { at: now, count: 1 });
      return { allowed: true };
    }
    if (current.count >= limit)
      return {
        allowed: false,
        retryAfter: Math.max(
          1,
          Math.ceil((window - (now - current.at)) / 1000),
        ),
      };
    current.count += 1;
    return { allowed: true };
  }
}
/**
 * Per-client-IP limits on `/api/v1/*` writes (#34): POST/PATCH share the
 * `mutation` bucket (10/s), DELETE the `cancel` bucket (20/s); reads and
 * `/health/*` are never limited. Registered as the first ingress hook, before
 * the admission gate, so a refused request is never counted as in flight. The
 * key is `request.ip`, which is the real client only when `TRUST_PROXY=true`
 * (the Oracle overlay behind Caddy); the `session` kind (5/min) is defined but
 * not applied by this hook — see spec §16.56.
 */
export function registerRateLimits(
  app: FastifyInstance,
  limiter: LayeredRateLimiter,
): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/v1/')) return;
    const kind =
      request.method === 'DELETE'
        ? 'cancel'
        : request.method === 'POST' || request.method === 'PATCH'
          ? 'mutation'
          : undefined;
    if (!kind) return;
    const result = limiter.check({ kind, ip: request.ip });
    if (!result.allowed) {
      reply
        .header('Retry-After', String(result.retryAfter ?? 1))
        .code(429)
        .send({
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          retryable: true,
          retryAfter: result.retryAfter ?? 1,
          requestId: request.id,
        });
    }
  });
}
