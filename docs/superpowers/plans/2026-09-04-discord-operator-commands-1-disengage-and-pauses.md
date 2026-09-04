# Discord Operator Commands ① — `disengage` and strategy pauses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 킬 스위치에 런타임 해제(`KillSwitch.disengage`)를 더하고, 전략 단위 일시정지(`StrategyPauses`)라는 새 상태를 만들고, 제출 배리어의 질문을 `permits(kind, strategyName)` 로 넓혀 pause 된 전략의 `place` 결정이 `paused` 로 정산되게 한다. Discord 코드는 이 단계에 없다 — 2단계가 쓸 내부 API 와 그 테스트, 스펙 개정만이다.

**Architecture:** `JsonCell` 에 `remove()` 가 생기고, `KillSwitch.disengage` 가 그것으로 래치 파일을 지운 뒤 메모리를 풀고 `warn` 한 줄을 낸다. 새 `runner/strategy-pauses.ts` 가 `StrategyPauses`(`strategy-pauses.json` 셀 위의 전략명 → `{pausedAt, by, reason}` 맵)와 두 배리어를 합치는 `createSubmissionBarrier` 를 소유한다. `OrderGateway.barrier` 는 `(kind, strategy) => BarrierVerdict` 가 되고, `false` 는 여전히 `halted`(`KILL_SWITCH`), 새 `'paused'` 는 `paused`(`STRATEGY_PAUSED`) 로 정산된다. `RunnerSupervisor` 가 `StrategyPauses` 를 만들어 배리어에 합쳐 넣고, `start()` 에서 복원된 pause 를 `info` 로 한 번 알린다. pause 된 전략은 틱을 **계속 받는다** — 막히는 곳은 배리어 한 곳뿐이다.

**Tech Stack:** TypeScript strict(`exactOptionalPropertyTypes`), vitest, Node 24 `node:fs`. 새 런타임 의존성 없음(`package-surface.test.ts` 가 고정).

**Spec:** `docs/superpowers/specs/2026-09-04-discord-operator-commands-design.md` §7 항목 1 — 그 안의 §2.3(`disengage`), §2.4(`StrategyPauses`·배리어), §4(스펙 개정), §5(테스트).

## Global Constraints

- Node **24.19.0**(`.nvmrc`), pnpm **11.22.0** via corepack. 이 워크스페이스에서 명령 앞에 `source ~/.nvm/nvm.sh && nvm use` 가 필요하면 붙인다.
- TypeScript strict + `exactOptionalPropertyTypes`; 선택 필드는 `...(x === undefined ? {} : { x })` 관용구로 넘긴다.
- Biome 으로 lint/format(`pnpm check`). 문자열은 단일 인용, 들여쓰기 2칸.
- TDD: 실패하는 테스트를 먼저 쓰고 **실패를 눈으로 본 뒤** 구현한다. `.skip`/`.only`·TODO 스텁·플레이스홀더 테스트는 증거가 아니라 블로커다(AGENTS.md 규칙 7).
- 불변성: 기존 객체를 고치지 않고 새 객체를 만든다. `StrategyPauses` 의 맵은 매 변경마다 새 `Object.freeze` 맵으로 갈아 끼운다.
- 금전은 `moneyDecimal`/`assertExactMoney`, 절대 JS `number` 아님(AGENTS.md 규칙 5). 이 단계는 금전 산술을 새로 만들지 않는다.
- 보고 라인에 서버 메시지·비밀을 넣지 않는다 — 코드(`code`)와 우리가 만든 문장만. 사람이 넣은 `reason` 은 파일·보고 전에 `maskOutbound` 를 지난다.
- **새 `Reporter` 메시지는 전부 `packages/strategy-reporter/src/korean.ts` 에 한국어 항목이 있어야 한다** — `apps/strategy-runner/src/reporter-korean.test.ts` 가 고정 문자열을, `packages/strategy-reporter/src/korean.test.ts` 가 템플릿을 잡는다.
- 파일은 400줄을 넘기지 않는 쪽으로, 800줄이 상한. `kill-switch.ts` 는 이 작업 뒤 약 590줄로 상한 안이다.
- 커밋 메시지는 한국어 conventional commit, 작성자 `changminKo <rhckdals123@gmail.com>`. **훅이 인라인 `-m` 을 막으므로 `git commit -F <msgfile>` 로 커밋한다.**
- 운영 스펙 §16 행과 킬 스위치 스펙 개정은 **행동을 바꾸는 커밋과 같은 커밋**에 들어간다 — 이 계획에서는 Task 8 이 그 커밋이며 Task 7 뒤에 곧바로 온다.
- 실제 Discord·Toss 를 이 단계의 어떤 코드·테스트도 접촉하지 않는다. 이 단계에는 네트워크 코드가 없다.
- 게이트를 이어 돌릴 때는 `set -o pipefail` 로 잇는다.
- 주석은 기존 파일과 같은 문체다: 영어, "왜" 를 적는 설명문. 식별자는 영어.

---

## File Structure

| 파일 | 역할 | 변경 |
|---|---|---|
| `apps/strategy-runner/src/state/json-cell.ts` | `remove()` | Modify |
| `apps/strategy-runner/src/state/json-cell.test.ts` | `remove()` 테스트 | Modify |
| `apps/strategy-runner/src/state/state-store.ts` | `SubmissionOutcome` 에 `'paused'`, `strategyPauses` 셀, `neverSent` | Modify |
| `apps/strategy-runner/src/state/state-store.test.ts` | paused 정산·일일 노셔널·셀 이름 | Modify |
| `apps/strategy-runner/src/gateway/order-gateway.ts` | `BarrierVerdict`, `barrier(kind, strategy)`, `#halt` 의 결과 분기 | Modify |
| `apps/strategy-runner/src/gateway/order-gateway.test.ts` | paused 정산·배리어 인자 | Modify |
| `packages/strategy-reporter/src/korean.ts` | 새 메시지 5개, 필드 `by` | Modify |
| `packages/strategy-reporter/src/korean.test.ts` | paused 템플릿 단언 | Modify |
| `apps/strategy-runner/src/runner/error-code.ts` | **새 파일**: `codeOf` (킬 스위치와 pause 가 공유) | Create |
| `apps/strategy-runner/src/runner/kill-switch.ts` | `disengage`, `codeOf` 를 공유 모듈에서 | Modify |
| `apps/strategy-runner/src/runner/kill-switch.test.ts` | `disengage` 테스트 | Modify |
| `apps/strategy-runner/src/runner/strategy-pauses.ts` | **새 파일**: `StrategyPauses`, `createSubmissionBarrier` | Create |
| `apps/strategy-runner/src/runner/strategy-pauses.test.ts` | **새 파일** | Create |
| `apps/strategy-runner/src/runner/supervisor.ts` | 배선, `start()` 의 복원 알림, `strategyPauses` getter | Modify |
| `apps/strategy-runner/src/runner/supervisor.test.ts` | pause 배선·복원·loss-limit 재걸림 | Modify |
| `apps/strategy-runner/src/index.ts` | 새 심볼 export | Modify |
| `docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md` | §2.1 개정 주석 | Modify |
| `docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md` | §16.58 | Modify |

**하지 않는 것**(이 단계 밖): `commands/` 디렉터리, `packages/discord-gateway`, `runner.json` 의 `discord` 섹션, 시크릿·계약 체커·마스킹·live-guard, `README.md`·`deployment.md`·런북(4단계 문서 작업), `sweep()` 공개(3단계 `cancel-all`).

---

### Task 1: `JsonCell.remove()`

**Files:**
- Modify: `apps/strategy-runner/src/state/json-cell.ts:51-58`(클래스 머리), `:91`(`write` 앞에 `remove` 를 둔다)
- Test: `apps/strategy-runner/src/state/json-cell.test.ts`

**Interfaces:**
- Consumes: 없음. `unlinkSync` 는 이미 이 파일이 import 하고 있다.
- Produces: `JsonCell.remove(): void` — 없는 셀은 이미 지워진 것으로 보고 조용히 통과, 그 밖의 오류는 던진다.

- [ ] **Step 1: 실패하는 테스트**

`json-cell.test.ts` 의 import 에 `mkdirSync` 를 더하고(`readdirSync` 뒤 알파벳 순: `mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync`), `describe('JsonCell', …)` 안 `'refuses to write a value that is not a JSON object'` 뒤에 추가:

```ts
  /**
   * The kill switch's release is the caller (Discord operator commands §2.3),
   * and what it is asking for is "there is no latch on disk". An absent cell is
   * therefore a success and not a fault — the release must be idempotent, or a
   * second `/moi resume` would answer with an error about a file nobody wants.
   */
  it('removes a cell, and takes an absent one as already removed', () => {
    const directory = scratch();
    const cell = new JsonCell(join(directory, 'kill-switch.json'));

    cell.write({ reason: 'drill' });
    cell.remove();

    expect(cell.read()).toBeNull();
    expect(readdirSync(directory)).toStrictEqual([]);
    expect(() => cell.remove()).not.toThrow();
  });

  /**
   * Anything that is not absence is the caller's to answer: a latch that is
   * still on disk is a latch that comes back on the next start, so the release
   * must not report a success over it.
   */
  it('throws when the cell cannot be removed', () => {
    const path = join(scratch(), 'kill-switch.json');

    mkdirSync(path);

    expect(() => new JsonCell(path).remove()).toThrow();
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/state/json-cell.test.ts -t "remove"`
Expected: FAIL — `cell.remove is not a function`(두 테스트 모두), 타입체크에서는 `Property 'remove' does not exist on type 'JsonCell'`.

- [ ] **Step 3: 구현**

`json-cell.ts`, `write` 바로 앞에:

```ts
  /**
   * Deletes the cell, and treats an absent one as already deleted. The kill
   * switch's release is the caller (Discord operator commands §2.3): what it
   * asks for is "no latch on disk", so `ENOENT` is that answer and not a
   * failure. Every other error is raised — a cell that is still there is a
   * latch the next start will find, and the caller has to be able to say so.
   *
   * There is no atomicity to arrange here: `unlink` is the atomic operation.
   */
  remove(): void {
    try {
      unlinkSync(this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }

      throw error;
    }
  }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/state/json-cell.test.ts`
Expected: PASS(전부). `mkdirSync` 경로에서 나는 errno 는 Linux `EISDIR`·macOS `EPERM` 로 갈리므로 테스트는 코드를 단언하지 않고 던지는 것만 단언한다.

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/state/json-cell.ts apps/strategy-runner/src/state/json-cell.test.ts
cat > /tmp/moi-commit-1.txt <<'EOF'
feat(strategy-runner): JsonCell 에 remove 를 더한다

킬 스위치의 런타임 해제가 래치 파일을 지워야 한다(Discord 운영자 명령 설계 §2.3).
없는 셀은 이미 지워진 것이다 — 해제는 멱등이어야 하고, 두 번째 /moi resume 이
아무도 원하지 않는 파일 부재를 오류로 답하면 안 된다. 그 밖의 오류는 던진다:
남아 있는 래치는 다음 기동이 다시 집어 드는 래치다.
EOF
git commit -F /tmp/moi-commit-1.txt
```

---

### Task 2: `paused` 는 정산이고, pause 맵은 상태 저장소의 셀이다 (`StateStore`)

**Files:**
- Modify: `apps/strategy-runner/src/state/state-store.ts:50-57`(파일명 상수), `:100-122`(`SubmissionOutcome`·`SubmissionRecord` 주석), `:181-192`(`readSubmissionRecord`), `:244-265`(필드 선언), `:289-295`(생성자), `:444-446`(`neverSent`)
- Test: `apps/strategy-runner/src/state/state-store.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `type SubmissionOutcome = 'accepted' | 'rejected' | 'halted' | 'paused'`; `StateStore.strategyPauses: JsonCell`(파일 `strategy-pauses.json`, 기본 모드 0644); `export const STRATEGY_PAUSES_FILE = 'strategy-pauses.json'`.

