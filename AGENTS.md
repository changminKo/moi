# AGENTS.md — working rules for Moi

Moi is an anonymous, deterministic paper-trading platform for KR/US equities
(`apps/paper-api` Fastify + PostgreSQL ledger, `apps/web` browser client,
`apps/e2e` Playwright harness, `packages/trading-core`, `packages/market-data`,
`packages/strategy-sdk`). This file is the contract for any coding agent or
human working in the repository. Longer material lives in the documents it
points to; when they disagree, the spec wins and the plan/this file is fixed.

## Toolchain

- Node **24.19.0** (`.nvmrc`), pnpm **11.22.0** via corepack, TypeScript strict
  with `exactOptionalPropertyTypes`, Biome for lint/format, vitest, Playwright,
  Testcontainers (Docker is required for integration tests).
- Gates, in order: `pnpm check` · `pnpm typecheck` · `pnpm test` ·
  `pnpm check:deployment` · `pnpm test:deployment` · `pnpm test:preflight` ·
  `pnpm build` · `pnpm --filter @moi/e2e test:e2e` ·
  `pnpm --filter @moi/paper-api test:drill` (two-process leader handoff; its own
  gate, excluded from `pnpm test`; release evidence needs 3 consecutive passes).
- CI (`.github/workflows/ci.yml`) runs the same gates; the integration suites
  are container-bound, so CI runs workspaces serially. The deployment-contract
  checker (`scripts/check-deployment-contract.mjs`) asserts the exact CI steps —
  change both together.

## Hard rules

1. **Never contact the real provider from code, tests, or CI.** Every Toss
   test uses the loopback fakes in `packages/market-data/src/testing/fake-toss`;
   `packages/market-data/src/testing/live-guard.ts` and the contract checker
   fail if a live host appears. The only live contact is an operator-run smoke
   through the compose stack.
2. **Secrets never enter the repository, logs, chat, or test assertions.**
   Production secrets come from the platform secret store; locally use sops +
   age (`infra/secrets.env.tpl` lists the variables). No `.env`, no literal
   credentials in compose, no token values in logs (the redaction rules and the
   B8 log scan enforce this).
3. **Ledger discipline.** Every mutation walks `LEDGER_LOCK_ORDER`
   (`apps/paper-api/src/db/lock-order.ts`): session → idempotency → wallets →
   positions → oco_groups → orders → reservations → outbox. Repository methods
   declare their locks with `acquireLock`; the lock-accounting suite in
   `unit-of-work.integration.test.ts` measures them against PostgreSQL and
   requires a probe for every repository method — adding a method without a
   probe fails the build. Raw-SQL runtime paths (`fill-persistence`,
   `trigger-persistence`, `fill-settlement`) follow the same order: lock the
   session `FOR UPDATE` first (`runSessionTransaction`), balances before the
   order, the reservation last.
4. **Never await the engine while holding database locks.** Cancellation
   commits the ledger transaction first and only then tells the engines
   (`runtime/order-cancellation.ts`); fill persistence rejects orders the
   ledger already holds as terminal (`OrderTerminalError`) and the engine
   mirrors the ledger's status.
5. **Money is exact.** Use `moneyDecimal` + `assertExactMoney` (80-digit
   domain) from `@moi/trading-core` for ledger arithmetic, the core's
   `calculateAverageCost` for average cost, and decimal strings across
   APIs — never JS `number`.
6. **Fail closed.** Production refuses to start without an explicit adapter,
   fee schedule, and credentials; invariant failures at startup open a GLOBAL
   incident and exit; rate changes need a new `FEE_SCHEDULE_VERSION` (the
   process refuses a republished version with different rates).
7. **Do not commit unverified work.** Run the gates that cover the change
   before committing; chain them with `set -o pipefail` so a grep cannot hide a
   failing suite. Placeholder tests, `.skip`/`.only`, and TODO stubs are
   blockers, not evidence.

## Design contracts

- Architecture: `docs/superpowers/specs/2026-08-21-moi-paper-trading-architecture-design.md`.
- Production runtime & provider handoff:
  `docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md`
  — **§16 is the implementation-deviation table.** Any behaviour that departs
  from the spec gets a numbered row there in the same commit.
- Public error contract: `docs/api/error-contract.md`; `PUBLIC_ERROR_CODES`
  and `httpStatusFor` in `apps/paper-api/src/plugins/error-handler.ts` are kept
  equal to it by test.
- Operations: `docs/operations/deployment.md`, `docs/operations/release-checklist.md`
  (an evidence ledger — an unchecked item blocks release), `docs/runbooks/*`.
- Provider contracts: `packages/market-data/contracts/toss/` (pinned; examples
  in it are examples, not validation rules — see spec §16.26).

## Workflow

- TDD: write the failing test, watch it fail, implement, watch it pass. Unit
  tests for pure logic, Testcontainers integration tests for anything that
  touches PostgreSQL, Playwright for browser journeys.
- Conventional commits (`feat|fix|test|docs|chore|ci(scope): …`); commit
  author `changminKo <rhckdals123@gmail.com>`. Small, verified commits; the
  release checklist and spec §16 are updated in the commit that changes
  behaviour, not later.
- Review convention: two independent read-only review lanes per wave (for
  example Codex deep reviews split by ledger vs runtime), findings ranked
  BLOCKER/HIGH/MEDIUM/LOW with file:line, each finding either fixed with a
  test or recorded as an explicit exception.
- Dependencies: Dependabot opens weekly PRs (npm dev-tooling grouped, GitHub
  Actions separately). Merge only when the protected-branch checks are green;
  `@types/node` stays on the Node 24 major (`.nvmrc`); a runtime dependency
  bump (`ws`, `pg`, `kysely`, `fastify`) needs the drill to pass 3× like any
  other change, and `@dependabot rebase` after `main` moves.
- Preserve other people's untracked work (`.cursor/`, `.omc/`, `.codegraph/`,
  `.superpowers/`) and never rewrite history that has been pushed.

## Local run (operator)

```bash
sops exec-env ~/.config/moi/secrets.enc.env 'pnpm preflight:deploy --environment local'
API_PORT=3001 WEB_PORT=8081 \
  sops exec-env ~/.config/moi/secrets.enc.env 'docker compose -f infra/compose.yaml up -d --build'
```

The egress address must be registered in the Toss console and recorded in
`infra/provider-allowlist.yaml` for the target environment; the preflight
refuses to deploy otherwise.
