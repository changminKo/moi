# Paper API Task 8 report

## Delivered

- Added `api.acceptance.integration.test.ts`, an executable seam-level vertical slice covering anonymous session issuance, virtual FX quote/exchange, a market order against a two-level book with a 2-of-3 partial fill, portfolio snapshot, and stream reconnect/replay.
- Added `api.crash-recovery.integration.test.ts` covering pre-ledger-commit non-persistence, post-commit/pre-response idempotent replay without a second order, and outbox restart behavior that does not rearm terminal orders.
- Added `docs/api/error-contract.md`, validated by the acceptance suite against one stable catalog. The catalog asserts `VALIDATION_ERROR` 400, `SESSION_EXPIRED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, domain/capability conflicts 409, `RATE_LIMITED` 429, and the three 503 recovery/service errors; only 429/503 are retryable and `retryAfter` is conditional on estimation.

## TDD and verification

- RED: the focused run failed because the required error-contract artifact was absent.
- GREEN: `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @skipjack/paper-api test -- api.acceptance.integration.test.ts api.crash-recovery.integration.test.ts` — 36 files / 240 tests passed (the package script runs the package suite despite the file filter).
- `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @skipjack/paper-api test` — 36 files / 240 tests passed.
- `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm --filter @skipjack/paper-api typecheck` passed.
- `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" pnpm typecheck` passed across all four packages.
- Changed-file Biome check passed for both new TypeScript suites.

Testcontainers is present in the paper-api devDependencies and Docker is available; these deterministic tests intentionally use the existing injectable seams and do not start live PostgreSQL/Redis containers or make Toss calls.

Author: changminKo <rhckdals123@gmail.com>
