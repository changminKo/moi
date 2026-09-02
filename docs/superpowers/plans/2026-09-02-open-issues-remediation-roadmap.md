# Open Issues Remediation Roadmap

**Recorded:** 2026-09-02
**Source:** the 33 GitHub issues open in `changminKo/moi` on the recorded date
**Execution rule:** handle one independently testable issue at a time, preserve the
dependency order below, and do not start the next item until the current item has
fresh verification evidence.

This is a sequencing and status document, not a replacement for an issue's
acceptance criteria. Behaviour changes still follow TDD, the gates in
`AGENTS.md`, and the implementation-deviation rules in the production spec.

## Priority definitions

- **P0:** required before the next affected production deploy.
- **P1:** correctness, availability, or fail-closed work to schedule next.
- **P2:** resilience, observability, or developer-signal improvements.
- **Decision:** an explicit product or scaling policy is needed before coding.
- **Close candidate:** the chosen resolution is already represented by pending
  work; verify it after merge and close or re-scope the issue.

## Execution order

### Wave 1: deployment integrity

- [x] **#44 P0 — serialize deploys.** Acquire an exclusive non-blocking mutex
  before fetch; a rejected second deploy must not touch the repository, the
  status marker, timers, or notifications.
- [x] **#28 P1 — re-exec the fetched deploy script.** Preserve the #44 mutex
  across `exec` and guard against a second re-exec.
- [x] **#83 P0 — verify image provenance.** Publish OCI revision labels and
  refuse an image whose revision differs from the requested checkout SHA.
- [ ] **#46 P0 for schema releases — test old-image/new-schema compatibility.**
  Replace the current documentary claim with an actual gate.
- [ ] **#25 P1 — production-origin browser smoke.** Exercise the deployed web
  origin, runtime API origin, session bootstrap, and browser errors.

### Wave 2: release signal and public mutation safety

- [ ] **#65 P1 — split and fix test instability.** Track container startup
  budget, deadlock retry-count assertions, and drill process/transport failures
  separately; they have different causes and acceptance tests.
- [ ] **#34 P1 — wire HTTP mutation rate limiting.** Prove a production-shaped
  server returns the public 429 contract under a write flood.
- [ ] **#10 P1 — finish durable cancel-all.** The audit rows exist; add
  Idempotency-Key replay and require GLOBAL cancel-only posture.
- [ ] **#91 P1 — decode `isRecoveryFill` fail-closed.** Missing or non-boolean
  values must be rejected rather than coerced to `false`.
- [ ] **#88 P1 — make `onFill` determinism enforceable.** The ledger already
  rejects a reused key with a different request hash, so the remaining risk is
  runner replay failure rather than an accepted mismatched order. Document the
  public contract and detect divergence before submission.

### Wave 3: durable fill and order API

- [ ] **#37 P1 — finish durable fill retrieval.** Event enrichment is already
  present; add the session-scoped, ordered, pageable historical fills endpoint.
- [ ] **Migrate fill consumers.** Move runner recovery and web realised-PnL
  reconstruction away from the accidental `activeOrders[].fills` history.
- [ ] **#33 P1 — make `activeOrders` active.** Only after #37 and consumer
  migration, exclude terminal orders and pin the mixed-status response contract.

The order above is strict. PR #97 currently computes realised PnL from
`activeOrders[].fills`; filtering terminal orders first would remove its data.

### Wave 4: web boundary and failure containment

- [ ] **#61 P1 — validate every web external-data boundary.** WebSocket quote
  narrowing exists; add REST/session decoders and remove the misleading pair of
  `QuoteSnapshot` meanings.
- [ ] **#70 P1 — bind the web quote model to the wire contract.** A field drift
  must fail CI instead of reaching a browser.
- [ ] **#69 P1 — collect `pageerror` and `console.error` in the shared E2E
  fixture.** Errors are denied by default with narrow per-test allowances.
- [ ] **#73 P1 — add panel-level ErrorBoundaries.** Keep independent trading
  panels alive and ensure caught errors still reach the E2E-visible reporter.
