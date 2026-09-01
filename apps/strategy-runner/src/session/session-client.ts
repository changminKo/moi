import { DomainError } from '@moi/trading-core';
import type { Reporter } from '../reporter.js';
import type { JsonCell } from '../state/json-cell.js';
import type {
  PaperApiClient,
  SessionCredentials,
} from '../transport/paper-api-client.js';

/**
 * The session lifecycle of design §4.3.
 *
 * 1. Reuse a persisted cookie, CSRF token and `sessionId`, confirming it with
 *    `GET /api/v1/portfolio`.
 * 2. Create one with `POST /api/v1/sessions/anonymous` when there is none or
 *    the stored one answers 401, and **persist it immediately** — before the
 *    runner is capable of placing anything under it.
 * 3. A swap is reported `warn` and the previous `sessionId` is kept in state,
 *    because the bot can no longer cancel that session's open orders and an
 *    operator needs the id to do it by hand.
 *
 * ## Persist-before-use, and why it is the same argument as the decision log
 *
 * A session that has been created but not written down is a session under which
 * orders can be placed and which a restart cannot find. The bot would create a
 * second session, and the first one's orders would be unreachable — the exact
 * consequence §4.3 point 3 describes, arrived at by accident instead of by an
 * operator's decision. So the write happens between the response and the
 * credentials becoming available, and it is an atomic replace at 0600 (§7.4).
 *
 * ## A CSRF token is a cache, not a credential
 *
 * §4.3 validates a reused session with `GET /api/v1/portfolio`, which confirms
 * the *cookie*. It does not confirm the CSRF token, and the two can part
 * company: the server mints a token per request from a nonce and a secret, so a
 * `CSRF_SECRET` rotation leaves a perfectly good cookie beside a token every
 * mutation answers 403 — a bot permanently unable to trade on an account that
 * is entirely healthy, with nothing in §7.1 to recover it (403 is `FORBIDDEN`,
 * which is deliberately not retried).
 *
 * So the token is re-minted from `GET /api/v1/session` on every establish. It
 * costs one read at startup, it is what the browser effectively does, and a
 * failure of that call falls back to the stored token rather than refusing to
 * start. This is a gap in §4.3 rather than a departure from it: the step it
 * specifies is performed exactly as written, and this is an addition beside it.
 */

const SESSION_PATH = '/api/v1/sessions/anonymous';
const SESSION_READ_PATH = '/api/v1/session';
const PORTFOLIO_PATH = '/api/v1/portfolio';

export interface PersistedSession {
  readonly sessionId: string;
  readonly cookie: string;
  readonly csrfToken: string;
  /**
   * Sessions this runner has abandoned, oldest first. Their open orders are
   * beyond the bot's reach (§4.3), so the ids are kept for an operator.
   */
  readonly previousSessionIds: readonly string[];
}

export interface SessionClientOptions {
  readonly api: PaperApiClient;
  readonly cell: JsonCell;
  readonly reporter: Reporter;
}

function refuse(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];

  if (typeof value !== 'string' || value.trim().length === 0) {
    refuse(`the session response is missing ${field}`);
  }

  return value;
}

/**
 * The cookie pair from a `Set-Cookie` header — name and value, without the
 * attributes, which are the browser's business and not a client's.
 */
function cookiePair(setCookie: string | null): string {
  const pair = setCookie?.split(';')[0]?.trim();

  if (pair === undefined || !pair.startsWith('moi_session=')) {
    refuse('the session response carried no moi_session cookie');
  }

  return pair;
}

/** Validates the state cell. A stored session is a file, so it is untrusted. */
export function readPersistedSession(saved: unknown): PersistedSession | null {
  if (saved === null || saved === undefined) {
    return null;
  }

  if (typeof saved !== 'object' || Array.isArray(saved)) {
    refuse('the persisted session must be a JSON object');
  }

  const source = saved as Record<string, unknown>;
  const previous = source.previousSessionIds ?? [];

  if (
    !Array.isArray(previous) ||
    previous.some((id) => typeof id !== 'string')
  ) {
    refuse('the persisted session previousSessionIds must be a string array');
  }

  return Object.freeze({
    sessionId: readString(source, 'sessionId'),
    cookie: readString(source, 'cookie'),
    csrfToken: readString(source, 'csrfToken'),
    previousSessionIds: Object.freeze([...(previous as string[])]),
  });
}

export class SessionClient {
  readonly #api: PaperApiClient;
  readonly #cell: JsonCell;
  readonly #reporter: Reporter;
  #current: PersistedSession | null = null;

  constructor(options: SessionClientOptions) {
    this.#api = options.api;
    this.#cell = options.cell;
    this.#reporter = options.reporter;
  }

