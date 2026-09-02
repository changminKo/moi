# Strategy Runner Kill Switch (phase D core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 러너 전역 킬 스위치 — 네 트립 소스가 하나의 영속 래치를 내리고, 래치는 `OrderGateway.submit()` 의 place 를 `halted` 로 정산하며, 미체결 주문을 게이트웨이 경로로 스윕 취소하고, 러너는 살아서 지켜본다.

**Architecture:** 새 `KillSwitch` 클래스(`runner/kill-switch.ts`)가 래치 상태·`kill-switch.json` 영속·멱등 `engage`·취소 스윕을 소유한다. `OrderGateway` 는 `barrier(kind)` 콜백과 in-flight 카운터·연속 실패 카운터를 얻고, `RiskGate` 는 결정 없이 묻는 `lossLimitBreach()` 를, `FillProcessor` 는 wedge 시 `engage('fill-wedge')` 를 얻는다. `RunnerSupervisor` 가 넷을 배선하고 래치 상태의 cycle 에서 호스트에 틱을 주지 않는다.

**Tech Stack:** TypeScript strict(`exactOptionalPropertyTypes`), vitest, Node 24 `node:fs`, Testcontainers(paper-api 통합 테스트). pnpm 은 이 워크스페이스에서 `source ~/.nvm/nvm.sh && nvm use && corepack pnpm`.

**Spec:** `docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md` (상위: `2026-08-30-moi-strategy-runner-design.md` §6·§7.2).

## Global Constraints

- 러너는 `@moi/strategy-sdk`·`@moi/trading-core` 에만 의존한다(`package-surface.test.ts` 가 고정). 새 의존성 없음.
- 금전은 `moneyDecimal`/`assertExactMoney`, 절대 JS `number` 아님(AGENTS.md 규칙 5).
- 보고 라인에 서버 메시지·비밀을 넣지 않는다 — 코드(`code`)와 우리가 만든 문장만(§7.3). 리포터가 마스킹하지만 애초에 넣지 않는다.
- 상수(설정 아님): `KILL_SWITCH_AFTER_FAILED_ATTEMPTS = 10`, `MAX_SWEEP_PASSES = 5`, `HEARTBEAT_MS = 1_800_000`, 파일명 `kill-switch.json`.
- 배리어는 **한 곳**, `OrderGateway.submit()`. 호스트·리스크 게이트에 두 번째 게이트를 두지 않는다.
- 래치 기록(파일 쓰기)이 `engage` 의 첫 durable 행위다. 보고·스윕은 그 뒤.
- 전이에서만 보고: 첫 `engage` 만 `error`, 이후 호출은 조용. heartbeat 는 별도 `warn`.
- 커밋 메시지는 한국어 conventional commit(`feat(strategy-runner): …`), 작성자 `changminKo <rhckdals123@gmail.com>`. 각 태스크 끝에 커밋.
- 게이트 실행은 `set -o pipefail` 로 잇는다. 테스트는 `corepack pnpm --filter @moi/strategy-runner exec vitest run <file>` 로 파일 단위.
- 모든 파일의 주석은 기존 파일과 같은 문체(영어, "왜"를 적는 설명문). 코드 식별자는 영어.

---

## File Structure

| 파일 | 역할 | 변경 |
|---|---|---|
| `apps/strategy-runner/src/state/state-store.ts` | `SubmissionOutcome` 에 `'halted'`, `killSwitch` 셀 | Modify |
| `apps/strategy-runner/src/state/state-store.test.ts` | halted 정산 테스트 | Modify |
| `apps/strategy-runner/src/gateway/order-gateway.ts` | `barrier`·`onExhausted` 옵션, in-flight/`idle()`, 연속 실패 카운터, `record()` 의 `tick: Tick \| null` | Modify |
| `apps/strategy-runner/src/gateway/order-gateway.test.ts` | 배리어·idle·exhausted 테스트 | Modify |
| `apps/strategy-runner/src/risk/risk-gate.ts` | `lossLimitBreach()`; `evaluate()` 가 재사용 | Modify |
| `apps/strategy-runner/src/risk/risk-gate.test.ts` | `lossLimitBreach` 테스트 | Modify |
| `apps/strategy-runner/src/runner/kill-switch.ts` | **새 파일**: `KillSwitch`, 상수, 타입 | Create |
| `apps/strategy-runner/src/runner/kill-switch.test.ts` | **새 파일** | Create |
| `apps/strategy-runner/src/fills/fill-processor.ts` | wedge → `engage('fill-wedge')` + 재throw | Modify |
| `apps/strategy-runner/src/fills/fill-processor.test.ts` | 세 모양 각각 engage 단언 | Modify |
| `apps/strategy-runner/src/runner/supervisor.ts` | 배선, `start()` 의 `resume()`, 래치 cycle | Modify |
| `apps/strategy-runner/src/runner/supervisor.test.ts` | 운영자 파일·손실 한도·래치 cycle 테스트 | Modify |
| `apps/strategy-runner/src/index.ts` | `KillSwitch`·상수 export | Modify |
| `apps/paper-api/src/runtime/strategy-runner-kill-switch.integration.test.ts` | **새 파일**: 통합 완료 기준 | Create |
| `apps/strategy-runner/README.md` | 상태 파일 표, quarantine 표, 운영 절차, D 행 | Modify |
| `docs/superpowers/specs/2026-08-27-…-design.md` | §16.48 | Modify |
| `docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md` | `resume()` 재스윕 한 줄 보강 | Modify |

---

### Task 1: `halted` 는 정산이다 (`StateStore`)

**Files:**
- Modify: `apps/strategy-runner/src/state/state-store.ts:97-108` (`SubmissionOutcome`, `SubmissionRecord`), `:166-172` (`readSubmissionRecord`), `:50-56` 상수, `:230-236` 셀 선언
- Test: `apps/strategy-runner/src/state/state-store.test.ts`

**Interfaces:**
- Produces: `type SubmissionOutcome = 'accepted' | 'rejected' | 'halted'`; `StateStore.killSwitch: JsonCell` (파일 `kill-switch.json`, 기본 모드); `export const KILL_SWITCH_FILE = 'kill-switch.json'`.

- [ ] **Step 1: 실패하는 테스트 — halted 는 settled, reopen 뒤에도**

`state-store.test.ts` 의 `describe('StateStore decisions', …)` 안, `'treats a rejection as settled'` 뒤에 추가:

```ts
  /**
   * The kill switch's verdict. A decision the barrier refused is finished: the
   * operator who clears the latch and restarts must not have yesterday's entry
   * resubmitted at them. So it settles, and it survives a reopen as settled.
   */
  it('treats a halted submission as settled, across a reopen', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendDecision(decision('d-1'));
    first.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'halted',
      code: 'KILL_SWITCH',
    });

    expect(first.pendingDecisions()).toStrictEqual([]);

    first.close();

    expect(store(directory).pendingDecisions()).toStrictEqual([]);
  });

  it('exposes the kill-switch cell at a fixed name in the state directory', () => {
    const directory = scratch();

    expect(store(directory).killSwitch.path).toBe(
      join(directory, 'kill-switch.json'),
    );
  });
```

- [ ] **Step 2: 실패 확인**

Run: `cd apps/strategy-runner && corepack pnpm exec vitest run src/state/state-store.test.ts -t "halted|kill-switch cell"`
Expected: 첫 테스트는 타입 에러 또는 `a submission record must be accepted or rejected` 로 FAIL(reopen 시 `readSubmissionRecord` 가 던진다). 둘째는 `killSwitch` undefined 로 FAIL.

- [ ] **Step 3: 구현**

`state-store.ts`:

```ts
const KILL_SWITCH = 'kill-switch.json';
/** The latch file's name, exported so an operator document and a test agree on it. */
export const KILL_SWITCH_FILE = KILL_SWITCH;
```

```ts
/**
 * `halted` is the kill switch's outcome (phase D): the barrier refused to submit
 * a decision that was already on disk. It settles the decision — see
 * `pendingDecisions` — because a decision the kill switch caught is a dead
 * decision, not a deferred one.
 */
export type SubmissionOutcome = 'accepted' | 'rejected' | 'halted';
```

`readSubmissionRecord`:

```ts
  if (outcome !== 'accepted' && outcome !== 'rejected' && outcome !== 'halted') {
    invalid(`${where} must be accepted, rejected or halted`);
  }
```

클래스 필드와 생성자:

```ts
  readonly session: JsonCell;
  readonly runtime: JsonCell;
  /**
   * The kill switch's latch (phase D). Present means engaged; absent means not.
   * An operator clears it by deleting the file and restarting — so it is a
   * cell, not a log line: there is no history to keep, only a current fact.
   */
  readonly killSwitch: JsonCell;
```

```ts
    this.runtime = new JsonCell(join(directory, RUNTIME));
    this.killSwitch = new JsonCell(join(directory, KILL_SWITCH));
```

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm exec vitest run src/state/state-store.test.ts`
Expected: PASS(전부).

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/state/state-store.ts apps/strategy-runner/src/state/state-store.test.ts
git commit -m "feat(strategy-runner): 제출 결과에 halted 를 더하고 킬 스위치 셀을 상태 저장소에 둔다

킬 스위치가 잡은 결정은 죽은 결정이다 — pending 으로 남기면 사람이 래치를 풀고 재시작한 순간
recoverPending 이 어제의 진입을 낸다. 그래서 halted 는 정산이고, 재오픈 뒤에도 정산이다."
```

---

### Task 2: 게이트웨이의 배리어, in-flight, 연속 실패 (`OrderGateway`)

