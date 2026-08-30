# Moi Strategy Runner (자동매매 봇) Design

- 문서 상태: 설계 문서 (design-only, 구현 전 교차검증 대상)
- 기준 커밋: `dd7ca0d` (`Merge pull request #29 from changminKo/fix/status-signature`)
- 선행 문서: [`2026-08-21-moi-paper-trading-architecture-design.md`](2026-08-21-moi-paper-trading-architecture-design.md), [`2026-08-27-moi-production-runtime-and-provider-handoff-design.md`](2026-08-27-moi-production-runtime-and-provider-handoff-design.md), [`docs/operations/deployment.md`](../../operations/deployment.md), [`AGENTS.md`](../../../AGENTS.md)
- 이 문서는 코드가 아니라 계약이다. 이 문서와 코드가 다르면 코드가 틀린 것이며, 문서를 바꾸려면 이 문서를 먼저 고친다.

## 0. 승인된 결정 (사용자)

| 축 | 결정 | 함의 |
|---|---|---|
| 실행 위치 | **별도 컨테이너** (`apps/strategy-runner`, compose 서비스 `bot`) | 공개 HTTP API만 사용. 원장·엔진 코드를 링크하지 않는다. 봇이 죽어도 거래 API는 산다. |
| 전략 범위 | **프레임워크부터 제대로** | 전략 레지스트리, 파라미터 스키마, 백테스트 하네스, 다중 전략 동시 실행. |
| 조종·관제 | **설정 파일 + Discord 알림** | 웹 UI 변경 0. 웹훅 URL은 별도 시크릿(`BOT_DISCORD_WEBHOOK_URL`)으로 주입되며 이 문서·저장소·로그에 값이 남지 않는다. |

## 1. 배경

`packages/strategy-sdk`에는 이미 다음이 있다.

| 부품 | 위치 | 상태 |
|---|---|---|
| `Broker` 인터페이스 (`placeOrder`/`cancelOrder`/`exchange`/`getPortfolio`) | `src/broker.ts` | 완성, 계약 테스트 있음 |
| `PaperBroker` (경로 화이트리스트 HTTP 어댑터) | `src/paper-broker.ts` | 완성. `/api/v1/orders`, `/api/v1/fx/conversions`, `/api/v1/portfolio`만 도달 가능 — **설정으로 실거래소를 가리킬 수 없다** |
| 커맨드 디코더·검증 (`readPlaceOrderCommand` 등) | `src/broker.ts`, `src/validation.ts` | 완성 |
| 브로커 계약 테스트 스위트 | `src/broker-contract.ts` | 완성 |

없는 것은 전략을 **실행**하는 모든 것이다: 시세 입력, 전략 수명주기, 스케줄러, 상태 보존, 리스크 한도, 백테스트, 관측.

이 문서는 그 공백을 채우되, 기존 SDK의 두 가지 안전 속성을 깨지 않는다.

1. `PaperBrokerPath` 화이트리스트 — 전략은 페이퍼 API 밖으로 주문을 보낼 수 없다.
2. 모든 금액은 `DecimalString`. 전략 코드에서도 JS `number` 산술을 쓰지 않는다.

## 2. 범위

### 2.1 이번 설계가 포함하는 것

- `packages/strategy-sdk`에 전략 계약(`Strategy`, `StrategyContext`, `StrategyDecision`) 추가.
- `apps/strategy-runner` 신규 앱: 설정 로드 → 세션 확보 → 시세 구독 → 전략 실행 → 주문 제출 → 상태 저장 → Discord 보고.
- 리스크 게이트(주문당·일일·포지션·연속손실), 킬 스위치.
- 백테스트 러너: 동일한 `Strategy` 구현을 기록된 틱으로 재생.
- 전략 2종: `sma-crossover`(추세), `grid`(횡보). 둘 다 파라미터 스키마를 가진다.
- compose 서비스 `bot`, systemd 통합, Discord 알림.

### 2.2 명시적 비범위

