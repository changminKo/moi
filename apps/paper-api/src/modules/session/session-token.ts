import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'moi_session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionTokenCodec {
  issue(): { readonly token: string; readonly tokenHash: string };
  hash(token: string, key?: string): string;
  matches(token: string, storedHash: string): boolean;
}

const digest = (key: string, token: string): Buffer =>
  createHmac('sha256', key).update(token, 'utf8').digest();

export function createSessionTokenCodec(
  keys: readonly [string, ...string[]],
  random: () => Buffer = () => randomBytes(32),
): SessionTokenCodec {
  const active = keys[0];
  const hash = (token: string, key = active): string =>
    digest(key, token).toString('base64url');
  return Object.freeze({
    issue: () => {
      const token = random().toString('base64url');
      if (token.length !== 43)
        throw new Error('session random source must provide 32 bytes');
      return { token, tokenHash: hash(token) };
    },
    hash,
    matches: (token: string, storedHash: string) => {
      const wanted = Buffer.from(storedHash, 'base64url');
      if (wanted.length !== 32) return false;
      return keys.some((key) => {
        const actual = digest(key, token);
        return timingSafeEqual(actual, wanted);
      });
    },
  });
}

export function issueSessionToken(): string {
  return randomBytes(32).toString('base64url');
}
