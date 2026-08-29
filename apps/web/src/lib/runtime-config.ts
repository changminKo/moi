export type RuntimeConfig = Readonly<{ apiOrigin: string; wsOrigin: string }>;

type RuntimeConfigInput = Readonly<{ apiOrigin: string }>;

declare global {
  interface Window {
    __MOI_RUNTIME_CONFIG__?: RuntimeConfigInput;
  }
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function readRuntimeConfig(
  input: RuntimeConfigInput = window.__MOI_RUNTIME_CONFIG__ ?? {
    apiOrigin: window.location.origin,
  },
  options: Readonly<{ production?: boolean }> = {
    production:
      import.meta.env.PROD &&
      import.meta.env.VITE_MOI_ALLOW_LOCAL_HTTP !== 'true',
  },
): RuntimeConfig {
  let parsed: URL;
  try {
    parsed = new URL(input.apiOrigin);
  } catch {
    throw new Error('apiOrigin must be an absolute URL');
  }
  const isLoopback = loopbackHosts.has(parsed.hostname);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopback && !options.production)
  ) {
    throw new Error(
      'apiOrigin must use HTTPS (HTTP is allowed only for local development)',
    );
  }
  if (parsed.username || parsed.password)
    throw new Error('apiOrigin must not include credentials');
  const apiOrigin = parsed.origin;
  return { apiOrigin, wsOrigin: apiOrigin.replace(/^http/, 'ws') };
}
