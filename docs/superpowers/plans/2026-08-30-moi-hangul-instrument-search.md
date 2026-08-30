# Moi Hangul Instrument Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate configured instruments with Korean provider names and support Korean syllable, in-progress syllable, choseong, symbol, and English-name searches without ever contacting the live provider in tests.

**Architecture:** Keep filtering in `InstrumentService`, delegating text matching to a pure `matchesInstrument` helper. Register routes from committed names and search aliases, then refresh display names once through the provider bundle's `InstrumentCatalog` after both leader leases are held; provider failure falls back to the snapshot and then the symbol. The Toss integration fake models `/api/v1/stocks/all`; the browser only changes presentation when the fallback name equals the symbol.

**Tech Stack:** Node 24.19.0, TypeScript 7 strict/NodeNext, Fastify, Vitest, React Testing Library, `es-hangul` 2.4.0, pnpm 11.22.0.

**Spec:** `docs/superpowers/specs/2026-08-30-moi-hangul-instrument-search-design.md`

**Status:** Implemented and verified. Two independent review lanes completed;
accepted findings for shutdown-abort propagation and real-catalog English alias
coverage were fixed with regression tests. A follow-up review finding that the
provider refresh dropped those aliases was also fixed and covered after the
runtime reaches `SERVING`.

## Global Constraints

- Tests and CI must use only loopback fakes and must never contact a live Toss host.
- Logs must contain no token, client secret, credential value, or provider error message that could embed one.
- Decimal and ledger behavior are out of scope and must not change.
- Keep search server-side; do not download the complete catalog to the browser.
- Support Korean substring, partially composed Korean input, choseong, symbol, and existing case-insensitive English-name matching.
- Do not add QWERTY-to-Hangul correction, pagination, or `englishName` locale behavior.
- Use Node 24.19.0 and pnpm 11.22.0 for every command.

---

### Task 1: Pure Hangul-aware instrument matching

**Files:**
- Create: `apps/paper-api/src/modules/instruments/hangul-match.ts`
- Create: `apps/paper-api/src/modules/instruments/hangul-match.test.ts`
- Modify: `apps/paper-api/src/modules/instruments/instrument-service.ts`
- Modify: `apps/paper-api/src/modules/instruments/instrument-routes.test.ts`
- Modify: `apps/paper-api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `Instrument` fields `symbol: string` and `name: string`.
- Produces: `matchesInstrument(query: string, instrument: Pick<Instrument, 'symbol' | 'name'>): boolean`.

- [ ] **Step 1: Add failing service-level matching cases**

Add literal expectations to `instrument-routes.test.ts` for a catalog row `{ symbol: '005930', name: '삼성전자' }`: `삼성`, `삼서`, `ㅅㅅㅈㅈ`, and `005930` return the row; `apple` matches `{ symbol: 'AAPL', name: 'Apple' }`; whitespace returns all rows; unrelated Latin text returns none. The production mutation caught is restoring the old combined-string `includes` predicate.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @moi/paper-api exec vitest run src/modules/instruments/instrument-routes.test.ts`

Expected: the `삼서` and `ㅅㅅㅈㅈ` assertions fail because the current predicate cannot match decomposed input or choseong.

- [ ] **Step 3: Add the dependency and pure matcher**

Run: `pnpm --filter @moi/paper-api add es-hangul@2.4.0`

Implement `hangul-match.ts` with `disassemble` and `getChoseong`. Normalize with `trim().toLowerCase()`, return true for an empty query, preserve direct case-insensitive symbol/name substring matching, use `/^[ㄱ-ㅎ]+$/u` for the choseong-only branch, and otherwise compare `disassemble(name).includes(disassemble(query))` when `/[가-힣ㄱ-ㅎㅏ-ㅣ]/u` is present.

- [ ] **Step 4: Delegate `InstrumentService.search` to the matcher**

Replace the inline combined-string predicate with `matchesInstrument(query, i)` while preserving the market filter and tradability mapping exactly.

- [ ] **Step 5: Add focused pure tests and verify GREEN**

Create `hangul-match.test.ts` with a table whose hand-derived outputs cover `삼성`, `삼서`, `ㅅㅅㅈㅈ`, `005930`, `apple`, an empty/whitespace query, and `banana`. Run both focused test files and expect all cases to pass.

- [ ] **Step 6: Commit the independently working matcher**

```bash
git add apps/paper-api/src/modules/instruments/hangul-match.ts apps/paper-api/src/modules/instruments/hangul-match.test.ts apps/paper-api/src/modules/instruments/instrument-service.ts apps/paper-api/src/modules/instruments/instrument-routes.test.ts apps/paper-api/package.json pnpm-lock.yaml
git commit -m "feat(api): support Hangul instrument matching"
```

