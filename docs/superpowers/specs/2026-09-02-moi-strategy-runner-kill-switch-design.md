# Moi Strategy Runner — 킬 스위치 제출 배리어 (phase D 코어) Design

- 상위 문서: [`2026-08-30-moi-strategy-runner-design.md`](./2026-08-30-moi-strategy-runner-design.md) §6(리스크 게이트의 "킬 스위치가 걸리면"), §7.2(API 거절표의 "10회 실패 시 킬 스위치"), §11(phase D).
- 구현 편차 기록: [`2026-08-27-moi-production-runtime-and-provider-handoff-design.md`](./2026-08-27-moi-production-runtime-and-provider-handoff-design.md) §16 — 이 설계가 만드는 행은 **§16.48**.
- 범위 밖(각각 후속 PR): #88(`onFill` 재생 발산 감지), #89(ready 직후 close flap storm), #93(bot 이미지·compose 배선, Discord 리포터 연결).

## 0. 승인된 결정 (사용자, 2026-09-02)

1. 이 PR 은 **배리어 코어만**: 래치·제출 배리어·취소 스윕·영속·트립 소스 4개·quarantine 과의 관계. #88·#89 는 넣지 않는다.
2. 트립 시 미체결 주문은 **자동 취소 스윕**한다(러너 설계 §6). 아키텍처 스펙의 "kill switch 는 resting order 를 자동 취소하지 않는다"는 **원장**의 포스처이고, 온콜이 없는 봇은 스스로 노출을 줄인다. 포지션은 청산하지 않는다.
3. 래치가 걸린 러너는 **살아서 지켜본다**: 프로세스 유지, 스트림·fill 처리(손익 장부) 계속, 전략에는 틱을 주지 않는다, 제출 배리어는 닫힌다. 종료하지 않는 이유는 `restart: unless-stopped` 아래서 종료가 재시작 루프가 되기 때문이다.
4. 킬 스위치는 **독립 클래스** `KillSwitch` 다. 게이트웨이는 그것을 묻고, 리스크 게이트는 그것을 모른다.

## 1. 배경

phase B/C 는 킬 스위치를 세 곳에서 미뤘다:

- `OrderGateway.submit()`: 재시도 소진을 `pending` 으로 남기고 "§7.1's escalation to the kill switch is phase D" 라고 적었다.
- `RiskGate`: 연속손실·일일손실 한도가 걸려도 **BUY 거부**에서 멈춘다 — 설계 §6 은 둘 다 "킬 스위치" 다.
- `FillProcessor`(§16.46): 설명 불가능한 fill 은 `INVARIANT_VIOLATION` 으로 fill 처리를 wedge 하지만 "wedge 가 멈추는 것은 체결 처리이지 틱 기반 거래가 아니다(러너 전체 정지는 §7.2 배리어, phase D)".

셋 다 같은 물건을 기다렸다. 이 문서가 그 물건이다.

## 2. 구성 요소

### 2.1 `KillSwitch` (`apps/strategy-runner/src/runner/kill-switch.ts`)

```ts
interface Engagement {
  readonly engagedAt: string;   // ISO, 러너의 시계
  readonly source: 'loss-limit' | 'submission-failures' | 'fill-wedge' | 'operator';
  readonly reason: string;      // 사람이 읽는 한 문장. 비밀 없음(리포터 마스킹을 지나지만 애초에 넣지 않는다)
}

class KillSwitch {
  get engaged(): boolean;
  get engagement(): Engagement | null;
  /** 멱등. 첫 호출만 영속·보고·스윕. 스윕 완료 Promise 를 돌려준다(이미 걸려 있으면 진행 중인 스윕의 것). */
  engage(source, reason, fields?): Promise<void>;
  /** 제출 배리어. place 는 막고 cancel 은 통과. */
  permits(kind: 'place' | 'cancel'): boolean;
  /** 운영자 파일 감시: 파일이 새로 나타났으면 engage('operator'). cycle 마다 호출. */
  observeOperatorFile(): Promise<void>;
  /** 걸린 채 30분마다 warn 한 줄. cycle 마다 호출, 시간은 주입된 시계. */
  heartbeat(): void;
  /** start() 에서: 파일로 걸려 있으면 보고 한 줄 + 재스윕. 아니면 조용. */
  resume(): Promise<void>;
}
```

