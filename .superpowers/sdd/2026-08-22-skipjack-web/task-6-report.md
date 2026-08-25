# Task 6 — Trading safety capabilities

Implemented the web trading safety view model and presentation layer. `SystemStatusProvider` fetches `/api/v1/health/trading`, preserves server reason codes, derives explicit place/cancel/FX availability, and fails closed for market degradation, recovery, session expiry, and server capability denials. Added status/error/banner/guard components and integrated capability-aware order and FX controls while preserving server rejection errors as alerts.

Tests cover normal, market degraded/recovering, cancel-only, read-only, unavailable, session-expired, unknown reason, and stale-capability fail-closed behavior. Verification: web Vitest 28 tests pass, typecheck/build pass on Node 24.19.0, and changed-file Biome check passes.
