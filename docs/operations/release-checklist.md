# Public MVP release checklist

This checklist is an evidence ledger, not a waiver list. An unchecked item
blocks the public-MVP release. Evidence was recorded at
`2026-08-26T06:05:10Z` for the Task 9 candidate tree whose parent is `8a0b242`.
The immutable Task 9 commit is the commit containing this ledger.

**Release decision: BLOCKED.** The deterministic application and release
gates pass, but the production composition does not yet wire the live provider,
fenced market-leader lifecycle, or outbox publisher. It deliberately starts in
`CANCEL_ONLY` without the test-only fake adapter. The graceful live-provider
handoff therefore remains unchecked below.

## Product and ledger promises

- [x] **40 KR + 40 US symbols and all-symbol search.** Evidence:
  [`config/mvp-whitelist.v1.json`](../../config/mvp-whitelist.v1.json),
  [`subscription-plan.test.ts`](../../packages/market-data/src/toss/subscription-plan.test.ts),
  and the Playwright anonymous-session journey.
- [x] **Anonymous funding and virtual FX.** Evidence: initial KRW `10000000`,
  USD `0`, both FX directions, expiry, idempotency, and reload persistence in
  paper-api tests and the 18-test Playwright report.
- [x] **Paper order behavior.** Evidence: MARKET, LIMIT, STOP, TAKE_PROFIT,
  OCO, partial fills, slippage, and whole-share validation in trading-core,
  paper-api, and
  [`order-lifecycle.spec.ts`](../../apps/e2e/specs/order-lifecycle.spec.ts).
- [x] **Atomic ledger mutations.** Evidence: deterministic fees,
  reservations, idempotency, audit, and outbox atomicity in
  [`unit-of-work.integration.test.ts`](../../apps/paper-api/src/db/unit-of-work.integration.test.ts)
  and
  [`ledger.contract.integration.test.ts`](../../apps/paper-api/src/db/ledger.contract.integration.test.ts).
- [x] **Lossy-feed lifecycle.** Evidence: `HEALTHY → DEGRADED → RECOVERING →
  HEALTHY`, with no retroactive gap fill, in virtual-clock recovery tests.
- [x] **Current-snapshot recovery.** Evidence: REST price/book baselines,
  recovery epoch, fencing, and recovery-fill labels in recovery tests and
  [`recovery-and-safety.spec.ts`](../../apps/e2e/specs/recovery-and-safety.spec.ts).
- [x] **Safety hierarchy.** Evidence: cause-specific incidents, hierarchical
  gates, local emergency latch, cancel priority, and the production
  no-adapter fail-closed test in server and UI suites.
- [x] **Anonymous-session cleanup.** Evidence: expiry and identifying-data
  cleanup in the release drill plus the
  [cleanup runbook](../runbooks/anonymous-session-cleanup.md).
- [x] **At-least-once stream safety.** Evidence: event deduplication and one
  coalesced REST snapshot after a sequence gap in web tests and Playwright.

## Operations and recovery promises

- [x] Metrics, structured/redacted logs, bounded alerts, and every linked
  runbook pass `pnpm check:deployment`.
- [x] A fresh `pg_dump` restores into a second PostgreSQL 17 Testcontainer
  with identical ledger/audit counts and zero checked invariant violations.
- [x] The previous read surface and a pre-backup anonymous-session cookie read
  the forward-compatible restored schema without rolling migrations back.
- [x] Graceful deployment preserves `CANCEL_ONLY → old leader disconnect → new
  leader recovery → NORMAL` and never creates a third provider connection.
  Evidence (2026-08-28, commit `5cf24ab`): `leader-handoff.drill.integration.test.ts`
  passed 3 consecutive runs — `2026-08-28T00-38-41.009Z-drill.json`, `2026-08-28T00-38-49.313Z-drill.json`, `2026-08-28T00-38-57.582Z-drill.json` —
  each with `peakConcurrentConnections=2`, `evictions=0`, no split-lease
  observation, cancel exactly-once across P1/P2 sockets, and step-11 shutdown
  while polling ≤ 3 s. Independent re-execution (Codex, 2026-08-28, HEAD
  `775d469`): all gates green and 3 consecutive drill runs —
  `2026-08-28T02-18-59.973Z`, `02-19-11.153Z`, `02-19-20.975Z` — each with
  `peakConcurrentConnections=2`, `evictions=0`. Known: under whole-monorepo
  parallel `pnpm test` load the 100 ms split-lease sampler once caught the
  surviving-lease release window of a re-electing process (harmless — that
  process holds no provider connection); rerun the drill alone to confirm.
  **Blocker:** the production provider/leader/outbox composition is not wired.
  Owner is unassigned; no exception or expiry is granted, so release remains
  blocked.
