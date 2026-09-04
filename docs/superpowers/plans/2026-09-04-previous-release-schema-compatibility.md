# Previous Release Schema Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #46 with a CI gate that proves the exact previous `paper-api` image can complete an anonymous-session market buy and persist its fill after the current checkout has migrated the database.

**Architecture:** A dedicated Vitest suite owns an isolated PostgreSQL/Redis Docker network. Current source migrates a fresh database, then a one-shot container built from the previous Git SHA runs its compiled production runtime with the deterministic fake provider and performs the old release's write path. A second scenario adds a deliberately incompatible `NOT NULL` column and must make the old container fail, proving the harness is capable of detecting the regression it is intended to prevent. The CI workflow resolves the previous SHA from the event, builds that source into a local image, and invokes only this dedicated suite.

**Tech Stack:** GitHub Actions, Docker Buildx, Node 24.19.0, pnpm 11.22.0, TypeScript, Vitest, Testcontainers, PostgreSQL 17.5, Redis 7.

**Spec:** [Issue #46](https://github.com/changminKo/moi/issues/46), `docs/operations/deployment.md`, and `AGENTS.md`.

## Global Constraints

- Never contact Toss or any other live provider. The previous runtime must use only `createFakeProviderBundle()` with `NODE_ENV=test` and `MARKET_DATA_ADAPTER=fake`.
- Exercise the old compiled production code from `/app/apps/paper-api/dist`; do not import current runtime code into the previous-image runner.
- Resolve the exact prior commit fail-closed: pull requests use `github.event.pull_request.base.sha`; pushes to `main` use `github.event.before`; reject missing, non-40-hex, or all-zero values.
- Keep the compatibility suite outside `apps/paper-api/src` so the ordinary `pnpm test` gate does not run this Docker-heavy cross-version check.
- The positive and negative scenarios each get a fresh migrated database. The negative probe must not contaminate or make the positive scenario order-dependent.
- Do not add a migration denylist. This issue requires the real behavioral guarantee selected in option 1.
- Do not add a production-runtime test seam solely for this gate. The mounted runner uses the existing public runtime/config/provider interfaces of the previous image.
- Do not expose or print secrets. Test-only key values remain synthetic and logs must not dump the environment.
- Because repository policy requires behavior, CI, operations documentation, and the release checklist to move atomically, do not make intermediate commits. Make one Korean conventional commit after all RED/GREEN cycles and documentation updates are complete.
- Before editing, confirm no user-owned changes exist in this worktree. Preserve all unrelated work.

---

### Task 1: Build a self-proving previous-image write harness

**Files:**
- Create: `apps/paper-api/schema-compat/previous-release.integration.test.ts`
- Create: `apps/paper-api/schema-compat/previous-release-runner.mjs`
- Create: `apps/paper-api/vitest.schema-compat.config.ts`
- Modify: `apps/paper-api/package.json`

**Interfaces:**

```ts
interface PreviousReleaseScenarioOptions {
  readonly addIncompatibleFillColumn?: boolean;
}

function runPreviousReleaseScenario(
  options?: PreviousReleaseScenarioOptions,
): Promise<void>;
```

The suite's only external input is `SCHEMA_COMPAT_PREVIOUS_IMAGE`. Missing or blank input fails with a clear message before Docker resources are started.

- [ ] Add `test:schema-compat` to `apps/paper-api/package.json` with the exact command `vitest run --config vitest.schema-compat.config.ts`.
- [ ] Add `vitest.schema-compat.config.ts`. Include only `schema-compat/**/*.integration.test.ts`, disable file parallelism, and give Docker startup/test hooks a bounded budget of at most five minutes.
- [ ] Write the integration test first. It must define two tests:
  1. current migrations + previous image + anonymous session + KR market order resolves successfully and persists a fill;
  2. the same setup after `ALTER TABLE fills ADD COLUMN schema_compat_probe text NOT NULL` rejects because the previous release cannot insert the fill.
- [ ] Run the suite without `SCHEMA_COMPAT_PREVIOUS_IMAGE` and capture RED: it fails with the explicit missing-image contract, not a generic timeout.
- [ ] Implement Testcontainers orchestration:
  - create a fresh explicit network per scenario;
  - start `postgres:17.5-alpine` and `redis:7-alpine` with stable network aliases;
  - use current `createDatabase()` plus current `migrateToLatest()` from the host test to apply the head schema;
  - optionally add the incompatible probe only after migration and while `fills` is empty;
  - start `SCHEMA_COMPAT_PREVIOUS_IMAGE` on the same network with `Wait.forOneShotStartup()`;
  - bind-mount `previous-release-runner.mjs` read-only into a neutral path such as `/tmp/moi-schema-compat/previous-release-runner.mjs` and override the image command to execute it with Node;
  - always destroy the Kysely handle, containers, and network in `finally`, including failed one-shot starts.
- [ ] Make the host test provide only synthetic test configuration. At minimum set `NODE_ENV=test`, `HOST=127.0.0.1`, `PORT=0`, `PUBLIC_ORIGIN=http://127.0.0.1:0`, the network PostgreSQL/Redis URLs, non-secret test session/CSRF values, `MARKET_DATA_ADAPTER=fake`, bounded shutdown/recovery values, and a zero-valued explicit fee schedule/version accepted by the previous config.
- [ ] Implement `previous-release-runner.mjs` as plain JavaScript compatible with the previous image. It must dynamically import these old compiled modules and no current application modules:
  - `/app/apps/paper-api/dist/config.js` → `loadConfig`
  - `/app/apps/paper-api/dist/runtime/production-runtime.js` → `ProductionRuntime`
  - `/app/apps/paper-api/dist/runtime/provider-bundle.js` → `createFakeProviderBundle`
- [ ] In the runner, start `ProductionRuntime({ config, bundle, signals: false })`, create an anonymous session, retain the session cookie and CSRF token, emit a deterministic KR `005930` order book, and submit a `MARKET` `BUY` with decimal-string quantity and a fresh idempotency key.
- [ ] Poll a public order read or PostgreSQL-observable completion through the previous API until the order is `FILLED`; fail on terminal non-filled status, non-2xx responses, or a bounded timeout. Print only a fixed success marker such as `SCHEMA_COMPAT_WRITE_OK`, then stop the runtime in `finally`.
- [ ] Ensure the runner exits nonzero when fill persistence fails. Do not swallow `runtime.stop()` errors if there is no earlier error; preserve the original error when both the scenario and cleanup fail.
- [ ] Build a local previous image from `origin/main` (or the current base SHA for the initial RED/GREEN cycle) with `apps/paper-api/Dockerfile`, tag it `moi-paper-api-schema-compat:previous`, then run:

```bash
SCHEMA_COMPAT_PREVIOUS_IMAGE=moi-paper-api-schema-compat:previous \
  pnpm --filter @moi/paper-api test:schema-compat
```

Expected GREEN: the compatible scenario passes and the incompatible-probe scenario passes by observing a rejected one-shot container. The test output must make clear which half is the positive compatibility proof and which half is the harness self-test.

---

### Task 2: Make the gate an enforced CI/deployment contract

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/check-deployment-contract.mjs`
- Modify: `scripts/check-deployment-contract.test.mjs`

**Required CI shape:**

```yaml
schema-compatibility:
  needs: verify
  # checkout current source, resolve/validate previous-ref, checkout that SHA
  # under .schema-compat/previous, build/load the old paper-api image, run
  # pnpm --filter @moi/paper-api test:schema-compat
```

- [ ] Extend `TRACKED` in `scripts/check-deployment-contract.test.mjs` with every new file the checker needs, including the schema-compat config/runner/test and `apps/paper-api/package.json` if not already present.
- [ ] Add mutation tests before the checker implementation. Each mutation copies the committed fixture, changes exactly one property, runs the checker, expects status 1, and matches a specific diagnostic:
  - remove the `schema-compatibility` job;
  - change the pull-request previous ref away from `github.event.pull_request.base.sha`;
  - change the push previous ref away from `github.event.before` or remove the full-SHA/all-zero validation;
  - change/remove the secondary checkout `ref` or its isolated `path`;
  - change the Docker build context/Dockerfile/tag or remove `load: true`;
  - change/remove the exact `pnpm --filter @moi/paper-api test:schema-compat` invocation.
- [ ] Run only the deployment contract tests and capture RED. New mutation cases must expose missing checker coverage; pre-existing cases must remain green.
- [ ] Add a `schema-compatibility` job to `.github/workflows/ci.yml` with `runs-on: ubuntu-24.04`, a bounded timeout, and `needs: verify` so the heavyweight gate does not contend with the ordinary integration suite.
- [ ] In that job, check out current source and set up the pinned pnpm/Node versions. Install with `pnpm install --frozen-lockfile` because the current host test imports the current migration and test code.
- [ ] Resolve `PREVIOUS_REF` from the event as specified in Global Constraints, validate it as an exact nonzero 40-character hexadecimal SHA in shell, and expose it via a step output. The validation must run before the secondary checkout or build.
- [ ] Check out that exact output SHA into `.schema-compat/previous`; never infer `main`, `HEAD^`, a tag, or a mutable image tag.
- [ ] Use `docker/build-push-action@v7` to build the previous checkout with context `.schema-compat/previous`, file `.schema-compat/previous/apps/paper-api/Dockerfile`, `load: true`, and local tag `moi-paper-api-schema-compat:previous`. Do not push it.
- [ ] Run the exact schema-compat package script with `SCHEMA_COMPAT_PREVIOUS_IMAGE=moi-paper-api-schema-compat:previous`.
- [ ] Extend `check-deployment-contract.mjs` to parse `.github/workflows/ci.yml` structurally and pin the dedicated job's name, `needs`, permissions inheritance, previous-ref expression/validation, checkout ref/path, build context/file/load/tag, package script, and absence of Toss credentials. Avoid broad substring checks where YAML structure is available; use the raw workflow text only for GitHub expressions that the YAML parser cannot preserve reliably.
- [ ] Run:

```bash
pnpm test:deployment
pnpm check:deployment
```

Expected GREEN: all existing cases and every new schema-compat mutation case pass.

---

### Task 3: Correct the operational record and verify atomically

**Files:**
- Modify: `docs/operations/deployment.md`
- Modify: `docs/operations/release-checklist.md`
- Modify: `docs/superpowers/plans/2026-09-02-open-issues-remediation-roadmap.md`
- Review only: `docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md`

- [ ] Replace the false deployment statement that CI runs the previous release's tests. State the exact guarantee: current migrations are applied to a fresh database; the exact event-derived previous source is built; its compiled production runtime executes anonymous-session → market buy → persisted fill with the fake provider; the negative incompatible-column scenario proves the harness fails closed.
- [ ] Add a checked release-checklist item for the previous-image/new-schema gate, including the CI job name and expected positive/negative evidence. Do not mark a release ready merely because the test file exists.
- [ ] Mark issue #46 complete in the open-issues remediation roadmap and summarize the implemented job/harness in the progress/evidence section already used by that document.
- [ ] Review the production runtime/provider handoff design deviation table. Do not add a deviation row unless implementation changed production behavior or intentionally departed from the spec; this CI-only enforcement should normally need no row.
- [ ] Run formatting on changed files as supported by the repository, then run the proportional local gates with Node 24.19.0 on `PATH`:

```bash
pnpm check
pnpm typecheck
pnpm test
pnpm check:deployment
pnpm test:deployment
pnpm test:preflight
pnpm build
SCHEMA_COMPAT_PREVIOUS_IMAGE=moi-paper-api-schema-compat:previous \
  pnpm --filter @moi/paper-api test:schema-compat
```

- [ ] Run `git diff --check`, inspect `git diff --stat`, and scan the changed files for `TODO`, `TBD`, `.skip`, `.only`, placeholder assertions, live provider hosts, and accidental credentials.
- [ ] Commit all code, CI, tests, and documentation together as author `changminKo <rhckdals123@gmail.com>` using Korean conventional-commit prose, for example:

```bash
git -c user.name=changminKo -c user.email=rhckdals123@gmail.com \
  commit -m "ci(paper-api): 이전 릴리스의 신규 스키마 쓰기 호환성을 검증한다 (#46)"
```

- [ ] Do not push or open a pull request yet. Hand the commit, complete command evidence (including the negative harness proof), and any skipped gate with its exact reason back to Codex for independent review.

---

## Codex Review Gate

Codex performs a read-only review after Claude's implementation. Review priorities are:

1. **BLOCKER:** any path can contact Toss/live infrastructure, uses mutable previous-source identity, or lets the negative self-test pass without actually exercising an incompatible fill write.
2. **HIGH:** cleanup leaks, false-positive one-shot success, incomplete previous-ref event handling, CI/checker drift, or ordinary `pnpm test` accidentally running the cross-version suite.
3. **MEDIUM/LOW:** diagnostics, maintainability, and documentation precision.

Every finding must include `file:line` and is either fixed by Claude with a regression test or recorded as an explicit exception. Only after the final Codex verification may Claude push and open the Korean-language pull request for issue #46.