### Task 2: Provider names with snapshot and symbol fallback

**Files:**
- Create: `apps/paper-api/src/modules/instruments/instrument-names.ts`
- Create: `apps/paper-api/src/modules/instruments/instrument-names.test.ts`
- Create: `apps/paper-api/src/modules/instruments/instrument-names.snapshot.json`
- Create: `apps/paper-api/src/modules/instruments/instrument-search-aliases.snapshot.json`
- Modify: `apps/paper-api/src/runtime/provider-bundle.ts`

**Interfaces:**
- Consumes: `InstrumentCatalog.searchInstruments(query: string, signal: AbortSignal)` and `Readonly<Record<Market, readonly string[]>>`.
- Produces: `loadInstrumentNames(options): Promise<ReadonlyMap<`${Market}:${string}`, string>>` and `ProviderBundle.instruments: InstrumentCatalog`.

- [ ] **Step 1: Write failing loader tests**

Cover provider precedence, sanitized failure fallback, symbol fallback, timeout fallback, caller-abort propagation, and complete display-name/search-alias coverage for every production symbol.

- [ ] **Step 2: Run the loader test and verify RED**

Run: `pnpm --filter @moi/paper-api exec vitest run src/modules/instruments/instrument-names.test.ts`

Expected: module resolution fails because `instrument-names.ts` does not exist yet.

- [ ] **Step 3: Commit the bounded snapshot**

Create JSON rows shaped exactly as `{ "market": "KR" | "US", "symbol": string, "name": string }`. Include `005930` as `삼성전자` and every symbol in `TOSS_SYMBOL_WHITELIST` with a stable Korean display name, including `AAPL` as `애플`. Do not include provider IDs, English aliases, prices, timestamps, or credentials.

- [ ] **Step 4: Implement the loader**

Import the JSON with a NodeNext JSON import attribute. Build provider and snapshot maps keyed by `${market}:${symbol}`; emit only configured symbols in market order; select `providerName || snapshotName || symbol`. Combine the caller signal with a private timeout signal, clear the timer in `finally`, and on failure call `log('instrument_names.provider_fallback', { reason: error.name })` without logging `error.message`.

- [ ] **Step 5: Expose an instrument catalog on provider bundles**

Add `readonly instruments: InstrumentCatalog` to `ProviderBundle`. `createTossProviderBundle` assigns the same `TossRestClient` instance used for snapshots. `createFakeProviderBundle` supplies a deterministic in-memory catalog containing `삼성전자`/`005930` and `애플`/`AAPL`, filters by query without network access, and implements `getInstrument` for the port contract.

- [ ] **Step 6: Run focused tests and typecheck**

Run the loader tests and `pnpm --filter @moi/paper-api typecheck`; expect PASS and no warnings.

- [ ] **Step 7: Commit name loading and bundle wiring**

```bash
git add apps/paper-api/src/modules/instruments/instrument-names.ts apps/paper-api/src/modules/instruments/instrument-names.test.ts apps/paper-api/src/modules/instruments/instrument-names.snapshot.json apps/paper-api/src/runtime/provider-bundle.ts
git commit -m "feat(api): load provider instrument names with snapshot fallback"
```

### Task 3: Runtime and loopback Toss integration

**Files:**
- Modify: `apps/paper-api/src/runtime/production-runtime.ts`
- Modify: `apps/paper-api/src/modules/instruments/instrument-service.ts`
- Modify: `apps/paper-api/src/modules/instruments/instrument-routes.test.ts`
- Modify: `apps/paper-api/src/runtime/production-runtime.integration.test.ts`
- Modify: `apps/paper-api/src/runtime/production-runtime.toss.integration.test.ts`
- Modify: `packages/market-data/src/testing/fake-toss/fake-toss-rest-server.ts`
- Modify: `packages/market-data/src/testing/fake-toss/fake-toss-rest-server.test.ts`

**Interfaces:**
- Consumes: `ProviderBundle.instruments` and `loadInstrumentNames` from Task 2.
- Produces: a snapshot-backed `InstrumentService` at route registration, followed by one atomic catalog replacement after both leader leases are held.

- [ ] **Step 1: Add failing runtime and fake-server tests**

In the fake REST test, seed `005930`/`삼성전자` and `AAPL`/`애플`, call authenticated `/api/v1/stocks/all`, and assert the complete contract-shaped rows. In production-runtime integration, call `/api/v1/instruments?q=ㅅㅅㅈㅈ` and assert `005930` is returned with `name: '삼성전자'`. In the Toss integration, assert the same endpoint is served after names came through the loopback REST fake.

