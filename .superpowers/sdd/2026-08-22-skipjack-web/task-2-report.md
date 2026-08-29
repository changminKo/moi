# Task 2 — Anonymous trading sessions

## Delivered

- Added typed API boundary types and a REST client with credentials on every request.
- Writes attach the in-memory CSRF token; caller-provided idempotency keys are forwarded for mutations.
- Added runtime origin validation (HTTPS except development loopback HTTP) and derived WebSocket origins.
- Added stable `ApiError` mapping retaining `requestId`, `retryable`, and `retryAfter`.
- Added in-memory anonymous `SessionProvider` with one-shot bootstrap, loading/error/retry states, and no browser storage.
- Added a shared TanStack Query client with transient-read retries capped at two and mutation retries disabled; wired both providers in `main.tsx`.

## Verification

- `pnpm --filter @skipjack/web test -- src/lib/api-client.test.ts src/features/session/session-provider.test.tsx` — passed (5 tests).
- `pnpm --filter @skipjack/web typecheck` — passed.
- `pnpm --filter @skipjack/web build` — passed.
- Changed-file Biome check — passed.

The workspace pnpm shim is installed under Node 20, so commands requiring pnpm's Node 24 runtime were executed with Node 24 on PATH while invoking the existing pnpm shim directly; Vitest, TypeScript, and Vite all completed successfully.