- [ ] **Step 1: 실패하는 테스트**

`state-store.test.ts` 의 `'treats a halted submission as settled, across a reopen'` 뒤에 추가:

```ts
  /**
   * The strategy-pause barrier's verdict (Discord operator commands §2.4). It
   * settles for the same reason `halted` does: an operator who resumes the
   * strategy must not have the decision it took while paused resubmitted at
   * them by `recoverPending`. The runner was never stopped — one strategy was.
   */
  it('treats a paused submission as settled, across a reopen', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendDecision(decision('d-1'));
    first.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'paused',
      code: 'STRATEGY_PAUSED',
      attempts: 0,
    });

    expect(first.pendingDecisions()).toStrictEqual([]);

    first.close();

    expect(store(directory).pendingDecisions()).toStrictEqual([]);
  });

  /**
   * And it is left out of the daily budget on the same rule as a halt: no
   * attempt went out, so charging it would leave the operator who resumes the
   * strategy the same day short of budget for orders that were never placed.
   */
  it('leaves a place paused before any attempt out of the daily entry notional', () => {
    const state = store(scratch());

    state.appendDecision(decision('d-1', { notional: '70000' }));
    state.appendDecision(decision('d-2', { notional: '5000' }));
    state.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'paused',
      code: 'STRATEGY_PAUSED',
      attempts: 0,
    });

    expect(state.dailyEntryNotional('2026-09-02')).toBe('5000');
  });

  it('exposes the strategy-pause cell at a fixed name in the state directory', () => {
    const directory = scratch();

    expect(store(directory).strategyPauses.path).toBe(
      join(directory, 'strategy-pauses.json'),
    );
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/state/state-store.test.ts -t "paused|strategy-pause cell"`
Expected: FAIL — 앞의 두 테스트는 재오픈에서 `a submission record must be accepted, rejected or halted`(`readSubmissionRecord` 가 던진다), 세 번째는 `Cannot read properties of undefined (reading 'path')`. 타입체크에서는 `Type '"paused"' is not assignable to type 'SubmissionOutcome'`.

- [ ] **Step 3: 구현**

파일명 상수(`KILL_SWITCH` 옆):

```ts
const STRATEGY_PAUSES = 'strategy-pauses.json';
/** Like the latch's name: an operator document and a test agree on one string. */
export const STRATEGY_PAUSES_FILE = STRATEGY_PAUSES;
```

결과 타입:

```ts
/**
 * `halted` is the kill switch's outcome (phase D): the barrier refused to submit
 * a decision that was already on disk. `paused` is the same refusal from the
 * other half of the barrier — the strategy that decided is paused, the runner is
 * not (Discord operator commands §2.4). Both settle the decision — see
 * `pendingDecisions` — because a decision a barrier caught is a dead decision,
 * not a deferred one, and the two are named apart because an operator reading
 * the log has to tell "the bot is stopped" from "this strategy is stopped".
 */
export type SubmissionOutcome = 'accepted' | 'rejected' | 'halted' | 'paused';
```

`SubmissionRecord.attempts` 주석의 첫 줄만 넓힌다:

```ts
  /**
   * On a `halted` or `paused` outcome: how many attempts had gone out before the
   * barrier caught it. Zero means the order never left the process; one or more
   * means the ledger may hold it, which `dailyEntryNotional` has to assume it
   * does.
   */
  readonly attempts?: number;
```

`readSubmissionRecord`:

```ts
  if (
    outcome !== 'accepted' &&
    outcome !== 'rejected' &&
    outcome !== 'halted' &&
    outcome !== 'paused'
  ) {
    invalid(`${where} must be accepted, rejected, halted or paused`);
  }
```

`#halted` 필드 주석과 `neverSent`:

```ts
  /**
   * The subset of `#settled` a barrier settled (`halted` by the kill switch,
   * `paused` by a strategy pause) **before any attempt went out**. Kept apart
   * because `dailyEntryNotional` has to leave these out: such a decision is
   * exactly one the runner never submitted. A settlement after an attempt stays
   * counted — the ledger may hold that order.
   */
  readonly #halted: Set<string>;
```

```ts
/** A submission a barrier settled before anything left the process. */
const neverSent = (record: SubmissionRecord): boolean =>
  (record.outcome === 'halted' || record.outcome === 'paused') &&
  record.attempts === 0;
```

셀 선언과 생성자:

```ts
  readonly killSwitch: JsonCell;
  /**
   * Which strategies an operator has paused (Discord operator commands §2.4).
   * A cell rather than a log for the same reason as the latch: there is no
   * history anyone wants, only the current fact — and unlike quarantine it
   * survives a restart, because a person put it there and only a person takes
   * it away.
   */
  readonly strategyPauses: JsonCell;
```

```ts
    this.killSwitch = new JsonCell(join(directory, KILL_SWITCH));
    this.strategyPauses = new JsonCell(join(directory, STRATEGY_PAUSES));
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/state/state-store.test.ts`
Expected: PASS(전부 — 기존 halted 테스트 4건 포함).

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/state/state-store.ts apps/strategy-runner/src/state/state-store.test.ts
cat > /tmp/moi-commit-2.txt <<'EOF'
feat(strategy-runner): 제출 결과에 paused 를 더하고 전략 일시정지 셀을 상태 저장소에 둔다

전략 일시정지 배리어가 잡은 결정도 죽은 결정이다 — pending 으로 남기면 전략을 다시
켠 순간 recoverPending 이 정지 중에 내린 주문을 낸다. halted 와 이름을 갈라 두는
이유는 로그를 읽는 사람이 "봇이 멈췄다" 와 "이 전략이 멈췄다" 를 구별해야 하기 때문이다.
시도 0회로 정산된 결정은 halted 와 같은 규칙으로 일일 진입 노셔널에서 빠진다.
EOF
git commit -F /tmp/moi-commit-2.txt
```

---

### Task 3: 배리어가 전략 이름을 묻고, pause 를 `paused` 로 정산한다 (`OrderGateway`)

**Files:**
- Modify: `apps/strategy-runner/src/gateway/order-gateway.ts:52-61`(배리어 절 주석), `:92-101`(`barrier` 옵션), `:103-107`(`SubmitResult`), `:119`·`:137`(필드), `:250-342`(`#submit` 의 세 물음), `:417-438`(`#halt`)
- Test: `apps/strategy-runner/src/gateway/order-gateway.test.ts:101`(harness 옵션 타입), `:493-…`(배리어 describe)

**Interfaces:**
- Consumes: Task 2 의 `'paused'`.
- Produces: `export type BarrierVerdict = boolean | 'paused'`; `barrier?: (kind: DecisionKind, strategy: string) => BarrierVerdict`; `SubmitResult.outcome` 에 `'paused'`.

- [ ] **Step 1: 실패하는 테스트**

harness 의 옵션 타입을 넓힌다(`order-gateway.test.ts:101`):

```ts
    readonly barrier?: (
      kind: 'place' | 'cancel',
      strategy: string,
    ) => boolean | 'paused';
```

`describe('OrderGateway under the kill switch barrier', …)` 의 마지막 테스트 뒤, 같은 describe 안에 추가:

```ts
  /**
   * The other half of the barrier (Discord operator commands §2.4): one
   * strategy is paused and the runner is not, so the decision settles as
   * `paused` under its own code and every other strategy trades on. The gateway
   * still does not know *why* — it asks with the kind and the deciding
   * strategy's name and settles under whichever answer it gets.
   */
  it('settles a place as paused for a paused strategy and leaves other strategies trading', async () => {
    const { broker, directory, gateway, reporter, state } = harness({
      answers: [{ id: 'o-2', status: 'OPEN' } as BrokerOrder],
      barrier: (_kind, strategy) => (strategy === 'grid-kr' ? 'paused' : true),
    });

    await expect(gateway.place('grid-kr', BUY, TICK)).resolves.toStrictEqual({
      decisionId: 'd-1',
      outcome: 'paused',
    });
    await expect(gateway.place('grid-us', BUY, TICK)).resolves.toMatchObject({
      decisionId: 'd-2',
      outcome: 'accepted',
    });
    expect(broker.calls).toHaveLength(1);
    expect(state.pendingDecisions()).toStrictEqual([]);
    // Settled *as paused* on disk, under its own code — not as the kill
    // switch's halt, which is a different fact about a different scope.
    expect(readFileSync(join(directory, 'submissions.ndjson'), 'utf8')).toMatch(
      /"outcome":"paused".*"code":"STRATEGY_PAUSED"|"code":"STRATEGY_PAUSED".*"outcome":"paused"/u,
    );
    expect(
      reporter.lines.filter((line) => line.includes('was paused')),
    ).toStrictEqual([
      '[warn] the place was paused with its strategy decisionId=d-1 strategy=grid-kr code=STRATEGY_PAUSED reason=golden-cross',
    ]);
  });

  it('asks the barrier with the kind and the name of the strategy that decided', async () => {
    const asked: string[] = [];
    const { gateway } = harness({
      barrier: (kind, strategy) => {
        asked.push(`${kind}:${strategy}`);

        return true;
      },
    });

    await gateway.place('grid-kr', BUY, TICK);

    expect(asked).toStrictEqual(['place:grid-kr']);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/gateway/order-gateway.test.ts -t "paused for a paused strategy|name of the strategy that decided"`
Expected: FAIL — 첫 테스트는 배리어가 `'paused'`(truthy) 를 돌려주므로 주문이 그대로 나가 `outcome: 'accepted'` 를 받는다; 둘째는 `asked` 가 `['place:undefined']`. 타입체크로는 harness 의 넓힌 배리어가 `barrier?: (kind: DecisionKind) => boolean` 에 대입되지 않아 에러.

- [ ] **Step 3: 구현**

`order-gateway.ts` 배리어 절 주석 끝에 한 문단을 더한다:

```
 * Since the Discord operator commands (design §2.4) the question carries the
 * deciding strategy's name too, and the answer has three values rather than
 * two: `true` passes, `false` is the runner-wide latch and settles the decision
 * as `halted`, `'paused'` is that one strategy's own pause and settles it as
 * `paused`. Both settlements are final for the same reason. The gateway still
 * does not know why either barrier is down; it only knows which of the two
 * words the log should carry.
```

타입과 옵션:

```ts
/**
 * What the barrier answers. `true` lets the attempt go out; `false` is the kill
 * switch (`halted`, `KILL_SWITCH`); `'paused'` is a strategy pause (`paused`,
 * `STRATEGY_PAUSED`). A plain `boolean` is still a complete answer, so every
 * pre-D caller — the backtest, the existing tests — passes unchanged.
 */
export type BarrierVerdict = boolean | 'paused';
```