- [ ] **Step 2: Run focused tests and verify RED**

Run each affected Vitest file. Expected: the fake endpoint returns `[]`, and runtime results still expose `name === symbol`.

- [ ] **Step 3: Extend the loopback fake**

Add a `seedInstrument` control method and a private instrument map. For `/api/v1/stocks/all`, return seeded rows with `symbol`, `name`, `securityType` (`FOREIGN_STOCK` for US and `STOCK` for KR), and `isCommonShare: true`. Preserve bearer auth, request recording, failure injection, and loopback binding.

- [ ] **Step 4: Serve snapshot names, then refresh after lease acquisition**

Construct the route's `InstrumentService` from the committed snapshot without provider I/O. Add `replaceCatalog` as an atomic array assignment. After `#acquireBundle` holds both leases, call `loadInstrumentNames` once with `this.#o.bundle.instruments`, configured symbols, `this.#controller.signal`, and `this.#log`, then replace the catalog before market recovery. This preserves the production contract that no token or provider connection is opened before both leases are held.

- [ ] **Step 5: Verify runtime integration GREEN**

Build dependencies, then run the three focused test files. Confirm request logs include `/api/v1/stocks/all` but never an authorization token or credentials.

- [ ] **Step 6: Commit runtime integration**

```bash
git add apps/paper-api/src/runtime/production-runtime.ts apps/paper-api/src/modules/instruments/instrument-service.ts apps/paper-api/src/modules/instruments/instrument-routes.test.ts apps/paper-api/src/runtime/production-runtime.integration.test.ts apps/paper-api/src/runtime/production-runtime.toss.integration.test.ts packages/market-data/src/testing/fake-toss/fake-toss-rest-server.ts packages/market-data/src/testing/fake-toss/fake-toss-rest-server.test.ts
git commit -m "test(api): cover Hangul search through loopback Toss"
```

### Task 4: Remove duplicate fallback labels in the browser

**Files:**
- Modify: `apps/web/src/features/instruments/instrument-search.tsx`
- Modify: `apps/web/src/pages/trade-page.test.tsx`

**Interfaces:**
- Consumes: API `Instrument` where `name` may equal `symbol` after the final fallback.
- Produces: visible text `삼성전자 (005930)` for a real name and `005930` for a fallback name.

- [ ] **Step 1: Add the failing browser assertion**

Add a `005930` fixture with `name: '005930'`; assert its button accessible name is exactly `005930` and that no `(005930)` text is present. This catches unconditional symbol-parenthesis rendering.

- [ ] **Step 2: Run the focused browser test and verify RED**

Run: `pnpm --filter @moi/web exec vitest run src/pages/trade-page.test.tsx`

Expected: the button is named `005930 (005930)`.

- [ ] **Step 3: Render the symbol conditionally**

Keep the name span, but render the separating space and parenthesized symbol span only when `instrument.name !== instrument.symbol`.

- [ ] **Step 4: Run the focused browser test and verify GREEN**

Run the same test file and expect PASS.

- [ ] **Step 5: Commit the presentation fix**

```bash
git add apps/web/src/features/instruments/instrument-search.tsx apps/web/src/pages/trade-page.test.tsx
git commit -m "fix(web): avoid duplicate fallback instrument labels"
```

### Task 5: Full verification and documentation state

**Files:**
- Modify: `docs/superpowers/specs/2026-08-30-moi-hangul-instrument-search-design.md`

- [ ] **Step 1: Mark the approved design implemented**

Change the status from `설계 승인 대기. 구현은 시작하지 않았다.` to `구현 완료.` after all behavior tests pass. Do not alter the decisions or expand scope.

- [ ] **Step 2: Run repository gates**

Run with `set -o pipefail`: `pnpm check`, `pnpm typecheck`, `pnpm --filter @moi/market-data test`, `pnpm --filter @moi/paper-api test`, `pnpm --filter @moi/web test`, and `pnpm build`. Docker must remain available for Testcontainers suites.

- [ ] **Step 3: Run two independent read-only review lanes**

Review lane 1 covers API matching, provider fallback, timeout, logging, and runtime startup. Review lane 2 covers fake-provider isolation, snapshot completeness, browser rendering, and test quality. Rank findings BLOCKER/HIGH/MEDIUM/LOW with file:line and fix every accepted finding with a failing test first.

- [ ] **Step 4: Commit verified documentation state**

```bash
git add docs/superpowers/specs/2026-08-30-moi-hangul-instrument-search-design.md docs/superpowers/plans/2026-08-30-moi-hangul-instrument-search.md
git commit -m "docs(search): record verified Hangul search implementation"
```