**Files:**
- Modify: `apps/strategy-runner/src/gateway/order-gateway.ts`
- Test: `apps/strategy-runner/src/gateway/order-gateway.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `'halted'`.
- Produces:
  ```ts
  export const KILL_SWITCH_AFTER_FAILED_ATTEMPTS = 10;
  export interface ExhaustedSubmissions { readonly code: string; readonly consecutiveFailures: number; }
  interface OrderGatewayOptions { …; readonly barrier?: (kind: DecisionKind) => boolean; readonly onExhausted?: (failure: ExhaustedSubmissions) => void; }
  interface SubmitResult { readonly outcome: 'accepted' | 'rejected' | 'pending' | 'halted'; … }
  record(strategy, decision, tick: Tick | null, options?): DecisionRecord | null   // cancel 은 tick 없이
  idle(): Promise<void>
  ```

- [ ] **Step 1: 실패하는 테스트 다섯 개**

`order-gateway.test.ts` 의 `harness()` 옵션에 `barrier`·`onExhausted` 를 통과시키도록 고친다:

```ts
function harness(
  options: {
    readonly answers?: readonly (BrokerOrder | Error)[];
    readonly directory?: string;
    readonly maxAttempts?: number;
    readonly barrier?: (kind: 'place' | 'cancel') => boolean;
    readonly onExhausted?: (failure: {
      readonly code: string;
      readonly consecutiveFailures: number;
    }) => void;
  } = {},
) {
```

그리고 `new OrderGateway({ … })` 안에:

```ts
      ...(options.barrier === undefined ? {} : { barrier: options.barrier }),
      ...(options.onExhausted === undefined
        ? {}
        : { onExhausted: options.onExhausted }),
```

파일 끝에 새 `describe`:

```ts
/**
 * Phase D's submission barrier (design §6, §7.2; kill-switch design §2.2). The
 * gateway does not know *why* the barrier is down — that is the kill switch's
 * business — only that a `place` may not go out and a `cancel` may.
 */
describe('OrderGateway under the kill switch barrier', () => {
  const CANCEL = Object.freeze({
    kind: 'cancel',
    reason: 'kill switch',
    orderId: 'o-9',
  } as const);

  it('settles a place as halted instead of submitting it', async () => {
    const { broker, gateway, state, reporter } = harness({
      barrier: (kind) => kind === 'cancel',
    });

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toStrictEqual({
      decisionId: 'd-1',
      outcome: 'halted',
    });
    expect(broker.calls).toStrictEqual([]);
    expect(state.pendingDecisions()).toStrictEqual([]);
    expect(reporter.lines.at(-1)).toMatch(
      /\[warn\] the place was halted by the kill switch .*code=KILL_SWITCH/u,
    );
  });

  it('lets a cancel through the same barrier', async () => {
    const { broker, gateway } = harness({
      answers: [{ id: 'o-9', status: 'CANCELLED' } as BrokerOrder],
      barrier: (kind) => kind === 'cancel',
    });
    const record = gateway.record('kill-switch', CANCEL, null, {
      decisionId: 'kill:2026-09-02T02:00:00.000Z:o-9',
    });

    await expect(gateway.submit(record as NonNullable<typeof record>)).resolves
      .toMatchObject({ outcome: 'accepted', orderId: 'o-9' });
    expect(broker.calls[0]?.kind).toBe('cancel');
  });

  /**
   * The barrier is asked before *every* attempt, not once at the door. A trip
   * that lands during a retry backoff — a fill wedge on the other chain, say —
   * must stop the next attempt; the one already sent cannot be unsent, and the
   * sweep is what catches that.
   */
  it('stops retrying when the barrier comes down between attempts', async () => {
    let down = false;
    const { broker, gateway } = harness({
      answers: [
        new DomainError('SERVICE_UNAVAILABLE', 'try later'),
      ],
      barrier: () => !down,
      maxAttempts: 4,
    });
    const originalPlace = broker.placeOrder.bind(broker);

    broker.placeOrder = async (command) => {
      down = true;

      return originalPlace(command);
    };

    await expect(gateway.place('samsung', BUY, TICK)).resolves.toMatchObject({
      outcome: 'halted',
    });
    expect(broker.calls).toHaveLength(1);
  });

  it('resolves idle() only after every in-flight submission has settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { broker, gateway } = harness();
    const originalPlace = broker.placeOrder.bind(broker);

    broker.placeOrder = async (command) => {
      await gate;

      return originalPlace(command);
    };

    const placing = gateway.place('samsung', BUY, TICK);
    let idle = false;
    const waiting = gateway.idle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);

    release();
    await placing;
    await waiting;
    expect(idle).toBe(true);
    // Nothing in flight: resolves at once.
    await expect(gateway.idle()).resolves.toBeUndefined();
  });

  /**
   * Design §7.2: "10회 실패 시 킬 스위치". Counted per failed *attempt* across
   * decisions, reset by a success, and a rejection is a verdict rather than a
   * failure so it neither counts nor resets. The callback fires once, on the
   * crossing.
   */
  it('reports exhaustion once after ten failed attempts in a row', async () => {
    const exhausted: { code: string; consecutiveFailures: number }[] = [];
    const fault = new DomainError('SERVICE_UNAVAILABLE', 'down');
    const { gateway } = harness({
      answers: [fault],
      maxAttempts: 4,
      onExhausted: (failure) => exhausted.push(failure),
    });

    await gateway.place('samsung', BUY, TICK); // attempts 1-4
    await gateway.place('samsung', BUY, TICK); // 5-8
    expect(exhausted).toStrictEqual([]);
    await gateway.place('samsung', BUY, TICK); // 9-12: fires at 10
    expect(exhausted).toStrictEqual([
      { code: 'SERVICE_UNAVAILABLE', consecutiveFailures: 10 },
    ]);
  });

  it('resets the failure run on a success and ignores rejections', async () => {
    const exhausted: unknown[] = [];
    const fault = new DomainError('SERVICE_UNAVAILABLE', 'down');
    const { gateway, broker } = harness({
      answers: [fault],
      maxAttempts: 9,
      onExhausted: (failure) => exhausted.push(failure),
    });

    await gateway.place('samsung', BUY, TICK); // 9 failures
    broker.placeOrder = async () => ({ id: 'o-1', status: 'OPEN' }) as BrokerOrder;
    await gateway.place('samsung', BUY, TICK); // success: back to 0
    broker.placeOrder = async () => {
      throw new DomainError('INVALID_ORDER', 'no');
    };
    await gateway.place('samsung', BUY, TICK); // rejection: not counted
    broker.placeOrder = async () => {
      throw fault;
    };
    await gateway.place('samsung', BUY, TICK); // 9 more, still under 10

    expect(exhausted).toStrictEqual([]);
  });
});
```

주의: `DomainError.retryable` 은 **코드로** 정해진다(`retryabilityByCode`) — `SERVICE_UNAVAILABLE`·`RATE_LIMITED` 는 재시도 가능, `INVALID_ORDER` 는 불가. 생성자에 `retryable` 옵션은 없다.

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm exec vitest run src/gateway/order-gateway.test.ts -t "kill switch barrier"`
Expected: 여섯 개 전부 FAIL(`barrier` 옵션 무시 → 제출됨, `idle` 없음, `onExhausted` 호출 없음).

- [ ] **Step 3: 구현**

`order-gateway.ts` 상단 상수·타입:

```ts
export const MAX_SUBMIT_ATTEMPTS = 4;
/**
 * Design §7.2: "10회 실패 시 킬 스위치". Failed *attempts*, across decisions,
 * in a row — a success resets the run and a rejection (a verdict, not a fault)
 * leaves it alone. Two and a half decisions at `MAX_SUBMIT_ATTEMPTS`, which is
 * the reading closest to the sentence. A constant, not configuration.
 */
export const KILL_SWITCH_AFTER_FAILED_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 200;

export interface ExhaustedSubmissions {
  readonly code: string;
  readonly consecutiveFailures: number;
}
```

`OrderGatewayOptions` 에:

```ts
  /**
   * Phase D's submission barrier. Asked before every attempt with the kind of
   * decision about to go out; `false` settles the decision as `halted`. The
   * default lets everything through, which is what the backtest and every
   * pre-D caller want. The gateway does not know why the barrier is down.
   */
  readonly barrier?: (kind: DecisionKind) => boolean;
  /** Fires once, on the attempt that makes the run of failures reach the limit. */
  readonly onExhausted?: (failure: ExhaustedSubmissions) => void;
```

`SubmitResult.outcome` 에 `'halted'` 추가. 클래스 필드:

```ts
  readonly #barrier: (kind: DecisionKind) => boolean;
  readonly #onExhausted: ((failure: ExhaustedSubmissions) => void) | undefined;
  #consecutiveFailures = 0;
  #inFlight = 0;
  readonly #idleWaiters: (() => void)[] = [];
```

생성자에 `this.#barrier = options.barrier ?? (() => true); this.#onExhausted = options.onExhausted;`.

`record()` 시그니처와 place 분기:

```ts
  record(
    strategy: string,
    decision: StrategyDecision,
    tick: Tick | null,
    options: { readonly decisionId?: string } = {},
  ): DecisionRecord | null {
```

```ts
    if (decision.kind === 'place' && tick === null) {
      // A cancel names an order and needs no price; a place is measured through
      // `notionalOf` and does. The kill switch's sweep is the caller that has
      // no tick, and it only ever cancels.
      throw new DomainError(
        'INVARIANT_VIOLATION',
        'a place decision cannot be recorded without a tick to price it',
      );
    }
```

그리고 `notional: notionalOf(decision.intent, tick as Tick)`.

`submit()` 을 둘로 나눈다 — 바깥은 in-flight 장부, 안쪽이 기존 루프:

```ts
  /** Steps 2 to 4, for a decision that is already on disk. */
  async submit(record: DecisionRecord): Promise<SubmitResult> {
    this.#inFlight += 1;

    try {
      return await this.#submit(record);
    } finally {
      this.#inFlight -= 1;

      if (this.#inFlight === 0) {
        for (const wake of this.#idleWaiters.splice(0)) {
          wake();
        }
      }
    }
  }

  /**
   * Resolves once nothing is in flight. The kill switch's sweep waits on this
   * before it reads the portfolio, so an order that was mid-submission when the
   * latch came down is in the snapshot the sweep cancels from.
   */
  idle(): Promise<void> {
    if (this.#inFlight === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  async #submit(record: DecisionRecord): Promise<SubmitResult> {
    const idempotencyKey = deriveIdempotencyKey(record.decisionId);
    let reestablished = false;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      // Before *every* attempt: a trip during a backoff stops the next send.
      if (!this.#barrier(record.kind)) {
        return this.#halt(record);
      }

      try {
        const order = await this.#send(record, idempotencyKey);

        this.#consecutiveFailures = 0;
        … (기존 accepted 처리 그대로)
      } catch (error) {
        const failure = asDomainError(error);

        if (failure.code === 'SESSION_EXPIRED' && !reestablished) {
          … (그대로)
        }

        if (failure.retryable) {
          this.#noteFailure(failure.code);
        }

        if (!failure.retryable || attempt === this.#maxAttempts) {
          return this.#settleOrLeavePending(record, failure, attempt);
        }
        … (warn + sleep 그대로)
      }
    }
    … (unreachable throw 그대로)
  }

  #noteFailure(code: string): void {
    this.#consecutiveFailures += 1;

    if (this.#consecutiveFailures === KILL_SWITCH_AFTER_FAILED_ATTEMPTS) {
      this.#onExhausted?.({
        code,
        consecutiveFailures: this.#consecutiveFailures,
      });
    }
  }

  #halt(record: DecisionRecord): SubmitResult {
    this.#state.appendSubmission({
      decisionId: record.decisionId,
      at: new Date(this.#now()).toISOString(),
      outcome: 'halted',
      code: 'KILL_SWITCH',
    });
    this.#reporter.report('warn', `the ${record.kind} was halted by the kill switch`, {
      decisionId: record.decisionId,
      strategy: record.strategy,
      code: 'KILL_SWITCH',
      reason: record.reason,
    });

    return { decisionId: record.decisionId, outcome: 'halted' };
  }
```