- [ ] **#71 P2 — give each web quote socket a generation token.** Late frames
  from a replaced socket must not clear or re-arm the live socket heartbeat.
- [ ] **#95 P2 quick win — repair the event-id dedupe test.** The first event
  must apply a complete LIVE snapshot and the duplicate must be the reason the
  second delivery is a no-op.

### Wave 5: strategy-runner packaging and runtime resilience

- [ ] **#92 P2 — use one outbound masker.** Runner imports
  `@moi/strategy-reporter`'s `maskOutbound`; remove the app-local duplicate.
- [ ] **#86 P1 with packaging — harden tool provisioning detection.** The
  checker must not depend on one literal shell-guard spelling.
- [ ] **#93 P1 when enabling the bot — ship runner image wiring atomically.**
  Dockerfile, publish workflow, compose override, deployment-contract coverage,
  and executable example-config validation land together.
- [ ] **#96 P1 before tick logging is enabled — rotate `BOT_TICK_LOG`.** Bound
  disk usage and startup replay while preserving an explicit backtest window.
- [ ] **#89 P2 — count ready-then-close flaps.** Repeated short-lived ready
  connections must reach the reconnect exhaustion band.
- [ ] **#38 P2 re-scope — acknowledge subscriptions.** Composite quote ordering
  is implemented in the runner; the remaining work is server acknowledgement
  and the public baseline-merge contract.

### Wave 6: runtime hygiene, harness isolation, and explicit decisions

- [ ] **#79 P2 — allocate E2E ports per run.** API, control, and web ports move
  together and concurrent workers cannot reuse another system.
- [ ] **#12 P2 — re-investigate drain admission after #65 instrumentation.**
  Distinguish an expected draining-leader rejection from harness misrouting.
- [ ] **#63 P2 — stop accumulating unread recovery incidents.** Either add a
  consumer and a recovery-safe resolution rule, or use a log/metric instead.
- [ ] **#62 P2 — retain safe provider fallback causes.** Log error class/code or
  HTTP status without credentials or response secrets.
- [ ] **#11 P2 — sequence-align stream snapshots.** REPEATABLE READ is already
  present; durable deltas or post-transaction snapshots remain.
- [ ] **#64 P2 quick win — remove the dead startup `manual` flag.** Behaviour
  stays unchanged and the misleading contract disappears.
- [ ] **#47 Decision — define the heavy-migration policy.** Current production
  volume is small; set and enforce a row-count threshold before it approaches
  the measured outage range.
- [ ] **#72 Decision — cap displayed quote depth.** Recommended default: retain
  the engine's full book and project at most 10 levels per side to clients.
- [ ] **#81 Close candidate — accept documented average-cost replay drift.** PR
  #97 records the caveat and limits presentation to two decimals; verify after
  merge and close unless exact accumulated cost becomes a product requirement.

## Issue hygiene

- Add `priority:P0|P1|P2`, `area:*`, and `status:needs-rescope` labels as each
  issue is picked up; do not bulk-edit before its current scope is confirmed.
- Re-scope partially completed issues #10, #11, #37, #38, #61, and #81 around
  their remaining work.
- Keep implementation commits small and conventional. Update spec §16 and the
  release checklist in the same commit whenever behaviour or an accepted
  deviation changes.
- Record verification commands and results in the issue or PR before closure.

## Progress log

| Date | Issue | State | Evidence |
|---|---:|---|---|
| 2026-09-02 | #44 | Complete locally | TDD RED→GREEN; `pnpm check`, `pnpm check:deployment`, and `pnpm test:deployment` (55/55) |
| 2026-09-02 | #28 | Complete locally | TDD RED→GREEN; fresh-script exec, inherited-mutex, forged-guard, and contract-mutation coverage; deployment tests 58/58 |
| 2026-09-02 | #83 | Complete locally | TDD RED→GREEN; publish-label and deploy-wiring mutation coverage; matching, mismatched, missing, and wrong-cardinality revision tests; deployment tests 64/64 |
