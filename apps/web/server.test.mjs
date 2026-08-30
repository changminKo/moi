// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWebServer,
  renderRuntimeConfig,
  validatePublicApiOrigin,
} from './server.mjs';

const INDEX_HTML =
  '<!doctype html><html><body><div id="root"></div></body></html>';
const API_ORIGIN = 'https://api.moi.example';

let server;
let baseUrl;

async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    redirect: 'manual',
    ...init,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  };
}

beforeAll(async () => {
  const distDir = await mkdtemp(join(tmpdir(), 'moi-web-dist-'));
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), INDEX_HTML);
  await writeFile(
    join(distDir, 'assets', 'index-C0hp302H.js'),
    'console.log(1)',
  );
  await writeFile(join(distDir, 'assets', 'index-C0hp302H.css'), 'body{}');
  await writeFile(join(distDir, 'secret.txt'), 'not served');
  await writeFile(
    join(distDir, 'favicon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" />',
  );
  await writeFile(join(distDir, 'apple-touch-icon.png'), 'PNG');
  await mkdir(join(distDir, 'fonts'), { recursive: true });
  await writeFile(join(distDir, 'fonts', 'bm-hanna-pro.woff2'), 'wOF2');
  await writeFile(join(distDir, '..', 'outside.txt'), 'outside dist').catch(
    () => {},
  );
  server = createWebServer({ distDir, publicApiOrigin: API_ORIGIN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('method handling', () => {
  it('serves HEAD without a body', async () => {
    const response = await request('/assets/index-C0hp302H.js', {
      method: 'HEAD',
    });
    expect(response.status).toBe(200);
    expect(response.body).toBe('');
    expect(response.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
  });

  it('rejects non-GET/HEAD methods with 405 and Allow', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await request('/', { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
    }
  });
});

describe('static assets', () => {
  it('serves hashed assets with immutable caching and MIME types', async () => {
    const js = await request('/assets/index-C0hp302H.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(js.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    const css = await request('/assets/index-C0hp302H.css');
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('serves the self-hosted fonts with a day of caching', async () => {
    const font = await request('/fonts/bm-hanna-pro.woff2');
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
    expect(font.headers.get('cache-control')).toBe('public, max-age=86400');
    const unknown = await request('/fonts/../secret.txt');
    expect(unknown.status).toBe(404);
    const other = await request('/fonts/evil.js');
    expect(other.status).toBe(404);
  });

  it('serves the brand icons from the public allowlist', async () => {
    const svg = await request('/favicon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    const png = await request('/apple-touch-icon.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    const unlisted = await request('/logo.svg');
    expect(unlisted.status).toBe(404);
  });

  it('serves index.html with no-store', async () => {
    const response = await request('/');
    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'text/html; charset=utf-8',
    );
  });

  it('returns 404 for missing hashed assets instead of falling back to index.html', async () => {
    const response = await request('/assets/missing-999.js');
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('<div id="root">');
  });

  it('refuses files outside the MIME allowlist', async () => {
    const response = await request('/secret.txt');
    expect(response.status).toBe(404);
    expect(response.body).not.toBe('not served');
  });

  it('confines path traversal to dist', async () => {
    for (const path of [
      '/../outside.txt',
      '/assets/..%2f..%2foutside.txt',
      '/%2e%2e/outside.txt',
      '/assets/../../server.mjs',
    ]) {
      const response = await request(path);
      expect(response.status, path).not.toBe(200);
      expect(response.body, path).not.toContain('outside dist');
    }
  });

  it('serves index.html as the SPA fallback for extensionless routes', async () => {
    const response = await request('/trade/KRX/005930');
    expect(response.status).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('security headers', () => {
  it('sets a CSP whose connect-src includes the API origin and its websocket origin', async () => {
    const response = await request('/');
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(
      /connect-src 'self' https:\/\/api\.moi\.example wss:\/\/api\.moi\.example/,
    );
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('permissions-policy')).toContain('camera=()');
  });
});

describe('runtime config', () => {
  it('serves /runtime-config.js with no-store from the validated origin', async () => {
    const response = await request('/runtime-config.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );
    expect(response.body).toContain(`"apiOrigin":"${API_ORIGIN}"`);
    expect(response.body).toMatch(
      /^window\.__MOI_RUNTIME_CONFIG__ = Object\.freeze\(/,
    );
  });

  it('escapes script-breaking characters when rendering the config', () => {
    const rendered = renderRuntimeConfig('https://api.example.com');
    expect(rendered).not.toContain('</script');
    expect(renderRuntimeConfig.toString()).toBeTypeOf('string');
    const evaluated = new Function(
      'window',
      `${rendered}; return window.__MOI_RUNTIME_CONFIG__;`,
    )({});
    expect(evaluated).toEqual({ apiOrigin: 'https://api.example.com' });
  });

  it('validates PUBLIC_API_ORIGIN to a bare https origin', () => {
    expect(validatePublicApiOrigin('https://api.example.com')).toBe(
      'https://api.example.com',
    );
    expect(validatePublicApiOrigin('https://api.example.com/')).toBe(
      'https://api.example.com',
    );
    expect(validatePublicApiOrigin('http://127.0.0.1:3000')).toBe(
      'http://127.0.0.1:3000',
    );
    expect(() => validatePublicApiOrigin('http://api.example.com')).toThrow(
      /HTTPS/,
    );
    expect(() =>
      validatePublicApiOrigin('https://user:pw@api.example.com'),
    ).toThrow(/credentials/);
    expect(() => validatePublicApiOrigin('https://api.example.com/v1')).toThrow(
      /path/,
    );
    expect(() =>
      validatePublicApiOrigin('https://api.example.com/</script>'),
    ).toThrow();
    expect(() => validatePublicApiOrigin('not a url')).toThrow(/absolute/);
    expect(() => validatePublicApiOrigin('')).toThrow();
  });
});
