import http from 'node:http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { installLiveProviderGuard, isLoopbackHost } from './live-guard.js';

installLiveProviderGuard();

describe('live provider guard (B9)', () => {
  it('classifies loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]'])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['example.com', '10.0.0.5', 'api.provider.test'])
      expect(isLoopbackHost(host)).toBe(false);
  });
  it('rejects non-loopback fetch before any network I/O', async () => {
    await expect(fetch('https://example.com/oauth2/token')).rejects.toThrow(
      /LIVE_PROVIDER_FORBIDDEN: example.com/,
    );
    await expect(fetch(new URL('https://example.com/'))).rejects.toThrow(
      /LIVE_PROVIDER_FORBIDDEN/,
    );
  });
  it('rejects non-loopback websocket handshakes and http requests', () => {
    expect(() => new WebSocket('wss://example.com/ws/v1')).toThrow(
      /LIVE_PROVIDER_FORBIDDEN/,
    );
    expect(() => http.request({ host: 'example.com', path: '/' })).toThrow(
      /LIVE_PROVIDER_FORBIDDEN/,
    );
  });
  it('still allows loopback traffic', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    expect(body).toBe('ok');
    await new Promise((resolve) => server.close(resolve));
  });
});
