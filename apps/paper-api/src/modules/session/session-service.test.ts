import { describe, expect, it } from 'vitest';
import { SessionService, verifyCsrfToken, type SessionPrincipal, type SessionStore } from './session-service.js';

const session = (id: string, now: Date): SessionPrincipal => ({ id, status: 'ACTIVE', expiresAt: new Date(now.getTime() + 1000), lastSeenAt: now });
describe('SessionService', () => {
  it('bootstraps wallets through the store exactly once and binds csrf to session', async () => {
    const now = new Date('2026-01-01T00:00:00Z'); let bootstraps = 0;
    const rows = new Map<string, SessionPrincipal>();
    const store: SessionStore = { findByTokenHash: async (hash) => rows.get(hash), bootstrap: async ({ id, tokenHash, now }) => { bootstraps++; const value = session(id, now); rows.set(tokenHash, value); return value; } };
    const service = new SessionService({ keys: ['secret'], csrfSecret: 'csrf-secret', store, clock: () => now });
    const first = await service.bootstrap();
    const second = await service.bootstrap(first.token);
    expect(bootstraps).toBe(1);
    expect(verifyCsrfToken('csrf-secret', first.session.id, first.csrfToken)).toBe(true);
    expect(second.session.id).toBe(first.session.id);
  });
});
