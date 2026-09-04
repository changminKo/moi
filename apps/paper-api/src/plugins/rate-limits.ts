import type { FastifyInstance, FastifyRequest } from 'fastify';
export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfter?: number;
}
export interface RateLimiterOptions {
  readonly now?: () => number;
  readonly redis?: { readonly available: boolean };
  /** Most keys kept in memory before the oldest are evicted (tests shrink it). */
  readonly maxKeys?: number;
}
type Kind = 'mutation' | 'cancel' | 'session';
/**
 * Keys are network-chosen values (`mutation:<ip>`), so the map would otherwise
 * grow by one entry per distinct source address for the life of the process —
 * an IPv6 /64 rotating addresses is both a limit bypass and a memory leak
 * (#34 review). Windows are at most a minute, so anything older than that is
 * dead weight; when the map is still over the cap after sweeping, the oldest
 * insertions go, which is the cheapest bounded approximation of LRU that keeps
 * `check` O(1) in the common case.
 */
const DEFAULT_MAX_KEYS = 10_000;
const LONGEST_WINDOW_MS = 60_000;
export class LayeredRateLimiter {
  readonly #now: () => number;
  readonly #redis: { readonly available: boolean } | undefined;
  readonly #maxKeys: number;
  readonly #counts = new Map<string, { at: number; count: number }>();
  constructor(options: RateLimiterOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#redis = options.redis;
    this.#maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }
  /** How many keys are tracked right now (bounded by `maxKeys`). */
  get size(): number {
    return this.#counts.size;
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
      if (current) this.#counts.delete(key); // re-insert as newest
      this.#evict(now);
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
  /**
   * Called before inserting a new key. Drops every expired entry once the map
   * reaches the cap, then the oldest insertions until it is under it.
   */
  #evict(now: number): void {
    if (this.#counts.size < this.#maxKeys) return;
    for (const [key, entry] of this.#counts)
      if (now - entry.at >= LONGEST_WINDOW_MS) this.#counts.delete(key);
    while (this.#counts.size >= this.#maxKeys) {
      const oldest = this.#counts.keys().next().value as string;
      this.#counts.delete(oldest);
    }
  }
  #checkFixed(key: string, limit: number, window: number): RateLimitResult {
    const now = this.#now();
    const current = this.#counts.get(key);
    if (!current || now - current.at >= window) {
      if (current) this.#counts.delete(key);
      this.#evict(now);
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
export interface RegisterRateLimitsOptions {
  /**
   * The browser origin the CSRF check accepts. A request that names another
   * origin is refused 403 further down the chain and must not spend the
   * client's bucket first: a hostile page can fire preflight-free POSTs from a
   * victim's browser, and without this the victim's own orders would see 429.
   */
  readonly publicOrigin?: string;
  /** Every refusal, for a metric and a log line — the gate has both, so does this. */
  readonly onRejected?: (info: {
    readonly kind: Kind;
    readonly path: string;
    readonly requestId: string;
  }) => void;
}

/**
 * Per-client-IP limits on `/api/v1/*` writes (#34): POST/PATCH share the
 * `mutation` bucket (10/s), DELETE the `cancel` bucket (20/s); reads and
 * `/health/*` are never limited. Registered as the first ingress hook, before
 * the admission gate, so a refused request is never counted as in flight. The
 * key is `request.ip`, which is the real client only when `TRUST_PROXY=true`
 * (the Oracle overlay behind Caddy); the `session` kind (5/min) is defined but
 * not applied by this hook — see spec §16.56. A fixed window: up to two
 * windows' worth can land across a boundary, fine for an abuse control.
 */
export function registerRateLimits(
  app: FastifyInstance,
  limiter: LayeredRateLimiter,
  options: RegisterRateLimitsOptions = {},
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
    const origin = request.headers.origin;
    if (
      options.publicOrigin !== undefined &&
      origin !== undefined &&
      origin !== options.publicOrigin
    )
      return;
    const result = limiter.check({ kind, ip: request.ip });
    if (!result.allowed) {
      options.onRejected?.({ kind, path, requestId: request.id });
      // `return reply` so the hook chain ends here regardless of how the
      // iterator treats a sent reply.
      return reply
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