파일 머리 docstring 의 "Phase B has no kill switch …" 단락을 phase D 기준으로 고쳐 쓴다: 배리어가 여기 있고, 소진은 `onExhausted` 로 에스컬레이션되며, `pending` 은 여전히 "재시도 소진 후 다음 시작이 재제출" 이라는 뜻이라고.

`#settleOrLeavePending` 의 "§7.1's escalation to the kill switch is phase D" 주석을 "the run of failures is counted in `#noteFailure`; escalation is the kill switch's, through `onExhausted`" 로.

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm exec vitest run src/gateway/order-gateway.test.ts src/fills/fill-processor.test.ts src/backtest`
Expected: PASS. (`record()` 시그니처 변경으로 `fill-processor.ts` 와 `backtest/engine.ts` 호출부는 이미 `Tick` 을 넘기므로 타입 그대로 맞는다. 컴파일: `corepack pnpm --filter @moi/strategy-runner typecheck`.)

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/gateway/order-gateway.ts apps/strategy-runner/src/gateway/order-gateway.test.ts
git commit -m "feat(strategy-runner): 게이트웨이에 제출 배리어·in-flight 대기·연속 실패 소진을 둔다

배리어는 매 attempt 전에 묻는다 — 백오프 중 내려온 래치가 다음 전송을 막는다. 막힌 place 는
halted 로 정산하고 cancel 은 통과시킨다(취소는 노출을 줄인다). idle() 은 스윕이 포트폴리오를
읽기 전에 기다릴 자리이고, 연속 실패 10회(설계 §7.2)는 onExhausted 로 한 번만 알린다."
```

---

### Task 3: `RiskGate.lossLimitBreach()`

**Files:**
- Modify: `apps/strategy-runner/src/risk/risk-gate.ts:237-259` (evaluate 의 두 손실 블록)
- Test: `apps/strategy-runner/src/risk/risk-gate.test.ts` (`describe('RiskGate loss limits')` 안)

**Interfaces:**
- Produces: `RiskGate.lossLimitBreach(): string | null` — 사유 문장(기존 `refuse` 문장과 동일) 또는 `null`.

- [ ] **Step 1: 실패하는 테스트**

`describe('RiskGate loss limits', …)` 끝에:

```ts
  /**
   * The same two folds, asked without a decision in hand. Phase D escalates a
   * tripped loss limit from "refuse entries" to the kill switch, and the
   * supervisor asks this once a cycle rather than waiting for the next BUY to
   * be refused.
   */
  describe('lossLimitBreach', () => {
    it('is null while both limits hold', () => {
      const { gate, state } = gateWith({ limits: { maxConsecutiveLosses: 3 } });

      losing(state, 1, '-100');
      losing(state, 2, '-100');

      expect(gate.lossLimitBreach()).toBeNull();
    });

    it('names the run of losses at the limit', () => {
      const { gate, state } = gateWith({ limits: { maxConsecutiveLosses: 3 } });

      losing(state, 1, '-100');
      losing(state, 2, '-100');
      losing(state, 3, '-100');

      expect(gate.lossLimitBreach()).toBe(
        '3 closing fills in a row lost, at the limit of 3',
      );
    });

    it('names the daily loss at the limit, on the boundary', () => {
      const { gate, state } = gateWith({
        limits: { maxConsecutiveLosses: 100, maxDailyLoss: '200' },
      });

      losing(state, 1, '-200', '2026-09-02T01:00:00.000Z');

      expect(gate.lossLimitBreach()).toBe(
        'today has realised -200, at the daily loss limit of 200',
      );
    });

    it('does not count a profitable day against the daily loss limit', () => {
      const { gate, state } = gateWith({
        limits: { maxConsecutiveLosses: 100, maxDailyLoss: '200' },
      });

      losing(state, 1, '900');

      expect(gate.lossLimitBreach()).toBeNull();
    });
  });
```

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm exec vitest run src/risk/risk-gate.test.ts -t lossLimitBreach`
Expected: FAIL — `gate.lossLimitBreach is not a function`.

- [ ] **Step 3: 구현** — evaluate 의 두 블록을 메서드로 뽑고 evaluate 는 그것을 부른다:

```ts
    const breach = this.lossLimitBreach();

    if (breach !== null) {
      return refuse(breach);
    }
```

```ts
  /**
   * §6.4's two loss limits, asked as a question rather than as a verdict on an
   * order. `evaluate` refuses a BUY on the same answer; phase D's supervisor
   * asks it once a cycle and hands a non-null answer to the kill switch (design
   * §6: both limits are "킬 스위치", not merely "거부"). One reading, two callers.
   */
  lossLimitBreach(): string | null {
    const losses = this.#state.fills.consecutiveLosses();

    if (losses >= this.#limits.maxConsecutiveLosses) {
      return `${losses} closing fills in a row lost, at the limit of ${this.#limits.maxConsecutiveLosses}`;
    }

    const realizedToday = moneyDecimal(
      this.#state.fills.realizedPnlOn(
        utcDay(new Date(this.#now()).toISOString()),
      ),
    );

    // Only a *loss* trips it. A day up on the session is not a day to stop
    // trading, and comparing a signed PnL against a positive limit directly
    // would refuse every entry on a profitable day.
    if (
      realizedToday.isNegative() &&
      realizedToday.abs().gte(this.#limits.maxDailyLoss)
    ) {
      return `today has realised ${realizedToday.toString()}, at the daily loss limit of ${this.#limits.maxDailyLoss}`;
    }

    return null;
  }
```

파일 머리의 "## What a tripped loss limit does, and what it does not do yet" 단락을 갱신: 거부는 그대로, 격상은 `lossLimitBreach` 를 통해 킬 스위치가 한다.

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm exec vitest run src/risk/risk-gate.test.ts`
Expected: PASS(기존 손실 한도 거부 테스트 포함).

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/risk/risk-gate.ts apps/strategy-runner/src/risk/risk-gate.test.ts
git commit -m "feat(strategy-runner): 손실 한도를 결정 없이 묻는 lossLimitBreach 를 리스크 게이트에 둔다

evaluate 의 BUY 거부와 같은 fold 를 읽는다. phase D 의 supervisor 가 cycle 마다 물어 킬 스위치로
격상한다(설계 §6 의 두 한도는 거부가 아니라 킬 스위치다)."
```

---

### Task 4: `KillSwitch`

**Files:**
- Create: `apps/strategy-runner/src/runner/kill-switch.ts`
- Create: `apps/strategy-runner/src/runner/kill-switch.test.ts`

**Interfaces:**
- Consumes: Task 1 `StateStore.killSwitch`(`JsonCell`), Task 2 `OrderGateway.idle/record/submit`, `isOpenOrder`(`risk-gate.ts`).
- Produces:
  ```ts
  export const MAX_SWEEP_PASSES = 5;
  export const HEARTBEAT_MS = 1_800_000;
  export type KillSwitchSource = 'loss-limit' | 'submission-failures' | 'fill-wedge' | 'operator';
  export interface Engagement { readonly engagedAt: string; readonly source: KillSwitchSource; readonly reason: string; }
  export interface KillSwitchTrigger { engage(source: KillSwitchSource, reason: string, fields?: ReportFields): Promise<void>; }
  export interface KillSwitchOptions {
    readonly cell: JsonCell;
    readonly gateway: Pick<OrderGateway, 'idle' | 'record' | 'submit'>;
    readonly portfolio: () => Promise<BrokerPortfolio>;
    readonly reporter: Reporter;
    readonly now?: () => number;
  }
  export class KillSwitch implements KillSwitchTrigger {
    get engaged(): boolean; get engagement(): Engagement | null;
    engage(source, reason, fields?): Promise<void>;
    permits(kind: DecisionKind): boolean;
    observeOperatorFile(): Promise<void>;
    resume(): Promise<void>;        // start() 에서: 걸려 있으면 보고 + 재스윕
    heartbeat(): void;
  }
  ```

- [ ] **Step 1: 실패하는 테스트**

`kill-switch.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerOrder, BrokerPortfolio } from '@moi/strategy-sdk';
import type { StrategyDecision, Tick } from '@moi/strategy-sdk/strategy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubmitResult } from '../gateway/order-gateway.js';
import { createRecordingReporter } from '../reporter.js';
import { JsonCell } from '../state/json-cell.js';
import type { DecisionRecord } from '../state/state-store.js';
import { HEARTBEAT_MS, KillSwitch, MAX_SWEEP_PASSES } from './kill-switch.js';

const ENGAGED_AT_MS = Date.parse('2026-09-02T02:00:00.000Z');

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'moi-kill-switch-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const order = (id: string, status = 'OPEN') =>
  ({
    id,
    market: 'KR',
    symbol: '005930',
    type: 'LIMIT',
    side: 'BUY',
    quantity: '1',
    filledQuantity: '0',
    status,
    fills: [],
    siblingOrderIds: [],
  }) as unknown as BrokerPortfolio['activeOrders'][number];

const portfolioOf = (orders: readonly BrokerPortfolio['activeOrders'][number][]) =>
  ({
    sessionId: 's-1',
    wallets: [],
    positions: [],
    activeOrders: orders,
    accountSequence: '1',
  }) as unknown as BrokerPortfolio;

/**
 * A gateway that records what the sweep asked of it. `idle` resolves when the
 * test says so, which is how the ordering "wait, then read" is observed.
 */
function fakeGateway(options: { readonly idle?: Promise<void> } = {}) {
  const recorded: DecisionRecord[] = [];
  const submitted: string[] = [];

  return {
    recorded,
    submitted,
    idle: () => options.idle ?? Promise.resolve(),
    record: (
      strategy: string,
      decision: StrategyDecision,
      _tick: Tick | null,
      recordOptions: { readonly decisionId?: string } = {},
    ): DecisionRecord | null => {
      if (decision.kind !== 'cancel') {
        throw new Error('the sweep only cancels');
      }

      const record: DecisionRecord = {
        decisionId: recordOptions.decisionId ?? 'unexpected',
        at: new Date(ENGAGED_AT_MS).toISOString(),
        strategy,
        kind: 'cancel',
        reason: decision.reason,
        orderId: decision.orderId,
      };

      recorded.push(record);

      return record;
    },
    submit: async (record: DecisionRecord): Promise<SubmitResult> => {
      submitted.push(record.decisionId);

      return { decisionId: record.decisionId, outcome: 'accepted', orderId: record.orderId as string };
    },
  };
}

function build(options: {
  readonly portfolios?: readonly BrokerPortfolio[];
  readonly gateway?: ReturnType<typeof fakeGateway>;
  readonly nowMs?: () => number;
} = {}) {
  const reporter = createRecordingReporter();
  const gateway = options.gateway ?? fakeGateway();
  const snapshots = [...(options.portfolios ?? [portfolioOf([])])];
  let reads = 0;
  const killSwitch = new KillSwitch({
    cell: new JsonCell(join(directory, 'kill-switch.json')),
    gateway,
    portfolio: async () => {
      reads += 1;

      return snapshots.length > 1 ? (snapshots.shift() as BrokerPortfolio) : (snapshots[0] as BrokerPortfolio);
    },
    reporter,
    now: options.nowMs ?? (() => ENGAGED_AT_MS),
  });

  return { killSwitch, gateway, reporter, reads: () => reads };
}

const latch = () =>
  JSON.parse(readFileSync(join(directory, 'kill-switch.json'), 'utf8')) as Record<string, unknown>;

describe('KillSwitch engagement', () => {
  it('starts disengaged and permits everything', () => {
    const { killSwitch } = build();

    expect(killSwitch.engaged).toBe(false);
    expect(killSwitch.permits('place')).toBe(true);
    expect(killSwitch.permits('cancel')).toBe(true);
  });

  it('writes the latch, reports once, and then refuses places but not cancels', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.engage('operator', 'drill', { by: 'test' });

    expect(latch()).toStrictEqual({
      engagedAt: '2026-09-02T02:00:00.000Z',
      source: 'operator',
      reason: 'drill',
    });
    expect(killSwitch.permits('place')).toBe(false);
    expect(killSwitch.permits('cancel')).toBe(true);
    expect(
      reporter.lines.filter((line) => line.includes('the kill switch is engaged')),
    ).toStrictEqual([
      '[error] the kill switch is engaged; new orders are refused and resting orders are being cancelled source=operator reason=drill by=test',
    ]);
  });

  it('is idempotent: a second engage neither rewrites nor re-reports', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.engage('operator', 'first');
    const before = reporter.lines.length;
    await killSwitch.engage('fill-wedge', 'second');

    expect(killSwitch.engagement?.reason).toBe('first');
    expect(reporter.lines.length).toBe(before);
  });

  it('comes up engaged when the latch file already exists', () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ engagedAt: '2026-09-01T00:00:00.000Z', source: 'loss-limit', reason: 'x' }),
    );

    const { killSwitch } = build();

    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.engagement).toStrictEqual({
      engagedAt: '2026-09-01T00:00:00.000Z',
      source: 'loss-limit',
      reason: 'x',
    });
  });
});