- **영속**: `BOT_STATE_DIR/kill-switch.json`, `JsonCell` 원자 교체. 내용은 `Engagement` 그대로. 파일이 있으면 걸린 것, 없으면 아닌 것 — 그 이상의 상태 기계는 없다.
- **메모리 배리어가 먼저, 래치 기록이 그다음, 보고·스윕은 그 뒤다.** `engage` 는 `#engagement` 를 먼저 세워 배리어를 닫고, 파일을 쓴 뒤에야 보고하고 스윕한다. 결정 기록이 제출보다 먼저인 것(§6.2)과 같은 이유: 스윕 도중 죽어도 재시작이 래치를 본다. **쓰기가 실패하면**(ENOSPC·읽기 전용 FS) 던지지 않고 `error` 로 보고하며 메모리 래치는 그대로 — 디스크가 거부해도 거래를 계속하는 쪽이 틀린 방향이다 — 그리고 이후 cycle 의 `observeOperatorFile` 이 쓰기를 재시도한다(레인 2 BLOCKER).
- **해제는 사람이 파일을 지우고 재시작한다**(설계 §6, 자동 해제 없음). 프로세스가 도는 동안 파일이 사라져도 래치는 풀리지 않는다 — 메모리의 `engaged` 가 진실이고 파일은 재시작을 위한 것이다. "지우면 바로 재개" 는 반쯤 지운 운영자에게 반쯤 도는 봇을 준다.
- **전이에서만 보고한다.** 첫 `engage` 가 `error` 한 줄(`the kill switch is engaged; new orders are refused and resting orders are being cancelled`, fields: `source`, `reason`, 추가 필드). 이후 `engage` 호출은 조용하다 — wedge 는 재연결마다 같은 이벤트를 다시 던지고, 그때마다 임베드를 내면 신호가 죽는다. 30분 heartbeat 는 별도의 `warn` 이다.
- **운영자 트립**: 사람이 `{"reason":"…"}` 를 `kill-switch.json` 에 쓰면 다음 cycle 에 `engage('operator', reason)`. 해제와 대칭이고 비용은 stat 하나다. 파일에 `reason` 이 없거나 JSON 이 아니면 `reason: 'operator file present'` 로 건다 — 파싱할 수 없는 킬 스위치 파일도 킬 스위치 파일이다. 반면 **실행 중** `EACCES`·`EIO`·`EISDIR` 같은 읽기 장애는 래치가 아니다: 전이에서 `warn` 한 줄을 내고 다음 cycle 에 다시 읽는다(일시적 I/O 오류가 온콜 없는 봇을 영구히 세우면 안 된다). **시작 시**의 읽기 장애는 다르다 — 경로에 무언가 있는데 러너가 그것이 래치인지 말할 수 없다 — 그러므로 fail closed: 메모리 래치로 시작하고(`reason: operator file present but unreadable (CODE)`), `resume()` 이 디스크가 허락하면 써 넣는다(레인 2 검증 BLOCKER). 운영자 파일의 여분 필드(`by`, 티켓)는 `resume()` 의 정규화 쓰기에서 보존된다 — 생성자는 읽기만 하고 쓰지 않는다. `reason` 은 파일에 쓰기 전에 `redact` 를 지난다.
- 재시작 시 파일이 있으면 생성자에서 `engaged = true` 로 시작하고 `start()` 의 `resume()` 이 그 사실을 `error` 로 한 번 보고한다(재시작마다 한 번 — 컨테이너가 다시 뜰 때마다 사람이 봐야 하는 상태다). 그리고 `resume()` 이 스윕을 **다시** 돈다 — 첫 스윕 도중 죽었을 때 기록되지 못한 주문을 잡는 유일한 길이고, id 가 같아 두 번 기록·제출되지 않는다. `resume()` 은 **생성자에서 읽은 래치에만, 한 번만** 말한다: `recoverPending` 이 실패를 소진해 같은 실행에서 걸린 래치는 이미 `engage` 가 보고했고 스윕 중이므로, `resume()` 은 조용히 지나간다(없는 파일을 지우라고 하거나 스윕을 겹쳐 돌리지 않는다).

