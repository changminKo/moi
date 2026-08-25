import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  type ApiClient,
  apiClient as defaultApiClient,
  setCsrfToken,
} from '../../lib/api-client';
import type { SessionSnapshot } from '../../lib/api-types';

type SessionState =
  | { status: 'loading' }
  | { status: 'error'; error: unknown; retry: () => void }
  | { status: 'ready'; session: SessionSnapshot };

type SessionContextValue = SessionState & {
  getCsrfToken: () => string | undefined;
};
const SessionContext = createContext<SessionContextValue | undefined>(
  undefined,
);

export function SessionProvider({
  children,
  apiClient = defaultApiClient,
}: {
  children: ReactNode;
  apiClient?: ApiClient;
}) {
  const csrfToken = useRef<string | undefined>(undefined);
  const bootstrapPromise = useRef<Promise<SessionSnapshot> | undefined>(
    undefined,
  );
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const bootstrap = () => {
    if (!bootstrapPromise.current) {
      bootstrapPromise.current = apiClient
        .post<{
          session: { id: string; expiresAt: string };
          csrfToken: string;
        }>('/api/v1/sessions/anonymous', undefined)
        .then((result) => {
          const snapshot: SessionSnapshot = {
            sessionId:
              result.session?.id ??
              (result as unknown as SessionSnapshot).sessionId,
            expiresAt:
              result.session?.expiresAt ??
              (result as unknown as SessionSnapshot).expiresAt,
            csrfToken: result.csrfToken,
          };
          csrfToken.current = snapshot.csrfToken;
          if (apiClient === defaultApiClient) setCsrfToken(snapshot.csrfToken);
          return snapshot;
        });
    }
    setState({ status: 'loading' });
    bootstrapPromise.current
      .then((session) => setState({ status: 'ready', session }))
      .catch((error: unknown) => {
        bootstrapPromise.current = undefined;
        setState({ status: 'error', error, retry: bootstrap });
      });
  };
  // The ref-backed promise makes this a once-per-provider bootstrap, including StrictMode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bootstrap is intentionally invoked once.
  useEffect(() => bootstrap(), []);
  return (
    <SessionContext.Provider
      value={{ ...state, getCsrfToken: () => csrfToken.current }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context)
    throw new Error('useSession must be used inside SessionProvider');
  return context;
}
