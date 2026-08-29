import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Market } from '@moi/trading-core';
import { type WebSocket, WebSocketServer } from 'ws';
import type { MetricsRegistry } from '../../observability/metrics.js';
import type { LayeredRateLimiter } from '../../plugins/rate-limits.js';
import { cookieValueFromHeader } from '../../plugins/session-auth.js';
import { SESSION_COOKIE } from '../session/session-token.js';
import type { StreamHub } from './stream-hub.js';
import { parseStreamQuery, StreamQueryError } from './stream-query.js';
import {
  type DurableEventSource,
  StreamSession,
  type StreamSocket,
} from './stream-session.js';

/** Upper bound for any client→server frame; the contract has none, so this only bounds abuse. */
export const STREAM_MAX_PAYLOAD_BYTES = 4096;
/** Upper bound for `closeAll`; sockets that do not echo the close frame are terminated. */
export const STREAM_CLOSE_GRACE_MS = 2000;
export const STREAM_PATH = '/api/v1/stream';

const RETRY_AFTER_SECONDS = 1;

type LogFn = (event: string, fields: Record<string, unknown>) => void;
type RejectReason =
  | 'not_ready'
  | 'closing'
  | 'auth'
  | 'rate_limited'
  | 'bad_request'
  | 'forbidden';

export interface StreamGate {
  isOpen(): boolean;
}

export interface StreamSessionAuthenticator {
  authenticate(token: string): Promise<{
    readonly session: { readonly id: string; readonly status?: string };
  }>;
}

export interface StreamUpgradeOptions {
  readonly server: Server;
  readonly publicOrigin: string;
  readonly sessionService: StreamSessionAuthenticator;
  readonly limiter: Pick<
    LayeredRateLimiter,
    'checkWebsocketConnection' | 'checkSubscription'
  >;
  readonly hub: StreamHub;
  readonly gate: StreamGate;
  readonly source: DurableEventSource;
  readonly tradableSymbols: ReadonlySet<string>;
  readonly maxPayloadBytes?: number;
  readonly closeGraceMs?: number;
  readonly metrics?: MetricsRegistry;
  readonly log?: LogFn;
}

export interface StreamUpgradeHandler {
  attach(): void;
  detach(): void;
  closeAll(code: number, reason: string): Promise<void>;
  pendingCount(): number;
  /** Test seam: the exact point where `wss.handleUpgrade` is invoked. */
  handleUpgradeForTest(): void;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function rejectUpgrade(
  socket: Duplex,
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  extraHeaders: Record<string, string> = {},
): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ code, message, retryable });
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
  ];
  try {
    socket.write(`${headers.join('\r\n')}\r\n\r\n${body}`);
  } catch {
    /* the client may already be gone */
  }
  socket.destroy();
}

function wrap(ws: WebSocket): StreamSocket {
  return {
    send: (text) => {
      if (ws.readyState === ws.OPEN) ws.send(text);
    },
    close: (code, reason) => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
        ws.close(code, reason);
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
  };
}

/**
 * `ws` noServer upgrade bridge (§7.5). Node's `upgrade` event bypasses Fastify
 * routing and hooks, so every check — stream gate, path, query, Origin, session
 * cookie, authentication, rate limits — happens here, before any 101 is written.
 */