### 2.2 `OrderGateway` — 배리어와 정산

- 옵션 `barrier: (kind: 'place' | 'cancel') => boolean` (기본 `() => true`, 백테스트 엔진과 기존 테스트는 바뀌지 않는다).
- `submit()` 은 **각 attempt 전에, 그리고 실패한 attempt 뒤에** 배리어를 묻는다(레인 2 BLOCKER: 요청이 날아가 있는 동안 래치가 내려오면, 그 실패를 pending 으로 두거나 백오프에 들어가는 대신 halted 로 정산한다 — pending 은 정확히 래치를 푼 재시작이 되살릴 것이다). 백오프는 `MAX_BACKOFF_MS = 5분`(§7.2) 을 넘지 않는다. 막히면 `appendSubmission({ decisionId, at, outcome: 'halted', code: 'KILL_SWITCH' })` 로 **정산**하고 `{ outcome: 'halted' }` 를 돌려준다. `SubmissionOutcome` 에 `'halted'` 가 추가되고 `readSubmissionRecord` 가 그것을 받아들인다(옛 로그는 그대로 읽힌다).
  - 정산하는 이유: 트립 **전에** 내린 결정이 pending 으로 남으면 사람이 파일을 지우고 재시작한 순간 `recoverPending` 이 어제의 BUY 를 오늘 낸다. 킬 스위치가 잡은 결정은 죽은 결정이다.
  - attempt **사이**에도 묻는 이유: 재시도 백오프 중에 다른 경로(fill wedge)가 트립할 수 있다. 이미 보낸 요청은 되돌릴 수 없지만, 다음 재시도는 안 보내도 된다 — 보냈던 것이 원장에 닿았다면 스윕이 잡는다.
- `recoverPending()` 도 같은 `submit()` 을 지나므로 래치 상태로 재시작하면 pending place 는 halted 로 정산되고 pending **cancel** 은 재제출된다 — 실패한 스윕 취소가 재시작마다 자동으로 재시도되는 경로가 이것이다.
- **in-flight 추적**: `#inFlight` 카운터와 `idle(): Promise<void>`. `submit()` 진입 시 +1, 어떤 경로로든 반환·throw 시 −1, 0 이 되면 대기자를 깨운다.
- **연속 실패 카운터**: retryable 실패 attempt 마다 +1, `accepted` 에서 0. `KILL_SWITCH_AFTER_FAILED_ATTEMPTS = 10`(§7.2 "10회 실패 시 킬 스위치" — attempt 단위로 세는 것이 문장에 가장 가깝고, `MAX_SUBMIT_ATTEMPTS = 4` 인 결정 두 개 반에 해당한다) 에 도달하면 `onExhausted(code, attempts)` 를 **한 번** 부른다(카운터는 계속 세되 콜백은 문턱을 넘는 순간만). 상수다 — 설정이 아니다. 거부(`rejected`)는 세지 않는다: 그것은 판정이지 장애가 아니다.

### 2.3 `RiskGate.lossLimitBreach(now): string | null`

`evaluate()` 가 이미 읽는 두 fold 를 결정 없이 묻는 질문으로 노출한다: `consecutiveLosses() >= maxConsecutiveLosses` 또는 `realizedPnlOn(today) <= -maxDailyLoss` 면 사유 문자열, 아니면 `null`. `evaluate()` 의 BUY 거부는 그대로 남는다(격상은 cycle 경계에서, 거부는 결정 순간에 — 둘 사이 최대 `pollIntervalMs` 동안 게이트가 진입을 막는다).

### 2.4 `FillProcessor.process()` — wedge 가 배리어를 함께 내린다

