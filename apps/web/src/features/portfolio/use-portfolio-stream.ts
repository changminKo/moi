import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import {
  parseUserStreamMessage,
  type UserStreamMessage,
} from '../../lib/user-stream';
import {
  createPortfolioState,
  type PortfolioSnapshot,
  type PortfolioState,
  reducePortfolio,
} from './portfolio-store';

export const PORTFOLIO_QUERY_KEY = ['portfolio'] as const;
type StreamSocket = WebSocket;
type Options = Readonly<{
  enabled?: boolean;
  webSocketFactory?: (url: string) => StreamSocket;
  now?: () => number;
  random?: () => number;
}>;

function streamUrl(): string {
  const url = new URL('/api/v1/stream', window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function usePortfolioStream(
  options: Options = {},
): PortfolioState & { readonly isLoading: boolean } {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: PORTFOLIO_QUERY_KEY,
    queryFn: () => apiClient.get<PortfolioSnapshot>('/api/v1/portfolio'),
    enabled: options.enabled !== false,
  });
  const [state, setState] = useState<PortfolioState | undefined>(() =>
    query.data ? createPortfolioState(query.data) : undefined,
  );
  const stateRef = useRef<PortfolioState | undefined>(state);
  const socketRef = useRef<StreamSocket | undefined>(undefined);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const heartbeatTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const heartbeatInterval = useRef(30_000);
  const attempt = useRef(0);
  const refreshQueued = useRef(false);
  const random = options.random ?? Math.random;

  const requestRefresh = useCallback(() => {
    if (refreshQueued.current) return;
    refreshQueued.current = true;
    void queryClient
      .invalidateQueries({ queryKey: PORTFOLIO_QUERY_KEY })
      .finally(() => {
        refreshQueued.current = false;
      });
  }, [queryClient]);

  useEffect(() => {
    if (!query.data) return;
    setState(() => createPortfolioState(query.data));
  }, [query.data]);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (options.enabled === false) return;
    let disposed = false;
    const clearHeartbeat = () => {
      if (heartbeatTimer.current) clearTimeout(heartbeatTimer.current);
      heartbeatTimer.current = undefined;
    };
    const reconnect = () => {
      if (disposed || reconnectTimer.current) return;
      const base = Math.min(15_000, 250 * 2 ** attempt.current++);
      const delay = Math.min(15_000, base * (0.75 + random() * 0.5));
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = undefined;
        connect();
      }, delay);
    };
    const connect = () => {
      if (disposed) return;
      const socket = (
        options.webSocketFactory ?? ((url) => new WebSocket(url))
      )(streamUrl());
      socketRef.current = socket;
      socket.onopen = () => {
        attempt.current = 0;
        const after = stateRef.current?.snapshot.accountSequence;
        if (after) socket.send(JSON.stringify({ afterSequence: after }));
      };
      socket.onmessage = (event) => {
        let message: UserStreamMessage;
        try {
          message = parseUserStreamMessage(event.data);
        } catch {
          return;
        }
        if (message.type === 'ready') {
          heartbeatInterval.current = message.heartbeatIntervalMs;
          clearHeartbeat();
          heartbeatTimer.current = setTimeout(() => {
            socket.close(4000, 'heartbeat timeout');
          }, message.heartbeatIntervalMs * 2);
        } else if (message.type === 'heartbeat') {
          clearHeartbeat();
          heartbeatTimer.current = setTimeout(() => {
            socket.close(4000, 'heartbeat timeout');
          }, heartbeatInterval.current * 2);
        } else if (message.type === 'event') {
          setState((current) =>
            current ? reducePortfolio(current, message) : current,
          );
        } else if (message.type === 'resync-required') {
          setState((current) =>
            current ? reducePortfolio(current, message) : current,
          );
          requestRefresh();
        }
      };
      socket.onclose = () => {
        clearHeartbeat();
        if (!disposed) {
          requestRefresh();
          reconnect();
        }
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      disposed = true;
      clearHeartbeat();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = undefined;
      socketRef.current?.close(1000, 'unmount');
      socketRef.current = undefined;
    };
    // Connection lifecycle intentionally starts once per enabled state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled, options.webSocketFactory, requestRefresh, random]);

  return {
    ...(state ??
      (query.data
        ? createPortfolioState(query.data)
        : createPortfolioState({
            wallets: [],
            positions: [],
            reservations: [],
            activeOrders: [],
            accountSequence: '0',
            market: { health: {}, recoveryFill: {} },
          }))),
    isLoading: query.isLoading,
  };
}