describe('KillSwitch operator file', () => {
  it('engages on the next observation when an operator writes the file', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.observeOperatorFile();
    expect(killSwitch.engaged).toBe(false);

    writeFileSync(join(directory, 'kill-switch.json'), JSON.stringify({ reason: 'manual stop' }));
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engaged).toBe(true);
    expect(killSwitch.engagement).toMatchObject({ source: 'operator', reason: 'manual stop' });
    expect(latch()).toMatchObject({ source: 'operator', reason: 'manual stop', engagedAt: '2026-09-02T02:00:00.000Z' });
    expect(reporter.lines.join('\n')).toContain('source=operator reason=manual stop');
  });

  /** Fail closed: a kill-switch file the runner cannot read is still a kill-switch file. */
  it('engages on an unreadable or reason-less operator file', async () => {
    const { killSwitch } = build();

    writeFileSync(join(directory, 'kill-switch.json'), 'not json');
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engagement).toMatchObject({ source: 'operator', reason: 'operator file present' });

    rmSync(join(directory, 'kill-switch.json'));
    const second = build();

    writeFileSync(join(directory, 'kill-switch.json'), '{}');
    await second.killSwitch.observeOperatorFile();

    expect(second.killSwitch.engagement).toMatchObject({ source: 'operator', reason: 'operator file present' });
  });

  it('stays engaged even if the file disappears while running', async () => {
    const { killSwitch } = build();

    await killSwitch.engage('operator', 'drill');
    rmSync(join(directory, 'kill-switch.json'));
    await killSwitch.observeOperatorFile();

    expect(killSwitch.engaged).toBe(true);
  });
});

describe('KillSwitch cancel sweep', () => {
  it('waits for in-flight submissions before reading the portfolio', async () => {
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = fakeGateway({ idle });
    const { killSwitch, reads } = build({ gateway, portfolios: [portfolioOf([])] });

    const engaging = killSwitch.engage('operator', 'drill');

    await Promise.resolve();
    expect(reads()).toBe(0);

    release();
    await engaging;
    expect(reads()).toBe(1);
  });

  it('cancels every open order through the gateway with a deterministic decision id', async () => {
    const gateway = fakeGateway();
    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [
        portfolioOf([order('o-1'), order('o-2', 'FILLED'), order('o-3', 'PARTIALLY_FILLED')]),
        portfolioOf([order('o-2', 'FILLED')]),
      ],
    });

    await killSwitch.engage('loss-limit', '3 closing fills in a row lost, at the limit of 3');

    expect(gateway.recorded.map((each) => [each.decisionId, each.strategy, each.orderId])).toStrictEqual([
      ['kill:2026-09-02T02:00:00.000Z:o-1', 'kill-switch', 'o-1'],
      ['kill:2026-09-02T02:00:00.000Z:o-3', 'kill-switch', 'o-3'],
    ]);
    expect(gateway.submitted).toStrictEqual([
      'kill:2026-09-02T02:00:00.000Z:o-1',
      'kill:2026-09-02T02:00:00.000Z:o-3',
    ]);
    expect(reporter.lines.at(-1)).toMatch(/\[info\] the cancel sweep found no resting orders .*passes=1/u);
  });

  it('rescans, so an order that appeared after the first pass is cancelled too', async () => {
    const gateway = fakeGateway();
    const { killSwitch } = build({
      gateway,
      portfolios: [portfolioOf([order('o-1')]), portfolioOf([order('o-9')]), portfolioOf([])],
    });

    await killSwitch.engage('operator', 'drill');

    expect(gateway.submitted).toStrictEqual([
      'kill:2026-09-02T02:00:00.000Z:o-1',
      'kill:2026-09-02T02:00:00.000Z:o-9',
    ]);
  });

  it('gives up after the last pass and names what is still resting', async () => {
    const gateway = fakeGateway();
    const { killSwitch, reporter } = build({
      gateway,
      portfolios: [portfolioOf([order('o-stuck')])],
    });

    await killSwitch.engage('operator', 'drill');

    expect(gateway.submitted).toHaveLength(MAX_SWEEP_PASSES);
    expect(reporter.lines.at(-1)).toBe(
      `[error] the cancel sweep left resting orders after its last pass passes=${MAX_SWEEP_PASSES} orderIds=o-stuck`,
    );
  });

  it('reports a sweep that throws instead of rejecting engage', async () => {
    const gateway = fakeGateway();

    gateway.submit = async () => {
      throw new Error('boom');
    };

    const { killSwitch, reporter } = build({ gateway, portfolios: [portfolioOf([order('o-1')])] });

    await expect(killSwitch.engage('operator', 'drill')).resolves.toBeUndefined();
    expect(killSwitch.engaged).toBe(true);
    expect(reporter.lines.at(-1)).toMatch(/\[error\] the cancel sweep failed .*error=boom/u);
  });
});