`resolve()` 를 감싸 `DomainError` 이고 `code === 'INVARIANT_VIOLATION'` 이면 `killSwitch.engage('fill-wedge', message)` 를 **기다리지 않고** 시작한 뒤 원래 오류를 **재throw** 한다. 커서는 그대로(§16.46 의 wedge 의미 보존), `StreamClient` 는 throw 를 담아 보고하고 재연결마다 재생한다 — 그때마다 `engage` 가 다시 불리지만 멱등이라 조용하다. 기다리지 않는 이유: 스윕은 포트폴리오를 읽고 취소를 제출하는 네트워크 작업이고, 이벤트 드레인 체인 위에서 그것을 기다리면 뒤의 이벤트가 그만큼 늦는다.

옵션은 `killSwitch?: Pick<KillSwitch, 'engage'>` — 백테스트 엔진은 넘기지 않는다.

### 2.5 `RunnerSupervisor` — 배선과 정지 자세

생성자에서 `KillSwitch` 를 만들고 게이트웨이에 `barrier: (kind) => killSwitch.permits(kind)`, `onExhausted` 를, fill processor 에 `killSwitch` 를 넘긴다. 스윕은 `KillSwitch` 가 `gateway`·`portfolio()`·`state` 를 받아 스스로 한다(§2.6).

`start()`: 래치 상태면 보고 한 줄, 그리고 `recoverPending()` 은 그대로 돈다(pending cancel 재시도가 여기서 일어난다).

`cycle()`:

```
observeOperatorFile()
if (!engaged) { breach = risk.lossLimitBreach(); if (breach) await engage('loss-limit', breach) }
portfolio 읽기; context.observePortfolio
ticks = feed.drain()
for tick: recorder.record; context.observeTick; if (!engaged) host.onTick → applyDecision
persist()
heartbeat()
```

걸린 뒤에도 포트폴리오 읽기·feed drain·recorder·cursor persist 는 계속한다: 큐가 쌓이지 않고, 틱 로그는 연구 자료로 남고, 재개 후 커서가 맞는다. 바뀌는 것은 **호스트에 틱을 주지 않는 것** 하나다. 스트림과 `FillProcessor` 는 계속 돈다 — 스윕이 낸 취소의 체결 이벤트가 이 경로로 장부에 들어온다. `StrategyHost.onFill` 이 결정을 내면 게이트웨이 배리어가 halted 로 정산한다(호스트 쪽에 두 번째 게이트를 두지 않는다 — 배리어는 한 곳이다).

### 2.6 취소 스윕

`engage` 의 나머지 절반. 순서가 곧 안전성이다:

