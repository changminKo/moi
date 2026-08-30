import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { ApiClient } from '../../lib/api-client';
import { apiClient as defaultApiClient } from '../../lib/api-client';
import { en } from '../../lib/i18n/messages.en';
import { ko } from '../../lib/i18n/messages.ko';

export type TradingAvailability = Readonly<{
  place: { enabled: boolean; reasons: readonly string[] };
  cancel: { enabled: boolean; reasons: readonly string[] };
  fx: { enabled: boolean; reasons: readonly string[] };
}>;
export type TradingHealth = Readonly<{
  mode?: string;
  canPlace?: boolean;
  canCancel?: boolean;
  canFx?: boolean;
  placement?: boolean;
  cancellation?: boolean;
  fx?: boolean;
  reasonCodes?: readonly string[];
  reasons?: readonly string[];
}>;

type ReasonKey = Extract<keyof typeof en, `reason.${string}`>;
const reasonKey = (reason: string) => `reason.${reason}` as ReasonKey;

/**
 * Render-safe: an unrecognised code degrades to the raw code instead of
 * throwing. A newly emitted server code must never blank the app while
 * trading is already degraded.
 */
export function presentationForReason(
  reason: string,
  locale: 'ko' | 'en' = 'en',
): string {
  const bundle = locale === 'ko' ? ko : en;
  return bundle[reasonKey(reason)] ?? reason;
}

/** Fail-fast validation for codes arriving from the API (both catalogues). */
export function assertKnownReason(reason: string): void {
  const key = reasonKey(reason);
  if (!(key in en) || !(key in ko))
    throw new Error(`Unknown trading reason code: ${reason}`);
}

export function composeTradingAvailability(
  health: TradingHealth,
): TradingAvailability {
  const reasons = [...(health.reasonCodes ?? health.reasons ?? [])];
  const mode = health.mode;
  const place = health.canPlace ?? health.placement ?? mode === 'NORMAL';
  const cancel =
    health.canCancel ??
    health.cancellation ??
    (mode === 'NORMAL' || mode === 'CANCEL_ONLY');
  const fx = health.canFx ?? health.fx ?? mode === 'NORMAL';
  const marketBlocked =
    reasons.includes('MARKET_DATA_DEGRADED') ||
    reasons.includes('RECOVERY_IN_PROGRESS');
  const gated = (
    enabled: boolean,
    extra: readonly string[] = reasons,
    blockMarket = false,
  ) => ({
    enabled:
      enabled &&
      !reasons.includes('SESSION_EXPIRED') &&
      !(blockMarket && marketBlocked),
    reasons: extra,
  });
  return {
    place: gated(place, reasons, true),
    cancel: gated(cancel),
    fx: gated(fx),
  };
}

type StatusContext = Readonly<{
  availability: TradingAvailability;
  reasons: readonly string[];
  loading: boolean;
  error?: string;
  retry: () => void;
}>;
const defaultAvailability = composeTradingAvailability({
  mode: 'NORMAL',
  canPlace: true,
  canCancel: true,
  canFx: true,
  reasonCodes: [],
});
const StatusContext = createContext<StatusContext>({
  availability: defaultAvailability,
  reasons: [],
  loading: false,
  retry: () => undefined,
});

export function SystemStatusProvider({
  children,
  apiClient = defaultApiClient,
  market,
  symbol,
}: {
  children: ReactNode;
  apiClient?: ApiClient;
  market?: 'KR' | 'US';
  symbol?: string;
}) {
  const [state, setState] = useState<StatusContext>({
    availability: defaultAvailability,
    reasons: [],
    loading: true,
    retry: () => undefined,
  });
  const load = () => {
    const query = market
      ? `?market=${market}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ''}`
      : '';
    setState((current) => ({ ...current, loading: true }));
    apiClient
      .get<TradingHealth>(`/api/v1/health/trading${query}`)
      .then((health) => {
        const reasons = [...(health.reasonCodes ?? health.reasons ?? [])];
        for (const reason of reasons) {
          assertKnownReason(reason);
        }
        setState({
          availability: composeTradingAvailability(health),
          reasons,
          loading: false,
          retry: load,
        });
      })
      .catch((error: unknown) =>
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : 'Service unavailable',
          retry: load,
        })),
      );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load captures the selected request inputs intentionally.
  useEffect(() => {
    load();
  }, [market, symbol, apiClient]);
  return (
    <StatusContext.Provider value={state}>{children}</StatusContext.Provider>
  );
}

export function useTradingStatus(): StatusContext {
  return useContext(StatusContext);
}