describe('KillSwitch resume and heartbeat', () => {
  it('resume() on a latched restart reports and sweeps again', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ engagedAt: '2026-09-01T00:00:00.000Z', source: 'operator', reason: 'x' }),
    );
    const gateway = fakeGateway();
    const { killSwitch, reporter } = build({ gateway, portfolios: [portfolioOf([order('o-1')]), portfolioOf([])] });

    await killSwitch.resume();

    expect(reporter.lines[0]).toBe(
      '[error] the kill switch is still engaged from a previous run; delete kill-switch.json and restart to resume trading source=operator reason=x engagedAt=2026-09-01T00:00:00.000Z',
    );
    expect(gateway.submitted).toStrictEqual(['kill:2026-09-01T00:00:00.000Z:o-1']);
  });

  it('resume() is silent when not engaged', async () => {
    const { killSwitch, reporter } = build();

    await killSwitch.resume();

    expect(reporter.lines).toStrictEqual([]);
  });

  it('heartbeats every HEARTBEAT_MS while engaged, and never otherwise', async () => {
    let at = ENGAGED_AT_MS;
    const { killSwitch, reporter } = build({ nowMs: () => at });

    killSwitch.heartbeat();
    expect(reporter.lines).toStrictEqual([]);

    await killSwitch.engage('operator', 'drill');
    const after = reporter.lines.length;

    at += HEARTBEAT_MS - 1;
    killSwitch.heartbeat();
    expect(reporter.lines.length).toBe(after);

    at += 1;
    killSwitch.heartbeat();
    expect(reporter.lines.at(-1)).toBe(
      '[warn] the kill switch is still engaged source=operator reason=drill engagedAt=2026-09-02T02:00:00.000Z',
    );

    killSwitch.heartbeat();
    expect(reporter.lines.length).toBe(after + 1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm exec vitest run src/runner/kill-switch.test.ts`
Expected: 모듈 없음으로 FAIL.

- [ ] **Step 3: 구현** — `kill-switch.ts`:

```ts
import { basename } from 'node:path';
import type { BrokerPortfolio } from '@moi/strategy-sdk';
import type { OrderGateway } from '../gateway/order-gateway.js';
import type { ReportFields, Reporter } from '../reporter.js';
import { isOpenOrder } from '../risk/risk-gate.js';
import type { JsonCell } from '../state/json-cell.js';
import type { DecisionKind } from '../state/state-store.js';

/**
 * The runner-wide kill switch (design §6, §7.2; the phase-D design document).
 *
 * One latch, four ways to trip it, and what tripping does: the latch is written
 * to `kill-switch.json` **first**, then reported once, then every resting order
 * is cancelled through the ordinary gateway path, and from then on the gateway's
 * barrier settles every `place` as `halted` while a `cancel` still goes out. The
 * runner stays up — the stream keeps delivering fills to the journal — and says
 * so every `HEARTBEAT_MS`. Clearing it is a person's act: delete the file and
 * restart. A latch that lifted itself would be a bot that resumed trading on
 * the same evidence it stopped on.
 *
 * ## Why the file comes first
 *
 * For the same reason a decision is on disk before it is submitted (§6.2): a
 * crash between "decided to stop" and "stopped" must leave a runner that comes
 * back stopped. `JsonCell.write` is an atomic replace, so the file is either
 * the whole latch or absent.
 *
 * ## Why the sweep goes through the gateway
 *
 * Each cancel is a recorded decision with a deterministic id,
 * `kill:{engagedAt}:{orderId}`. That buys three things at once: an audit line
 * per cancel, idempotency across a re-sweep (`appendDecision` writes nothing for
 * an id it has seen), and recovery — a cancel that failed is a pending decision,
 * and pending cancels are what `recoverPending` resubmits on the next start. The
 * sweep has no cancellation code of its own to get wrong.
 *
 * ## Why it reports on the transition only
 *
 * A fill wedge re-throws on every reconnect, and each throw calls `engage`
 * again. The second and later calls are silent; an embed per reconnect would be
 * the noise that hides the one that mattered.
 */

export const MAX_SWEEP_PASSES = 5;
export const HEARTBEAT_MS = 30 * 60 * 1_000;

export type KillSwitchSource =
  | 'loss-limit'
  | 'submission-failures'
  | 'fill-wedge'
  | 'operator';

export interface Engagement {
  readonly engagedAt: string;
  readonly source: KillSwitchSource;
  readonly reason: string;
}

/** The half a trip source needs. `FillProcessor` takes this rather than the class. */
export interface KillSwitchTrigger {
  engage(
    source: KillSwitchSource,
    reason: string,
    fields?: ReportFields,
  ): Promise<void>;
}

export interface KillSwitchOptions {
  readonly cell: JsonCell;
  readonly gateway: Pick<OrderGateway, 'idle' | 'record' | 'submit'>;
  /** The ledger's own view, read fresh on every sweep pass. */
  readonly portfolio: () => Promise<BrokerPortfolio>;
  readonly reporter: Reporter;
  readonly now?: () => number;
}

const SOURCES: ReadonlySet<unknown> = new Set<KillSwitchSource>([
  'loss-limit',
  'submission-failures',
  'fill-wedge',
  'operator',
]);

const OPERATOR_FILE_PRESENT = 'operator file present';

export class KillSwitch implements KillSwitchTrigger {
  readonly #cell: JsonCell;
  readonly #gateway: Pick<OrderGateway, 'idle' | 'record' | 'submit'>;
  readonly #portfolio: () => Promise<BrokerPortfolio>;
  readonly #reporter: Reporter;
  readonly #now: () => number;
  #engagement: Engagement | null;
  #sweep: Promise<void> | null = null;
  #lastHeartbeatAt = 0;

  constructor(options: KillSwitchOptions) {
    this.#cell = options.cell;
    this.#gateway = options.gateway;
    this.#portfolio = options.portfolio;
    this.#reporter = options.reporter;
    this.#now = options.now ?? Date.now;
    this.#engagement = this.#readLatch();
  }

  get engaged(): boolean {
    return this.#engagement !== null;
  }

  get engagement(): Engagement | null {
    return this.#engagement;
  }

  permits(kind: DecisionKind): boolean {
    return kind === 'cancel' || this.#engagement === null;
  }

  engage(
    source: KillSwitchSource,
    reason: string,
    fields: ReportFields = {},
  ): Promise<void> {
    if (this.#engagement !== null) {
      return this.#sweep ?? Promise.resolve();
    }

    const engagement: Engagement = Object.freeze({
      engagedAt: new Date(this.#now()).toISOString(),
      source,
      reason,
    });

    // The first durable act. Everything after this line can fail and the next
    // start still comes up engaged.
    this.#cell.write({ ...engagement });
    this.#engagement = engagement;
    this.#lastHeartbeatAt = this.#now();
    this.#reporter.report(
      'error',
      'the kill switch is engaged; new orders are refused and resting orders are being cancelled',
      { source, reason, ...fields },
    );
    this.#sweep = this.#sweepGuarded(engagement);

    return this.#sweep;
  }

  /**
   * An operator engages the switch by writing `{"reason": "…"}` to the latch
   * file; the runner notices on its next cycle. A file that is present but
   * unreadable, or has no reason, still engages — a kill-switch file the runner
   * cannot read is not a reason to keep trading. Once engaged this is a no-op:
   * the file on disk is then the runner's own, and deleting it while running
   * does not lift the latch (that takes a restart, by design).
   */
  async observeOperatorFile(): Promise<void> {
    if (this.#engagement !== null) {
      return;
    }

    let saved: Readonly<Record<string, unknown>> | null;

    try {
      saved = this.#cell.read();
    } catch {
      saved = {};
    }

    if (saved === null) {
      return;
    }

    const reason =
      typeof saved.reason === 'string' && saved.reason.trim().length > 0
        ? saved.reason
        : OPERATOR_FILE_PRESENT;

    await this.engage('operator', reason);
  }

  /**
   * What `start()` does with a latch it found on disk: say so, and sweep again.
   * The re-sweep is what closes the gap a crash *during* the first sweep leaves
   * — cancels that were recorded are pending and `recoverPending` has already
   * resubmitted them, but an order the sweep never reached is only caught by
   * reading the portfolio again. The ids are the same, so nothing is recorded or
   * submitted twice.
   */
  async resume(): Promise<void> {
    const engagement = this.#engagement;

    if (engagement === null) {
      return;
    }

    this.#lastHeartbeatAt = this.#now();
    this.#reporter.report(
      'error',
      `the kill switch is still engaged from a previous run; delete ${basename(this.#cell.path)} and restart to resume trading`,
      {
        source: engagement.source,
        reason: engagement.reason,
        engagedAt: engagement.engagedAt,
      },
    );
    this.#sweep = this.#sweepGuarded(engagement);

    await this.#sweep;
  }

  heartbeat(): void {
    const engagement = this.#engagement;

    if (engagement === null) {
      return;
    }

    const now = this.#now();

    if (now - this.#lastHeartbeatAt < HEARTBEAT_MS) {
      return;
    }

    this.#lastHeartbeatAt = now;
    this.#reporter.report('warn', 'the kill switch is still engaged', {
      source: engagement.source,
      reason: engagement.reason,
      engagedAt: engagement.engagedAt,
    });
  }

  #readLatch(): Engagement | null {
    let saved: Readonly<Record<string, unknown>> | null;

    try {
      saved = this.#cell.read();
    } catch {
      // Unreadable is still present. Normalised below as an operator latch.
      saved = {};
    }

    if (saved === null) {
      return null;
    }

    if (
      typeof saved.engagedAt === 'string' &&
      SOURCES.has(saved.source) &&
      typeof saved.reason === 'string'
    ) {
      return Object.freeze({
        engagedAt: saved.engagedAt,
        source: saved.source as KillSwitchSource,
        reason: saved.reason,
      });
    }

    // An operator wrote it (or nobody could read it) before this start: adopt
    // it as an operator engagement and write it back in the runner's own shape,
    // so the next reader sees one form.
    const adopted: Engagement = Object.freeze({
      engagedAt: new Date(this.#now()).toISOString(),
      source: 'operator',
      reason:
        typeof saved.reason === 'string' && saved.reason.trim().length > 0
          ? saved.reason
          : OPERATOR_FILE_PRESENT,
    });

    this.#cell.write({ ...adopted });

    return adopted;
  }

  async #sweepGuarded(engagement: Engagement): Promise<void> {
    try {
      await this.#runSweep(engagement);
    } catch (error) {
      // The latch is down regardless; the barrier holds. What failed is the
      // cleanup, and the next start's `resume` tries it again.
      this.#reporter.report('error', 'the cancel sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #runSweep(engagement: Engagement): Promise<void> {
    // An order that was mid-submission when the latch came down has to be in
    // the snapshot this reads, or the sweep misses it.
    await this.#gateway.idle();

    let resting = await this.#resting();
    let passes = 0;

    while (resting.length > 0 && passes < MAX_SWEEP_PASSES) {
      passes += 1;

      for (const orderId of resting) {
        const record = this.#gateway.record(
          'kill-switch',
          {
            kind: 'cancel',
            orderId,
            reason: `kill switch: ${engagement.reason}`,
          },
          null,
          { decisionId: `kill:${engagement.engagedAt}:${orderId}` },
        );

        if (record !== null) {
          await this.#gateway.submit(record);
        }
      }

      resting = await this.#resting();
    }

    if (resting.length === 0) {
      this.#reporter.report('info', 'the cancel sweep found no resting orders', {
        passes,
      });

      return;
    }

    this.#reporter.report(
      'error',
      'the cancel sweep left resting orders after its last pass',
      { passes, orderIds: resting.join(',') },
    );
  }

  async #resting(): Promise<readonly string[]> {
    const portfolio = await this.#portfolio();

    return portfolio.activeOrders.filter(isOpenOrder).map((order) => order.id);
  }
}

