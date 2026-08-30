# Moi Strategy Runner (자동매매 봇) Design — v2

- 문서 상태: 설계 문서 (design-only). v1은 Codex·agy 교차검증에서 **BLOCKED** 판정을 받았고, 이 문서가 그 지적을 흡수한 2차본이다.
- 기준 커밋: `c6ae33b` (`Merge pull request #31 …market session phase`)
- 선행 문서: [`2026-08-21-…-architecture-design.md`](2026-08-21-moi-paper-trading-architecture-design.md), [`2026-08-27-…-provider-handoff-design.md`](2026-08-27-moi-production-runtime-and-provider-handoff-design.md), [`AGENTS.md`](../../../AGENTS.md)
- 선행 이슈(구현 착수 전 해결): [#32](https://github.com/changminKo/moi/issues/32) SDK↔API 계약 불일치, [#33](https://github.com/changminKo/moi/issues/33) `activeOrders` 필터, [#34](https://github.com/changminKo/moi/issues/34) 미연결 레이트 리밋.
- 이 문서는 코드가 아니라 계약이다. 이 문서와 코드가 다르면 코드가 틀린 것이며, 문서를 바꾸려면 이 문서를 먼저 고친다.

## 0. 승인된 결정 (사용자)

| 축 | 결정 |
|---|---|
| 실행 위치 | 별도 컨테이너 `apps/strategy-runner` (compose 서비스 `bot`) |
| 전략 범위 | 프레임워크부터 제대로 (레지스트리·파라미터 스키마·백테스트·다중 전략) |
| 조종·관제 | 설정 파일 + Discord. 봇 전용 웹훅 `DISCORD_WEBHOOK_TRADE_URL`(운영 알림용 `DISCORD_WEBHOOK_URL`과 **다른 채널**)을 시크릿으로 주입하며, 값은 문서·저장소·로그·백테스트 산출물에 남기지 않는다 |

## 1. v1에서 무엇이 틀렸는가

교차검증이 찾아낸 것 중 **설계가 바뀐** 항목만 적는다. 기존 코드 결함은 §2로 분리했다.

| # | v1의 가정 | 사실 | v2의 처리 |
|---|---|---|---|
| 1 | 공개 API를 그냥 부르면 된다 | 모든 변경 요청은 `Origin === PUBLIC_ORIGIN` + CSRF 토큰 필요(`plugins/csrf.ts:19`), WS 업그레이드도 동일(`stream-upgrade.ts:338`) | §4.2 세션·헤더 계약을 명시. 봇은 `Origin`을 `PUBLIC_ORIGIN`으로 보내고 CSRF 토큰을 세션과 함께 보관 |
| 2 | 시세 20종목 구독 | `STREAM_MAX_QUOTE_SUBSCRIPTIONS = 5`, 그리고 `current >= 5`에서 거부(`rate-limits.ts:53`) → 실질 4 | §5.3 구독 상한 4, 설정 검증에서 초과를 **거부**(런타임 폴백 금지) |
| 3 | WS 프레임에 `price`/`asOf`/`health`가 있다 | 프레임은 `{type:'quote', market, symbol, recoveryEpoch, marketDataVersion, payload}`이고 `payload`는 **호가창**(`market-runtime.ts:333`). 체결(`trade`) 이벤트는 **구독자에게 발행되지 않는다**(`market-runtime.ts:315-325`) | §5.2 `Tick`을 호가창에서 유도(중간가)하거나 REST 시세로 보강. 체결 발행은 §9 선행 작업으로 분리 |
| 4 | 세션은 매번 새로 만들면 된다 | 쿠키 없이 부트스트랩하면 **새 원장 세션**(`session-service.ts:123`), 멱등성은 `(session_id, key)` 스코프(`idempotency-repository.ts:75`) | §4.3 세션 쿠키·CSRF를 상태 저장소에 영속화, 재시작 시 재사용. 새 세션은 명시적 초기화 명령으로만 |
| 5 | 게이트웨이가 결정 저장 후 멱등키를 만든다 | `PlaceOrderCommand`가 이미 `sessionId`·`idempotencyKey`를 요구(`broker.ts:31`) | §6.2 전략은 `OrderIntent`(세션·키 없음)를 반환하고, 게이트웨이가 그것을 `PlaceOrderCommand`로 승격한다 |
| 6 | 킬 스위치는 "취소 → 차단" 순서 | in-flight 주문이 취소 스윕 뒤에 커밋될 수 있다 | §7.2 제출 배리어: 차단 플래그 → in-flight 완료 대기 → 취소 스윕 → 재조회 확인 |
| 7 | 손실 한도는 메모리 카운터 | 재시작하면 초기화되어 한도를 넘겨 거래 가능 | §6.4 실현손익·연속손실을 상태 DB에 기록하고 재시작 시 원장 체결로 재구성 |
| 8 | `bot`을 compose에 추가하면 된다 | `check-deployment-contract.mjs:27`이 서비스 집합을 정확히 검사 | §8.1 체커를 함께 확장하는 것을 완료 조건에 포함 |
| 9 | 호스트 마스킹 규칙을 재사용하면 비밀이 안 샌다 | 규칙에 쿠키·CSRF 패턴이 없다(`notify.sh:33`) | §7.4 `moi_session=`, `x-csrf-token`, `Set-Cookie` 패턴을 마스커에 추가(호스트 스크립트와 러너 양쪽) |
| 10 | 신규 세션으로 미국 주식 전략 가능 | 신규 세션은 ₩10,000,000 / **$0**(`session-repository.ts:103`) | §6.5 USD 전략은 시작 시 가상 환전(`/api/v1/fx/conversions`)을 요구하고, 잔고 부족이면 기동 거부 |
| 11 | `tradingHoursOnly`를 판단할 방법이 있다 | v1 시점엔 없었음 | #31로 `GET /api/v1/markets/:market/session`이 생겼다(phase·opensAt·closesAt). §6.3이 이를 사용 |
| 12 | `activeOrders`는 미체결 주문 | 상태 필터가 없다(`portfolio-repository.ts:70`) | §2 이슈 #33. 해결 전까지 러너가 상태로 직접 거른다 |
| 13 | 백테스트가 원장 수수료 모델을 재사용 | `FeeModel`은 요율·통화·반올림 자릿수·모드를 요구하는데 공개 엔드포인트가 없다(`fee-model.ts:15`) | §8.3 수수료 파라미터를 설정에 명시하고, 실제 체결 수수료와의 괴리를 보고서에 표시 |

## 2. 선행 조건 (봇 코드보다 먼저)

봇은 **#32가 닫히기 전에는 구현을 시작하지 않는다.** SDK가 API의 정상 응답을 거부하는 상태에서 그 위에 프레임워크를 얹으면, 첫 통합 테스트가 SDK 결함을 봇 결함으로 오인하게 만든다.

| 이슈 | 봇에 대한 의미 |
|---|---|
| #32 | `placeOrder`/`getPortfolio` 디코드, STOP·OCO 와이어 형태, 401 코드 매핑. 전부 봇의 주 경로 |
| #33 | 미체결 주문 계산·킬 스위치 취소 대상 |
| #34 | 429 재시도 경로를 통합 테스트로 증명할 수 있는지 |

## 3. 아키텍처

```
  bot 컨테이너 (apps/strategy-runner)
    ConfigLoader → RunnerSupervisor
                      ├── SessionClient   (쿠키·CSRF 영속)
                      ├── MarketFeed      (WS 구독 + REST 보강)
                      ├── StrategyHost ×N (전략별 윈도우·상태)
                      ├── RiskGate        (한도·세션 위상·킬 스위치)
                      ├── OrderGateway    (Intent → Command, 멱등, 재시도)
                      ├── StateStore      (append-only NDJSON + 인덱스)
                      └── Reporter        (Discord, 마스킹)
            │
            ▼ HTTPS/WSS, Origin: $PUBLIC_ORIGIN
  paper-api (봇 때문에 바뀌는 것은 §9의 선행 작업뿐)
```

경계: `@moi/strategy-sdk`, `@moi/trading-core`만 의존한다. `@moi/paper-api`·`@moi/market-data`를 import 하지 않으며 데이터베이스에 직접 접속하지 않는다. `package-surface` 테스트로 고정한다.

## 4. 세션·전송 계약

### 4.1 오리진

`BOT_API_ORIGIN`은 **허용 목록과 대조**한다. 기본값은 `PUBLIC_ORIGIN`이며, 목록에 없는 값이면 기동을 거부한다(fail closed). 이것이 v1의 "경로 화이트리스트가 실거래소 접속을 막는다"는 잘못된 주장(경로만 제한하고 호스트는 자유였다)에 대한 실제 방어다. 추가로 `PaperBrokerTransport` 구현이 URL을 만들 때 호스트를 상수로 고정한다.

### 4.2 헤더

| 요청 | 필수 헤더 |
|---|---|
| 모든 변경(POST/DELETE) | `Origin: $PUBLIC_ORIGIN`, `X-CSRF-Token: <세션의 토큰>`, `Cookie: moi_session=…`, `Idempotency-Key` |
| WS 업그레이드 | `Origin: $PUBLIC_ORIGIN`, `Cookie: moi_session=…` |
| 읽기 | `Cookie` (세션 스코프 데이터인 경우) |

### 4.3 세션 수명주기

1. 상태 저장소에 쿠키·CSRF 토큰·`sessionId`가 있으면 재사용하고 `GET /api/v1/portfolio`로 유효성을 확인한다.
2. 없거나 401이면 `POST /api/v1/sessions/anonymous`로 새로 만들고 **즉시 영속화**한다.
3. 세션이 바뀌면 이전 세션의 미체결 주문은 봇이 더 이상 취소할 수 없다. 따라서 세션 교체는 Discord `warn`으로 보고하고, 이전 `sessionId`를 상태에 남긴다.
4. `SESSION_EXPIRED`와 `ACCOUNT_READ_ONLY`를 구분해야 하므로, #32가 401 매핑을 고치기 전까지 러너는 HTTP 상태 코드를 직접 보는 얇은 전송 계층을 쓴다.

## 5. 시세 입력

### 5.1 소스

| 채널 | 내용 | 용도 |
|---|---|---|
| `GET /api/v1/stream?quoteSymbols=KR:005930,…` (WS) | `{type:'quote', market, symbol, recoveryEpoch, marketDataVersion, payload: OrderBookSnapshot}` | 호가·중간가, 구독 상한 4 |
| `GET /api/v1/markets/:m/symbols/:s/quote` (REST) | 최근 스냅샷(가격 포함) | 시작 시 1회, WS 공백 복구, 상한 초과 심볼 |
| `GET /api/v1/markets/:m/session` (REST, #31) | `phase`, `opensAt`, `closesAt` | 리스크 게이트의 장중 판정. 60초 캐시 |

### 5.2 `Tick` 유도

```ts
export interface Tick {
  readonly market: Market;
  readonly symbol: string;
  readonly price: DecimalString;        // 중간가 또는 REST 스냅샷 가격
  readonly priceSource: 'book-mid' | 'rest-snapshot';
  readonly bestBid: DecimalString | null;
  readonly bestAsk: DecimalString | null;
  readonly asOf: string;                // 러너 수신 시각(ISO). 제공자 시각이 아니다
  readonly marketDataVersion: string;   // 순서 판정용 단조 증가 값
}
```

- 중간가 = `(bestBid + bestAsk) / 2`, `trading-core`의 decimal 유틸로 계산하고 **시장별 호가 단위로 반올림**한다. 반올림 자릿수·모드는 설정에 명시한다(AGENTS.md 규칙 5).
- 한쪽 호가만 있으면 그 값을 쓰고 `priceSource`를 기록한다. 양쪽 다 없으면 틱을 만들지 않는다.
- `asOf`는 러너 시각임을 이름과 문서에 남긴다. 제공자 시각을 아는 척하지 않는다.
- 정렬은 `marketDataVersion`으로 한다. 역행하는 프레임은 버린다.

### 5.3 공백과 재연결

- WS는 계정 이벤트만 `afterSequence`로 재생한다. **시세는 재생되지 않는다.** 재연결하면 러너는 구독 심볼마다 REST 스냅샷을 1회 읽어 윈도우를 이어붙이고, 그 지점을 `gap` 표시로 상태에 남긴다.
- 전략은 `context.window()`에서 `gap` 이후 구간을 구분할 수 있어야 한다(`Tick.gapBefore: boolean`). SMA 같은 지표는 공백 직후 N틱 동안 진입을 보류한다.
- 구독 상한(4)을 넘는 설정은 기동 시 거부한다. 조용한 REST 폴백은 없다.

## 6. 전략과 리스크

### 6.1 전략 계약

```ts
export interface Strategy<P = unknown> {
  readonly id: string;
  readonly parameterSchema: ParameterSchema<P>;
  subscriptions(params: P): readonly InstrumentRef[];
  onStart?(state: StrategyState, context: StrategyContext, params: P): void;
  onTick(tick: Tick, context: StrategyContext, params: P): readonly StrategyDecision[];
  onFill?(fill: FillEvent, context: StrategyContext, params: P): readonly StrategyDecision[];
  /** 재시작 시 복원할 전략 자체 상태. JSON 직렬화 가능해야 한다. */
  snapshot?(): StrategyState;
}
```

`onTick`은 동기·순수. `context.now()` 외의 시각·난수·I/O 금지(lint 규칙으로 강제).

### 6.2 결정 → 주문

```ts
type StrategyDecision =
  | { kind: 'noop'; reason?: string }
  | { kind: 'place'; intent: OrderIntent; reason: string }   // sessionId·idempotencyKey 없음
  | { kind: 'cancel'; orderId: string; reason: string };
```

`OrderGateway`가 (1) 결정을 상태에 append → (2) `decisionId`로 멱등키 유도 → (3) `OrderIntent` + 세션 + 키를 `PlaceOrderCommand`로 승격 → (4) 제출. 크래시가 어디서 나든 재기동 시 같은 키가 재계산된다.

### 6.3 리스크 게이트

| 한도 | 판정 근거 |
|---|---|
| 주문·일일 명목, 포지션 수량, 미체결 수 | 상태 DB + `/api/v1/portfolio`(#33 해결 전까지 상태로 직접 필터) |
| 연속 손실, 일일 손실 | §6.4 |
| 장중 한정 | `GET /api/v1/markets/:m/session`의 `phase === 'REGULAR'` |
| 심볼 화이트리스트 | 설정 |
| 시세 신선도 | 마지막 틱이 N초 이상 오래되면 진입 거부 |

**전략 격리**: 한 심볼은 **한 전략만** 거래한다. 설정 검증에서 심볼 중복을 거부한다. 여러 전략이 한 세션의 지갑·포지션을 공유하는 구조에서 논리 포지션을 분리하는 것은 이번 범위 밖이며, 그 이유를 여기 남긴다(교차검증 HIGH 지적).

### 6.4 손익 추적

체결은 WS 계정 이벤트로 받는다. 러너는 `accountSequence`(마지막 처리 이벤트 커서)를 상태에 저장하고, 재연결·재시작 시 그 지점부터 재생한다. 실현손익·연속손실은 체결에서 계산해 append 하며, 재시작 시 커서 이후 이벤트를 재생해 재구성한다. `onFill`이 주문을 낼 수 있으므로 이벤트 처리는 **커서 전진과 같은 트랜잭션**에서 기록한다(중복 발주·누락 방지).

### 6.5 통화

USD 전략은 기동 시 필요한 USD를 `/api/v1/fx/conversions`로 확보한다. 설정에 `initial_fx`가 없고 잔고가 부족하면 기동을 거부한다.

## 7. 실패와 안전

### 7.1 API 응답 처리

HTTP 상태와 도메인 코드를 **둘 다** 본다. `401`→세션 재수립 1회, `409 CANCEL_ONLY`→진입 중단·취소만, `409 MARKET_CLOSED`→해당 시장 일시정지, `429`→지수 백오프, `5xx`/네트워크→백오프 후 재시도(3회 경고, 10회 킬 스위치), `INSUFFICIENT_*`→재시도 없이 기록.

### 7.2 킬 스위치

순서를 고정한다: **차단 플래그 세팅 → in-flight 제출 완료 대기(배리어) → 미체결 주문 취소 → `/api/v1/portfolio` 재조회로 잔여 확인 → 상태·Discord 기록.** 잔여가 남으면 `fail`로 보고하고 사람이 개입할 때까지 반복 취소한다. 해제는 사람이 상태 파일을 지우고 재시작해야 한다.

### 7.3 봇 격리

`restart: unless-stopped`. 봇이 죽어도 paper-api·web·원장은 영향 없다. 원장이 사실의 원본이고 봇 상태는 캐시·감사 기록이다.

### 7.4 비밀

마스킹 규칙에 `moi_session=…`, `x-csrf-token: …`, `Set-Cookie: …`, `Idempotency-Key`를 추가한다(러너와 `infra/oracle/notify.sh` 양쪽). 봇은 `DISCORD_WEBHOOK_TRADE_URL`만 읽고 운영용 `DISCORD_WEBHOOK_URL`은 읽지 않는다 — 채널이 분리되어야 거래 소음이 장애 알림을 덮지 않는다. 상태 저장소의 쿠키·토큰 파일은 0600, 로그·Discord·백테스트 산출물에 절대 포함하지 않는다.

## 8. 상태·백테스트·배포

### 8.1 상태 저장

append-only NDJSON + 재시작 시 메모리 인덱스. `node:sqlite`는 쓰지 않는다(Node 24에서 실험적, v1의 열린 질문 1 해결). 파일: `runs.ndjson`, `decisions.ndjson`, `submissions.ndjson`, `fills.ndjson`, `session.json`(0600), `cursor.json`, `kill-switch.json`. compose 볼륨에 저장한다.

배포: compose 서비스 `bot` 추가 + `scripts/check-deployment-contract.mjs`의 서비스 집합·CI 단계 확장을 **같은 커밋에서** 한다.

### 8.2 백테스트

`--record`로 남긴 NDJSON 틱을 같은 `Strategy`·`RiskGate`로 재생한다. 체결은 `SimulatedExchange`(지정가 도달 시 체결, 시장가는 반대편 최우선호가).

### 8.3 수수료

설정에 요율·통화·반올림 자릿수·모드를 명시하고 `FeeModel`을 구성한다. 실제 원장 수수료와 다를 수 있음을 백테스트 보고서 머리에 명시한다. 공개 수수료 엔드포인트가 생기면 그때 설정 대신 조회한다.

### 8.4 알려진 한계

과거 캔들 API가 없어 백테스트 입력은 직접 기록한 틱뿐이다. Toss 계약의 `/market-indicators/{symbol}/candles`는 아직 어댑터·엔드포인트가 없다(별도 작업).

## 9. paper-api 선행 작업 (봇 때문에 필요한 것)

이것들은 봇 PR이 아니라 **API PR**로 먼저 낸다. 각각 스펙 §16 행을 동반한다.

1. **체결(trade) 이벤트 발행**: 현재 `publishQuote`는 호가창만 보낸다. 체결 가격 틱이 필요하면 `trade` 이벤트도 발행해야 한다. 없으면 봇·웹 스파크라인 모두 중간가로만 산다. — 우선순위 판단 필요.
2. #32/#33/#34 해결.
3. (선택) 구독 상한 상향. 지금은 상한 4를 그대로 받아들인다.

## 10. 검증 계획

| 층 | 대상 |
|---|---|
| 단위 | 전략 결정표(경계값), 파라미터 스키마, 리스크 각 한도, 멱등키 유도, 중간가 반올림, gap 판정 |
| 계약 | `PaperBroker`가 **실제 앱**을 상대로 통과(Testcontainers) — #32의 회귀 방지 |
| 통합 | 세션 재사용·만료·교체, 주문 왕복, 401/409/429 경로, 재시작 후 멱등 복원, 커서 재생으로 중복 없는 `onFill` |
| 실패 주입 | WS 강제 종료 후 REST 보강, paper-api 재시작, 킬 스위치 배리어(in-flight 제출 중 발동), 두 전략이 같은 심볼을 설정했을 때 기동 거부 |
| 백테스트 | 고정 틱 → 고정 결과 스냅샷 |
| 배포 | `bot` 서비스 기동·헬스체크, 계약 체커 통과, Discord 임베드 1건 |

**금지**: 실제 Toss 접속(AGENTS.md 규칙 1). 봇 테스트도 fake 어댑터만 쓴다.

## 11. 단계

| 단계 | 산출물 | 완료 기준 |
|---|---|---|
| 0 | #32 해결 + `PaperBroker` 실앱 계약 테스트 | 실앱 상대 왕복 성공 |
| A | 전략 계약·파라미터 스키마·`sma-crossover` | 결정표 단위 테스트 |
| B | 러너 골격(설정·세션 영속·REST 피드·상태·리스크·게이트웨이) | 통합 테스트에서 주문 1건 왕복 + 재시작 멱등 |
| C | WS 구독·재연결·gap 보강·체결 커서 | 강제 종료 주입 통과, 중복 `onFill` 없음 |
| D | 킬 스위치 배리어·Discord·compose/계약 체커 | 배리어 테스트, 호스트에서 임베드 수신 |
| E | 백테스트·`grid` 전략 | 스냅샷 테스트, 두 전략 동시 실행(다른 심볼) |

이전 단계가 초록이 아니면 다음 단계를 시작하지 않는다.

## 12. 남은 열린 질문

1. 체결 이벤트 발행(§9.1)을 이번에 할 것인가, 중간가로만 갈 것인가. 중간가만 쓰면 체결가 기반 전략은 만들 수 없다.
2. 구독 상한 4가 다중 전략 목표와 충돌한다. 상한을 올릴 것인가, 심볼 수를 제한할 것인가.
3. 봇 세션을 원장에서 구분할 태그가 필요한가(감사·정리 용도).
