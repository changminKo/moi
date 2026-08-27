import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const LOOPBACK = new Set([
  '127.0.0.1',
  '::1',
  '[::1]',
  'localhost',
  '0.0.0.0',
  '::',
]);

export class LiveProviderForbiddenError extends Error {
  constructor(host: string) {
    super(`LIVE_PROVIDER_FORBIDDEN: ${host}`);
    this.name = 'LiveProviderForbiddenError';
  }
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined || host === '') return true; // relative / unix sockets
  const bare = host.replace(/^\[|\]$/g, '').split(':')[0] ?? host;
  return LOOPBACK.has(bare) || LOOPBACK.has(host);
}

function hostOf(input: unknown): string | undefined {
  if (typeof input === 'string') {
    try {
      return new URL(input).hostname;
    } catch {
      return undefined;
    }
  }
  if (input instanceof URL) return input.hostname;
  if (input && typeof input === 'object') {
    const options = input as { host?: string; hostname?: string; url?: string };
    if (typeof options.url === 'string') return hostOf(options.url);
    return options.hostname ?? options.host;
  }
  return undefined;
}

function assertLoopback(input: unknown): void {
  const host = hostOf(input);
  if (!isLoopbackHost(host)) throw new LiveProviderForbiddenError(String(host));
}

/**
 * Test-only network fence (§9.5). Every outbound HTTP(S), WebSocket handshake
 * (which rides on http/https.request), and raw TCP/TLS connection must target
 * a loopback host. Idempotent.
 */
export function installLiveProviderGuard(): void {
  const marker = Symbol.for('skipjack.liveProviderGuard');
  const g = globalThis as Record<symbol, boolean>;
  if (g[marker]) return;
  g[marker] = true;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    assertLoopback(input instanceof Request ? input.url : input);
    return originalFetch(input as RequestInfo, init as RequestInit);
  }) as typeof fetch;

  for (const mod of [http, https] as const) {
    const originalRequest = mod.request.bind(mod);
    const originalGet = mod.get.bind(mod);
    const guard = (original: typeof mod.request) =>
      ((...args: unknown[]) => {
        const [first, second] = args;
        assertLoopback(first);
        if (second && typeof second === 'object' && !(second instanceof URL))
          assertLoopback(second);
        return (original as (...a: unknown[]) => http.ClientRequest)(...args);
      }) as typeof mod.request;
    mod.request = guard(originalRequest);
    mod.get = guard(originalGet) as typeof mod.get;
  }

  const originalNetConnect = net.connect.bind(net);
  const netGuard = ((...args: unknown[]) => {
    const [first] = args;
    if (first && typeof first === 'object' && !('path' in (first as object)))
      assertLoopback(first);
    if (typeof args[1] === 'string') assertLoopback({ host: args[1] });
    return (originalNetConnect as (...a: unknown[]) => net.Socket)(...args);
  }) as typeof net.connect;
  net.connect = netGuard;
  net.createConnection = netGuard;

  const originalTlsConnect = tls.connect.bind(tls);
  tls.connect = ((...args: unknown[]) => {
    const [first] = args;
    if (first && typeof first === 'object') assertLoopback(first);
    if (typeof args[1] === 'string') assertLoopback({ host: args[1] });
    return (originalTlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args);
  }) as typeof tls.connect;
}