```

주의:
- `ReportFields` 는 `reporter.ts` 에 이미 export 되어 있다.
- 첫 테스트의 리포트 라인 정확 일치는 `formatReport` 의 `name=value` 순서(삽입 순서)에 의존한다: `{ source, reason, ...fields }` 순서를 지킨다.
- `'the cancel sweep found no resting orders'` 의 첫 테스트 기대 `passes=1`: 스윕이 한 패스 돌고 두 번째 읽기에서 비었을 때 `passes` 는 1. 주문이 처음부터 없으면 `passes=0`.

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm exec vitest run src/runner/kill-switch.test.ts`
Expected: PASS(15개). 실패하면 기대 문자열의 필드 순서부터 본다.

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/runner/kill-switch.ts apps/strategy-runner/src/runner/kill-switch.test.ts
git commit -m "feat(strategy-runner): 킬 스위치 — 영속 래치, 멱등 engage, 게이트웨이 경로의 취소 스윕

파일이 첫 durable 행위다(결정이 제출보다 먼저인 것과 같은 이유). 스윕은 in-flight 가 정산될
때까지 기다린 뒤 포트폴리오를 읽고, 열린 주문마다 kill:{engagedAt}:{orderId} 결정을 기록해
제출한다 — 감사·멱등·recoverPending 재시도를 한 번에 얻는다. 전이에서만 보고하고 30분마다
살아 있음을 말한다. 운영자는 파일을 써서 걸고, 지우고 재시작해서 푼다."
```

---

### Task 5: fill wedge 가 배리어를 함께 내린다 (`FillProcessor`)

**Files:**
- Modify: `apps/strategy-runner/src/fills/fill-processor.ts:67-80` (옵션), `:118` (`resolve` 호출)
- Test: `apps/strategy-runner/src/fills/fill-processor.test.ts` (`unaccountable` 헬퍼와 `build`)

**Interfaces:**
- Consumes: Task 4 `KillSwitchTrigger`.
- Produces: `FillProcessorOptions.killSwitch?: KillSwitchTrigger`.

- [ ] **Step 1: 실패하는 테스트** — `build()` 옵션에 `killSwitch` 를 더하고 `unaccountable` 이 engage 를 단언한다:

`build` 의 옵션 타입에 `readonly killSwitch?: { engage: (...args: unknown[]) => Promise<void> }` 를 더하고 `new FillProcessor({ …, ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }) })`.

`unaccountable` 을:

```ts
  const unaccountable = async (
    what: RegExp,
    event: StreamAccountEvent,
  ): Promise<void> => {
    const engaged: unknown[][] = [];
    const { processor, state, reporter } = build(scratch(), {
      killSwitch: {
        engage: async (...args) => {
          engaged.push(args);
        },
      },
    });

    await expect(processor.process(event)).rejects.toThrow(DomainError);

    expect(state.fills.cursor).toBeNull();
    expect(state.fills.hasEvent(event.eventId)).toBe(false);
    expect(reporter.lines.join('\n')).toMatch(what);
    // §16.46 closed: the wedge also brings the submission barrier down (phase D).
    expect(engaged).toHaveLength(1);
    expect(engaged[0]?.[0]).toBe('fill-wedge');
    expect(String(engaged[0]?.[1])).toMatch(what);
    expect(engaged[0]?.[2]).toStrictEqual({
      accountSequence: event.accountSequence,
      eventType: event.eventType,
    });
  };
```

그리고 같은 `describe` 에 하나 더:

```ts
  it('processes an ordinary fill without touching the kill switch', async () => {
    const engaged: unknown[] = [];
    const { processor } = build(scratch(), {
      killSwitch: {
        engage: async (...args) => {
          engaged.push(args);
        },
      },
    });

    await processor.process(fillEvent('12'));

    expect(engaged).toStrictEqual([]);
  });
```

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm exec vitest run src/fills/fill-processor.test.ts -t "stops|ordinary fill without"`
Expected: 세 wedge 테스트가 `expected [] to have a length of 1` 로 FAIL(옵션은 무시됨), 넷째는 PASS.

- [ ] **Step 3: 구현**

옵션:

```ts
  /**
   * Phase D. An unexplainable fill (§16.46) wedges fill processing *and* brings
   * the submission barrier down: the runner has evidence the ledger published
   * something the contract does not allow, and trading on ticks meanwhile is
   * the half §16.46 left for the barrier. Absent in a backtest.
   */
  readonly killSwitch?: KillSwitchTrigger;
```

`process()` 의 resolve 호출:

```ts
    let resolution: Awaited<ReturnType<FillResolver['resolve']>>;

    try {
      resolution = await this.#resolver.resolve(event, portfolio);
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === 'INVARIANT_VIOLATION'
      ) {
        // Not awaited: the sweep is network work, and this is the event drain
        // chain. `engage` is idempotent, so the replay on every reconnect is
        // silent after the first.
        void this.#options.killSwitch?.engage('fill-wedge', error.message, {
          accountSequence: event.accountSequence,
          eventType: event.eventType,
        });
      }

      throw error;
    }
```

`import { DomainError } from '@moi/trading-core'` 와 `import type { KillSwitchTrigger } from '../runner/kill-switch.js'` 추가. `FillResolver['resolve']` 반환 타입이 export 되어 있으면 그 이름을 쓴다.

파일 머리 주석의 "wedge" 문단(있다면 `fill-resolver.ts:85-86` 의 "halting the whole runner is the submission barrier of §7.2, in phase D")을 "and, since phase D, the wedge also engages the kill switch" 로 고친다.

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm exec vitest run src/fills/fill-processor.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/fills/fill-processor.ts apps/strategy-runner/src/fills/fill-resolver.ts apps/strategy-runner/src/fills/fill-processor.test.ts
git commit -m "feat(strategy-runner): 설명 불가능한 fill 이 킬 스위치도 함께 내린다

§16.46 은 wedge 가 체결 처리만 멈추고 틱 거래는 phase D 배리어에 맡겼다. 이제 같은 throw 가
engage('fill-wedge') 를 부른 뒤 재throw 한다 — 커서는 그대로, 재연결마다의 재생은 멱등이라 조용하다."
```

---

### Task 6: supervisor 배선과 래치 자세

**Files:**
- Modify: `apps/strategy-runner/src/runner/supervisor.ts` (생성자, `start`, `cycle`, `#applyTick`), `apps/strategy-runner/src/index.ts`
- Test: `apps/strategy-runner/src/runner/supervisor.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `RunnerSupervisor.killSwitch: KillSwitch` (getter); `index.ts` 가 `KillSwitch`, `KILL_SWITCH_FILE`, `MAX_SWEEP_PASSES`, `HEARTBEAT_MS`, `KILL_SWITCH_AFTER_FAILED_ATTEMPTS`, 타입 `Engagement`·`KillSwitchSource`·`KillSwitchTrigger` 를 export.

- [ ] **Step 1: 실패하는 테스트** — `supervisor.test.ts` 끝에:

```ts
describe('the kill switch in the runner', () => {
  it('engages from an operator file and then hands no tick to any strategy', async () => {
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
    await supervisor.cycle(); // primes the grid
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({ reason: 'operator drill' }),
    );
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle(); // would have crossed a level and bought
    time.advance(HALF_A_FRESHNESS_WINDOW);
    await supervisor.cycle();
    supervisor.close();

    expect(stub.placed).toStrictEqual([]);
    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'operator',
      reason: 'operator drill',
    });
    expect(reporter.lines).toContain(
      '[error] the kill switch is engaged; new orders are refused and resting orders are being cancelled source=operator reason=operator drill',
    );
    expect(reporter.lines).toContain(
      '[info] the cancel sweep found no resting orders passes=0',
    );
    // The feed still ran: cursors moved on the engaged cycles.
    expect(
      (supervisor.state.runtime.read() as { cursors: Record<string, unknown> })
        .cursors,
    ).not.toStrictEqual({});
  });

  it('engages from a tripped loss limit at the start of a cycle', async () => {
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

    expect(stub.placed).toStrictEqual([]);
    expect(supervisor.killSwitch.engagement).toMatchObject({
      source: 'loss-limit',
      reason: '3 closing fills in a row lost, at the limit of 3',
    });
  });

  it('comes back engaged after a restart and says so', async () => {
    writeFileSync(
      join(directory, 'kill-switch.json'),
      JSON.stringify({
        engagedAt: '2026-08-30T00:00:00.000Z',
        source: 'fill-wedge',
        reason: 'a fill record could not be read',
      }),
    );

    const stub = api({ '005930': ['70800', '70600'] });
    const reporter = createRecordingReporter();
    const supervisor = new RunnerSupervisor({
      config: config(
        [grid('grid-samsung', '005930', '70000')],
        [{ market: 'KR', symbol: '005930' }],
      ),
      reporter,
      fetch: stub.fetch,
      now: () => Date.parse('2026-08-31T01:00:00.000Z'),
      socketFactory: idleSocket,
    });

    await supervisor.start();
    await supervisor.cycle();
    supervisor.close();

    expect(supervisor.killSwitch.engaged).toBe(true);
    expect(reporter.lines.join('\n')).toContain(
      'the kill switch is still engaged from a previous run; delete kill-switch.json and restart to resume trading source=fill-wedge',
    );
    expect(stub.placed).toStrictEqual([]);
  });
});
```

`import { writeFileSync }` 를 `node:fs` import 에 더하고, `import { StateStore } from '../state/state-store.js'` 추가.

- [ ] **Step 2: 실패 확인**

Run: `corepack pnpm exec vitest run src/runner/supervisor.test.ts -t "kill switch in the runner"`
Expected: `supervisor.killSwitch` undefined 로 FAIL.

- [ ] **Step 3: 구현** — `supervisor.ts`:

import 에 `import { KillSwitch } from './kill-switch.js';`. 필드 `readonly #killSwitch: KillSwitch;`.

게이트웨이 생성에 두 옵션(둘 다 호출 시점에 `#killSwitch` 를 읽는 클로저 — 게이트웨이가 먼저 만들어지므로):

```ts
      barrier: (kind) => this.#killSwitch.permits(kind),
      onExhausted: ({ code, consecutiveFailures }) => {
        void this.#killSwitch.engage(
          'submission-failures',
          `${consecutiveFailures} submission attempts failed in a row`,
          { code, consecutiveFailures },
        );
      },
```

게이트웨이 뒤, `FillProcessor` 앞에:

```ts
    this.#killSwitch = new KillSwitch({
      cell: this.#state.killSwitch,
      gateway: this.#gateway,
      portfolio: () => this.#portfolio(),
      reporter: options.reporter,
      now: this.#now,
    });
```

`FillProcessor` 옵션에 `killSwitch: this.#killSwitch`.

getter:

```ts
  get killSwitch(): KillSwitch {
    return this.#killSwitch;
  }
```

`start()`:

```ts
    await this.#session.establish();
    await this.#gateway.recoverPending();
    // A latch found on disk is announced and swept again before any strategy
    // is restored — the pending cancels `recoverPending` just resubmitted are
    // the recorded half of an interrupted sweep; this reads the rest.
    await this.#killSwitch.resume();
```

`cycle()`:

```ts
  async cycle(): Promise<void> {
    await this.#killSwitch.observeOperatorFile();

    if (!this.#killSwitch.engaged) {
      const breach = this.#risk.lossLimitBreach();

      if (breach !== null) {
        await this.#killSwitch.engage('loss-limit', breach);
      }
    }

    const portfolio = await this.#portfolio();

    this.#context.observePortfolio(portfolio);

    const ticks = await this.#feed.drain();

    for (const tick of ticks) {
      await this.#applyTick(tick, portfolio);
    }

    this.#persist();
    this.#killSwitch.heartbeat();
  }
```

`#applyTick` 에서 recorder·observeTick 뒤, owner 조회 앞:

```ts
    // Engaged: the feed, the recorder and the cursors carry on — the runner is
    // watching, not trading — and the one thing that stops is this hand-off.
    if (this.#killSwitch.engaged) {
      return;
    }
```

파일 머리 주석의 cycle 설명에 "0. the operator file and the loss limits, for the kill switch" 를 더한다.

`index.ts`:

```ts
export {
  type ExhaustedSubmissions,
  KILL_SWITCH_AFTER_FAILED_ATTEMPTS,
  OrderGateway,
} from './gateway/order-gateway.js';
export {
  type Engagement,
  HEARTBEAT_MS,
  KillSwitch,
  type KillSwitchSource,
  type KillSwitchTrigger,
  MAX_SWEEP_PASSES,
} from './runner/kill-switch.js';
export { KILL_SWITCH_FILE, StateStore } from './state/state-store.js';
```

- [ ] **Step 4: 통과 확인**

Run: `corepack pnpm --filter @moi/strategy-runner typecheck && corepack pnpm --filter @moi/strategy-runner test`
Expected: 전부 PASS. `package-surface.test.ts` 가 export 표를 고정한다면 새 export 를 그 표에 더한다.

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/src/runner/supervisor.ts apps/strategy-runner/src/runner/supervisor.test.ts apps/strategy-runner/src/index.ts apps/strategy-runner/src/package-surface.test.ts
git commit -m "feat(strategy-runner): supervisor 가 킬 스위치를 배선하고 걸린 뒤엔 살아서 지켜본다

네 트립 소스(운영자 파일·손실 한도·제출 소진·fill wedge)를 잇는다. 걸린 cycle 도 포트폴리오·
피드·레코더·커서는 그대로 돌고 호스트에 틱만 주지 않는다. 재시작은 래치를 보고하고 다시 스윕한다."
```

---

### Task 7: 통합 완료 기준 (paper-api, Testcontainers)

**Files:**
- Create: `apps/paper-api/src/runtime/strategy-runner-kill-switch.integration.test.ts`

**Interfaces:**
- Consumes: `RunnerSupervisor.killSwitch`, `KILL_SWITCH_FILE` (Task 6), 기존 `strategy-runner.integration.test.ts` 의 하네스 형태(컨테이너·`appConfig`·`publishPrice`·`runnerConfig`·`feedPrice`·`PaperBroker` 구성). 그 파일에서 **복사**한다 — 두 파일이 공유 모듈을 갖지 않는 기존 관례를 따른다.

- [ ] **Step 1: 테스트 작성**

`strategy-runner.integration.test.ts` 의 1–140 행(import·상수·`appConfig`·`PRICES`·`publishPrice`)과 `runnerConfig`·`scratch`·`observed`·`feedPrice`·`beforeAll`/`afterAll` 을 그대로 복사한 뒤(파일 머리 주석은 이 테스트의 목적으로 바꾼다), 본문:

```ts
/**
 * Phase D's done-criterion for the kill switch, against the real ledger: a
 * tripped runner cancels its resting orders and places nothing afterwards —
 * and still places nothing after a restart, because the latch is a file.
 */
