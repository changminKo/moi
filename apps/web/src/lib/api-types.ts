export type ApiErrorBody = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  retryAfter?: number;
  requestId: string;
}>;

export type SessionSnapshot = Readonly<{
  sessionId: string;
  expiresAt: string;
  csrfToken: string;
}>;

export type CapabilitySnapshot = Readonly<{
  mode: 'NORMAL' | 'CANCEL_ONLY' | 'READ_ONLY' | 'UNAVAILABLE';
  canPlace: boolean;
  canCancel: boolean;
  reasonCodes: readonly string[];
}>;
