export interface ExpiredSession {
  readonly id: string;
  readonly lastSeenAt: Date;
}
export interface SessionCleanupStore {
  findInactive(before: Date): Promise<readonly ExpiredSession[]>;
  expire(input: {
    readonly sessionId: string;
    readonly expiredAt: Date;
  }): Promise<void>;
  deleteIdentifying?(before: Date): Promise<number>;
}
export interface SessionCleanupOptions {
  readonly store: SessionCleanupStore;
  readonly now?: () => Date;
  readonly inactivityMs?: number;
  readonly retentionMs?: number;
}
export async function expireInactiveSessions(
  options: SessionCleanupOptions,
): Promise<{ expired: number; deleted: number }> {
  const now = (options.now ?? (() => new Date()))();
  const inactivityMs = options.inactivityMs ?? 30 * 24 * 60 * 60 * 1000;
  const sessions = await options.store.findInactive(
    new Date(now.getTime() - inactivityMs),
  );
  for (const session of sessions)
    await options.store.expire({ sessionId: session.id, expiredAt: now });
  const retentionMs = options.retentionMs ?? inactivityMs;
  const deleted = options.store.deleteIdentifying
    ? await options.store.deleteIdentifying(
        new Date(now.getTime() - retentionMs),
      )
    : 0;
  return { expired: sessions.length, deleted };
}
