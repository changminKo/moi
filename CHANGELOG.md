# Changelog

All notable public-MVP changes are recorded here. The project is not yet
published as a versioned package.

## Unreleased — Plan 4 Task 9

### Added

- A production `paper-api` entrypoint with PostgreSQL migrations, anonymous
  sessions, portfolio reads, health probes, paper-order mutations, safety-mode
  administration, graceful database shutdown, and deterministic fake-feed
  release support.
- A disposable release drill covering forward migration, `pg_dump` restore,
  ledger and audit invariants, forward-compatible application rollback,
  dependency failures, leader loss, feed loss, outbox backlog, session expiry,
  PONG detection, and bounded recovery.
- A load smoke runner that consumes server-observed durations, enforces the
  500 ms healthy mutation and 1,000 ms cancel-only cancellation p95 limits,
  and restores `NORMAL` while cancelling test orders during cleanup.
- A public release evidence checklist and explicit simulation/trust-boundary
  documentation.

### Changed

- The paper API image now launches the production composition root instead of
  importing a library-only server module and exiting.
- The production composition starts in `CANCEL_ONLY` when no market-data
  adapter is available, so a missing provider cannot admit paper placements.
- Readiness reports dependency exceptions as stable `503 NOT_READY` responses
  while liveness remains available.
- API responses expose a non-sensitive `Server-Timing` application duration for
  release SLO measurement.

### Security

- No real-account order execution or broker credential path was introduced.
- The fake market-data adapter remains limited to deterministic development and
  acceptance tests.
- Public deployment remains blocked until the live provider, leader lifecycle,
  and outbox publisher are wired into the runtime composition and the graceful
  handoff is drilled end to end.
