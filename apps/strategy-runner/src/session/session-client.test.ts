import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import { JsonCell } from '../state/json-cell.js';
import {
  type ApiRequest,
  type FetchLike,
  PaperApiClient,
} from '../transport/paper-api-client.js';
import { SessionClient } from './session-client.js';

const ORIGIN = 'http://127.0.0.1:3001';

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly setCookie?: string;
}

/** A paper API stand-in keyed by `METHOD path`, answering a queue per key. */
function api(routes: Readonly<Record<string, readonly Reply[]>>): {
  readonly fetch: FetchLike;
  readonly sent: ApiRequest[];
} {
  const queues = new Map(
    Object.entries(routes).map(([key, replies]) => [key, [...replies]]),
  );
  const sent: ApiRequest[] = [];

  return {
    sent,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const key = `${init.method} ${path}`;

      sent.push({
        method: init.method as 'GET',
        path,
        authenticated: init.headers.cookie !== undefined,
      });

      const queue = queues.get(key);
      const reply = (queue?.length ?? 0) > 1 ? queue?.shift() : queue?.[0];

      if (reply === undefined) {
        throw new Error(`no stubbed reply for ${key}`);
      }

      return {
        status: reply.status,
        headers: {
          get: (name: string) =>
            name === 'set-cookie' ? (reply.setCookie ?? null) : null,
        },
        text: async () =>
          reply.body === undefined ? '' : JSON.stringify(reply.body),
      };
    },
  };
}

const BOOTSTRAP: Reply = {
  status: 200,
  body: { session: { id: 's-new' }, csrfToken: 'csrf-new' },
  setCookie: 'moi_session=cookie-new; Max-Age=1209600; Path=/; HttpOnly',
};

function harness(routes: Readonly<Record<string, readonly Reply[]>>) {
  const directory = mkdtempSync(join(tmpdir(), 'moi-session-'));
  const cell = new JsonCell(join(directory, 'session.json'), { mode: 0o600 });
  const reporter = createRecordingReporter();
  const stub = api(routes);
  const client = new SessionClient({
    api: new PaperApiClient({
      origin: ORIGIN,
      credentials: () => session.credentials(),
      fetch: stub.fetch,
    }),
    cell,
    reporter,
  });
  const session = client;

  return { cell, client, directory, reporter, sent: stub.sent };
}

describe('SessionClient with no stored session', () => {
  it('creates one, persists it, and reports it', async () => {
    const { cell, client, reporter } = harness({
      'POST /api/v1/sessions/anonymous': [BOOTSTRAP],
    });

    await expect(client.establish()).resolves.toStrictEqual({
      sessionId: 's-new',
      cookie: 'moi_session=cookie-new',
      csrfToken: 'csrf-new',
    });
    expect(cell.read()).toStrictEqual({
      sessionId: 's-new',
      cookie: 'moi_session=cookie-new',
      csrfToken: 'csrf-new',
      previousSessionIds: [],
    });
    expect(reporter.lines).toStrictEqual([
      '[info] created a trading session sessionId=s-new',
    ]);
  });

  /** §7.4: the file holding the cookie and the token is owner-only. */
  it('writes the session cell at 0600', async () => {
    const { cell, client } = harness({
      'POST /api/v1/sessions/anonymous': [BOOTSTRAP],
    });

    await client.establish();

    expect(statSync(cell.path).mode & 0o777).toBe(0o600);
  });

  it('keeps only the cookie pair, not the attributes', async () => {
    const { cell, client } = harness({
      'POST /api/v1/sessions/anonymous': [BOOTSTRAP],
    });

    await client.establish();

    expect((cell.read() as { cookie: string }).cookie).toBe(
      'moi_session=cookie-new',
    );
  });

  it('fails closed when the bootstrap carries no cookie', async () => {
    const { client } = harness({
      'POST /api/v1/sessions/anonymous': [
        { status: 200, body: { session: { id: 's' }, csrfToken: 'c' } },
      ],
    });

    await expect(client.establish()).rejects.toThrow(DomainError);
  });

  it('fails closed when the bootstrap is refused', async () => {
    const { client, cell } = harness({
      'POST /api/v1/sessions/anonymous': [{ status: 503 }],
    });

    await expect(client.establish()).rejects.toThrow(/answered 503/u);
    expect(cell.read()).toBeNull();
  });
});

