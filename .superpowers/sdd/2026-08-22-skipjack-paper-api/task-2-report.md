# Paper API Task 2 report

## Delivered

- Added HMAC-SHA-256 session token codec using 32 random bytes/base64url (43 characters), storing only the digest and checking all configured rotation keys with constant-time comparison.
- Added injectable `SessionService` with transactional UoW adapter: anonymous bootstrap creates the session and KRW 10,000,000/USD 0 wallets through one transaction, existing valid cookies reuse the session, and activity touch is hourly bounded.
- Added secure cookie output, session authentication, CSRF token generation/verification bound to the session, exact-Origin write protection, session routes, inactive-session cleanup interface, and public exports.
- Extended the existing session repository with token lookup, idempotent wallet bootstrap, touch-compatible session records, and expiry status transition; lock-accounting probes were updated for the new repository methods.

## Verification

All commands used Node 24 explicitly with `PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"`.

- RED: session token/service tests were initially absent and the new implementation was developed against failing-first checks.
- GREEN: `pnpm --filter @skipjack/paper-api test -- session-token.test.ts session-service.test.ts` — 20 files / 192 tests passed.
- `pnpm --filter @skipjack/paper-api typecheck` passed.

## Notes

Cleanup is deliberately expressed as an injectable store boundary so the expiry transaction can be wired to account gates, incident, cancellation/release, audit, and outbox repositories without introducing a second transaction boundary.