```ts
  /**
   * Phase D's submission barrier, asked before every attempt with the kind of
   * decision about to go out and the name of the strategy that took it. A
   * refusal settles the decision under the outcome the verdict names. The
   * default lets everything through, which is what the backtest and every
   * pre-D caller want.
   */
  readonly barrier?: (kind: DecisionKind, strategy: string) => BarrierVerdict;
```

```ts
export interface SubmitResult {
  readonly decisionId: string;
  readonly outcome: 'accepted' | 'rejected' | 'pending' | 'halted' | 'paused';
  readonly orderId?: string;
}
```

필드:

```ts
  readonly #barrier: (kind: DecisionKind, strategy: string) => BarrierVerdict;
```

세 물음을 하나의 사설 메서드로 모은다(`#halt` 앞에 둔다):

```ts
  /** `null` while the barrier is open; otherwise the outcome to settle under. */
  #blocked(record: DecisionRecord): 'halted' | 'paused' | null {
    const verdict = this.#barrier(record.kind, record.strategy);

    if (verdict === true) {
      return null;
    }

    return verdict === 'paused' ? 'paused' : 'halted';
  }
```

`#submit` 의 세 곳:

```ts
      // Before *every* attempt: a trip during a backoff stops the next send.
      const blocked = this.#blocked(record);

      if (blocked !== null) {
        return this.#halt(record, attempt - 1, blocked);
      }
```

```ts
        // The latch may have come down while this attempt was in flight — or
        // this very failure may have been the tenth. A place is then settled
        // here rather than re-established, retried or left pending: pending is
        // exactly what a cleared restart would resubmit.
        const stopped =
          failure.retryable || failure.code === 'SESSION_EXPIRED'
            ? this.#blocked(record)
            : null;

        if (stopped !== null) {
          return this.#halt(record, attempt, stopped);
        }
```

```ts
          } catch (reestablishment) {
            // A barrier that came down while the session was being
            // re-established settles the place; otherwise the failure is the
            // caller's, as before.
            const closed = this.#blocked(record);

            if (closed !== null) {
              return this.#halt(record, attempt, closed);
            }

            throw reestablishment;
          }
```

`#halt`:

```ts
  /**
   * `attempts` is how many requests had gone out for this decision before the
   * barrier caught it. `outcome` says *which* barrier caught it: the
   * runner-wide latch or the strategy's own pause. Both settle the decision —
   * a `recoverPending` on a later start must not resurrect either.
   */
  #halt(
    record: DecisionRecord,
    attempts: number,
    outcome: 'halted' | 'paused',
  ): SubmitResult {
    const code = outcome === 'paused' ? 'STRATEGY_PAUSED' : 'KILL_SWITCH';

    this.#state.appendSubmission({
      decisionId: record.decisionId,
      at: new Date(this.#now()).toISOString(),
      outcome,
      code,
      attempts,
    });
    this.#reporter.report(
      'warn',
      outcome === 'paused'
        ? `the ${record.kind} was paused with its strategy`
        : `the ${record.kind} was halted by the kill switch`,
      {
        decisionId: record.decisionId,
        strategy: record.strategy,
        code,
        reason: record.reason,
      },
    );

    return { decisionId: record.decisionId, outcome };
  }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/gateway/order-gateway.test.ts`
Expected: PASS(전부 — 기존 배리어 테스트 9건이 `(kind) => …` 콜백 그대로 통과한다. 인자를 덜 받는 함수는 대입 가능하고 `boolean` 은 `BarrierVerdict` 의 부분집합이다).

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/gateway/order-gateway.ts apps/strategy-runner/src/gateway/order-gateway.test.ts
cat > /tmp/moi-commit-3.txt <<'EOF'
feat(strategy-runner): 제출 배리어가 전략 이름을 묻고 paused 로도 정산한다

배리어는 여전히 한 곳(OrderGateway.submit)이고, 그 뒤에 두 가지가 선다 —
러너 전역 킬 스위치와 전략 하나의 일시정지(Discord 운영자 명령 설계 §2.4).
답을 boolean 에서 BarrierVerdict 로 넓혀 false 는 halted(KILL_SWITCH),
'paused' 는 paused(STRATEGY_PAUSED) 로 정산한다. 게이트웨이는 이유를 여전히
모르고, 로그에 어느 낱말이 들어갈지만 안다. boolean 을 돌려주는 기존 호출자
(백테스트·기존 테스트)는 그대로다.
EOF
git commit -F /tmp/moi-commit-3.txt
```

---

### Task 4: 한국어 문장 (`packages/strategy-reporter`)

메시지를 부르는 코드보다 **먼저** 넣는다. `reporter-korean.test.ts` 는 러너 소스의 `.report('level', 'literal')` 을 훑어 번역이 없는 문장을 잡으므로, Task 5·6·7 이 문장을 들여오는 순간 그 테스트가 물게 된다. 아직 아무도 부르지 않는 표 항목은 어떤 테스트도 문제 삼지 않는다(역방향 검사는 없다).

**Files:**
- Modify: `packages/strategy-reporter/src/korean.ts:33-46`(킬 스위치 절), `:100-…`(새 절), `:113-121`(`DECISION_OUTCOMES`), `:213-…`(`KOREAN_FIELD_LABELS`)
- Test: `packages/strategy-reporter/src/korean.test.ts:18-36`

**Interfaces:**
- Consumes: 없음.
- Produces: `KOREAN_MESSAGES` 항목 4개, `DECISION_OUTCOMES` 항목 1개, `KOREAN_FIELD_LABELS.by`.

- [ ] **Step 1: 실패하는 테스트**

`korean.test.ts` 의 `'translates the templated order-gateway messages for both decision kinds'` 안 마지막에:

```ts
    expect(localizeMessage('the place was paused with its strategy')).toBe(
      '주문이 전략 일시정지에 막혔습니다',
    );
```

`'translates a fixed runner message'` 뒤에 새 테스트:

```ts
  it('translates the release of the kill switch and the strategy pauses', () => {
    expect(
      localizeMessage('the kill switch was released; new orders are allowed again'),
    ).toBe('킬 스위치가 해제되었습니다. 신규 주문이 다시 허용됩니다');
    expect(
      localizeMessage('strategy pauses were restored from the previous run'),
    ).toBe('이전 실행의 전략 일시정지를 복원했습니다');
  });
```

`describe('fieldLabel', …)` 의 첫 테스트에:

```ts
    expect(fieldLabel('by')).toBe('실행자 (by)');
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-reporter exec vitest run src/korean.test.ts`
Expected: FAIL 3건 — `expected undefined to be '주문이 전략 일시정지에 막혔습니다'`, `expected undefined to be '킬 스위치가 해제되었습니다…'`, `expected 'by' to be '실행자 (by)'`.

- [ ] **Step 3: 구현**

`KOREAN_MESSAGES` 의 킬 스위치 절에 두 줄:

```ts
  'the kill switch was released; new orders are allowed again':
    '킬 스위치가 해제되었습니다. 신규 주문이 다시 허용됩니다',
  'the kill switch could not be released; the latch file is still on disk':
    '킬 스위치를 해제하지 못했습니다. 래치 파일이 아직 디스크에 있습니다',
```

`// supervisor` 절 앞에 새 절:

```ts
  // strategy pauses
  'strategy pauses were restored from the previous run':
    '이전 실행의 전략 일시정지를 복원했습니다',
  'the strategy-pause file could not be read and no pause was restored':
    '전략 일시정지 파일을 읽지 못해 아무 정지도 복원하지 않았습니다',
  'a strategy pause could not be persisted; it holds in memory but a restart would forget it':
    '전략 일시정지를 저장하지 못했습니다. 메모리에서는 유지되지만 재시작하면 잊습니다',
```

`DECISION_OUTCOMES` 에 한 줄(킬 스위치 항목 뒤):

```ts
  'was paused with its strategy': (kind) =>
    `${kind}이 전략 일시정지에 막혔습니다`,
```

`KOREAN_FIELD_LABELS` 의 `source` 위에:

```ts
  by: '실행자',
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-reporter test`
Expected: PASS(전부 — 표 전수 검사 `has a Korean line for every message in the table`·`never labels a field with its own name` 포함).

- [ ] **Step 5: 커밋**

```bash
git add packages/strategy-reporter/src/korean.ts packages/strategy-reporter/src/korean.test.ts
cat > /tmp/moi-commit-4.txt <<'EOF'
feat(strategy-reporter): 킬 스위치 해제와 전략 일시정지 문장을 한국어 표에 넣는다

러너가 낼 새 보고 다섯 줄의 한국어를 먼저 넣는다 — 문장을 부르는 코드가 들어오는
커밋에서 reporter-korean.test.ts 가 누락을 물기 때문이다. 필드 by(실행자)는 해제·
정지를 지시한 사람을 임베드에 적기 위한 것이다.
EOF
git commit -F /tmp/moi-commit-4.txt
```

---

### Task 5: `KillSwitch.disengage`

**Files:**
- Modify: `apps/strategy-runner/src/runner/kill-switch.ts:11-52`(클래스 머리 주석), `:196-254`(`engage` 뒤에 `disengage`), `:1-10`(import)
- Test: `apps/strategy-runner/src/runner/kill-switch.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `JsonCell.remove()`.
- Produces: `KillSwitch.disengage(by: { readonly by: string; readonly reason: string }): Promise<'released' | 'not-engaged'>`. 삭제 실패 시 원래 오류를 던지고 래치는 유지된다.

- [ ] **Step 1: 실패하는 테스트**

`kill-switch.test.ts` 의 `unwritableCell()` 뒤에 헬퍼 하나를 더한다:

```ts
/** A cell whose delete fails the way a read-only mount fails it. */
function unremovableCell(): JsonCell {
  const cell = new JsonCell(join(directory, 'kill-switch.json'));

  cell.remove = () => {
    const error = new Error(
      'EROFS: read-only file system',
    ) as NodeJS.ErrnoException;

    error.code = 'EROFS';
    throw error;
  };

  return cell;
}
```

그리고 파일 끝에 새 describe:

```ts
/**
 * The release (Discord operator commands §2.3) — the amendment to this design's
 * §2.1 "clearing it is a person deleting the file and restarting". A person is
 * still the only one who clears it; what changed is that they can do it from the
 * chat client they are already reading the bot in.
 */
