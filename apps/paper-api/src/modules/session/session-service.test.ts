import { describe, expect, it } from 'vitest';
import {
  type SessionPrincipal,
  SessionService,
  type SessionStore,
  verifyCsrfToken,
} from './session-service.js';

const session = (id: string, now: Date): SessionPrincipal => ({
  id,
  status: 'ACTIVE',
  expiresAt: new Date(now.getTime() + 1000),
  lastSeenAt: now,
});
describe('SessionService', () => {
  it('can issue an HTTP-only cookie for an explicitly insecure local test origin', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const store: SessionStore = {
      findByTokenHash: async () => undefined,
      bootstrap: async ({ id, now: createdAt }) => session(id, createdAt),
    };
    const service = new SessionService({
      keys: ['primary-key'],
      csrfSecret: 'csrf-secret',
      store,
      secureCookie: false,
      clock: () => now,
    });

    const issued = await service.bootstrap();

    expect(issued.setCookie).toContain('HttpOnly');
    expect(issued.setCookie).not.toContain('Secure');
  });
  it('bootstraps wallets through the store exactly once and binds csrf to session', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let bootstraps = 0;
    const rows = new Map<string, SessionPrincipal>();
    const store: SessionStore = {
      findByTokenHash: async (hash) => rows.get(hash),
      bootstrap: async ({ id, tokenHash, now }) => {
        bootstraps++;
        const value = session(id, now);
        rows.set(tokenHash, value);
        return value;
      },
    };
    const service = new SessionService({
      keys: ['secret'],
      csrfSecret: 'csrf-secret',
      store,
      clock: () => now,
    });
    const first = await service.bootstrap();
    const second = await service.bootstrap(first.token);
    expect(bootstraps).toBe(1);
    expect(
      verifyCsrfToken('csrf-secret', first.session.id, first.csrfToken),
    ).toBe(true);
    expect(second.session.id).toBe(first.session.id);
  });
});
