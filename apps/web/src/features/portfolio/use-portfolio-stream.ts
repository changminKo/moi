import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { readRuntimeConfig } from '../../lib/runtime-config';
import {
  parseUserStreamMessage,
  type UserStreamMessage,
} from '../../lib/user-stream';
import {
  announceFill,
  createFillLedger,
  type FillAnnouncement,
  recordFills,
} from '../orders/fill-announcement';
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
  /**
   * Called once for each fill this client had not seen before, so a caller can
   * announce it. The stream is the only place that sees both the REST snapshot
   * and every event, which is what `fill-announcement.ts` needs to tell a fresh
   * fill from a replayed one — hence the callback here rather than a second
   * consumer of the same socket.
   */
  onFill?: (announcement: FillAnnouncement) => void;
}>;

const AFTER_SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;

function streamUrl(afterSequence?: string): string {
  const url = new URL('/api/v1/stream', readRuntimeConfig().wsOrigin);
  if (afterSequence !== undefined && AFTER_SEQUENCE.test(afterSequence))
    url.searchParams.set('afterSequence', afterSequence);
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
  const fills = useRef(createFillLedger());
  // Held in a ref so a caller may pass an inline closure without tearing the
  // socket down and reconnecting on every render.
  const onFill = useRef(options.onFill);
  useEffect(() => {
    onFill.current = options.onFill;
  }, [options.onFill]);

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
    // Every fill the snapshot already carries is history, not news. Recording
    // it here — before the socket can deliver a replay of the same fills — is
    // what keeps a page load silent.
    fills.current = recordFills(fills.current, query.data);
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
      )(streamUrl(stateRef.current?.snapshot.accountSequence));
      socketRef.current = socket;
      socket.onopen = () => {
        attempt.current = 0;
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
          // Outside the state updater on purpose: StrictMode invokes an
          // updater twice, and an announcement must happen exactly once. It is
          // also independent of the store going STALE — a gap means the patch
          // cannot be applied, not that the fill did not happen.
          const fill = announceFill(
            fills.current,
            message.eventType,
            message.payload,
          );
          fills.current = fill.ledger;
          if (fill.announcement !== undefined)
            onFill.current?.(fill.announcement);
          setState((current) => {
            if (!current) return current;
            const next = reducePortfolio(current, message);
            if (
              next.sync.status === 'STALE' &&
              next.sync.refreshRequested &&
              current.sync.status !== 'STALE'
            ) {
              queueMicrotask(requestRefresh);
            }
            return next;
          });
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