  /** The supplier `PaperApiClient` reads before every request. */
  credentials = (): SessionCredentials | null =>
    this.#current === null
      ? null
      : {
          sessionId: this.#current.sessionId,
          cookie: this.#current.cookie,
          csrfToken: this.#current.csrfToken,
        };

  async establish(): Promise<SessionCredentials> {
    const stored = readPersistedSession(this.#cell.read());

    if (stored !== null && (await this.#reuse(stored))) {
      return this.credentials() as SessionCredentials;
    }

    await this.create(stored);

    return this.credentials() as SessionCredentials;
  }

  /**
   * Re-establishes after a 401 in flight (§7.1: one attempt, then the caller
   * decides). The current session is the one being replaced, so it is what the
   * swap is reported against.
   */
  async reestablish(): Promise<SessionCredentials> {
    await this.create(this.#current);

    return this.credentials() as SessionCredentials;
  }

  async #reuse(stored: PersistedSession): Promise<boolean> {
    this.#current = stored;

    const response = await this.#api.send({
      method: 'GET',
      path: PORTFOLIO_PATH,
    });

    if (response.status === 401) {
      this.#reporter.report('info', 'the stored session has expired', {
        sessionId: stored.sessionId,
      });

      return false;
    }

    if (response.status !== 200) {
      // Not a reason to abandon a session. A 503 during recovery would
      // otherwise make every restart burn a session and orphan its orders.
      this.#current = null;
      refuse(
        `validating the stored session answered ${response.status}; refusing to replace a session that may be healthy`,
      );
    }

    const sessionId = readString(
      (response.body ?? {}) as Record<string, unknown>,
      'sessionId',
    );

    if (sessionId !== stored.sessionId) {
      // The cookie authenticates a different account than the one recorded.
      // Continuing would trade an account whose history the runner does not
      // have, so it fails closed rather than adopting it.
      this.#current = null;
      refuse(
        `the stored cookie authenticates session ${sessionId}, not the recorded ${stored.sessionId}`,
      );
    }

    await this.#refreshCsrfToken(stored);
    this.#reporter.report('info', 'reusing the stored session', { sessionId });

    return true;
  }

  async #refreshCsrfToken(stored: PersistedSession): Promise<void> {
    let token: string;

    try {
      const response = await this.#api.send({
        method: 'GET',
        path: SESSION_READ_PATH,
      });

      if (response.status !== 200) {
        return;
      }

      token = readString(
        (response.body ?? {}) as Record<string, unknown>,
        'csrfToken',
      );
    } catch {
      // The stored token stands. See the note on CSRF tokens above: this is a
      // refresh of a cache, and a cache that could not be refreshed is not a
      // reason to refuse to start.
      return;
    }

    if (token === stored.csrfToken) {
      return;
    }

    this.#persist({ ...stored, csrfToken: token });
  }

  /** Creates a session and persists it before it becomes usable. */
  async create(replacing: PersistedSession | null): Promise<void> {
    // Cleared first: the bootstrap is unauthenticated, and leaving a dead
    // session in place would let a concurrent read send a cookie the server has
    // already rejected.
    this.#current = null;

    const response = await this.#api.send({
      method: 'POST',
      path: SESSION_PATH,
      authenticated: false,
    });

    if (response.status < 200 || response.status >= 300) {
      refuse(`creating a session answered ${response.status}`);
    }

    const body = (response.body ?? {}) as Record<string, unknown>;
    const session = body.session;

    if (typeof session !== 'object' || session === null) {
      refuse('the session response is missing session');
    }

    const created: PersistedSession = {
      sessionId: readString(session as Record<string, unknown>, 'id'),
      cookie: cookiePair(response.setCookie),
      csrfToken: readString(body, 'csrfToken'),
      previousSessionIds:
        replacing === null
          ? []
          : [...replacing.previousSessionIds, replacing.sessionId],
    };

    this.#persist(created);

    if (replacing !== null) {
      // §4.3 point 3. `warn`, not `info`: the previous session's open orders are
      // now beyond the bot's reach, and only a person can close them.
      this.#reporter.report(
        'warn',
        'the trading session was replaced; the previous session’s open orders can no longer be cancelled by the bot',
        {
          previousSessionId: replacing.sessionId,
          sessionId: created.sessionId,
        },
      );
    } else {
      this.#reporter.report('info', 'created a trading session', {
        sessionId: created.sessionId,
      });
    }
  }

  #persist(session: PersistedSession): void {
    this.#cell.write({
      sessionId: session.sessionId,
      cookie: session.cookie,
      csrfToken: session.csrfToken,
      previousSessionIds: [...session.previousSessionIds],
    });
    this.#current = session;
  }
}