- 웹 UI 변경, 봇 제어용 신규 공개 API (§0 결정).
- 실거래·실계좌 연동. `PaperBroker` 화이트리스트를 넓히지 않는다.
- 과거 캔들 기반 지표. 캔들 엔드포인트는 아직 없다(§8.2 의존성).
- 다중 세션·다중 계정. 봇은 자기 익명 세션 하나만 쓴다.

## 3. 아키텍처

```
                    ┌──────────────────────────────────────────┐
  infra/compose     │ bot (apps/strategy-runner)               │
                    │                                          │
                    │  ConfigLoader ─→ RunnerSupervisor         │
                    │                    │                      │
                    │        ┌───────────┼───────────┐          │
                    │        ▼           ▼           ▼          │
                    │  StrategyHost  StrategyHost  ...          │
                    │   (전략 1)      (전략 2)                   │
                    │        │           │                      │
                    │        └─────┬─────┘                      │
                    │              ▼                            │
                    │        RiskGate → OrderGateway            │
                    │              │         │                  │
                    │        StateStore   PaperBroker(SDK)      │
                    │              │         │                  │
                    │         (SQLite)       │  Reporter ──→ Discord
                    └────────────────────────┼──────────────────┘
                                             ▼  HTTPS (공개 API만)
                    ┌────────────────────────────────────────────┐
                    │ paper-api  (변경 없음)                      │
                    │  POST /api/v1/sessions/anonymous            │
                    │  GET  /api/v1/instruments                   │
                    │  GET  /api/v1/markets/{m}/symbols/{s}/quote │
                    │  GET  /api/v1/stream            (WebSocket) │
                    │  POST /api/v1/orders  DELETE /api/v1/orders/{id} │
                    │  GET  /api/v1/portfolio                     │
                    │  GET  /api/v1/health/trading                │
                    └────────────────────────────────────────────┘
```

**경계 규칙**: `apps/strategy-runner`는 `@moi/strategy-sdk`와 `@moi/trading-core`에만 의존한다. `@moi/paper-api`, `@moi/market-data`를 import 하지 않는다(패키지 의존성으로 강제하고 `package-surface` 테스트로 고정). 봇은 paper-api의 데이터베이스에 접속하지 않는다.

## 4. 전략 계약 (`@moi/strategy-sdk` 확장)

```ts
export interface Tick {
  readonly market: Market;
  readonly symbol: string;
  readonly price: DecimalString;      // null 가격은 전달하지 않는다
  readonly asOf: string;              // ISO instant
  readonly health: 'HEALTHY' | 'DEGRADED' | 'RECOVERING';
}

export interface StrategyContext {
  /** 이 전략이 구독한 심볼의 최신 틱. 없으면 undefined. */
  latest(market: Market, symbol: string): Tick | undefined;
  /** 러너가 유지하는 롤링 윈도우. 길이는 전략 파라미터가 선언한 최대치. */
  window(market: Market, symbol: string): readonly Tick[];
  /** 러너가 최근에 읽은 포트폴리오 스냅샷(캐시). 주문 직전에 갱신된다. */
  portfolio(): PortfolioSnapshot;
  /** 이 전략이 낸 미체결 주문. */
  openOrders(): readonly OrderSnapshot[];
  /** 결정론적 시각. 백테스트에서는 재생 시각이다. */
  now(): string;
  /** 구조화 로그. 비밀은 자동 마스킹된다(§7.3). */
  log(event: string, fields?: Readonly<Record<string, string>>): void;
}

export type StrategyDecision =
  | { readonly kind: 'noop'; readonly reason?: string }
  | { readonly kind: 'place'; readonly command: PlaceOrderCommand; readonly reason: string }
  | { readonly kind: 'cancel'; readonly command: CancelOrderCommand; readonly reason: string };

export interface Strategy<P = unknown> {
  readonly id: string;                       // 레지스트리 키, kebab-case
  readonly parameterSchema: ParameterSchema<P>;
  /** 구독할 심볼. 설정에서 온 값을 검증해 돌려준다. */
  subscriptions(params: P): readonly InstrumentRef[];
  /** 시작 시 1회. 상태 복원 용도. 주문을 내지 않는다. */
  onStart?(context: StrategyContext, params: P): void;
  /** 틱마다. 순수 함수여야 한다: 같은 입력 → 같은 결정. */
  onTick(tick: Tick, context: StrategyContext, params: P): readonly StrategyDecision[];
  /** 체결 통지. 상태 갱신용. 주문 결정도 반환할 수 있다. */
  onFill?(fill: FillEvent, context: StrategyContext, params: P): readonly StrategyDecision[];
}
```