describe('SessionClient with a stored session', () => {
  const STORED = {
    sessionId: 's-1',
    cookie: 'moi_session=cookie-1',
    csrfToken: 'csrf-1',
    previousSessionIds: [],
  };

  it('reuses it after confirming it with the portfolio', async () => {
    const { cell, client, reporter } = harness({
      'GET /api/v1/portfolio': [{ status: 200, body: { sessionId: 's-1' } }],
      'GET /api/v1/session': [{ status: 200, body: { csrfToken: 'csrf-1' } }],
    });

    cell.write(STORED);

    await expect(client.establish()).resolves.toStrictEqual({
      sessionId: 's-1',
      cookie: 'moi_session=cookie-1',
      csrfToken: 'csrf-1',
    });
    expect(reporter.lines).toStrictEqual([
      '[info] reusing the stored session sessionId=s-1',
    ]);
  });

  /**
   * The gap in §4.3 this closes: `GET /api/v1/portfolio` confirms the cookie and
   * says nothing about the CSRF token, so after a `CSRF_SECRET` rotation the bot
   * would 403 on every order forever with a session that is entirely healthy.
   */
  it('re-mints a CSRF token that the server no longer accepts', async () => {
    const { cell, client } = harness({
      'GET /api/v1/portfolio': [{ status: 200, body: { sessionId: 's-1' } }],
      'GET /api/v1/session': [{ status: 200, body: { csrfToken: 'csrf-2' } }],
    });

    cell.write(STORED);

    await expect(client.establish()).resolves.toMatchObject({
      csrfToken: 'csrf-2',
    });
    expect(cell.read()).toMatchObject({
      sessionId: 's-1',
      csrfToken: 'csrf-2',
    });
  });

  it('keeps the stored token when the refresh is unavailable', async () => {
    const { cell, client } = harness({
      'GET /api/v1/portfolio': [{ status: 200, body: { sessionId: 's-1' } }],
      'GET /api/v1/session': [{ status: 503 }],
    });

    cell.write(STORED);

    await expect(client.establish()).resolves.toMatchObject({
      csrfToken: 'csrf-1',
    });
  });

  /** §4.3 point 2: a 401 means create a new one. */
  it('creates a new session when the stored one answers 401', async () => {
    const { cell, client, reporter } = harness({
      'GET /api/v1/portfolio': [
        { status: 401, body: { code: 'SESSION_EXPIRED' } },
      ],
      'POST /api/v1/sessions/anonymous': [BOOTSTRAP],
    });

    cell.write(STORED);

    await expect(client.establish()).resolves.toMatchObject({
      sessionId: 's-new',
    });
    expect(reporter.lines).toStrictEqual([
      '[info] the stored session has expired sessionId=s-1',
      '[warn] the trading session was replaced; the previous session’s open orders can no longer be cancelled by the bot previousSessionId=s-1 sessionId=s-new',
    ]);
  });

  /** §4.3 point 3: the abandoned id stays in state for an operator. */
  it('keeps the abandoned session id in state', async () => {
    const { cell, client } = harness({
      'GET /api/v1/portfolio': [{ status: 401 }],
      'POST /api/v1/sessions/anonymous': [BOOTSTRAP],
    });

    cell.write(STORED);

    await client.establish();

    expect(cell.read()).toMatchObject({
      sessionId: 's-new',
      previousSessionIds: ['s-1'],
    });
  });

  it('accumulates every abandoned id across repeated swaps', async () => {
    const { cell, client } = harness({
      'POST /api/v1/sessions/anonymous': [
        BOOTSTRAP,
        {
          ...BOOTSTRAP,
          body: { session: { id: 's-third' }, csrfToken: 'c3' },
          setCookie: 'moi_session=c3; Path=/',
        },
      ],
      'GET /api/v1/portfolio': [{ status: 401 }],
    });

    cell.write(STORED);

    await client.establish();
    await client.reestablish();

    expect(cell.read()).toMatchObject({
      sessionId: 's-third',
      previousSessionIds: ['s-1', 's-new'],
    });
  });

  /**
   * A 503 while validating is not evidence the session is dead. Burning one on
   * every restart during a recovery window would orphan a set of open orders
   * per restart, which is the failure §4.3 point 3 exists to make rare.
   */
  it('refuses to replace a session over a transient validation failure', async () => {
    const { cell, client } = harness({
      'GET /api/v1/portfolio': [{ status: 503 }],
    });

    cell.write(STORED);

    await expect(client.establish()).rejects.toThrow(/may be healthy/u);
    expect(cell.read()).toMatchObject({ sessionId: 's-1' });
  });

  /**
   * The cookie authenticates an account the runner has no history for. Adopting
   * it would trade a stranger's ledger; failing closed makes an operator look.
   */
  it('fails closed when the cookie authenticates a different session', async () => {
    const { cell, client } = harness({
      'GET /api/v1/portfolio': [
        { status: 200, body: { sessionId: 's-other' } },
      ],
    });

    cell.write(STORED);

    await expect(client.establish()).rejects.toThrow(/not the recorded s-1/u);
  });

  it('fails closed on a state cell that is not a session', async () => {
    const { cell, client } = harness({ 'GET /api/v1/portfolio': [] });

    cell.write({ sessionId: 's-1' });

    await expect(client.establish()).rejects.toThrow(DomainError);
  });
});
