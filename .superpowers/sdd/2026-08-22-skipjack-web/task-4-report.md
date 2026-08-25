# Task 4 report

Implemented the market-selection, quote, wallet, and virtual-FX slice of the web application.

## Delivered

- Typed instrument, quote/book, wallet, and FX boundary models with canonical decimal strings.
- 150ms debounced instrument search and URL `symbol` selection.
- Quote REST seeding, health badges, order-book depth bars bounded through Decimal.js, and non-tradable order-ticket disablement with `SYMBOL_NOT_TRADABLE`.
- Separate KRW/USD available, reserved, and total wallet presentation.
- FX quote-first workflow with positive validation, server-provided rate/fee/source/destination values, pending double-submit guard, fresh idempotency keys, and explicit conversion errors.
- `/trade` route integration while preserving the existing shell/session providers.

## Verification

- Targeted web tests: 14 passed.
- Full web tests: 14 passed.
- Web build/typecheck: passed.
- Changed-file Biome check: passed.

## Notes

The current quote hook seeds from the authoritative REST quote endpoint and scopes updates to the selected tradable instrument; stream transport remains owned by the shared stream layer from Task 3.
