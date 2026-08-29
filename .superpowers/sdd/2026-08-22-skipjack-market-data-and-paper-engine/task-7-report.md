# Task 7 report

## Delivered

- Added `evaluateConditional`, using decimal.js comparisons and explicit stop/take-profit crossing rules for BUY and SELL legs.
- Added `OcoExecutor` with per-group parent arbitration, one winner under concurrent triggers, sibling cancellation through one execution callback, and one shared-reservation release callback.
- Added recovery stop-first tie-breaking when both conditions are true, recovery market-closed deferral, and fencing checks before conditional processing in `PaperEngine`.
- Added conditional registration and observed-trade triggering hooks to `PaperEngine`, preserving epoch/version/pricing provenance in callback context.

## TDD and verification

The requested RED tests were written first. The package-level `pnpm` command could not start in this environment because the installed pnpm requires Node 22.13+ and Node 20.19.6 lacks `node:sqlite`; the equivalent local Vitest invocation passed all 5 conditional/OCO tests, and the paper-api TypeScript build passed.

The executor's `execute` callback is the transaction seam: a DB-backed caller should acquire the OCO parent row first and perform winner transition, sibling cancellation, fill, audit, and outbox writes inside its UnitOfWork callback.