1. `await gateway.idle()` — 진행 중인 제출이 정산될 때까지, **최대 `SWEEP_IDLE_WAIT_MS = 5초`**. 상한이 이기면 원래의 `idle()` 이 풀리는 순간 **스윕을 한 번 더** 돈다 — 상한 뒤에 원장에 닿은 place 를 방치하지 않기 위해(레인 2 검증 BLOCKER). "in-flight submission racing a cancel sweep": 방금 나간 주문은 다음 단계의 포트폴리오 읽기에 나타나야 한다. 상한을 두는 이유: `idle()` 은 백오프 중인 제출에 잡혀 있을 수 있고, 그 시간만큼 미체결이 남는 것이 더 나쁜 실패다 — 상한 뒤에 정산되는 주문은 재스캔이나 다음 재시작의 `resume()` 이 잡는다.
2. 최대 `MAX_SWEEP_PASSES = 5` 패스. 각 패스: `portfolio()` 재조회 → `isOpenOrder` 필터 → 각 주문에 대해 게이트웨이 경로로 `record('kill-switch', { kind: 'cancel', orderId, reason }, tick?, { decisionId: 'kill:' + engagedAt + ':' + orderId })` 후 `submit()`. 빈 스캔이면 종료.
   - 게이트웨이 경로를 쓰는 이유: 결정 로그에 남고(감사), `decisionId` 가 결정론적이라 `appendDecision` 이 멱등하며(결정 행은 하나 — 재스윕·재스캔은 아직 열린 주문에 같은 키로 취소 **요청**을 다시 보내고, 원장의 멱등성이 그것을 재생으로 만든다; 이것은 의도다 — 주문이 아직 열려 있다는 것이 재전송의 이유다, #88 의 관찰), 실패한 취소는 pending cancel 로 남아 **재시작의 `recoverPending` 이 재시도**한다. 스윕이 자기만의 취소 코드를 갖지 않는다.
   - `record()` 는 `tick` 을 `notionalOf` 에만 쓰고 cancel 은 notional 을 기록하지 않으므로, cancel 에 한해 `tick` 을 선택으로 완화한다.
3. 스윕 자체가 던지면(포트폴리오 읽기 실패 등) `error` 로 **코드만** 보고한다 — 메시지는 서버의 것일 수 있다(§7.3). 5패스 뒤에도 열린 주문이 남으면 `error` 로 남은 `orderId` 목록을 보고한다. 러너는 계속 산다(§0.3); 다음 재시작이 pending cancel 을 다시 낸다 — 정확히는 `recoverPending` 이 기록된 취소를 재제출하고, 이어지는 `resume()` 의 재스윕이 기록되지 못한 나머지를 읽는다.
4. 스윕 중 취소가 `rejected` 되는 경우(예: 이미 체결됨) 는 정상이다 — 다음 패스의 포트폴리오에 없다.

스윕 실패가 게이트웨이 연속 실패 카운터를 올려 `onExhausted` 를 다시 부를 수 있다 — `engage` 가 멱등이라 무해하다.

### 2.7 Quarantine 과의 관계

| | quarantine | kill switch |
|---|---|---|
| 단위 | 전략 하나 | 러너 전체 |
| 영속 | 없음(재시작이 푼다) | 파일(사람이 푼다) |
| 미체결 | 그대로 | 취소 스윕 |
| 트립 | 연속 throw 3회 | §2 의 네 소스 |

quarantine 은 킬 스위치를 **트립하지 않는다**(전략 하나의 결함으로 다른 전략을 멈추지 않는다 — B 의 결정). 킬 스위치는 quarantine 을 **무시한다**(걸리면 어차피 아무 호스트도 틱을 못 받는다). 둘 다 걸린 전략의 보고는 각자 한 번씩이다. 같은 결함이 둘 다 건드리는 경로는 없다: 전략 throw 는 호스트가 삼키고, 킬 스위치 소스 넷은 전부 전략 바깥이다.

## 3. 설정

**없음.** `KILL_SWITCH_AFTER_FAILED_ATTEMPTS = 10`, `MAX_SWEEP_PASSES = 5`, `HEARTBEAT_MS = 30 * 60 * 1000` 은 코드 상수다. 설계 §7.2 가 10 을 적었고, 나머지 둘은 운영자가 고를 이유가 없다. 손실 한도 두 개는 이미 설정에 있다.

## 4. 문서·스펙

- §16.48 한 행: (a) 아키텍처 스펙 "kill switch 는 자동 취소 안 함" 대비 봇의 자동 스윕, (b) `halted` 정산 — 트립 전 결정은 되살리지 않는다, (c) §7.2 "10회" = 연속 실패 attempt, (d) 손실 한도의 격상(거부 → 킬 스위치), (e) 살아있는 정지 자세, (f) 운영자 파일 트립(설계에 없는 추가), (g) fill wedge 가 배리어를 함께 내림(§16.46 의 "phase D" 를 닫음).
- README: "Quarantine is not a kill switch" 절을 §2.7 표로, 상태 파일 표에 `kill-switch.json`, "What is not here" 표의 D 행 갱신, 운영 절차(걸기·풀기) 한 단락.
- 러너 설계 문서(`2026-08-30-…-strategy-runner-design.md`)는 이 브랜치의 첫 커밋으로 main 에 들어온다(그동안 `origin/spec/trading-bot` 에만 있어 README 링크가 깨져 있었다).

## 5. 테스트

단위(vitest, `apps/strategy-runner`):

- `kill-switch.test.ts`: 첫 `engage` 만 파일 쓰기·보고, 두 번째는 조용·같은 Promise; 파일이 있는 채 생성 → engaged; 운영자 파일(정상·`reason` 없음·깨진 JSON) 세 모양; heartbeat 30분 경계; 스윕 — `idle` 을 기다린 뒤 읽는다(in-flight 중엔 포트폴리오 읽기 0), 2패스에 걸쳐 새로 나타난 주문도 취소, `decisionId` 결정론, 5패스 잔존 보고.
- `order-gateway.test.ts`: `barrier` 가 place 를 막으면 `halted` 정산 + 반환, cancel 은 통과; 백오프 사이에 배리어가 닫히면 다음 attempt 없음; `idle` 이 in-flight 정산 뒤 풀림; retryable 실패 10회 연속에 `onExhausted` 한 번, 성공이 카운터 리셋, `rejected` 는 안 셈; `recoverPending` 아래 래치 → place halted·cancel 재제출.
- `state-store.test.ts`: `halted` 레코드가 읽히고 그 결정은 pending 이 아니다; **시도 0회로** halted 된 결정은 `dailyEntryNotional` 에 들지 않는다(내지 않은 주문이 같은 날 래치를 푼 운영자의 예산을 깎지 않는다) — 시도 뒤 halted 는 원장에 닿았을 수 있어 계속 센다(`SubmissionRecord.attempts`).
- `risk-gate.test.ts`: `lossLimitBreach` 두 한도 각각, 경계값(같음 = 걸림), 둘 다 아니면 `null`.
- `fill-processor.test.ts`: §16.46 세 모양 각각에서 `engage('fill-wedge')` 호출 + 재throw + 커서 불변.
- `supervisor.test.ts`: 래치 cycle 에 `onTick` 0회·drain·persist 는 있음; 운영자 파일 → 다음 cycle 에 걸림; `lossLimitBreach` → engage; 재시작 시 `resume` 보고; **배선 고정** — 래치 아래 `recoverPending` 의 pending place 가 halted(배리어 배선), 503 연속으로 `submission-failures`(`onExhausted` 배선), 스트림의 설명 불가 fill 로 `fill-wedge`(`FillProcessor` 배선), 30분 뒤 heartbeat(`heartbeat()` 호출).

통합(`apps/paper-api`, Testcontainers, 기존 `strategy-runner*.integration.test.ts` 옆): **"a tripped runner cancels its resting orders and places nothing afterwards, across a restart"** — 지정가 2건이 원장에 열린 상태에서 운영자 파일로 트립 → 원장에서 둘 다 `CANCELLED`, 이후 틱에 주문 0, 재시작 뒤에도 0, `kill-switch.json` 과 `submissions.ndjson` 의 `halted` 행 존재.

변이 확인(리뷰 레인 증거, 실제 결과): 게이트웨이의 배리어 분기 제거 → `order-gateway.test.ts` 2건 + `supervisor.test.ts`(운영자 파일) 가 문다 — 통합 테스트는 물지 **않는다**(래치 cycle 의 조기 반환이 먼저 틱을 막아 place 가 게이트웨이에 닿지 않는다); `#halt` 의 `outcome` 을 `rejected` 로 → `order-gateway.test.ts` 의 로그 행 단언이 문다(첫 시도엔 살아남아 보강); `idle()` 대기 제거 → `kill-switch.test.ts` in-flight 테스트가 문다; **배선** 넷(supervisor 의 `barrier`·`onExhausted`·`killSwitch`·`heartbeat()`) 은 각각 `supervisor.test.ts` 의 "recovered pending place", "ten failed submission attempts", "unexplainable fill on the stream", "heartbeat interval" 이 문다(레인 1 리뷰가 잡은 빈틈); 파일을 보고·스윕 뒤로 옮기면 `kill-switch.test.ts` "latch on disk before the first report" 가 문다.

## 6. 하지 않는 것

- 포지션 청산(시장가 매도) — 사람의 일이다.
- 자동 해제, 시간 기반 해제.
- Discord 임베드 연결 — `Reporter` 심을 지나며, 매핑은 #93 의 배선이 한다. `error` 레벨 한 줄이 이 PR 의 전부다.
- `maxDailyNotional` 의 "당일 일시정지"(설계 §6 표) — 거부로 남는다. 별개 메커니즘이고 노출을 늘리지 않는다.
- #88(재생 발산 → 킬 스위치 트립 후보), #89.
