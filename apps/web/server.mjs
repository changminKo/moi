/**
 * Production static server for the Moi web bundle.
 *
 * Deliberately small: GET/HEAD only, paths confined to `dist`, an explicit
 * MIME allowlist, security headers on every response, immutable caching for
 * hashed assets, `no-store` for the HTML shell and runtime config. The API
 * origin arrives through `PUBLIC_API_ORIGIN`; no secret ever enters the
 * generated `/runtime-config.js`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ALLOWED_METHODS = 'GET, HEAD';
const HASHED_ASSET_PATTERN =
  /^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});
// `.txt` is a valid type for e.g. robots.txt but only when explicitly listed.
const PUBLIC_FILES = new Set([
  '/robots.txt',
  '/favicon.ico',
  '/manifest.webmanifest',
]);

/**
 * Accepts only a bare origin: absolute URL, no credentials, no path/query/hash.
 * HTTP is tolerated for loopback hosts so local Compose runs work.
 */
export function validatePublicApiOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('PUBLIC_API_ORIGIN is required');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUBLIC_API_ORIGIN must be an absolute URL');
  }
  if (url.username || url.password) {
    throw new Error('PUBLIC_API_ORIGIN must not include credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_API_ORIGIN must be a bare origin without a path');
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('PUBLIC_API_ORIGIN must use HTTPS outside loopback hosts');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('PUBLIC_API_ORIGIN must use http or https');
  }
  return url.origin;
}

/** Renders the runtime config script; JSON-escapes `<`, `>`, `&` so no markup can break out. */
export function renderRuntimeConfig(apiOrigin) {
  const json = JSON.stringify({ apiOrigin })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
  return `window.__MOI_RUNTIME_CONFIG__ = Object.freeze(${json});\n`;
}

function buildCsp(apiOrigin) {
  const wsOrigin = apiOrigin.replace(/^http/, 'ws');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin} ${wsOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function securityHeaders(csp) {
  return Object.freeze({
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
}

/** Resolves a request path to a file inside dist, or null when it escapes or is malformed. */
function resolveInsideDist(distDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded.split('/').some((segment) => segment === '..')) return null;
  const candidate = resolve(distDir, `.${decoded}`);
  const rel = relative(distDir, candidate);
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.includes(`..${sep}`)) {
    return null;
  }
  return candidate;
}

async function fileStat(path) {
  try {
    const info = await stat(path);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

function send(response, method, status, headers, body) {
  response.writeHead(status, headers);
  if (method === 'HEAD' || body === undefined) {
    response.end();
    return;
  }
  response.end(body);
}

function streamFile(response, method, status, headers, path, size) {
  response.writeHead(status, { ...headers, 'Content-Length': size });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(path)
    .on('error', () => response.destroy())
    .pipe(response);
}

export function createWebServer({ distDir, publicApiOrigin }) {
  const root = resolve(distDir);
  const apiOrigin = validatePublicApiOrigin(publicApiOrigin);
  const baseHeaders = securityHeaders(buildCsp(apiOrigin));
  const runtimeConfig = renderRuntimeConfig(apiOrigin);
  const indexPath = join(root, 'index.html');

  const serveIndex = async (response, method) => {
    const info = await fileStat(indexPath);
    if (!info) {
      send(
        response,
        method,
        500,
        {
          ...baseHeaders,
          'Cache-Control': NO_STORE,
          'Content-Type': MIME_TYPES['.txt'],
        },
        'index.html missing',
      );
      return;
    }
    streamFile(
      response,
      method,
      200,
      {
        ...baseHeaders,
        'Cache-Control': NO_STORE,
        'Content-Type': MIME_TYPES['.html'],
      },
      indexPath,
      info.size,
    );
  };

  const notFound = (response, method) =>
    send(
      response,
      method,
      404,
      {
        ...baseHeaders,
        'Cache-Control': NO_STORE,
        'Content-Type': MIME_TYPES['.txt'],
      },
      'Not Found',
    );

  return createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(
        response,
        'GET',
        405,
        {
          ...baseHeaders,
          Allow: ALLOWED_METHODS,
          'Cache-Control': NO_STORE,
          'Content-Type': MIME_TYPES['.txt'],
        },
        'Method Not Allowed',
      );
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname === '/runtime-config.js') {
      send(
        response,
        method,
        200,
        {
          ...baseHeaders,
          'Cache-Control': NO_STORE,
          'Content-Type': MIME_TYPES['.js'],
        },
        runtimeConfig,
      );
      return;
    }

    const isHashedAsset = HASHED_ASSET_PATTERN.test(pathname);
    const isPublicFile = PUBLIC_FILES.has(pathname);
    if (isHashedAsset || isPublicFile) {
      const filePath = resolveInsideDist(root, pathname);
      const type = filePath
        ? MIME_TYPES[extname(filePath).toLowerCase()]
        : undefined;
      const info = filePath && type ? await fileStat(filePath) : null;
      if (!info) {
        notFound(response, method);
        return;
      }
      const cache = isHashedAsset ? IMMUTABLE_CACHE : 'public, max-age=3600';
      streamFile(
        response,
        method,
        200,
        { ...baseHeaders, 'Cache-Control': cache, 'Content-Type': type },
        filePath,
        info.size,
      );
      return;
    }

    // Anything with a file extension that is not a hashed asset or a listed
    // public file is unknown to the bundle: 404, never the SPA shell.
    if (
      extname(pathname) !== '' ||
      resolveInsideDist(root, pathname) === null
    ) {
      notFound(response, method);
      return;
    }
    await serveIndex(response, method);
  });
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const distDir = process.env.WEB_DIST_DIR ?? join(here, 'dist');
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  const server = createWebServer({
    distDir,
    publicApiOrigin: process.env.PUBLIC_API_ORIGIN,
  });
  server.listen(port, host, () => {
    console.log(
      JSON.stringify({ level: 'info', msg: 'web listening', host, port }),
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
