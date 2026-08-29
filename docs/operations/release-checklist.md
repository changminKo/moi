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
  `peakConcurrentConnections=2`, `evictions=0`. Re-run after the review-driven
  ledger/trigger hardening, the Moi rename, and the versioned fee schedule
  (2026-08-29): 3 consecutive runs — `2026-08-29T13-13-55.644Z`, `2026-08-29T13-14-03.692Z`,
  `2026-08-29T13-14-11.420Z` — each `peakConcurrentConnections=2`, `evictions=0`. One
  earlier run that day failed without a captured reason and passed on the
  immediate rerun (6 of 7 runs green); treat as a flake to watch, not evidence.
  Known: under whole-monorepo
  parallel `pnpm test` load the 100 ms split-lease sampler once caught the
  surviving-lease release window of a re-electing process (harmless — that
  process holds no provider connection); rerun the drill alone to confirm.
  **Blocker:** the production provider/leader/outbox composition is not wired.
  Owner is unassigned; no exception or expiry is granted, so release remains
  blocked.
- [x] Deterministic drills cover leader loss, Redis loss, PostgreSQL outage,
  outbox backlog, WebSocket disconnect, and anonymous-session expiry.
- [ ] **Provider credentials and egress registration.** Credentials live only in
  the operator's sops/age store (`~/.config/moi/secrets.enc.env`, age key
  outside the repository); the secret-manager template is
  [`infra/secrets.env.tpl`](../../infra/secrets.env.tpl). Evidence 2026-08-30:
  `sops exec-env … pnpm preflight:deploy --environment local` passed 3/3
  (variables, `docker compose config`, egress `210.121.195.35` registered in the
  Toss console and recorded in
  [`infra/provider-allowlist.yaml`](../../infra/provider-allowlist.yaml) as
  environment `local`). The real credential also exposed an over-strict
  `TOSS_CLIENT_ID` pattern (`c_…` was only the contract's example); fixed.
  **Live provider smoke (2026-08-29 15:07 UTC, weekend session):** the compose
  stack built from this tree (`moi/paper-api:local`, `moi/web:local`) booted
  with `MARKET_DATA_ADAPTER=toss` and the sops-held credentials, acquired both
  leases (epoch 1), completed REST recovery against the real Toss API (KR
  `005930` in 5.4 s; the US allow list in 11.3 s), reached `SERVING` with
  `placement/cancellation/fx = true`, held `provider_connections_open 2`, and
  its logs contained zero bearer tokens or client-secret fragments. Quotes were
  `null` because both markets were closed; no order was placed. Stack torn down
  with `down -v`.
  **Still open:** no production egress address exists — `--environment
  production` fails by design until a static address is registered. Blocked
  on infrastructure, not code.
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
- [ ] Alerting channel proven: `notify.sh info test` from the host received in
  Discord; one CI failure embed and one `main` success embed observed from
  `.github/workflows/notify.yml`; a `Moi status` line and a `deploy finished`
  embed observed after a deploy (`docs/runbooks/alerting.md`).

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