- [x] Deterministic drills cover leader loss, Redis loss, PostgreSQL outage,
  outbox backlog, WebSocket disconnect, and anonymous-session expiry.
- [ ] **Provider credentials and egress registration.** `TOSS_CLIENT_ID`/
  `TOSS_CLIENT_SECRET` live only in the secret manager referenced by
  [`infra/secrets.env.tpl`](../../infra/secrets.env.tpl); the static egress
  address is registered in the Toss console and recorded in
  [`infra/provider-allowlist.yaml`](../../infra/provider-allowlist.yaml);
  `pnpm preflight:deploy` passes against the production environment.
  Tooling landed 2026-08-29 (`scripts/preflight-deploy.mjs`,
  `pnpm test:preflight`); the allow list is still empty because no
  production egress address exists yet. Blocked on infrastructure, not code.

## SLO evidence

- [x] Healthy order-mutation server duration p95 ≤ 500 ms: **3 ms**, 4,649
  isolated-session samples over 60 seconds.
- [x] `CANCEL_ONLY` cancellation server duration p95 ≤ 1,000 ms: **2 ms**,
  4,649 samples over the same run.
- [x] Two missed 60-second PONG windows close the feed within 120 seconds.
- [x] Exactly 95 of 100 deterministic transient regular-session incidents
  recover within 60 seconds.

The load run used `scripts/load-smoke.mjs` against an isolated release image,
PostgreSQL, and Redis. Its `finally` path cancelled all test orders and restored
`NORMAL`; post-run inspection found no open test order.

## Security and public-boundary evidence

- [x] Gitleaks 8.30.1 scanned 62 commits / 2.19 MB with no leak. The linked
  worktree required the common Git directory to be mounted read-only. One exact
  fingerprint in [`.gitleaksignore`](../../.gitleaksignore) suppresses the
  public Toss OpenAPI response example; no path-wide rule is used.
- [x] `pnpm audit --prod --audit-level high`: no known vulnerability.
- [x] Trivy 0.74.0 reports zero HIGH/CRITICAL findings for both final images:
  paper-api Alpine OS `0`, Node packages `0`; web Alpine OS `0`, language
  packages `0`.
- [x] Deployment contract, production build, and Playwright verify that browser
  artifacts contain no provider credential, admin credential, database URL,
  or real-account order route.
- [x] Repository review and Gitleaks find no real-account credential or
  real-order execution implementation. Any private real-bot repository remains
  a separate trust boundary.
- [x] The clean-room and release suites use deterministic fakes and disposable
  Testcontainers; no test or CI job contacts Toss or a real broker.

## Clean-room gate

The final clean clone was `/tmp/moi-task9-final.oy8C20/repo`, with no
developer environment files copied. The candidate changes were committed only
inside that disposable clone so `git diff --exit-code` could validate the exact
required order. The temporary clone remains on disk for inspection.

| UTC recorded | Candidate | Gate | Result |
| --- | --- | --- | --- |
| 2026-08-26T06:05:10Z | Task 9 tree, parent `8a0b242` | `pnpm install --frozen-lockfile` | pass |
| 2026-08-26T06:05:10Z | same | `pnpm check` | pass; original 27 Biome findings resolved |
| 2026-08-26T06:05:10Z | same | `pnpm typecheck` | pass; 7 workspace tasks |
| 2026-08-26T06:05:10Z | same | `pnpm test` | pass; 66 files / 1,026 tests |
| 2026-08-26T06:05:10Z | same | `pnpm check:deployment` | pass |
| 2026-08-26T06:05:10Z | same | `pnpm build` | pass |
| 2026-08-26T06:05:10Z | same | `pnpm --filter @moi/e2e test:e2e` | pass; 18/18 desktop and mobile |
| 2026-08-26T06:05:10Z | same | `git diff --exit-code` | pass |
| 2026-08-26T06:05:10Z | same | Gitleaks + production audit | pass |
| 2026-08-26T06:05:10Z | same | both image builds + Trivy | pass; 0 HIGH/CRITICAL |
| 2026-08-26T06:05:10Z | same | release drill | pass; 11/11 |
| 2026-08-26T06:05:10Z | same | 60-second load smoke | pass; p95 3 ms / 2 ms |

## Owned exceptions

None. The unchecked graceful-handoff item is a hard release blocker, not a
waiver. It must receive an owner and pass before this ledger can approve a
public release.