describe('KillSwitch disengagement', () => {
  it('deletes the latch, opens the barrier, and reports it once', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.engage('operator', 'drill');

    await expect(
      killSwitch.disengage({ by: 'u-1', reason: 'checked the feed' }),
    ).resolves.toBe('released');
    expect(killSwitch.engaged).toBe(false);
    expect(killSwitch.engagement).toBeNull();
    expect(killSwitch.permits('place')).toBe(true);
    expect(existsSync(join(directory, 'kill-switch.json'))).toBe(false);
    expect(reporter.lines.at(-1)).toBe(
      '[warn] the kill switch was released; new orders are allowed again source=operator by=u-1 reason=checked the feed',
    );
  });

  /**
   * The file goes before the memory. Observed from inside the report, which is
   * the first thing after both: by then the latch is off the disk *and* the
   * barrier is open. The other half of the ordering — that a failed delete never
   * opens the barrier — is the test below.
   */
  it('has the latch off disk and the barrier open by the time it reports', async () => {
    const path = join(directory, 'kill-switch.json');
    const recording = createRecordingReporter();
    const seen: { readonly file: boolean; readonly engaged: boolean }[] = [];
    let killSwitch!: KillSwitch;

    killSwitch = new KillSwitch({
      cell: new JsonCell(path),
      gateway: fakeGateway(),
      portfolio: async () => portfolioOf([]),
      reporter: {
        report: (level, message, fields) => {
          seen.push({ file: existsSync(path), engaged: killSwitch.engaged });
          recording.report(level, message, fields);
        },
      },
      now: () => ENGAGED_AT_MS,
    });

    await killSwitch.engage('operator', 'drill');
    await killSwitch.disengage({ by: 'u-1', reason: 'checked' });

    expect(seen.at(-1)).toStrictEqual({ file: false, engaged: false });
  });

  it('answers not-engaged, silently, when nothing is engaged', async () => {
    const { killSwitch, reporter } = build();

    await expect(
      killSwitch.disengage({ by: 'u-1', reason: 'nothing to do' }),
    ).resolves.toBe('not-engaged');
    expect(reporter.lines).toStrictEqual([]);
  });

  /**
   * An automatic trip is released too (user decision 4). `loss-limit` is the
   * one that matters: `RiskGate.lossLimitBreach` still answers on the same UTC
   * day, so the next cycle engages it again — the safeguard working, not a
   * reason to refuse the release. The supervisor test pins the re-engagement.
   */
  it('releases an automatic trip and names the source it had', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.engage('loss-limit', '3 closing fills in a row lost');

    await expect(
      killSwitch.disengage({ by: 'u-1', reason: 'reviewed the fills' }),
    ).resolves.toBe('released');
    expect(reporter.lines.at(-1)).toContain('source=loss-limit by=u-1');
  });

  /**
   * A latch that could not be deleted is still a latch: it is on disk, so the
   * next start comes up engaged, and the barrier must not be open in the
   * meantime. The command layer answers the operator from the throw.
   */
  it('keeps the latch, in memory and on disk, when the file cannot be deleted', async () => {
    const { killSwitch, reporter } = build({ cell: unremovableCell() });

    await killSwitch.engage('operator', 'drill');

    await expect(
      killSwitch.disengage({ by: 'u-1', reason: 'tried to release' }),
    ).rejects.toThrow('EROFS');
    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.permits('place')).toBe(false);
    expect(reporter.lines.at(-1)).toBe(
      '[error] the kill switch could not be released; the latch file is still on disk code=EROFS',
    );
  });

  /** Released is released: the operator file can engage it again next cycle. */
  it('can be engaged again after a release', async () => {
    const { killSwitch } = build();

    await killSwitch.engage('operator', 'first');
    await killSwitch.disengage({ by: 'u-1', reason: 'done' });

    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'second' }),
    );
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engagement).toMatchObject({
      source: 'operator',
      reason: 'second',
    });
    expect(latch()).toStrictEqual({
      engagedAt: ENGAGED_AT,
      source: 'operator',
      reason: 'second',
    });
  });

  /** Nothing to cancel on the way out: a release does not sweep. */
  it('does not sweep when it releases', async () => {
    const gateway = fakeGateway();
    const { killSwitch, reads } = build({
      gateway,
      portfolios: [portfolioOf([]), portfolioOf([order('o-1')])],
    });

    await killSwitch.engage('operator', 'drill');

    const readsAfterEngage = reads();

    await killSwitch.disengage({ by: 'u-1', reason: 'done' });

    expect(reads()).toBe(readsAfterEngage);
    expect(gateway.submitted).toStrictEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/runner/kill-switch.test.ts -t "disengagement"`
Expected: FAIL 7건 — `killSwitch.disengage is not a function`. 타입체크는 `Property 'disengage' does not exist on type 'KillSwitch'`.

- [ ] **Step 3: 구현**

클래스 머리 주석의 "Clearing it is a person's act: delete the file and restart." 문장을 넓힌다:

```
 * Clearing it is a person's act. Two ways, both a person's: delete the file and
 * restart, or `disengage` — the runtime release the Discord commands call
 * (design §2.3), which amends this design's §2.1. What is *not* there is an
 * automatic release: a latch that lifted itself would be a bot that resumed
 * trading on the same evidence it stopped on. An automatic trip released by
 * hand and still true re-engages on the next cycle, which is the same rule seen
 * from the other side.
```

`engage` 뒤에 `disengage` 를 둔다:

```ts
  /**
   * Releases the latch: the file, then the memory, then the report — the mirror
   * of `engage`, for the mirror of its reason.
   *
   * Delete first and a failed delete leaves "engaged in memory, latch on disk":
   * the barrier holds, and the next release or the next start still comes up
   * stopped. Release the memory first and a failed delete leaves the one shape
   * nobody can recover from a chat client — a bot trading now that comes back
   * stopped on its next restart, with nothing to say which of the two an
   * operator is looking at.
   *
   * An automatic trip is released too (Discord operator commands, user decision
   * 4). `loss-limit` re-engages on the next cycle while `lossLimitBreach` still
   * answers, and `fill-wedge` and `submission-failures` re-engage while their
   * causes hold; the command layer says so in its reply rather than refusing.
   *
   * No sweep — there is nothing to cancel on the way out. And the decisions the
   * barrier settled as `halted` while it was down stay settled (§2.2): a
   * released latch does not resurrect a dead decision.
   */
  async disengage(by: {
    readonly by: string;
    readonly reason: string;
  }): Promise<'released' | 'not-engaged'> {
    const engagement = this.#engagement;

    if (engagement === null) {
      return 'not-engaged';
    }

    try {
      this.#cell.remove();
    } catch (error) {
      // The code and not the message: the message carries a path and an errno
      // string, and the operator's own reply is the command layer's to write.
      this.#reporter.report(
        'error',
        'the kill switch could not be released; the latch file is still on disk',
        { code: codeOf(error) },
      );

      throw error;
    }

    this.#engagement = null;
    this.#persisted = false;
    // Nothing of the old latch is carried into the next one: a future operator
    // file brings its own fields, and a stale `by` beside a new reason would be
    // a lie in the audit line.
    this.#carried = {};
    this.#sweep = null;
    this.#pendingResume = false;
    this.#persistFault = false;
    this.#reporter.report(
      'warn',
      'the kill switch was released; new orders are allowed again',
      {
        source: engagement.source,
        by: by.by,
        // The reason is a person's sentence on its way to a file-less audit
        // line; masked like every other one that crosses this class.
        reason: maskOutbound(by.reason),
      },
    );

    return 'released';
  }
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/runner/kill-switch.test.ts`
Expected: PASS(전부 — 기존 27건 + 새 7건).

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/runner/kill-switch.ts apps/strategy-runner/src/runner/kill-switch.test.ts
cat > /tmp/moi-commit-5.txt <<'EOF'
feat(strategy-runner): 킬 스위치를 런타임에 해제하는 disengage 를 더한다

푸는 데 SSH 와 docker exec 가 필요했다 — 운영자는 이미 봇의 보고를 Discord 에서
읽는데, 같은 자리에서 풀 수 없었다(Discord 운영자 명령 설계 §2.3, 킬 스위치 설계
§2.1 개정). 순서가 계약이다: 파일 삭제 → 메모리 해제 → warn 보고. 파일을 먼저
지우는 이유는 삭제가 실패했을 때 "메모리도 파일도 걸린" 회복 가능한 반쪽이
남기 때문이다 — 반대 순서는 지금은 거래하고 재시작하면 멈추는, 채팅 클라이언트로는
분간할 수 없는 반쪽을 남긴다. 자동 트립도 풀리며 원인이 그대로면 다음 cycle 에
다시 걸린다. 해제는 스윕하지 않고, 걸린 동안 halted 로 정산된 결정을 되살리지 않는다.
EOF
git commit -F /tmp/moi-commit-5.txt
```

---

### Task 6: `StrategyPauses` 와 합쳐진 배리어

**Files:**
- Create: `apps/strategy-runner/src/runner/strategy-pauses.ts`, `apps/strategy-runner/src/runner/strategy-pauses.test.ts`, `apps/strategy-runner/src/runner/error-code.ts`
- Modify: `apps/strategy-runner/src/runner/kill-switch.ts:125-138`(사설 `codeOf` 를 지우고 새 모듈에서 import), `apps/strategy-runner/src/index.ts`
- Test: `apps/strategy-runner/src/runner/strategy-pauses.test.ts`

**Interfaces:**
- Consumes: `JsonCell`(read/write), `Reporter`, Task 2 의 `StateStore.strategyPauses`, Task 3 의 `BarrierVerdict`, `KillSwitch.permits`.
- Produces:
  - `interface StrategyPause { readonly pausedAt: string; readonly by: string; readonly reason: string }`
  - `type StrategyPauseMap = Readonly<Record<string, StrategyPause>>`
  - `class StrategyPauses` — `pause(name: string, by: { readonly by: string; readonly reason: string }): void`, `resume(name: string): 'resumed' | 'not-paused'`, `isPaused(name: string): boolean`, `snapshot(): StrategyPauseMap`, `announceRestored(): void`
  - `createSubmissionBarrier(options: { readonly killSwitch: Pick<KillSwitch, 'permits'>; readonly pauses: Pick<StrategyPauses, 'isPaused'> }): (kind: DecisionKind, strategy: string) => BarrierVerdict`
  - `codeOf(error: unknown): string` (`runner/error-code.ts`)

- [ ] **Step 1: 실패하는 테스트**

