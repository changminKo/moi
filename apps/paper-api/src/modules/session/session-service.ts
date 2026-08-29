import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { UnitOfWork } from '../../db/unit-of-work.js';
import {
  createSessionTokenCodec,
  SESSION_MAX_AGE_SECONDS,
} from './session-token.js';

export type SessionStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export interface SessionPrincipal {
  readonly id: string;
  readonly status: SessionStatus;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}
export interface SessionBootstrapResult {
  readonly session: SessionPrincipal;
  readonly token: string;
  readonly csrfToken: string;
  readonly setCookie: string;
}
export interface SessionStore {
  findByTokenHash(hash: string): Promise<SessionPrincipal | undefined>;
  bootstrap(input: {
    id: string;
    tokenHash: string;
    now: Date;
    expiresAt: Date;
  }): Promise<SessionPrincipal>;
  touch?(id: string, now: Date, expiresAt: Date): Promise<SessionPrincipal>;
}

export interface SessionServiceOptions {
  readonly keys: readonly [string, ...string[]];
  readonly csrfSecret: string;
  readonly store: SessionStore;
  readonly clock?: () => Date;
  /** False only for an explicitly HTTP loopback test origin. */
  readonly secureCookie?: boolean;
}

/** Adapter that keeps anonymous bootstrap and wallet initialization in one UoW transaction. */
export function createUnitOfWorkSessionStore(
  unitOfWork: UnitOfWork,
): SessionStore {
  const principal = (record: {
    id: string;
    status: SessionStatus;
    expiresAt: Date;
    lastSeenAt: Date;
  }): SessionPrincipal => ({
    id: record.id,
    status: record.status,
    expiresAt: record.expiresAt,
    lastSeenAt: record.lastSeenAt,
  });
  return {
    findByTokenHash: async (hash) => {
      const record = await unitOfWork.run((tx) =>
        tx.sessions.findByTokenHash(hash),
      );
      return record === undefined ? undefined : principal(record);
    },
    bootstrap: async (input) =>
      principal(await unitOfWork.run((tx) => tx.sessions.bootstrap(input))),
    touch: async (id, now, expiresAt) =>
      unitOfWork.run(async (tx) => {
        const current = await tx.sessions.lock(id);
        if (!current) throw new Error('session does not exist');
        await tx.sessions.touch({
          sessionId: id,
          expectedVersion: current.version,
          lastSeenAt: now,
        });
        return principal({ ...current, lastSeenAt: now, expiresAt });
      }),
  };
}

function csrf(secret: string, sessionId: string, nonce: string): string {
  return `${nonce}.${createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest('base64url')}`;
}

export class SessionService {
  readonly #codec;
  readonly #csrfSecret: string;
  readonly #store: SessionStore;
  readonly #clock: () => Date;
  readonly #secureCookie: boolean;
  constructor(options: SessionServiceOptions) {
    this.#codec = createSessionTokenCodec(options.keys);
    this.#csrfSecret = options.csrfSecret;
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#secureCookie = options.secureCookie ?? true;
  }
  async bootstrap(existingToken?: string): Promise<SessionBootstrapResult> {
    const now = this.#clock();
    let token = existingToken;
    let session: SessionPrincipal | undefined;
    if (existingToken) {
      const hash = this.#codec.hash(existingToken);
      const candidate = await this.#store.findByTokenHash(hash);
      if (
        candidate &&
        candidate.status === 'ACTIVE' &&
        candidate.expiresAt > now &&
        this.#codec.matches(existingToken, hash)
      ) {
        session = candidate;
        token = existingToken;
        if (
          this.#store.touch &&
          now.getTime() - candidate.lastSeenAt.getTime() >= 60 * 60 * 1000
        ) {
          session = await this.#store.touch(
            candidate.id,
            now,
            new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
          );
        }
      }
    }
    if (!session) {
      const issued = this.#codec.issue();
      token = issued.token;
      session = await this.#store.bootstrap({
        id: randomUUID(),
        tokenHash: issued.tokenHash,
        now,
        expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
      });
    }
    const nonce = this.#codec.issue().token;
    const csrfToken = csrf(this.#csrfSecret, session.id, nonce);
    const setCookie = `moi_session=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly;${this.#secureCookie ? ' Secure;' : ''} SameSite=Lax`;
    if (!token) throw new Error('session token was not issued');
    return { session, token, csrfToken, setCookie };
  }
  async authenticate(token: string): Promise<{
    readonly session: SessionPrincipal;
    readonly csrfToken: string;
  }> {
    const now = this.#clock();
    const hash = this.#codec.hash(token);
    const session = await this.#store.findByTokenHash(hash);
    if (
      session?.status !== 'ACTIVE' ||
      session.expiresAt <= now ||
      !this.#codec.matches(token, hash)
    ) {
      throw Object.assign(new Error('session is expired or invalid'), {
        statusCode: 401,
        code: 'SESSION_EXPIRED',
      });
    }
    return { session, csrfToken: this.csrfToken(session.id) };
  }
  csrfToken(sessionId: string): string {
    const nonce = this.#codec.issue().token;
    return csrf(this.#csrfSecret, sessionId, nonce);
  }
}

export function verifyCsrfToken(
  secret: string,
  sessionId: string,
  token: string,
): boolean {
  const [nonce, signature] = token.split('.');
  if (!nonce || !signature) return false;
  const expected = createHmac('sha256', secret)
    .update(`${sessionId}.${nonce}`)
    .digest();
  const actual = Buffer.from(signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
