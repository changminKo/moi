import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import type { QuoteSnapshot } from '../../lib/api-types';
import { readRuntimeConfig } from '../../lib/runtime-config';
import { parseUserStreamMessage } from '../../lib/user-stream';

type StreamSocket = WebSocket;
export type QuoteStreamOptions = Readonly<{
  webSocketFactory?: (url: string) => StreamSocket;
  random?: () => number;
}>;

/** Server cap for `quoteSymbols` (spec §7.5); one instrument is selected at a time. */
export const MAX_QUOTE_SUBSCRIPTIONS = 5;

export function quoteStreamUrl(
  symbols: readonly { market: 'KR' | 'US'; symbol: string }[],
): string {
  const url = new URL('/api/v1/stream', readRuntimeConfig().wsOrigin);
  url.searchParams.set(
    'quoteSymbols',
    symbols
      .slice(0, MAX_QUOTE_SUBSCRIPTIONS)
      .map(({ market, symbol }) => `${market}:${symbol}`)
      .join(','),
  );
  return url.toString();
}

/**
 * One REST snapshot to paint the panel immediately, then live pushes from the
 * `quoteSymbols` stream subscription (spec §7.5). The snapshot is fenced by a
 * monotonic request id so a slow response can never overwrite a newer one, and
 * the quote is cleared on every instrument change so a failed load can never
 * leave another symbol's price beside the order ticket.
 */
export function useQuoteStream(
  market: 'KR' | 'US' | undefined,
  symbol: string | undefined,
  apiClient: ApiClient = defaultApiClient,
  options: QuoteStreamOptions = {},
) {
  const [quote, setQuote] = useState<QuoteSnapshot | null>(null);
  const request = useRef(0);
  const { webSocketFactory, random } = options;

  useEffect(() => {
    const id = ++request.current;
    setQuote(null);
    if (!market || !symbol) return;
    apiClient
      .get<QuoteSnapshot>(
        `/api/v1/markets/${market}/symbols/${encodeURIComponent(symbol)}/quote`,
      )
      .then((next) => {
        if (id === request.current) setQuote(next);
      })
      .catch(() => {
        if (id === request.current) setQuote(null);
      });
  }, [apiClient, market, symbol]);

  useEffect(() => {
    if (!market || !symbol) return;
    let disposed = false;
    let socket: StreamSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatInterval = 30_000;
    let attempt = 0;
    const roll = random ?? Math.random;
    const clearHeartbeat = () => {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const armHeartbeat = (current: StreamSocket, intervalMs: number) => {
      clearHeartbeat();
      heartbeatTimer = setTimeout(
        () => current.close(4000, 'heartbeat timeout'),
        intervalMs * 2,
      );
    };
    const reconnect = () => {
      if (disposed || reconnectTimer) return;
      const base = Math.min(15_000, 250 * 2 ** attempt++);
      const delay = Math.min(15_000, base * (0.75 + roll() * 0.5));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    };
    const connect = () => {
      if (disposed) return;
      const next = (webSocketFactory ?? ((url) => new WebSocket(url)))(
        quoteStreamUrl([{ market, symbol }]),
      );
      socket = next;
      next.onopen = () => {
        attempt = 0;
      };
      next.onmessage = (event) => {
        let message: ReturnType<typeof parseUserStreamMessage>;
        try {
          message = parseUserStreamMessage(event.data);
        } catch {
          return;
        }
        if (message.type === 'ready') {
          heartbeatInterval = message.heartbeatIntervalMs;
          armHeartbeat(next, heartbeatInterval);
        } else if (message.type === 'heartbeat') {
          armHeartbeat(next, heartbeatInterval);
        } else if (
          message.type === 'quote' &&
          message.market === market &&
          message.symbol === symbol
        ) {
          // A push always wins over an in-flight snapshot for this symbol.
          request.current += 1;
          setQuote(message.payload as unknown as QuoteSnapshot);
        }
      };
      next.onclose = () => {
        clearHeartbeat();
        if (!disposed) reconnect();
      };
      next.onerror = () => next.close();
    };
    connect();
    return () => {
      disposed = true;
      clearHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close(1000, 'unmount');
      socket = undefined;
    };
  }, [market, symbol, webSocketFactory, random]);

  return { quote };
}