**핵심 제약**

- `onTick`은 **동기·순수**하다. I/O를 하지 않고, 시각은 `context.now()`로만 얻는다. 이것이 백테스트와 실행이 같은 코드를 쓰는 근거다.
- 전략은 주문을 **직접 보내지 않는다**. 결정을 반환할 뿐이고, 제출은 `RiskGate` → `OrderGateway`가 한다.
- 랜덤이 필요하면 `params`에 시드를 받는다. `Math.random()` 사용은 lint 규칙으로 금지한다.

### 4.1 파라미터 스키마

```ts
export interface ParameterSchema<P> {
  parse(input: unknown): P;          // 실패 시 ConfigError, 필드 경로 포함
  readonly describe: Readonly<Record<string, string>>; // Discord 보고·문서용
}
```

zod를 쓰지 않고 `trading-core`의 기존 검증 유틸을 쓴다(런타임 의존성 추가 회피). 수치 파라미터도 `DecimalString`으로 받는다.

## 5. 러너 구조 (`apps/strategy-runner`)

| 모듈 | 파일 | 책임 |
|---|---|---|
| `ConfigLoader` | `src/config.ts` | `BOT_CONFIG_PATH`의 TOML/JSON 로드, 스키마 검증, 시크릿은 env에서만 |
| `SessionClient` | `src/session-client.ts` | 익명 세션 생성·쿠키/CSRF 보관·만료 시 재수립 |
| `QuoteFeed` | `src/quote-feed.ts` | `/api/v1/stream` WebSocket 구독, 끊기면 지수 백오프 재연결, 폴백으로 REST 폴링 |
| `StrategyHost` | `src/strategy-host.ts` | 전략 1개의 윈도우·상태·수명주기 |
| `RiskGate` | `src/risk-gate.ts` | 결정 → 허용/거부. §6 |
| `OrderGateway` | `src/order-gateway.ts` | 멱등 키 생성, 제출, 재시도, 결과 기록 |
| `StateStore` | `src/state-store.ts` | SQLite(`better-sqlite3` 대신 `node:sqlite` 내장 모듈) 영속화 |
| `Reporter` | `src/reporter.ts` | Discord 임베드. 기존 `infra/oracle/notify.sh`와 같은 마스킹 규칙 |
| `RunnerSupervisor` | `src/supervisor.ts` | 조립, 우아한 종료, 킬 스위치 |

### 5.1 제어 흐름 (한 틱)

1. `QuoteFeed`가 틱을 방출한다.
2. `StrategyHost`가 윈도우에 넣고 `strategy.onTick(...)`을 호출한다.
3. 결정 배열을 `RiskGate`가 순서대로 평가한다. 거부된 결정은 사유와 함께 기록되고 버려진다.
4. 허용된 결정은 `OrderGateway`가 제출한다. `place`는 `Idempotency-Key`를 반드시 붙인다(§5.3).
5. 결과(성공·거부·오류)를 `StateStore`에 append, 필요하면 `Reporter`가 Discord로 보낸다.
6. `paper-api`가 `CANCEL_ONLY`/`MARKET_CLOSED`/`503`을 반환하면 전략을 일시정지하고 백오프한다(§7.2).

### 5.2 상태 (SQLite, 볼륨에 저장)

```
strategy_runs(id, strategy_id, params_hash, started_at, stopped_at, status)
decisions(id, run_id, at, tick_as_of, kind, reason, accepted, risk_reason)
submissions(id, run_id, decision_id, idempotency_key, order_id, status, error_code, at)
positions_cache(run_id, market, symbol, quantity, avg_cost, updated_at)
kill_switch(reason, engaged_at)
```

재시작 시 `submissions`의 미결 항목을 `GET /api/v1/portfolio`와 대조해 복원한다. 봇의 상태는 **사실의 원본이 아니다** — 원장이 원본이고, 봇 상태는 캐시·감사 기록이다.

