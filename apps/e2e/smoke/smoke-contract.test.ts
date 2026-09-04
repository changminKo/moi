import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  apiCallsToOrigin,
  isIgnorableConsoleError,
  readRuntimeConfigApiOrigin,
  requireSmokeWebOrigin,
} from './smoke-contract.js';

describe('isIgnorableConsoleError', () => {
  it('tolerates the favicon Chromium asks for and does not get', () => {
    assert.equal(
      isIgnorableConsoleError({
        text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
        location: 'https://moi.example/favicon.ico',
      }),
      true,
    );
    assert.equal(
      isIgnorableConsoleError({
        text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
        location: 'https://moi.example/favicon.svg?v=2',
      }),
      true,
    );
  });

  it('keeps a failed API call, which is the whole point of the smoke', () => {
    assert.equal(
      isIgnorableConsoleError({
        text: 'Failed to load resource: the server responded with a status of 405 (Method Not Allowed)',
        location: 'https://moi.example/api/v1/sessions/anonymous',
      }),
      false,
    );
  });

  it('keeps an error with no location at all', () => {
    assert.equal(
      isIgnorableConsoleError({
        text: 'Uncaught TypeError: x is not a function',
      }),
      false,
    );
  });

  // A resource under a directory named after the icon is not the icon, and an
  // error that merely mentions the word is not a load failure.
  it('does not let the word favicon excuse an unrelated error', () => {
    assert.equal(
      isIgnorableConsoleError({
        text: 'Refused to connect because it violates the Content Security Policy',
        location: 'https://moi.example/favicon.ico',
      }),
      false,
    );
    assert.equal(
      isIgnorableConsoleError({
        text: 'Failed to load resource: 404',
        location: 'https://moi.example/favicon/bundle.js',
      }),
      false,
    );
  });
});

describe('readRuntimeConfigApiOrigin', () => {
  it('reads the origin the web server injected', () => {
    assert.equal(
      readRuntimeConfigApiOrigin(
        'window.__MOI_RUNTIME_CONFIG__ = Object.freeze({"apiOrigin":"https://api.moi.example"});\n',
      ),
      'https://api.moi.example',
    );
  });

  // The regression's own shape: the file shipped in apps/web/public assigns
  // window.location.origin, so a container serving it never names an origin.
  it('refuses the unconfigured fallback that names no origin', () => {
    assert.throws(
      () =>
        readRuntimeConfigApiOrigin(
          'window.__MOI_RUNTIME_CONFIG__ = {\n  apiOrigin: window.location.origin,\n};\n',
        ),
      /declares no literal apiOrigin/,
    );
  });

  it('refuses an origin carrying a path or credentials', () => {
    assert.throws(
      () =>
        readRuntimeConfigApiOrigin(
          '{"apiOrigin":"https://api.moi.example/v1"}',
        ),
      /bare origin without a path/,
    );
    assert.throws(
      () =>
        readRuntimeConfigApiOrigin(
          '{"apiOrigin":"https://u:p@api.moi.example"}',
        ),
      /must not include credentials/,
    );
  });
});

describe('requireSmokeWebOrigin', () => {
  it('names the variable and an example when it is unset or empty', () => {
    assert.throws(
      () => requireSmokeWebOrigin(undefined),
      /SMOKE_WEB_ORIGIN is required/,
    );
    assert.throws(
      () => requireSmokeWebOrigin(''),
      /SMOKE_WEB_ORIGIN is required/,
    );
  });

  it('normalises an accepted origin', () => {
    assert.equal(
      requireSmokeWebOrigin('https://moi.example'),
      'https://moi.example',
    );
  });

  it('refuses anything that is not a bare http(s) origin', () => {
    assert.throws(() => requireSmokeWebOrigin('moi.example'), /absolute URL/);
    assert.throws(
      () => requireSmokeWebOrigin('https://moi.example/trade'),
      /bare origin without a path/,
    );
    assert.throws(
      () => requireSmokeWebOrigin('ftp://moi.example'),
      /http or https/,
    );
  });
});

describe('apiCallsToOrigin', () => {
  const responses = [
    { url: 'https://moi.example/trade', status: 200 },
    { url: 'https://api.moi.example/api/v1/sessions/anonymous', status: 201 },
    { url: 'https://api.moi.example/api/v1/portfolio', status: 200 },
    { url: 'https://api.moi.example/api/v1/orders', status: 500 },
  ];

  it('counts only successful API calls that went to the configured origin', () => {
    assert.deepEqual(
      apiCallsToOrigin(responses, 'https://api.moi.example').map((r) => r.url),
      [
        'https://api.moi.example/api/v1/sessions/anonymous',
        'https://api.moi.example/api/v1/portfolio',
      ],
    );
  });

  // #25 itself: the bundle called the page's own origin, so nothing reached
  // the origin the runtime config named.
  it('finds nothing when the bundle called its own origin instead', () => {
    assert.deepEqual(
      apiCallsToOrigin(
        [{ url: 'https://moi.example/api/v1/sessions/anonymous', status: 405 }],
        'https://api.moi.example',
      ),
      [],
    );
  });
});
