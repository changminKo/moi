# Task 5 report — paper order and portfolio workflows

## Delivered

- Added discriminated `MARKET`, `LIMIT`, `STOP`, `TAKE_PROFIT`, and `OCO` drafts with strict positive whole-share quantity validation, decimal price validation, and OCO trigger inequality validation.
- Added API-compatible request mapping, including take-profit `stopPrice` and OCO `LIMIT`/`STOP` legs.
- Added accessible order ticket, open-order lifecycle view, amendment dialog, fill history, positions table, and portfolio page.
- Added mutation hooks for placement, amendment, and cancellation. Each explicit gesture gets a fresh idempotency key; successful mutations invalidate the authoritative `['portfolio']` query.
- Integrated `/portfolio` in the application router.

## Verification

Using Node 24.19.0:

- `pnpm --filter @skipjack/web test` — 8 test files, 21 tests passed.
- `pnpm --filter @skipjack/web build` — passed.
- Changed-file `pnpm exec biome check ...` — passed.

The targeted test added in this task was first run in RED before implementation, then passed after the implementation.