### 5.3 멱등성

`Idempotency-Key = sha256(run_id | strategy_id | decision_id)`의 앞 32자. 재시작 후 같은 결정을 다시 제출해도 원장은 주문을 한 번만 만든다. 키는 결정이 저장된 **뒤에** 계산되므로 크래시 시점과 무관하게 재현된다.

### 5.4 시세 입력

1차: `GET /api/v1/stream` WebSocket. 세션 쿠키로 인증한다.
2차(폴백): 심볼당 `GET /api/v1/markets/{market}/symbols/{symbol}/quote`를 5초 간격 폴링. 웹 클라이언트와 같은 부하 특성이므로 심볼 수 상한을 설정에 둔다(기본 20).

`health`가 `DEGRADED`/`RECOVERING`인 틱은 윈도우에 넣되 **신규 진입 결정은 거부**한다(청산·취소는 허용).

## 6. 리스크 게이트

설정에서 오는 한도. 모두 `DecimalString` 비교이며, 하나라도 위반하면 결정은 거부된다.

| 한도 | 기본값 | 위반 시 |
|---|---|---|
| `maxOrderNotional` | 통화별 필수 | 거부 |
| `maxDailyNotional` | 필수 | 거부 + 당일 일시정지 |
| `maxPositionQuantity` (심볼당) | 필수 | 거부 |
| `maxOpenOrders` (전략당) | 10 | 거부 |
| `maxConsecutiveLosses` | 5 | 킬 스위치 |
| `maxDailyLossNotional` | 필수 | 킬 스위치 |
| `minTickHealth` | `HEALTHY` | 진입만 거부 |
| `allowedSymbols` | 필수(화이트리스트) | 거부 |
| `tradingHoursOnly` | true | `REGULAR` 아니면 거부 |

킬 스위치가 걸리면 러너는 (1) 모든 미체결 주문 취소 시도, (2) 신규 결정 전부 거부, (3) Discord에 `fail` 임베드, (4) `kill_switch` 행 기록. 해제는 사람이 파일에서 지우고 재시작해야 한다 — 자동 해제 없음.

## 7. 실패 모드

### 7.1 봇이 죽어도 되는 것

봇 컨테이너는 `restart: unless-stopped`. 크래시해도 paper-api·web·원장은 영향받지 않는다. 미체결 주문은 원장에 남고, 재시작 시 §5.2로 복원한다.

### 7.2 API가 거절할 때

| 응답 | 러너 동작 |
|---|---|
| `401 SESSION_EXPIRED` | 세션 재수립 후 1회 재시도 |
| `409 CANCEL_ONLY` | 진입 중단, 취소만 허용, 60초 후 재평가 |
| `409 MARKET_CLOSED` | 해당 시장 전략 일시정지, 다음 개장까지 |
| `429` | 지수 백오프(최대 5분), Discord `warn` 1회 |
| `5xx`, 네트워크 | 백오프 재시도. 3회 실패 시 `warn`, 10회 실패 시 킬 스위치 |
| `INSUFFICIENT_*` | 거부 기록만. 전략 로직 문제이므로 재시도 없음 |

### 7.3 비밀 취급

세션 토큰·CSRF·웹훅 URL은 로그·Discord·상태 DB에 남지 않는다. `Reporter`는 호스트 알림과 같은 마스킹 패스를 재사용한다(`scheme://user:pass@`, `*(TOKEN|SECRET|KEY|WEBHOOK)*=` → `***`, 웹훅 URL → `<webhook>`).

## 8. 백테스트

### 8.1 하네스

`pnpm --filter @moi/strategy-runner backtest -- --strategy sma-crossover --params ./params.json --ticks ./ticks.ndjson`

- 입력: NDJSON 틱 파일(러너가 실행 중 `--record` 옵션으로 남긴 것, 또는 `FakeMarketData`로 생성).
- 실행: 같은 `Strategy` 구현 + 같은 `RiskGate`. `OrderGateway` 자리에 `SimulatedExchange`(즉시 체결 또는 지정가 도달 시 체결, 수수료는 `trading-core`의 수수료 모델 재사용).
- 출력: 총손익, 최대낙폭, 거래 수, 승률, 거부 사유 히스토그램 — 전부 `DecimalString`.

