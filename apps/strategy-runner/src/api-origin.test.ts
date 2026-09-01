import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_API_HOSTS,
  readApiOrigin,
  readPublicOrigin,
} from './api-origin.js';

describe('readApiOrigin', () => {
  it('accepts a loopback origin on any port', () => {
    expect(readApiOrigin('http://127.0.0.1:3001')).toBe(
      'http://127.0.0.1:3001',
    );
    expect(readApiOrigin('http://localhost:8080')).toBe(
      'http://localhost:8080',
    );
    expect(readApiOrigin('http://[::1]:3001')).toBe('http://[::1]:3001');
  });

  it('accepts the compose service host the bot container reaches', () => {
    expect(readApiOrigin('http://paper-api:3000')).toBe(
      'http://paper-api:3000',
    );
  });

  /**
   * The defence, and the reason this function exists (design §4.1). v1 claimed a
   * path whitelist kept the bot off a live venue; it never did, because the path
   * union says nothing about the host. This does: an origin whose host is not in
   * `ALLOWED_API_HOSTS` refuses to start, so a misconfigured `BOT_API_ORIGIN`
   * cannot point order placement at a real exchange.
   *
   * The refused hosts are `.example` names on purpose. Naming the real provider
   * would put its hostname in a test file, and
   * `scripts/check-deployment-contract.mjs` fails the build when it appears
   * outside the pinned contracts and server constants — a guard for AGENTS.md
   * rule 1 worth more than the documentary value of the literal. The property
   * under test is "the host is not on the allow-list", and any off-list host
   * demonstrates it.
   */
  it('refuses a host that is not on the allow-list', () => {
    for (const origin of [
      'https://api.live-venue.example',
      'https://api.another-venue.example',
      // A suffix that merely ends in an allowed name, and a subdomain of one.
      'https://127.0.0.1.evil.example',
      'http://paper-api.evil.example',
      // The cloud metadata endpoint, which is loopback-adjacent and is not
      // loopback.
      'http://169.254.169.254',
    ]) {
      expect(() => readApiOrigin(origin)).toThrow(DomainError);
      expect(() => readApiOrigin(origin)).toThrow(/not on the allow-list/u);
    }
  });

  it('names no venue and no non-loopback public host on the allow-list', () => {
    expect([...ALLOWED_API_HOSTS].sort()).toStrictEqual([
      '127.0.0.1',
      '[::1]',
      'localhost',
      'paper-api',
    ]);
  });

  /**
   * An origin is a scheme, a host and a port — nothing else. A value carrying a
   * path, a query, or credentials is either a mistake or an attempt to smuggle
   * something past `new URL(path, origin)`, and both fail closed.
   */
  it('refuses anything that is not a bare origin', () => {
    for (const origin of [
      'http://127.0.0.1:3001/api',
      'http://127.0.0.1:3001/',
      'http://127.0.0.1:3001?x=1',
      'http://127.0.0.1:3001#x',
      'http://user:pass@127.0.0.1:3001',
      'ws://127.0.0.1:3001',
      'file:///etc/passwd',
      'not a url',
      '',
    ]) {
      expect(() => readApiOrigin(origin)).toThrow(DomainError);
    }
  });

  it('refuses a value that is not a string', () => {
    expect(() => readApiOrigin(undefined as never)).toThrow(DomainError);
  });
});

/**
 * The `Origin` header value the paper API's CSRF check compares against its own
 * `PUBLIC_ORIGIN` (§4.2). A different value from the connect target, and the
 * distinction is not cosmetic: in compose the bot reaches `http://paper-api:3000`
 * while the public origin is the browser app's `https://app.moi.example`, so
 * sending the connect target would be answered 403 on every mutation.
 */
describe('readPublicOrigin', () => {
  it('accepts the public origin of a deployment the bot never connects to', () => {
    expect(readPublicOrigin('https://app.moi.example')).toBe(
      'https://app.moi.example',
    );
  });

  /**
   * Deliberately not allow-listed. The allow-list stops the runner *reaching* a
   * venue; a header value reaches nothing, it is a string the API compares
   * against its own configuration. A rule that made the web app's origin appear
   * on a list of hosts the bot may connect to would be a rule about the wrong
   * thing.
   */
  it('does not hold the header value to the connect allow-list', () => {
    expect(() => readApiOrigin('https://app.moi.example')).toThrow(
      /not on the allow-list/u,
    );
    expect(readPublicOrigin('https://app.moi.example')).toBe(
      'https://app.moi.example',
    );
  });

  it('still refuses a value that is not a bare origin', () => {
    for (const bad of [
      'https://app.moi.example/',
      'https://user:pass@app.moi.example',
      'ftp://app.moi.example',
      'not a url',
      undefined,
    ]) {
      expect(() => readPublicOrigin(bad as never)).toThrow(DomainError);
    }
  });
});