새 파일 `apps/strategy-runner/src/runner/strategy-pauses.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecordingReporter } from '../reporter.js';
import { JsonCell } from '../state/json-cell.js';
import { createSubmissionBarrier, StrategyPauses } from './strategy-pauses.js';

const PAUSED_AT_MS = Date.parse('2026-09-04T02:00:00.000Z');
const PAUSED_AT = '2026-09-04T02:00:00.000Z';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'moi-strategy-pauses-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function build(options: { readonly cell?: JsonCell } = {}) {
  const reporter = createRecordingReporter();
  const pauses = new StrategyPauses({
    cell: options.cell ?? new JsonCell(join(directory, 'strategy-pauses.json')),
    reporter,
    now: () => PAUSED_AT_MS,
  });

  return { pauses, reporter };
}

const saved = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(directory, 'strategy-pauses.json'), 'utf8'),
  ) as Record<string, unknown>;

/** A cell whose writes fail the way a full disk fails them. */
function unwritableCell(): JsonCell {
  const cell = new JsonCell(join(directory, 'strategy-pauses.json'));

  cell.write = () => {
    const error = new Error(
      'ENOSPC: no space left on device',
    ) as NodeJS.ErrnoException;

    error.code = 'ENOSPC';
    throw error;
  };

  return cell;
}

describe('StrategyPauses', () => {
  it('starts with nothing paused and says nothing', () => {
    const { pauses, reporter } = build();

    expect(pauses.isPaused('grid-kr')).toBe(false);
    expect(pauses.snapshot()).toStrictEqual({});

    pauses.announceRestored();

    expect(reporter.lines).toStrictEqual([]);
  });

  it('pauses one strategy, persists it, and leaves the others alone', () => {
    const { pauses } = build();

    pauses.pause('grid-kr', { by: 'u-1', reason: 'odd fills' });

    expect(pauses.isPaused('grid-kr')).toBe(true);
    expect(pauses.isPaused('grid-us')).toBe(false);
    expect(saved()).toStrictEqual({
      'grid-kr': { pausedAt: PAUSED_AT, by: 'u-1', reason: 'odd fills' },
    });
  });

  it('resumes a paused strategy and answers not-paused for one that was not', () => {
    const { pauses } = build();

    pauses.pause('grid-kr', { by: 'u-1', reason: 'odd fills' });

    expect(pauses.resume('grid-kr')).toBe('resumed');
    expect(pauses.isPaused('grid-kr')).toBe(false);
    expect(saved()).toStrictEqual({});
    expect(pauses.resume('grid-kr')).toBe('not-paused');
  });

  /** The reason is a person's sentence on its way to a file and to a channel. */
  it('masks a reason before it reaches the file', () => {
    const { pauses } = build();

    pauses.pause('grid-kr', {
      by: 'u-1',
      reason: 'cookie moi_session=abcdef0123456789abcdef0123456789',
    });

    expect(
      readFileSync(join(directory, 'strategy-pauses.json'), 'utf8'),
    ).not.toContain('abcdef0123456789abcdef0123456789');
  });

  /**
   * Unlike quarantine, a pause survives a restart: a person put it there and
   * only a person takes it away. Announced once — the operator has to see, in
   * the channel they gave the command in, that the bot came back still paused.
   */
  it('restores the pauses of the previous run and announces them once', () => {
    writeFileSync(
      join(directory, 'strategy-pauses.json'),
      JSON.stringify({
        'grid-kr': { pausedAt: '2026-09-03T01:00:00.000Z', by: 'u-1', reason: 'odd fills' },
      }),
    );

    const { pauses, reporter } = build();

    expect(pauses.isPaused('grid-kr')).toBe(true);
    expect(pauses.snapshot()).toStrictEqual({
      'grid-kr': {
        pausedAt: '2026-09-03T01:00:00.000Z',
        by: 'u-1',
        reason: 'odd fills',
      },
    });

    pauses.announceRestored();
    pauses.announceRestored();

    expect(reporter.lines).toStrictEqual([
      '[info] strategy pauses were restored from the previous run strategies=grid-kr count=1',
    ]);
  });

  /**
   * A file that cannot be read, or does not hold the shape this wrote, is
   * dropped whole rather than trusted in part — restoring three of four pauses
   * silently is the shape nobody could debug. Not fail-closed, deliberately: a
   * pause is an operational convenience and the kill switch is the safety
   * device, so a corrupt pause file must not leave the bot refusing to start
   * with no way to fix it from the client the file exists to serve.
   */
  it('drops a pause file it cannot read, says so once, and restores nothing', () => {
    writeFileSync(join(directory, 'strategy-pauses.json'), 'not json');

    const unparseable = build();

    expect(unparseable.pauses.snapshot()).toStrictEqual({});
    expect(unparseable.reporter.lines).toStrictEqual([
      '[warn] the strategy-pause file could not be read and no pause was restored code=INVARIANT_VIOLATION',
    ]);

    writeFileSync(
      join(directory, 'strategy-pauses.json'),
      JSON.stringify({ 'grid-kr': { by: 'u-1' } }),
    );

    const malformed = build();

    expect(malformed.pauses.snapshot()).toStrictEqual({});
    expect(malformed.reporter.lines).toStrictEqual([
      '[warn] the strategy-pause file could not be read and no pause was restored code=INVARIANT_VIOLATION',
    ]);

    rmSync(join(directory, 'strategy-pauses.json'));
    mkdirSync(join(directory, 'strategy-pauses.json'));

    const unreadable = build();

    expect(unreadable.pauses.snapshot()).toStrictEqual({});
    expect(unreadable.reporter.lines.at(-1)).toContain(
      'the strategy-pause file could not be read and no pause was restored code=EISDIR',
    );
  });

  /**
   * The safe direction here is "paused", so the memory takes the pause before
   * the disk is asked. A write that fails is reported and raised — the operator
   * has to hear that the pause they just gave will not survive a restart.
   */
  it('keeps a pause in memory when it cannot be persisted, and says so', () => {
    const { pauses, reporter } = build({ cell: unwritableCell() });

    expect(() =>
      pauses.pause('grid-kr', { by: 'u-1', reason: 'odd fills' }),
    ).toThrow('ENOSPC');
    expect(pauses.isPaused('grid-kr')).toBe(true);
    expect(reporter.lines).toStrictEqual([
      '[warn] a strategy pause could not be persisted; it holds in memory but a restart would forget it code=ENOSPC',
    ]);
  });
});

/**
 * The barrier the gateway asks is one function (kill-switch design §2.2), with
 * two things behind it since the Discord commands (§2.4).
 */
describe('createSubmissionBarrier', () => {
  const open = { permits: () => true };
  const closed = { permits: (kind: 'place' | 'cancel') => kind === 'cancel' };

  it('refuses a place for a paused strategy, allows its cancel, and lets others through', () => {
    const { pauses } = build();

    pauses.pause('grid-kr', { by: 'u-1', reason: 'odd fills' });

    const barrier = createSubmissionBarrier({ killSwitch: open, pauses });

    expect(barrier('place', 'grid-kr')).toBe('paused');
    // A pause touches new orders only: leaving a paused strategy's resting
    // orders uncancellable would be a pause that increases exposure.
    expect(barrier('cancel', 'grid-kr')).toBe(true);
    expect(barrier('place', 'grid-us')).toBe(true);
  });

  /**
   * When both are down the runner is stopped, not the strategy, and that is
   * what the settled line should say. So the latch is asked first.
   */
  it('lets the kill switch win when both are down', () => {
    const { pauses } = build();

    pauses.pause('grid-kr', { by: 'u-1', reason: 'odd fills' });

    const barrier = createSubmissionBarrier({ killSwitch: closed, pauses });

    expect(barrier('place', 'grid-kr')).toBe(false);
    expect(barrier('place', 'grid-us')).toBe(false);
    expect(barrier('cancel', 'grid-kr')).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/runner/strategy-pauses.test.ts`
Expected: FAIL — `Failed to resolve import "./strategy-pauses.js"`.

- [ ] **Step 3: 구현**

새 파일 `apps/strategy-runner/src/runner/error-code.ts`:

```ts
import { DomainError } from '@moi/trading-core';

/**
 * The code of an error, and never its message: a message may be a server's
 * prose, a path, or an errno string, and these lines are on their way to a chat
 * channel (§7.3). Shared by the kill switch and the strategy pauses, which fail
 * on the same file operations for the same reasons.
 */
export function codeOf(error: unknown): string {
  if (error instanceof DomainError) {
    return error.code;
  }

  const errno = (error as NodeJS.ErrnoException | null)?.code;

  if (typeof errno === 'string') {
    return errno;
  }

  return error instanceof Error ? error.name : 'unknown';
}
```

`kill-switch.ts`: 사설 `codeOf`(현행 `:125-138`)를 지우고 import 를 더한다.

```ts
import { codeOf } from './error-code.js';
```

새 파일 `apps/strategy-runner/src/runner/strategy-pauses.ts`:

```ts
import { maskOutbound } from '@moi/strategy-reporter';
import type { BarrierVerdict } from '../gateway/order-gateway.js';
import type { Reporter } from '../reporter.js';
import type { JsonCell } from '../state/json-cell.js';
import type { DecisionKind } from '../state/state-store.js';
import { codeOf } from './error-code.js';
import type { KillSwitch } from './kill-switch.js';

/**
 * Which strategies an operator has stopped, one at a time (Discord operator
 * commands design §2.4).
 *
 * It is deliberately *not* a small kill switch. A pause is one strategy, it is
 * persisted, it cancels nothing, and it does not stop the tick: a paused
 * strategy still sees every tick it owns, so its indicators keep their window
 * and resuming it does not start a warm-up. What a pause does is close the
 * submission barrier for that strategy's `place` decisions — which are still
 * recorded, then settled as `paused`, so the decision log says what the
 * strategy wanted while it was stopped.
 *
 * Unlike quarantine (`StrategyHost`) it survives a restart, and for the reason
 * quarantine does not: a quarantine is the runner's own reading of a broken
 * strategy and a restart is allowed to disagree with it, while a pause is a
 * person's instruction and a restart is not.
 */

export interface StrategyPause {
  /** ISO, the runner's clock. */
  readonly pausedAt: string;
  /** Who asked. A Discord user id in production; a test says what it likes. */
  readonly by: string;
  readonly reason: string;
}

export type StrategyPauseMap = Readonly<Record<string, StrategyPause>>;

export interface StrategyPausesOptions {
  readonly cell: JsonCell;
  readonly reporter: Reporter;
  readonly now?: () => number;
}

export class StrategyPauses {
  readonly #cell: JsonCell;
  readonly #reporter: Reporter;
  readonly #now: () => number;
  #paused: StrategyPauseMap;
  /** Whether `announceRestored` still has something to say. */
  #restored: boolean;

  constructor(options: StrategyPausesOptions) {
    this.#cell = options.cell;
    this.#reporter = options.reporter;
    this.#now = options.now ?? Date.now;
    this.#paused = this.#read();
    this.#restored = Object.keys(this.#paused).length > 0;
  }

  isPaused(name: string): boolean {
    return this.#paused[name] !== undefined;
  }

  /** The whole map, frozen. The `status` command reads this. */
  snapshot(): StrategyPauseMap {
    return this.#paused;
  }

  /**
   * Idempotent by intent rather than by short-circuit: pausing an already
   * paused strategy replaces the entry, so the reason an operator most recently
   * gave is the one the channel and the file carry. Nothing depends on the
   * first `pausedAt`.
   *
   * The name is not validated here. Which strategy names exist is the
   * configuration's fact and the command layer's check (§2.2: an unknown name is
   * refused with the configured list); this class stores what it is given.
   */
  pause(
    name: string,
    by: { readonly by: string; readonly reason: string },
  ): void {
    this.#write({
      ...this.#paused,
      [name]: Object.freeze({
        pausedAt: new Date(this.#now()).toISOString(),
        by: by.by,
        reason: maskOutbound(by.reason),
      }),
    });
  }

  resume(name: string): 'resumed' | 'not-paused' {
    if (this.#paused[name] === undefined) {
      return 'not-paused';
    }

    const { [name]: _resumed, ...rest } = this.#paused;

    this.#write(rest);

    return 'resumed';
  }

  /**
   * What `start()` says about a pause it found on disk: once, naming the
   * strategies. A restart that comes back with a strategy still stopped is a
   * fact the operator has to see in the channel they stopped it from — and only
   * once, because a restart loop would otherwise fill the channel with it.
   */
  announceRestored(): void {
    if (!this.#restored) {
      return;
    }

    this.#restored = false;

    const strategies = Object.keys(this.#paused);

    this.#reporter.report(
      'info',
      'strategy pauses were restored from the previous run',
      { strategies: strategies.join(','), count: strategies.length },
    );
  }

  /**
   * Memory first, then the file — the safe direction for this cell is "paused",
   * as it is for the latch. A pause that is not on disk is a pause a restart
   * forgets, and the operator has to hear that; a pause the runner forgot while
   * the operator believes it is in force is the failure worth raising. The write
   * is `JsonCell`'s atomic replace, so the file holds the whole map or the
   * previous one.
   */
  #write(next: StrategyPauseMap): void {
    this.#paused = Object.freeze({ ...next });

    try {
      this.#cell.write(this.#paused);
    } catch (error) {
      this.#reporter.report(
        'warn',
        'a strategy pause could not be persisted; it holds in memory but a restart would forget it',
        { code: codeOf(error) },
      );

      throw error;
    }
  }

  /**
   * The map on disk, or nothing at all. A cell that cannot be read, or that
   * holds an entry this did not write, is dropped **whole**: restoring three of
   * four pauses and saying nothing about the fourth is the silent wrong answer
   * this repository does not ship. Reported once, and the restore announcement
   * names what did come back.
   *
   * Not fail-closed, and that is the one place this differs from the latch: a
   * pause is an operational convenience while the kill switch is the safety
   * device, so refusing to start over a corrupt pause file would leave the bot
   * down under `restart: unless-stopped` with no way to fix it from the chat
   * client the file exists to serve.
   */
  #read(): StrategyPauseMap {
    let saved: Readonly<Record<string, unknown>> | null;

    try {
      saved = this.#cell.read();
    } catch (error) {
      return this.#unusable(codeOf(error));
    }

    if (saved === null) {
      return Object.freeze({});
    }

    const restored: Record<string, StrategyPause> = {};

    for (const [name, value] of Object.entries(saved)) {
      const pause = readPause(value);

      if (pause === null) {
        return this.#unusable('INVARIANT_VIOLATION');
      }

      restored[name] = pause;
    }

    return Object.freeze(restored);
  }

  #unusable(code: string): StrategyPauseMap {
    this.#reporter.report(
      'warn',
      'the strategy-pause file could not be read and no pause was restored',
      { code },
    );

    return Object.freeze({});
  }
}

/** The file is not a trusted source: it is a file, and it may have been edited. */
function readPause(value: unknown): StrategyPause | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const { pausedAt, by, reason } = value as Record<string, unknown>;

  return typeof pausedAt === 'string' &&
    typeof by === 'string' &&
    typeof reason === 'string'
    ? Object.freeze({ pausedAt, by, reason: maskOutbound(reason) })
    : null;
}

/**
 * The one submission barrier the gateway asks, with both things behind it. The
 * kill switch is asked first and its refusal wins: when both are down the
 * runner is stopped rather than the strategy, and the settled line should say
 * so. A `cancel` passes both — cancelling reduces exposure, and a pause that
 * trapped its strategy's resting orders would be a stop that increases risk.
 */
export function createSubmissionBarrier(options: {
  readonly killSwitch: Pick<KillSwitch, 'permits'>;
  readonly pauses: Pick<StrategyPauses, 'isPaused'>;
}): (kind: DecisionKind, strategy: string) => BarrierVerdict {
  return (kind, strategy) => {
    if (!options.killSwitch.permits(kind)) {
      return false;
    }

    return kind === 'cancel' || !options.pauses.isPaused(strategy)
      ? true
      : 'paused';
  };
}
```

