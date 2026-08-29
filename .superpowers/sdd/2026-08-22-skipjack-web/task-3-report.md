# Task 3 report: reconcile portfolio user stream

## Implemented

- Added a validated discriminated user-stream protocol parser for ready, event, quote, resync-required, and heartbeat messages.
- Added immutable portfolio reconciliation state with BigInt-only sequence adjacency checks, a bounded 2,048-entry event-id LRU, stale-state gating, authoritative snapshot recovery, and recovery-fill preservation.
- Added `usePortfolioStream` with TanStack Query `['portfolio']` refresh coalescing, WebSocket reconnect jitter capped at 15 seconds, server heartbeat timeout handling, stream replay cursor, and clean unmount close.

## Verification

- `pnpm --filter @skipjack/web test` — passed (5 files, 10 tests)
- `pnpm --filter @skipjack/web build` — passed
- Changed-file Biome check — passed