### 8.2 알려진 한계

과거 캔들 API가 없으므로 백테스트 입력은 **직접 기록한 틱**뿐이다. Toss 계약에는 `/api/v1/market-indicators/{symbol}/candles`가 있으나 아직 어댑터·엔드포인트가 없다(별도 작업). 이 한계는 문서화된 상태로 출발한다.

## 9. 설정 예시

```toml
# /etc/moi/bot.toml — 시크릿 없음. 웹훅 URL과 API 오리진은 환경변수.
api_origin_env = "BOT_API_ORIGIN"        # 예: https://moi-app.duckdns.org
poll_interval_ms = 5000
max_symbols = 20

[[strategy]]
id = "sma-crossover"
enabled = true
[strategy.params]
market = "KR"
symbol = "005930"
fast_window = 5
slow_window = 20
order_quantity = "1"
[strategy.risk]
max_order_notional = "200000"
max_daily_notional = "1000000"
max_position_quantity = "10"
max_daily_loss_notional = "100000"
allowed_symbols = ["005930"]
```

## 10. 검증 계획

| 층 | 대상 | 도구 |
|---|---|---|
| 단위 | 전략 `onTick` 결정표(경계값 포함), 파라미터 스키마, 리스크 게이트 각 한도, 멱등 키 생성 | vitest |
| 계약 | 러너의 `Broker` 사용이 SDK 계약 테스트를 통과 | 기존 `@moi/strategy-sdk/testing` |
| 통합 | 러너 ↔ 실제 paper-api(Testcontainers + `MARKET_DATA_ADAPTER=fake`): 세션 수립, 틱 소비, 주문 제출, 401/409/429 경로, 재시작 후 멱등 복원 | vitest + Testcontainers |
| 백테스트 | 고정 틱 파일 → 고정 결과(스냅샷) | vitest |
| 실패 주입 | WebSocket 강제 종료, paper-api 재시작, 킬 스위치 발동 | 통합 테스트 |
| 배포 | compose `bot` 서비스 기동·헬스체크, systemd, Discord 임베드 1건 | `pnpm check:deployment` 확장 |

**금지**: 실제 Toss 접속(AGENTS.md 규칙 1). 봇 테스트도 `fake-toss`와 fake 어댑터만 쓴다.

## 11. 단계

| 단계 | 산출물 | 완료 기준 |
|---|---|---|
| A | SDK 전략 계약 + 파라미터 스키마 + `sma-crossover` 전략 | 단위 테스트 통과, 백테스트 없이도 결정표 고정 |
| B | 러너 골격(설정·세션·폴링 피드·상태·리스크·게이트웨이) | Testcontainers 통합 테스트에서 fake 어댑터로 주문 1건 왕복 |
| C | WebSocket 피드 + 재연결 + 실패 경로 | 강제 종료 주입 테스트 통과 |
| D | Discord 리포터 + compose/systemd 통합 | 호스트에서 임베드 수신, `check:deployment` 통과 |
| E | 백테스트 하네스 + `grid` 전략 | 스냅샷 테스트, 두 전략 동시 실행 |

각 단계는 독립 PR이며, 이전 단계가 초록이 아니면 다음 단계를 시작하지 않는다.

## 12. 열린 질문

1. `node:sqlite`(Node 24 내장, 실험 플래그 필요 여부 확인)로 충분한가, 아니면 상태를 append-only NDJSON으로 두고 SQLite를 피할 것인가.
2. 봇 세션의 초기 자금(₩10,000,000)이 전략 규모에 맞는가. 필요하면 관리자 API로 시드하는 절차가 필요하다.
3. 다중 전략이 같은 심볼을 거래할 때 포지션 충돌을 어떻게 다룰 것인가 — 전략별 논리적 포지션을 러너가 분리 관리할지, 아니면 심볼당 전략 1개로 강제할지.
4. 봇 세션이 웹 UI 세션과 원장에서 구분되어야 하는가(감사 태그).