describe('the kill switch against the real paper API', () => {
  it(
    'cancels resting orders on a trip and places nothing afterwards, across a restart',
    async () => {
      const stateDir = scratch();
      const reporter = createRecordingReporter();
      const supervisor = new RunnerSupervisor({
        config: runnerConfig(stateDir),
        reporter,
      });

      try {
        await publishPrice(PRICES[0]);
        await supervisor.start();
        await feedPrice(supervisor, PRICES[0]);

        const credentials = () => {
          const session = supervisor.state.session.read() as {
            sessionId: string;
            cookie: string;
            csrfToken: string;
          };

          return session;
        };
        const broker = new PaperBroker(
          new PaperApiClient({
            origin,
            publicOrigin: PUBLIC_ORIGIN,
            credentials,
          }).brokerTransport(),
        );
        const sessionId = credentials().sessionId;

        // Two limit bids far below the market rest in the ledger.
        for (const key of ['rest-1', 'rest-2']) {
          await broker.placeOrder({
            sessionId,
            idempotencyKey: key,
            market: 'KR',
            symbol: SYMBOL,
            side: 'BUY',
            type: 'LIMIT',
            quantity: '1',
            limitPrice: '50000',
          });
        }

        const open = (await broker.getPortfolio(sessionId)).activeOrders.filter(
          (order) => order.status === 'OPEN' || order.status === 'RECEIVED',
        );

        expect(open).toHaveLength(2);

        // The operator pulls the switch.
        writeFileSync(
          join(stateDir, KILL_SWITCH_FILE),
          JSON.stringify({ reason: 'integration drill' }),
        );
        await supervisor.cycle();

        expect(supervisor.killSwitch.engagement).toMatchObject({
          source: 'operator',
          reason: 'integration drill',
        });

        const afterSweep = await broker.getPortfolio(sessionId);

        expect(
          afterSweep.activeOrders
            .filter((order) => order.symbol === SYMBOL)
            .map((order) => order.status)
            .sort(),
        ).toStrictEqual(['CANCELLED', 'CANCELLED']);

        // The series that would have bought (see PRICES): nothing is placed.
        for (const price of PRICES.slice(1)) {
          await feedPrice(supervisor, price);
        }

        expect(
          reporter.lines.filter((line) => line.includes('the place was accepted')),
        ).toStrictEqual([]);
        expect(
          (await broker.getPortfolio(sessionId)).activeOrders.filter(
            (order) => order.symbol === SYMBOL,
          ),
        ).toHaveLength(2);

        supervisor.close();

        // Restart on the same state: still engaged, still nothing placed.
        const restarted = new RunnerSupervisor({
          config: runnerConfig(stateDir),
          reporter: createRecordingReporter(),
        });

        try {
          await restarted.start();

          expect(restarted.killSwitch.engaged).toBe(true);

          for (const price of PRICES) {
            await feedPrice(restarted, price);
          }

          expect(
            (await broker.getPortfolio(sessionId)).activeOrders.filter(
              (order) => order.symbol === SYMBOL,
            ),
          ).toHaveLength(2);
        } finally {
          restarted.close();
        }

        const latch = JSON.parse(
          readFileSync(join(stateDir, KILL_SWITCH_FILE), 'utf8'),
        ) as Record<string, unknown>;

        expect(latch).toMatchObject({ source: 'operator', reason: 'integration drill' });
        expect(readFileSync(join(stateDir, 'decisions.ndjson'), 'utf8')).toMatch(
          /"decisionId":"kill:[^"]+:[^"]+"/u,
        );
      } finally {
        // `close()` is idempotent for the stream; the state store is not, so
        // guard the second close from the restart path above.
        try {
          supervisor.close();
        } catch {
          // already closed
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
```

import 에 `KILL_SWITCH_FILE` (from `@moi/strategy-runner`), `readFileSync`·`writeFileSync` (from `node:fs`). `broker.placeOrder` 의 `PlaceOrderCommand` 필드명(`limitPrice`)은 `packages/strategy-sdk/src/order-intent.ts` 로 확인한다. 재시작 뒤 `feedPrice` 가 세션을 재수립하는지(같은 `session.json` 을 읽으므로 같은 세션) 확인 — 다르면 restarted 의 세션으로 `sessionId` 를 다시 읽는다. `supervisor.close()` 가 두 번 불려 `StateStore.close` 가 던지면 첫 `close()` 뒤 플래그로 막는다.

- [ ] **Step 2: 실행**

Run: `cd apps/paper-api && corepack pnpm exec vitest run src/runtime/strategy-runner-kill-switch.integration.test.ts` (Docker 필요; ~2분)
Expected: PASS. 실패 시 원인이 하네스(세션·필드명)인지 구현인지 리포터 라인으로 가른다.

- [ ] **Step 3: 커밋**

```bash
git add apps/paper-api/src/runtime/strategy-runner-kill-switch.integration.test.ts
git commit -m "test(paper-api): 킬 스위치 통합 완료 기준 — 트립이 미체결을 취소하고 재시작 뒤에도 아무것도 내지 않는다"
```

---

### Task 8: 문서 — README, §16.48, 설계 보강

**Files:**
- Modify: `apps/strategy-runner/README.md:24-31` (D 행), `:107-118` (상태 파일 표), `:314-318` (quarantine 절), `:336-341` (손실 한도 격상 문장), 새 절 "The kill switch"
- Modify: `docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md` §16 표 끝(16.47 뒤)
- Modify: `docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md` §2.1·§2.6

- [ ] **Step 1: README**

"Deliberately **not** here" 표의 D 행을 둘로:

```markdown
| The kill-switch submission barrier | **here since phase D** — see "The kill switch" | |
| Discord embeds, the compose service | D (#93) | The `Reporter` seam is here; the wiring is not |
| Escalating a tripped loss limit past "refuse new entries" | **here since phase D** | `RiskGate.lossLimitBreach` feeds the kill switch |
```

상태 파일 표에 행 추가:

```markdown
| `kill-switch.json` | atomic replace | the kill switch's latch — present means engaged |
```

quarantine 절의 문장을:

```markdown
Quarantine is not a kill switch. The two differ on every axis that matters:

| | quarantine | kill switch |
|---|---|---|
| unit | one strategy | the whole runner |
| persisted | no — a restart lifts it | `kill-switch.json` — a person lifts it |
| resting orders | untouched | cancelled by the sweep |
| tripped by | three consecutive throws | a loss limit, ten failed submission attempts in a row, an unexplainable fill, or an operator |

A quarantine does not trip the kill switch (one strategy's fault does not stop the
others — phase B's call), and the kill switch does not consult quarantine (once
engaged, no host receives a tick anyway).
```

"What a tripped loss limit does" 문장을 "A tripped loss limit refuses new entries **and**, since phase D, engages the kill switch through `RiskGate.lossLimitBreach()`, which the supervisor asks once a cycle." 로.

새 절(quarantine 절 뒤):

```markdown
## The kill switch

Design §6's "킬 스위치가 걸리면": the latch is written to `kill-switch.json`
first, reported once at `error`, every resting order is cancelled through the
ordinary gateway path (`decisionId` `kill:{engagedAt}:{orderId}`, so a re-sweep
records nothing twice and a failed cancel is a pending decision the next start
resubmits), and from then on the gateway settles every `place` as `halted` while
a `cancel` still goes out. The runner stays up — fills keep reaching the journal —
and says `the kill switch is still engaged` every 30 minutes.

Four things trip it: `maxConsecutiveLosses` or `maxDailyLoss` (design §6 calls
both "킬 스위치"; the BUY refusal stays too), ten failed submission attempts in a
row (design §7.2), an unexplainable fill (§16.46 — the wedge now brings the
barrier down with it), and an operator.

**To engage it by hand**, write `{"reason": "…"}` to `kill-switch.json` in
`BOT_STATE_DIR`; the runner notices on its next cycle. **To clear it**, delete the
file and restart the container. It does not lift itself, and deleting the file
while the runner is up does not lift it either — a half-cleared switch would be a
half-trading bot.

A decision the barrier catches is settled as `halted`, not left pending: an
operator who clears the latch must not have yesterday's entry resubmitted at
them. The position is not closed; that is a person's decision.
```

- [ ] **Step 2: §16.48**

`| 16.47 |` 행 바로 아래에 한 행(원문 형식대로 한 줄):

```markdown
| 16.48 | 아키텍처 설계 §9.2 "kill switch는 resting order를 자동 취소하지 않는다. cancel-all은 별도의 명시적·멱등 운영 명령이다"; 전략 러너 설계 §6 "킬 스위치가 걸리면 (1) 모든 미체결 주문 취소 시도 … 해제는 사람이 파일에서 지우고 재시작", §7.2 "10회 실패 시 킬 스위치"; §16.46 "러너 전체 정지는 §7.2 배리어, phase D" | **봇의 킬 스위치는 자기 미체결을 스스로 취소한다** — 아키텍처 §9.2 는 원장의 포스처이고(온콜이 있는 서비스는 사람이 cancel-all 을 고른다), 온콜 없는 컨테이너 속 봇은 노출을 스스로 줄이는 쪽이 fail-closed 다. 취소는 `/admin/cancel-all` 이 아니라 세션 범위의 `cancelOrder` 를 **게이트웨이 경로로** 낸다(`decisionId = kill:{engagedAt}:{orderId}` — 감사 행, 재스윕 멱등, 실패한 취소는 pending cancel 로 남아 `recoverPending` 이 재시도). 포지션은 청산하지 않는다. **배리어가 잡은 결정은 `halted` 로 정산한다**(pending 으로 두면 사람이 래치를 풀고 재시작한 순간 트립 전 진입이 나간다 — 킬 스위치가 잡은 결정은 죽은 결정이다); `SubmissionOutcome` 에 `halted` 가 는다. 배리어는 `OrderGateway.submit()` 한 곳, 매 attempt 전에 묻는다(백오프 중 내려온 래치가 다음 전송을 막는다); cancel 은 통과한다. §7.2 의 "10회" 는 **결정을 가로지른 연속 실패 attempt** 로 읽는다(성공이 리셋, 거부는 세지 않음, 상수 `KILL_SWITCH_AFTER_FAILED_ATTEMPTS`). 설계 §6 의 두 손실 한도는 BUY 거부에 더해 킬 스위치로 **격상**한다(`RiskGate.lossLimitBreach()`, cycle 마다). §16.46 의 wedge 는 이제 `engage('fill-wedge')` 를 함께 부른다 — 커서는 그대로, 재생마다의 재호출은 멱등이라 조용하다. **걸린 러너는 살아서 지켜본다**(종료하면 `restart: unless-stopped` 가 재시작 루프를 만든다): 스트림·fill 처리·커서·레코더는 계속, 호스트에 틱만 주지 않고 30분마다 `warn`. 설계에 없는 추가 하나: **운영자가 `kill-switch.json` 에 `{"reason":…}` 을 써서 건다**(해제와 대칭, 읽을 수 없는 파일도 건다 — fail closed). 재시작은 래치를 보고하고 **다시 스윕한다**(첫 스윕 도중 죽었을 때 기록되지 못한 주문을 잡는 유일한 길; id 가 같아 두 번 기록되지 않는다). 설정 항목은 없다 — 임계값 셋은 상수다. 설계 문서: `2026-09-02-moi-strategy-runner-kill-switch-design.md`. | `kill-switch.test.ts`(멱등 engage·파일 우선·전이 1회 보고·운영자 파일 세 모양·idle 대기·재스캔·5패스 잔존·resume 재스윕·heartbeat), `order-gateway.test.ts` "under the kill switch barrier"(halted 정산·cancel 통과·attempt 사이 배리어·idle·10회 소진·리셋/거부 무시), `state-store.test.ts` "halted … settled, across a reopen", `risk-gate.test.ts` "lossLimitBreach", `fill-processor.test.ts` §16.46 세 모양 + `engage('fill-wedge')`, `supervisor.test.ts` "the kill switch in the runner", `strategy-runner-kill-switch.integration.test.ts`(원장에서 두 미체결이 CANCELLED, 이후·재시작 뒤 주문 0) |
```

- [ ] **Step 3: 설계 보강** — 킬 스위치 설계 §2.1 의 마지막 불릿("재시작 시 파일이 있으면 …") 끝에, 그리고 §2.6 의 3번 끝에 한 문장씩:

§2.1: "그리고 `resume()` 이 스윕을 **다시** 돈다 — 첫 스윕 도중 죽었을 때 기록되지 못한 주문을 잡는 유일한 길이고, id 가 같아 두 번 기록·제출되지 않는다."

§2.6 3번: "정확히는 `recoverPending` 이 기록된 취소를 재제출하고, 이어지는 `resume()` 의 재스윕이 기록되지 못한 나머지를 읽는다."

- [ ] **Step 4: 확인**

Run: `corepack pnpm check` (biome 이 md 를 보지 않으면 `git diff --stat` 으로 세 파일만 바뀐 것 확인). §16 표는 한 행이 한 줄이어야 한다: `grep -c '^| 16.48 |' docs/superpowers/specs/2026-08-27-*.md` → 1.

- [ ] **Step 5: 커밋**

```bash
git add apps/strategy-runner/README.md docs/superpowers/specs/2026-08-27-moi-production-runtime-and-provider-handoff-design.md docs/superpowers/specs/2026-09-02-moi-strategy-runner-kill-switch-design.md
git commit -m "docs: 킬 스위치 — README 운영 절차와 quarantine 대비표, 스펙 §16.48, 설계의 재스윕 보강"
```

---

### Task 9: 게이트와 증거

**Files:** 없음(실행만). 실패하면 해당 태스크로 돌아간다.

- [ ] **Step 1: 저장소 게이트** (워크트리 루트에서, `set -o pipefail`)

```bash
source ~/.nvm/nvm.sh && nvm use && set -o pipefail
corepack pnpm check 2>&1 | tail -5
corepack pnpm typecheck 2>&1 | tail -5
corepack pnpm --filter @moi/strategy-runner test 2>&1 | tail -8
corepack pnpm --filter @moi/strategy-sdk test 2>&1 | tail -5
corepack pnpm check:deployment 2>&1 | tail -3
corepack pnpm build 2>&1 | tail -3
```

Expected: 전부 exit 0. `pnpm test` 전체(paper-api 통합 포함)는 Docker 점유가 크므로 `apps/paper-api` 는 `strategy-runner*.integration.test.ts` 세 파일만 직접 돌리고, 전체는 CI 에 맡긴다(그렇게 했다고 PR 에 적는다).

- [ ] **Step 2: 변이 확인** (증거 — 각각 되돌린다)

1. `order-gateway.ts` 의 `if (!this.#barrier(record.kind)) return this.#halt(record);` 를 지운다 → `order-gateway.test.ts` "settles a place as halted" 와 통합 테스트가 문다. 복구.
2. `#halt` 의 `outcome: 'halted'` 를 `'rejected'` 로 → 문지 않으면 pending 검사 테스트를 보강한다(`state.pendingDecisions()` 뿐 아니라 `submissions.ndjson` 의 `"outcome":"halted"` 를 단언).
3. `kill-switch.ts` 의 `await this.#gateway.idle()` 을 지운다 → "waits for in-flight submissions before reading the portfolio" 가 문다. 복구.

각각 `git stash` 를 쓰지 말고(공유 stash) 편집 → 실행 → `git checkout -- <file>` 로 되돌린다.

- [ ] **Step 3: PR**

`gh pr create` — 제목 `feat(strategy-runner): 킬 스위치 제출 배리어 — 래치·스윕·halted 정산 (phase D 코어)`, 본문은 한국어로: 무엇(설계 §6/§7.2 의 미구현 절반), 어떻게(§16.48 요약), 검증(게이트 목록·통합 테스트·변이 3건), 리뷰 체크박스 두 레인(코드 리뷰어 / 독립 에이전트 — `codex`·`agy` 가용 여부는 그날 확인), 후속 이슈 링크(#88 #89 #93, 러너 설계 문서 main 반입은 이 PR 첫 커밋).