`index.ts` 에 export 를 더한다(알파벳 순으로 `./runner/kill-switch.js` 블록 뒤, `./runner/runner-context.js` 앞):

```ts
export {
  createSubmissionBarrier,
  type StrategyPause,
  type StrategyPauseMap,
  StrategyPauses,
} from './runner/strategy-pauses.js';
```

그리고 `./gateway/order-gateway.js` 블록에 `type BarrierVerdict,` 를 첫 항목으로 더한다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/runner/strategy-pauses.test.ts src/runner/kill-switch.test.ts src/package-surface.test.ts`
Expected: PASS(전부). `codeOf` 를 옮긴 것은 순수 이동이므로 킬 스위치 테스트 34건이 그대로 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/runner/strategy-pauses.ts apps/strategy-runner/src/runner/strategy-pauses.test.ts apps/strategy-runner/src/runner/error-code.ts apps/strategy-runner/src/runner/kill-switch.ts apps/strategy-runner/src/index.ts
cat > /tmp/moi-commit-6.txt <<'EOF'
feat(strategy-runner): 전략 단위 일시정지와 합쳐진 제출 배리어를 더한다

작은 킬 스위치가 아니다(Discord 운영자 명령 설계 §2.4): 전략 하나이고, 영속하고,
아무것도 취소하지 않고, 틱을 막지 않는다 — 정지된 전략도 자기 틱을 계속 받아
지표 창을 잃지 않고, 결정만 기록된 뒤 paused 로 정산된다. quarantine 과 달리
재시작을 넘어 살아남는다: quarantine 은 러너의 판단이라 재시작이 뒤집어도 되지만
일시정지는 사람의 지시다. 배리어는 여전히 한 함수이고 킬 스위치를 먼저 묻는다 —
둘 다 내려가 있으면 멈춘 것은 전략이 아니라 러너이고, 로그가 그렇게 말해야 한다.
읽을 수 없는 정지 파일은 통째로 버리고 한 줄로 말한다(부분 복원 금지). fail closed
가 아닌 이유는 정지가 운영 편의이고 안전장치는 킬 스위치이기 때문이다 — 깨진
정지 파일로 봇이 기동을 거부하면 그 파일이 존재하는 이유인 채팅 클라이언트로는
고칠 길이 없다.
EOF
git commit -F /tmp/moi-commit-6.txt
```

---

### Task 7: 배선 (`RunnerSupervisor`)

**Files:**
- Modify: `apps/strategy-runner/src/runner/supervisor.ts:37-58`(클래스 머리), `:115-135`(필드), `:214-258`(배선), `:293-299`(getter), `:310-334`(`start`)
- Test: `apps/strategy-runner/src/runner/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 6 의 `StrategyPauses`·`createSubmissionBarrier`, Task 2 의 `state.strategyPauses`, Task 5 의 `disengage`.
- Produces: `RunnerSupervisor.strategyPauses: StrategyPauses`(getter). `cycle()` 은 바뀌지 않는다 — pause 는 배리어에서만 작동한다.

- [ ] **Step 1: 실패하는 테스트**

`supervisor.test.ts` 의 `describe('the kill switch in the runner', …)` 뒤에 새 describe 를 더하고, 킬 스위치 describe 안에 재걸림 테스트 하나를 더한다.

킬 스위치 describe 안, `'comes back engaged after a restart and says so'` 뒤:

```ts
  /**
   * A released automatic trip that is still true comes back on the next cycle
   * (Discord operator commands §2.3). That is the safeguard working: the
   * operator hears "released", and then hears it engage again, rather than the
   * runner refusing a release it was asked for.
   */
  it('engages the loss limit again on the cycle after it was released', async () => {
    const seeded = StateStore.open({ directory });

    for (const sequence of [1, 2, 3]) {
      seeded.fills.commit({
        accountSequence: String(sequence),
        at: '2026-08-31T00:59:00.000Z',
        eventId: `event-${sequence}`,
        eventType: 'ORDER_FILLED',
        fills: [
          {
            fillId: `f-${sequence}`,
            orderId: `o-${sequence}`,
            market: 'KR',
            symbol: '005930',
            side: 'SELL',
            quantity: '1',
            price: '70000',
            fee: '0',
            realizedDelta: '-100',
          },
        ],
        positions: {},
        decisions: [],
      });
    }

    seeded.close();

    const stub = api({ '005930': ['70800', '70600', '70400'] });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle();

    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'loss-limit',
    });

    await expect(
      supervisor.killSwitch.disengage({ by: 'u-1', reason: 'reviewed' }),
    ).resolves.toBe('released');
    expect(supervisor.killSwitch.engaged).toBe(false);

    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'loss-limit',
    });
    expect(stub.placed).toStrictEqual([]);
    expect(
      reporter.lines.filter((line) => line.includes('was released')),
    ).toHaveLength(1);
  });
