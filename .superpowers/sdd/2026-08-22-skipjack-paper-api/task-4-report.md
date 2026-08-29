# Paper API Task 4 report

## Delivered

- Added strict discriminated order schemas for market, limit, stop, take-profit, and two-leg OCO requests, including amend validation.
- Added `OrderService` place/amend/cancel commands with whitelist, market-session, capability, and cancel-only admission checks.
- Added canonical JSON serialization with schema field ordering, decimal normalization, and SHA-256 UTF-8 hashes.
- Added `IdempotencyService` with same-key replay, same-key/different-payload conflict handling, and concurrent in-process request coalescing; HTTP routes preserve status/body/headers on replay and expose POST/PATCH/DELETE order commands.

## Verification

All commands used `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.

- RED: focused order/canonical tests initially failed because the requested modules did not exist.
- GREEN: `pnpm --filter @skipjack/paper-api test -- order-routes.integration.test.ts canonical-request.test.ts` — 26 files / 198 tests passed.
- `pnpm --filter @skipjack/paper-api test` — 26 files / 198 tests passed.
- `pnpm --filter @skipjack/paper-api typecheck` — passed.

Author: changminKo <rhckdals123@gmail.com>