export function createStreamUpgradeHandler(
  options: StreamUpgradeOptions,
): StreamUpgradeHandler {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? STREAM_MAX_PAYLOAD_BYTES,
  });
  const closeGraceMs = options.closeGraceMs ?? STREAM_CLOSE_GRACE_MS;
  const pending = new Set<Duplex>();
  let closing = false;
  let attached = false;

  const reject = (
    socket: Duplex,
    reason: RejectReason,
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    extraHeaders?: Record<string, string>,
  ): void => {
    options.metrics?.counter('stream_upgrade_rejected_total', { reason });
    options.log?.('stream.upgrade_rejected', { reason, status, code });
    rejectUpgrade(socket, status, code, message, retryable, extraHeaders);
  };
  const notReady = (socket: Duplex): void =>
    reject(
      socket,
      'not_ready',
      503,
      'NOT_READY',
      'Stream is not available on this instance',
      true,
      {
        'Retry-After': String(RETRY_AFTER_SECONDS),
      },
    );

  const onOpen = async (
    ws: WebSocket,
    sessionId: string,
    query: ReturnType<typeof parseStreamQuery>,
  ): Promise<void> => {
    const socket = wrap(ws);
    const handle = options.hub.registerOpening(sessionId, socket);
    ws.on('close', () => options.hub.unregister(sessionId, handle));
    ws.on('error', (error) => {
      options.log?.('stream.socket_error', { sessionId, error: error.message });
      ws.terminate();
    });
    ws.on('message', () => {
      options.log?.('stream.inbound_rejected', { sessionId });
      ws.close(1003, 'UNSUPPORTED_DATA');
    });
    let opened: Awaited<ReturnType<typeof StreamSession.open>>;
    try {
      opened = await StreamSession.open({
        sessionId,
        source: options.source,
        socket,
        quoteSymbols: options.tradableSymbols,
        ...(query.afterSequence !== undefined
          ? { afterSequence: query.afterSequence }
          : {}),
      });
    } catch (error) {
      options.hub.unregister(sessionId, handle);
      if ((error as Error).message !== 'OUTBOX_GAP') {
        options.log?.('stream.open_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        ws.close(1011, 'STREAM_OPEN_FAILED');
      }
      return;
    }
    try {
      for (const { market, symbol } of query.quoteSymbols)
        await opened.session.subscribeQuote(market as Market, symbol);
    } catch (error) {
      options.hub.unregister(sessionId, handle);
      options.log?.('stream.subscribe_failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      ws.close(1011, 'STREAM_OPEN_FAILED');
      return;
    }
    await options.hub.promoteToLive(sessionId, handle, opened);
  };

  const handler: StreamUpgradeHandler = {
    attach() {
      if (attached) return;
      closing = false;
      attached = true;
      options.server.on('upgrade', onUpgrade);
    },
    detach() {
      closing = true;
      if (attached) {
        options.server.removeListener('upgrade', onUpgrade);
        attached = false;
      }
      for (const socket of pending) socket.destroy();
      pending.clear();
    },
    async closeAll(code, reason) {
      const sockets = [...wss.clients];
      const closed = Promise.all(
        sockets.map(
          (ws) =>
            new Promise<void>((resolve) => {
              if (ws.readyState === ws.CLOSED) resolve();
              else ws.once('close', () => resolve());
            }),
        ),
      );
      await options.hub.closeAll(code, reason);
      for (const ws of sockets)
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING)
          ws.close(code, reason);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, closeGraceMs);
      });
      await Promise.race([closed, grace]);
      if (timer !== undefined) clearTimeout(timer);
      for (const ws of sockets) if (ws.readyState !== ws.CLOSED) ws.terminate();
      await closed;
    },
    pendingCount: () => pending.size,
    handleUpgradeForTest() {
      /* replaced per call below; exists so tests can spy on it */
    },
  };

  const completeUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    sessionId: string,
    query: ReturnType<typeof parseStreamQuery>,
  ): void => {
    handler.handleUpgradeForTest();
    wss.handleUpgrade(request, socket, head, (ws) => {
      void onOpen(ws, sessionId, query).catch((error: unknown) => {
        options.log?.('stream.upgrade_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        ws.terminate();
      });
    });
  };

  async function onUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      if (closing) {
        socket.destroy();
        return;
      }
      if (!options.gate.isOpen()) {
        notReady(socket);
        return;
      }
      const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
      const connection = String(request.headers.connection ?? '').toLowerCase();
      if (upgrade !== 'websocket' || !connection.includes('upgrade')) {
        reject(
          socket,
          'bad_request',
          426,
          'UPGRADE_REQUIRED',
          'WebSocket upgrade required',
          false,
        );
        return;
      }
      const url = new URL(request.url ?? '/', 'http://placeholder');
      if (url.pathname !== STREAM_PATH) {
        reject(
          socket,
          'bad_request',
          404,
          'NOT_FOUND',
          'Unknown upgrade path',
          false,
        );
        return;
      }
      let query: ReturnType<typeof parseStreamQuery>;
      try {
        query = parseStreamQuery(url, options.tradableSymbols);
      } catch (error) {
        if (error instanceof StreamQueryError) {
          reject(
            socket,
            'bad_request',
            400,
            'BAD_REQUEST',
            error.message,
            false,
          );
          return;
        }
        throw error;
      }
      if (request.headers.origin !== options.publicOrigin) {
        reject(
          socket,
          'forbidden',
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
          false,
        );
        return;
      }
      const token = cookieValueFromHeader(
        request.headers.cookie,
        SESSION_COOKIE,
      );
      if (token === undefined) {
        reject(
          socket,
          'auth',
          401,
          'SESSION_EXPIRED',
          'Session is required',
          false,
        );
        return;
      }
      pending.add(socket);
      socket.once('close', () => pending.delete(socket));
      let session: { id: string; status?: string };
      try {
        session = (await options.sessionService.authenticate(token)).session;
      } catch (error) {
        pending.delete(socket);
        if ((error as { statusCode?: number }).statusCode === 401) {
          reject(
            socket,
            'auth',
            401,
            'SESSION_EXPIRED',
            'Session is invalid or expired',
            false,
          );
          return;
        }
        throw error;
      } finally {
        pending.delete(socket);
      }
      if (session.status !== undefined && session.status !== 'ACTIVE') {
        reject(
          socket,
          'auth',
          401,
          'SESSION_EXPIRED',
          'Session is not active',
          false,
        );
        return;
      }
      const connectionCheck = options.limiter.checkWebsocketConnection(
        session.id,
      );
      if (!connectionCheck.allowed) {
        reject(
          socket,
          'rate_limited',
          429,
          'RATE_LIMITED',
          'Too many stream connections',
          true,
          {
            'Retry-After': String(
              connectionCheck.retryAfter ?? RETRY_AFTER_SECONDS,
            ),
          },
        );
        return;
      }
      const subscriptionCheck = options.limiter.checkSubscription(
        session.id,
        query.quoteSymbols.length,
      );
      if (!subscriptionCheck.allowed) {
        reject(
          socket,
          'rate_limited',
          429,
          'RATE_LIMITED',
          'Too many stream subscriptions',
          true,
          {
            'Retry-After': String(
              subscriptionCheck.retryAfter ?? RETRY_AFTER_SECONDS,
            ),
          },
        );
        return;
      }
      // Recheck after every await: detach, re-election, or the client leaving.
      if (closing || socket.destroyed) {
        socket.destroy();
        return;
      }
      if (!options.gate.isOpen()) {
        notReady(socket);
        return;
      }
      completeUpgrade(request, socket, head, session.id, query);
    } catch (error) {
      pending.delete(socket);
      options.log?.('stream.upgrade_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      rejectUpgrade(socket, 500, 'INTERNAL_ERROR', 'Upgrade failed', true);
    }
  }

  return handler;
}