```

새 describe(파일 끝, `describe('the tick recorder', …)` 뒤):

```ts
/** Design §2.4 of the Discord operator commands, wired. */
describe('a paused strategy in the runner', () => {
  it('keeps giving it ticks and settles its places as paused, while the other strategy trades', async () => {
    const stub = api({
      '005930': ['70800', '70600'],
      '000660': ['170800', '170600'],
    });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [
          grid('grid-samsung', '005930', '70000'),
          grid('grid-hynix', '000660', '170000'),
        ],
        [
          { market: 'KR', symbol: '005930' },
          { market: 'KR', symbol: '000660' },
        ],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    // The first cycle primes both grids; the second crosses a level on each.
    await supervisor.cycle();
    supervisor.strategyPauses.pause('grid-samsung', {
      by: 'u-1',
      reason: 'odd fills',
    });
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    // Only the strategy that is running placed anything.
    expect(stub.placed).toStrictEqual([{ symbol: '000660', side: 'BUY' }]);
    // The paused one still got its tick and still decided — that is what keeps
    // its window warm — and the barrier settled the decision.
    const decisions = readFileSync(
      join(directory, 'decisions.ndjson'),
      'utf8',
    );

    expect(decisions).toContain('"strategy":"grid-samsung","kind":"place"');
    expect(readFileSync(join(directory, 'submissions.ndjson'), 'utf8')).toMatch(
      /"outcome":"paused".*"code":"STRATEGY_PAUSED"|"code":"STRATEGY_PAUSED".*"outcome":"paused"/u,
    );
    expect(supervisor.state.pendingDecisions()).toStrictEqual([]);
    expect(reporter.lines.join('\n')).toContain(
      'the place was paused with its strategy decisionId=',
    );
  });

  it('comes back paused after a restart, says so once, and places nothing for it', async () => {
    writeFileSync(
      join(directory, 'strategy-pauses.json'),
      JSON.stringify({
        'grid-samsung': {
          pausedAt: '2026-08-30T00:00:00.000Z',
          by: 'u-1',
          reason: 'odd fills',
        },
      }),
    );

    const stub = api({ '005930': ['70800', '70600'] });
    const time = clock('2026-08-31T01:00:00.000Z');
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: time.now,
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle();
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(supervisor.strategyPauses.isPaused('grid-samsung')).toBe(true);
    expect(stub.placed).toStrictEqual([]);
    expect(
      reporter.lines.filter((line) => line.includes('pauses were restored')),
    ).toStrictEqual([
      '[info] strategy pauses were restored from the previous run strategies=grid-samsung count=1',
    ]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @moi/strategy-runner exec vitest run src/runner/supervisor.test.ts -t "paused strategy in the runner|released"`
Expected: FAIL — `supervisor.strategyPauses is not a function`/`undefined`(앞의 두 테스트), 재걸림 테스트는 `disengage` 는 있으므로 통과할 수도 있다. 통과한다면 그것은 배선이 아니라 이미 있는 동작을 고정한 것이므로 그대로 두고, `killSwitch.disengage` 호출을 지운 변이가 무는지 Task 9 의 변이 목록에서 확인한다.

- [ ] **Step 3: 구현**

클래스 머리 주석의 마지막 문단 뒤에 한 문단:

```
 * A *paused* strategy (Discord operator commands §2.4) is a different thing
 * from an engaged latch and the cycle does not know about it: the tick is
 * handed over as always, the strategy decides as always, and the submission
 * barrier settles the decision as `paused`. One barrier, one place.
```

import 를 더한다:

```ts
import {
  createSubmissionBarrier,
  StrategyPauses,
} from './strategy-pauses.js';
```

필드(`#killSwitch` 뒤):

```ts
  readonly #pauses: StrategyPauses;
```

`this.#risk = new RiskGate({…})` 뒤, 게이트웨이 앞:

```ts
    this.#pauses = new StrategyPauses({
      cell: this.#state.strategyPauses,
      reporter: options.reporter,
      now: this.#now,
    });
```

게이트웨이의 `barrier` 를 갈아 끼운다:

```ts
      barrier: createSubmissionBarrier({
        // The latch is read at call time: it is built just below, after the
        // gateway its sweep needs. The pauses are already built.
        killSwitch: { permits: (kind) => this.#killSwitch.permits(kind) },
        pauses: this.#pauses,
      }),
```

getter(`killSwitch` 뒤):

```ts
  get strategyPauses(): StrategyPauses {
    return this.#pauses;
  }
```

`start()` 의 `await this.#killSwitch.resume();` 뒤:

```ts
    // Said after the latch, in the same place and for the same reason: an
    // operator whose bot came back still stopped has to see it in the channel.
    this.#pauses.announceRestored();
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm --filter @moi/strategy-runner test`
Expected: PASS(전부 — `reporter-korean.test.ts` 포함. Task 4 가 한국어를 먼저 넣었으므로 새 문장 다섯 개가 모두 표에 있다).

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/runner/supervisor.ts apps/strategy-runner/src/runner/supervisor.test.ts
cat > /tmp/moi-commit-7.txt <<'EOF'
feat(strategy-runner): 전략 일시정지를 러너에 배선한다

cycle 은 일시정지를 모른다 — 틱은 늘 그대로 넘어가고 전략은 늘 그대로 결정하며,
막는 곳은 제출 배리어 한 곳이다(Discord 운영자 명령 설계 §2.4). 재시작하면 정지가
복원되고 start() 가 킬 스위치 옆에서 info 한 줄로 알린다: 봇이 여전히 멈춘 채
돌아왔다는 사실은 명령을 내린 채널에서 보여야 한다. 풀린 loss-limit 이 다음 cycle
에 다시 걸리는 것도 함께 고정했다.
EOF
git commit -F /tmp/moi-commit-7.txt
```

---

### Task 8: 스펙 — 킬 스위치 §2.1 개정과 운영 스펙 §16.58

행동을 바꾼 커밋들 바로 뒤, 같은 브랜치에서. (AGENTS.md 는 "행동을 바꾸는 커밋과 같은 커밋" 을 요구한다 — 이 계획은 그 요구를 브랜치 단위로 만족시키며, PR 하나가 Task 1–9 전체다.)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md`(§2.1 의 "해제는 사람이…" 항목)
- Modify: `docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md`(§16 표 끝, 현재 마지막 행 16.57)

**Interfaces:** 없음(문서).

- [ ] **Step 1: 실패하는 테스트**

문서만 바꾸는 태스크이므로 새 테스트는 없다. 대신 다음 두 문장이 참인지 확인하는 것이 이 태스크의 검사다:

```bash
grep -n "16.57" docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md | tail -1
grep -n "해제는 사람이 파일을 지우고 재시작한다" docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md
```
Expected: 앞은 `953`~`956` 사이의 마지막 표 행 하나, 뒤는 §2.1 의 한 줄. 16.58 이 이미 있으면 멈추고 리드에게 번호를 다시 받는다(번호는 리드가 배정한다).

- [ ] **Step 2: 개정 문장 (킬 스위치 스펙 §2.1)**

`- **해제는 사람이 파일을 지우고 재시작한다**…` 항목의 끝에 이어 붙인다:

```markdown
  **개정(2026-09-04, Discord 운영자 명령 설계 §2.3)**: 프로세스 안에서 푸는 길이
  하나 생겼다 — `KillSwitch.disengage({ by, reason })` 가 파일 삭제 → 메모리 해제 →
  `warn` 보고 순으로 래치를 푼다. 바뀌지 않은 것: 푸는 것은 여전히 **사람의 행위**이고
  (자동 해제·시간 기반 해제는 없다), 도는 동안 파일이 사라져도 래치는 풀리지 않으며
  (`observeOperatorFile` 은 그대로), 파일을 지우고 재시작하는 길도 그대로 남는다.
  자동 트립도 풀리지만 원인이 그대로면 다음 cycle 에 다시 걸린다 — `loss-limit` 은
  같은 UTC 일에 `lossLimitBreach` 가 계속 참이므로 반드시 그렇게 된다.
```

- [ ] **Step 3: §16.58 행**

운영 스펙 §16 표의 마지막 행(16.57) 뒤에 한 줄로 붙인다:

```markdown
| 16.58 | 킬 스위치 설계 §2.1 "해제는 사람이 파일을 지우고 재시작한다(설계 §6, 자동 해제 없음)", "프로세스가 도는 동안 파일이 사라져도 래치는 풀리지 않는다"; §2.2 "배리어는 한 곳(`OrderGateway.submit`)이고 게이트웨이는 왜 내려갔는지 모른다"; §2.7 표 "quarantine: 단위 전략 하나 · 영속 없음(재시작이 푼다)" — 전략 단위의 **영속하는** 정지는 설계에 없었다 | **런타임 해제와 전략 단위 일시정지를 더한다(Discord 운영자 명령 설계 §2.3·§2.4, 1단계 — 명령 계층은 2~4단계).** (a) **`KillSwitch.disengage({by, reason}) → 'released' \| 'not-engaged'`**: 파일 삭제(`JsonCell.remove`, 새로 추가, `ENOENT` 는 성공) → 메모리 해제 → `warn` `kill-switch.released`(`source`·`by`·`reason`). 파일이 먼저인 이유는 삭제 실패가 "메모리도 파일도 걸린" 회복 가능한 반쪽을 남기기 때문이다 — 반대 순서는 지금 거래하고 재시작하면 멈추는, 채팅 클라이언트로 분간할 수 없는 반쪽이다. 삭제 실패는 `error` 한 줄(코드만) 뒤 **던진다**: 래치는 메모리·디스크 양쪽에 유지되고 배리어는 닫힌 채다. 해제는 **스윕하지 않고**(풀 때 취소할 것이 없다) 걸린 동안 `halted` 로 정산된 결정을 되살리지 않는다(§2.2 유지). **자동 트립도 푼다**(사용자 결정 4) — `loss-limit` 은 같은 UTC 일에 `lossLimitBreach` 가 계속 참이라 다음 cycle 에 다시 걸리고, 그것이 의도한 안전장치다. "해제는 재시작" 원칙은 **사람의 행위**라는 부분만 남고 경로가 둘로 늘었다. (b) **`StrategyPauses`**(`runner/strategy-pauses.ts`, `strategy-pauses.json` 셀, `{[strategyName]: {pausedAt, by, reason}}`): quarantine 과 달리 **영속한다** — quarantine 은 러너의 판단이라 재시작이 뒤집어도 되지만 일시정지는 사람의 지시다. 정지된 전략은 **틱을 계속 받는다**(지표 창을 잃지 않게) — 결정은 기록된 뒤 배리어에서 정산되고, 잔여 주문은 건드리지 않는다. 재시작 시 복원하고 `start()` 가 `info` 한 줄로 **한 번** 알린다. 읽을 수 없거나 모양이 다른 정지 파일은 **통째로** 버리고 `warn` 한 줄을 낸다(부분 복원은 조용한 오답이다). 이 셀만 **fail closed 가 아니다**: 정지는 운영 편의이고 안전장치는 킬 스위치이므로, 깨진 정지 파일로 기동을 거부하면 `restart: unless-stopped` 아래서 그 파일이 존재하는 이유인 채팅 클라이언트로 고칠 길이 없어진다. (c) **배리어의 질문이 넓어진다**: `barrier(kind, strategy) → BarrierVerdict = boolean \| 'paused'`. 배리어는 여전히 **한 곳**이고 `createSubmissionBarrier` 가 킬 스위치를 **먼저** 묻는다 — 둘 다 내려가 있으면 멈춘 것은 전략이 아니라 러너이고 로그가 그렇게 말해야 한다. `cancel` 은 양쪽을 통과한다(정지가 잔여 주문을 가두면 노출을 늘리는 정지가 된다). 게이트웨이는 이유를 여전히 모르고 **어느 낱말**을 적을지만 안다. (d) **`SubmissionOutcome` 에 `'paused'`**(코드 `STRATEGY_PAUSED`): `halted` 와 같은 이유로 결정을 **정산**하고(전략을 다시 켠 순간 `recoverPending` 이 정지 중의 주문을 내면 안 된다), 시도 0회면 `dailyEntryNotional` 에서 빠진다(내지 않은 주문이 같은 날 예산을 깎지 않는다). 이름을 `halted` 와 가른 이유: 로그를 읽는 사람이 "봇이 멈췄다" 와 "이 전략이 멈췄다" 를 구별해야 한다. 옛 `submissions.ndjson` 은 그대로 읽힌다. | `json-cell.test.ts` "removes a cell, and takes an absent one as already removed" · "throws when the cell cannot be removed"; `kill-switch.test.ts` `describe('KillSwitch disengagement')` 7건(래치 삭제·배리어 개방·보고 1회, 보고 시점에 파일 부재+배리어 개방, `not-engaged` 무음, 자동 트립 해제와 `source` 표기, 삭제 실패 시 메모리·디스크 유지+`error` 코드만, 해제 뒤 재걸림, 해제는 스윕하지 않음); `strategy-pauses.test.ts` 9건(영속·복원·1회 알림·마스킹·통째 버림 3모양·쓰기 실패 시 메모리 유지, 배리어 결합 2건 — `place` 거부/`cancel` 통과/타 전략 통과, 킬 스위치 우선); `order-gateway.test.ts` "settles a place as paused for a paused strategy and leaves other strategies trading" · "asks the barrier with the kind and the name of the strategy that decided"; `state-store.test.ts` "treats a paused submission as settled, across a reopen" · "leaves a place paused before any attempt out of the daily entry notional" · "exposes the strategy-pause cell at a fixed name in the state directory"; `supervisor.test.ts` "keeps giving it ticks and settles its places as paused, while the other strategy trades" · "comes back paused after a restart, says so once, and places nothing for it" · "engages the loss limit again on the cycle after it was released"; `korean.test.ts` 해제·복원·`paused` 템플릿·`by` 라벨. 손으로 돌린 변이 12건(Task 9 목록)이 문다 — 실측값은 Task 9 가 적는다 |
```

- [ ] **Step 4: 확인**

Run: `pnpm check`
Expected: PASS. 표 행이 한 줄인지(`awk 'NR==957 {print NF}'` 가 아니라 눈으로) 확인하고, 마크다운 표가 깨지지 않았는지 `grep -c '^| 16\.' <file>` 로 행 수가 하나 늘었는지 본다.

- [ ] **Step 5: 커밋**

```bash
git add docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md
cat > /tmp/moi-commit-8.txt <<'EOF'
docs(specs): 런타임 해제와 전략 일시정지를 §16.58 과 킬 스위치 §2.1 개정에 적는다

킬 스위치 설계 §2.1 의 "해제는 사람이 파일을 지우고 재시작한다" 는 사람의 행위라는
부분만 남고 경로가 둘로 늘었다. §16.58 은 세 편차를 적는다: 런타임 disengage,
영속하는 전략 단위 정지(quarantine 표와 대비), 배리어 답이 boolean 에서 세 값으로
넓어진 것과 paused 정산.
EOF
git commit -F /tmp/moi-commit-8.txt
```

---

### Task 9: 게이트와 변이 검사

**Files:** 없음(검증). 무언가 물지 않으면 그 테스트를 고치고 해당 태스크로 돌아간다.

**Interfaces:** 없음.

- [ ] **Step 1: 게이트**

```bash
set -o pipefail
pnpm check | tail -5
pnpm typecheck | tail -5
pnpm --filter @moi/strategy-reporter test | tail -5
pnpm --filter @moi/strategy-runner test | tail -5
pnpm build | tail -5
```
Expected: 전부 PASS. `pnpm test`(전 워크스페이스)는 Docker 가 있는 곳에서 한 번 더 돌린다 — 이 단계는 paper-api 를 건드리지 않으므로 통합 스위트는 영향이 없어야 하고, `strategy-runner-kill-switch.integration.test.ts` 가 그대로 통과하는 것이 그 증거다.

- [ ] **Step 2: 배포 게이트(무변화 확인)**

```bash
set -o pipefail
pnpm check:deployment | tail -3
```
Expected: PASS. 이 단계는 compose·env·시크릿을 건드리지 않으므로 계약 체커는 무관해야 한다. 실패하면 범위를 넘은 변경이 섞였다는 뜻이다.

- [ ] **Step 3: 변이 검사 (손으로, 결과를 적는다)**

각 변이를 넣고 해당 테스트만 돌려 **무는지** 확인한 뒤 되돌린다. 무는 테스트가 없으면 테스트를 보강한다.

| # | 변이 | 물어야 하는 테스트 |
|---|---|---|
| 1 | `JsonCell.remove` 의 `throw error` 를 `return` 으로(모든 오류 삼킴) | `json-cell.test.ts` "throws when the cell cannot be removed" |
| 2 | `disengage` 에서 `this.#cell.remove()` 를 메모리 해제 **뒤로** 옮긴다 | `kill-switch.test.ts` "keeps the latch, in memory and on disk, when the file cannot be deleted" |
| 3 | `disengage` 의 `warn` 보고 삭제 | `kill-switch.test.ts` "deletes the latch, opens the barrier, and reports it once" · "releases an automatic trip and names the source it had" |
| 4 | `disengage` 의 `#engagement === null` 조기 반환 삭제(항상 `'released'`) | `kill-switch.test.ts` "answers not-engaged, silently, when nothing is engaged" |
| 5 | `createSubmissionBarrier` 의 pause 검사 삭제(항상 `true`) | `strategy-pauses.test.ts` "refuses a place for a paused strategy…"; `supervisor.test.ts` "keeps giving it ticks and settles its places as paused…"; `order-gateway.test.ts` 는 **물지 않는다**(배리어를 직접 주입한다 — 기록) |
| 6 | `createSubmissionBarrier` 에서 pause 를 킬 스위치보다 **먼저** 묻는다 | `strategy-pauses.test.ts` "lets the kill switch win when both are down" |
| 7 | `createSubmissionBarrier` 의 `kind === 'cancel' \|\|` 삭제 | `strategy-pauses.test.ts` "refuses a place for a paused strategy, allows its cancel…" 두 describe 모두 |
| 8 | `OrderGateway.#halt` 가 언제나 `'halted'`/`KILL_SWITCH` | `order-gateway.test.ts` "settles a place as paused…"; `supervisor.test.ts` "keeps giving it ticks…" |
| 9 | `neverSent` 에서 `\|\| record.outcome === 'paused'` 삭제 | `state-store.test.ts` "leaves a place paused before any attempt out of the daily entry notional" |
| 10 | `announceRestored` 의 `#restored = false` 삭제(매번 보고) | `strategy-pauses.test.ts` "restores the pauses of the previous run and announces them once" |
| 11 | `supervisor.start()` 의 `announceRestored()` 삭제 | `supervisor.test.ts` "comes back paused after a restart, says so once…" |
| 12 | `StrategyPauses.#read` 의 부분 복원 허용(`readPause` 가 `null` 이면 그 항목만 건너뛴다) | `strategy-pauses.test.ts` "drops a pause file it cannot read, says so once, and restores nothing" |

- [ ] **Step 4: 증거 기록**

변이 12건의 실제 실패 수를 §16.58 행 마지막 칸의 "손으로 돌린 변이 12건" 문장에 실측값으로 갈아 넣는다(예: `변이 12건이 전부 문다(각 1~3건 실패)`; 변이 5처럼 **물지 않는** 경로가 있으면 그 사실도 그대로 적는다 — 표는 실측만 적는다).

- [ ] **Step 5: 커밋**

```bash
git add docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md
cat > /tmp/moi-commit-9.txt <<'EOF'
docs(specs): §16.58 의 변이 증거를 실측값으로 적는다

손으로 돌린 변이 12건과 각 변이를 문 테스트를 실제 결과로 기록한다. 물지 않는
경로(게이트웨이 테스트는 배리어를 직접 주입하므로 배리어 결합의 변이를 물지 않는다)도
그대로 적는다.
EOF
git commit -F /tmp/moi-commit-9.txt
```

---

## Self-review

### 스펙 커버리지

| 스펙 조항 | 요구 | Task |
|---|---|---|
| §2.3 서명 `disengage(by) → 'released' \| 'not-engaged'` | 그대로 | 5 |
| §2.3 순서: 파일 삭제 → 메모리 → `warn` `kill-switch.released`(source·by·reason) | 파일 먼저인 근거 포함 | 5 (파일은 1) |
| §2.3 자동 트립도 푼다, `loss-limit` 은 다음 cycle 재걸림 | 단위 + 배선 테스트 | 5, 7 |
| §2.3 스윕 없음, `halted` 결정 부활 없음 | "does not sweep when it releases" | 5 |
| §2.3 `observeOperatorFile` 은 그대로, 파일↔Discord 교차 | "can be engaged again after a release" | 5 |
| §2.4 `strategy-pauses.json` 형태 `{[name]: {pausedAt, by, reason}}`, 원자 교체 | `JsonCell` 위 | 2, 6 |
| §2.4 `pause`·`resume`·`isPaused`·`snapshot` | + `announceRestored` | 6 |
| §2.4 `permits(kind, strategyName)` = 킬 스위치 AND pause, `cancel` 항상 허용 | `createSubmissionBarrier` | 6 |
| §2.4 pause 된 전략도 틱을 받는다, 결정은 `paused` 로 기록 | 게이트웨이 + 배선 | 3, 7 |
| §2.4 잔여 주문 건드리지 않음 | pause 는 스윕하지 않는다(코드에 스윕 경로 없음), `cancel` 통과 테스트 | 6 |
| §2.4 재시작 복원 + `info` 한 번 | `announceRestored` | 6, 7 |
| §4 킬 스위치 스펙 §2.1 개정 주석 | → 새 스펙 §2.3 | 8 |
| §4 운영 스펙 §16 행 1개(번호 리드 배정 = 16.58) | 4칸 형식 | 8, 9 |
| §5 `kill-switch.test.ts`: 파일 먼저, 보고, `not-engaged`, loss-limit 재걸림, 삭제 실패 시 메모리 유지 | 5건 + 2건 | 5, 7 |
| §5 `strategy-pauses.test.ts`: 영속·복원·`permits` 결합 | 9건 | 6 |
| §5 `reporter-korean` 누락 검사 | 문장 5개 표 등재 + 템플릿 단언 | 4 |
| §5 변이 검사 관행 | 12건 목록 + 실측 기록 | 9 |
| §7 항목 1 = "내부 API 와 테스트만" | Discord 코드·설정·시크릿 없음 | — |

**이 단계 밖으로 남긴 것**: `sweep()` 공개(3단계 `cancel-all`), `runner.json` 의 `discord` 섹션과 `DISCORD_BOT_TOKEN`·마스킹·live-guard·계약 체커(3단계), `README.md`·`deployment.md`·런북(4단계). `apps/strategy-runner/README.md` 의 킬 스위치 절은 "해제는 파일 삭제 + 재시작" 을 아직 말한다 — 4단계 문서 작업에서 Discord 경로와 함께 갱신한다(3단계까지는 명령이 없으므로 README 가 거짓이 아니다).

### 타입 일관성

- `barrier` 는 세 곳에서 같은 서명이다: `OrderGatewayOptions.barrier`(선택), `OrderGateway.#barrier`(필수, 기본 `() => true`), `createSubmissionBarrier` 의 반환. 인자는 `(kind: DecisionKind, strategy: string)`, 반환은 `BarrierVerdict = boolean | 'paused'`.
- 기존 호출자(`order-gateway.test.ts` 의 `(kind) => …` 9건, 백테스트의 미지정)는 인자 수가 적거나 `boolean` 을 돌려주므로 대입 가능하다 — 타입 확장이지 파괴적 변경이 아니다.
- `SubmitResult.outcome`(`'accepted' | 'rejected' | 'pending' | 'halted' | 'paused'`)은 `SubmissionOutcome`(`'pending'` 없음)의 상위집합이다. 기존 관계 그대로 — `pending` 은 정산이 아니므로 레코드가 되지 않는다.
- `SubmissionOutcome` 를 소진하는 `switch` 는 저장소에 없다(확인: `grep -rn "outcome ===" apps packages` → `state-store.ts` 의 `neverSent`, `backtest/engine.ts` 의 `'rejected'` 비교, 시뮬레이터의 자체 유니온). 두 곳 모두 새 값을 안전하게 무시하거나 Task 2 에서 함께 넓힌다.
- `Pick<KillSwitch, 'permits'>`·`Pick<StrategyPauses, 'isPaused'>` 로 받으므로 배선의 `{ permits: (kind) => … }` 리터럴이 그대로 맞고, 백테스트는 아무것도 넘기지 않는다.
- `StrategyPauseMap` 은 `Readonly<Record<string, StrategyPause>>` — `exactOptionalPropertyTypes` 아래 인덱스 접근은 `StrategyPause | undefined` 이므로 `isPaused` 는 `!== undefined` 로 비교한다.
- `disengage` 는 `async` 이면서 `await` 이 없다. Biome recommended 에 `useAwait` 는 없고 저장소에도 선례가 있다(`runner/reporter-wiring.ts:70` 의 `close: async () => {}`). `pnpm check` 가 그럼에도 물면 `async` 를 떼고 `Promise.resolve(…)` 를 돌려준다 — 스펙이 고정한 것은 반환 **타입**이다.

### 플레이스홀더 스캔

이 계획에는 `TODO`·`TBD`·"Task N 과 비슷하게"·`.skip`·`.only`·빈 테스트 본문이 없다. 모든 Step 1 은 실제 테스트 코드, 모든 Step 3 은 실제 구현 코드, 모든 Step 2/4 는 실제 명령과 기대 실패·통과 문장을 담는다. Task 8 만 테스트가 없고(문서), 그 자리에는 실행 가능한 확인 `grep` 두 줄과 `pnpm check` 가 들어간다. Task 9 Step 4 는 §16.58 의 증거 칸을 **실측값으로 갈아 넣으라**는 지시이며, 그 전까지 표에 들어가는 "변이 8건" 문장은 Task 9 를 돌리기 전의 초안이다 — Task 9 를 건너뛰면 그 숫자가 거짓이 되므로, Task 9 는 선택이 아니다.
