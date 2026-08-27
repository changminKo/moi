# Skipjack Production Market Runtime and Provider Handoff Design

- 문서 상태: 승인된 아키텍처를 구체화한 설계 문서 (Task 10 A/B/C, design-only)
- 기준 커밋: `97921b7` (`docs: record public mvp acceptance evidence`)
- 선행 문서: [`2026-08-21-skipjack-paper-trading-architecture-design.md`](2026-08-21-skipjack-paper-trading-architecture-design.md), [`docs/operations/deployment.md`](../../operations/deployment.md), [`docs/operations/release-checklist.md`](../../operations/release-checklist.md)
- 구현 책임: Claude (implementation owner). 각 단계는 Codex가 독립 검증한다.
- 이 문서는 코드가 아니라 계약이다. 이 문서와 코드가 다르면 코드가 틀린 것이며, 문서를 바꾸려면 이 문서를 먼저 고친다.

## 1. 배경과 문제

릴리스 체크리스트의 유일한 미완 항목은 다음이다.

> Graceful deployment preserves `CANCEL_ONLY → old leader disconnect → new leader recovery → NORMAL` and never creates a third provider connection.

`apps/paper-api/src/main.ts`의 현재 `startProductionServer()`는 다음을 조립하지 않는다.

| 이미 존재하는 부품 | 위치 | 현재 `main.ts`에서의 상태 |
|---|---|---|
| `StartupCoordinator` | `src/lifecycle/startup-coordinator.ts` | 사용 안 함 |
| `ShutdownCoordinator` | `src/lifecycle/shutdown-coordinator.ts` | 사용 안 함 (`drain`이 `database.destroy()`만 호출) |
| `LeaderLease` (PostgreSQL advisory lock + `leader_epochs`) | `src/market-data/leader-lease.ts` | 사용 안 함 |
| `RecoveryCoordinator` | `src/market-data/recovery-coordinator.ts` | 사용 안 함 |
| `MarketHealthMachine` | `src/market-data/health-machine.ts` | 사용 안 함 |
| `MarketStateStore` | `src/market-data/market-state-store.ts` | 사용 안 함 |
| `PaperEngine` | `src/engine/paper-engine.ts` | 사용 안 함 (`placement.engine`이 no-op 스텁) |
| `OutboxPublisher`, `claimPendingOutbox`, `markOutboxPublished`, `prunePublishedOutbox` | `src/modules/stream/outbox-publisher.ts` | 사용 안 함 |
| `registerStreamRoutes` / `StreamSession` | `src/modules/stream/` | 등록 안 됨 (WebSocket upgrade 핸들러도 없음) |
| `TossRestClient`, `TossWebSocketMarketData`, `buildSubscriptionPlan` | `packages/market-data/src/toss/` | 사용 안 함 |
| `FakeMarketData` | `packages/market-data/src/fake-market-data.ts` | `MARKET_DATA_ADAPTER=fake`일 때만 “cancelOnly=false” 플래그로 참조 |

그 결과 프로덕션 이미지는 fail-closed로 `CANCEL_ONLY`에서 시작하고, 실제 시세도, 리더 인계도, outbox 발행도 없다. 이 문서는 그 부품들을 하나의 `ProductionRuntime` 경계 안에서 조립하고, 가짜 provider 서버만으로 인계 드릴을 증명하는 방법을 확정한다.

### 1.1 조사 중 확인한 결함 (이 설계가 흡수하는 것)

구현 전에 알아야 할, 기준 커밋에 존재하는 불일치다. 각각 어느 단계(A/B/C)가 해소하는지 명시한다.

1. **구독 선언 프레임이 pinned AsyncAPI 1.2.2와 다르다.** 계약은 텍스트 프레임에 **JSON 배열** `[{"id":"req-1"},{"type":"trade:us","codes":["AAPL"]}]`을 보내라고 하지만, `TossWebSocketMarketData.declare()`는 `{"type":"subscriptions","subscriptions":[{"channel":"trade:us","codes":[...]}]}` 객체를 보낸다. 계약에서 파생된 가짜 WS 서버는 이 프레임을 `wrong-format` 에러로 거부하므로 B 단계 테스트가 이 결함을 반드시 드러낸다. **B가 어댑터를 계약에 맞게 고친다.**
2. **`transportClosed` 이벤트의 `market`이 `'US'`로 고정**되어 있다(`finish()`). 시장별 연결 모델(§5.2)에서는 어댑터 인스턴스가 자기 시장을 알아야 한다. **B가 `TossWebSocketOptions.market`을 추가한다.**
3. **어댑터가 자체 keepalive 타이머(`setInterval`, 60 s)를 소유**한다. `ports.ts` 주석은 “no port owns a timer of its own”을 요구하고, `MarketHealthMachine.onPong`은 결과를 받아야 상태를 바꾼다. **B가 어댑터 내부 타이머를 제거하고, A의 `KeepaliveLoop`가 유일한 타이머 소유자가 된다.**
4. **`RecoveryCoordinator.recover()`가 `acquireLease(market)`을 다시 호출**한다. `StartupCoordinator.open()`도 같은 시장의 lease를 먼저 획득하므로, 두 곳이 원시 `LeaderLease.acquire`를 쓰면 epoch가 두 번 증가하고 PostgreSQL 연결이 두 개 열린다. **A가 `LeaseRegistry`(§5.4)로 획득을 멱등화한다.**
5. **프로덕션 `main.ts`에 사용자 스트림(`/api/v1/stream`)과 WebSocket upgrade가 없다.** e2e `start-system.ts`만 수제 upgrade를 갖는다. **A가 `ws` noServer 기반 upgrade 브리지(§7.5)를 프로덕션에 등록한다.** upgrade 이벤트는 Fastify 라우트·훅을 거치지 않으므로 브리지가 인증·검사를 직접 수행한다.
6. **한 연결에 KR 40 + US 40 종목 × 2 채널 = 160 topic**은 계약의 연결당 100 topic 한도를 넘는다. 따라서 시장당 1 연결(80 topic)이 유일한 합법 배치이고, 계정당 동시 연결 한도 2개가 정확히 소진된다. 이것이 “세 번째 연결 금지”가 단순한 규범이 아니라 provider 한도에서 나오는 하드 제약인 이유다.
7. **문서 드리프트**: `infra/compose.yaml` 라벨 `skipjack.leader-markets: KRX,US`는 코드의 `Market` 값 `KR`과 다르다. `docs/runbooks/redis-or-leader-loss.md`는 `skipjack:leader:*` Redis 키와 `leader_epochs.released_at` 컬럼을 언급하지만 lease는 PostgreSQL advisory lock이고 컬럼은 없다. 이 문서는 Redis를 lease에 쓰지 않음을 확정하고(§3.2), `released_at` 컬럼을 A의 additive migration으로 추가한다(§13). 라벨과 런북 수정은 A의 문서 범위에 포함한다.
8. **웹 클라이언트와 서버의 `afterSequence` 전달 방식이 다르다.** `apps/web/src/features/portfolio/use-portfolio-stream.ts`는 소켓 `onopen` 직후 텍스트 프레임 `{"afterSequence":"<n>"}`을 보낸다. 그러나 `registerStreamRoutes`는 `afterSequence`를 **쿼리 문자열**에서만 읽고, 이 문서의 upgrade 브리지는 클라이언트→서버 프레임을 모두 1003으로 닫는다(§7.5). 지금 상태로는 브라우저가 접속 직후 끊긴다. **A가 쿼리 문자열을 유일한 프로토콜로 확정하고 웹 훅의 `streamUrl(afterSequence)`를 그에 맞춘다**(§2.2의 유일한 프론트 변경 허용, §7.5).
9. **heartbeat를 보내는 서버가 없다.** `StreamSession.open`은 `ready` 프레임에 `heartbeatIntervalMs: 30000`을 광고하고, 웹 훅은 heartbeat를 두 번 놓치면(60 s) `close(4000, 'heartbeat timeout')`한다. 그런데 `StreamSession`, e2e `start-system.ts` 어디에도 `{type:'heartbeat'}`를 보내는 코드가 없다. 지금 프로토콜대로면 모든 사용자 스트림이 60 s마다 끊기고 재접속한다. **A가 프로세스 단위 `StreamHeartbeatLoop`(§7.6)를 추가한다.**

## 2. 목표와 비목표

### 2.1 목표

- G1. 프로덕션 `paper-api` 프로세스 하나가 HTTP, 시장별 fenced leader, provider 스트림/스냅샷, `PaperEngine`, outbox 발행, 사용자 스트림을 소유하고, 정상 상태에서 `NORMAL`을 보인다.
- G2. 시작·종료·장애·복구가 하나의 명시적 상태 기계(§6)를 따르며, 모든 비정상 경로가 fail-closed(`CANCEL_ONLY` 유지, 취소는 항상 가능)다.
- G3. 인계 드릴 `CANCEL_ONLY → old leader disconnect → new leader recovery → NORMAL`을 두 개의 실제 API 프로세스로 자동 증명하고, provider 연결 동시 개수 최대 2를 계측으로 증명한다.
- G4. Toss OAuth/REST/WebSocket 어댑터는 pinned 계약(OpenAPI 1.2.14, AsyncAPI 1.2.2)에서 파생한 **로컬 가짜 서버**로만 검증한다. 어떤 자동화도 라이브 Toss에 접속하지 않는다.
- G5. provider 비밀(client id/secret, access token)은 런타임 메모리와 플랫폼 secret store에만 존재하고, 로그·감사·브라우저·CI·테스트 단언 어디에도 나타나지 않는다.
- G6. 릴리스 체크리스트의 미완 항목을 체크할 수 있는 증거(드릴 로그, 메트릭 스냅샷, 커밋 해시)를 생산한다.

### 2.2 비목표

- 실제 주문 경로, 계좌 채널(`personal:order`), 실계좌 인증 정보. 기존 공개 경계(README “Real-account boundary”)는 그대로다.
- `paper-api` 다중 replica, 수평 확장, 시장 단위 프로세스 분리.
- Redis 기반 lease, Redis pub/sub fan-out. Redis는 계속 rate-limit 저장소로만 쓴다.
- 새 주문 유형, 수수료, 슬리피지, 화이트리스트 변경.
- 라이브 provider에 대한 탐색·회귀·성능 테스트. 계약 갱신은 사람이 수동으로 수행하는 별도 절차다(§9.5).
- 웹 프론트엔드 변경 — **단 하나의 예외**를 둔다: §1.1-8의 프로토콜 정렬을 위해 `apps/web/src/features/portfolio/use-portfolio-stream.ts`의 `streamUrl(afterSequence)`가 검증된 십진 `afterSequence`를 쿼리로 인코딩하고 `onopen`의 `socket.send`를 제거하는 편집(§7.5 “프론트 정렬”)과 그 회귀 테스트만 허용한다. UI, 상태 표시, 스토어, 파서(`lib/user-stream.ts`는 이미 `heartbeat`를 파싱한다)는 건드리지 않는다. 프론트는 이미 `NORMAL/DEGRADED/RECOVERING/CANCEL_ONLY`를 표시한다.

## 3. 고려한 대안

| # | 대안 | 결정 | 이유 |
|---|---|---|---|
| 3.1 | 리더/시세를 별도 `market-leader` 프로세스로 분리 | 기각 | 배포 토폴로지·런북·`check:deployment`가 “단일 `paper-api`가 HTTP와 leader를 함께 소유”를 전제한다. 프로세스 분리는 인계 드릴 대상 프로세스를 둘로 늘려 “세 번째 연결” 증명을 어렵게 한다. |
| 3.2 | Redis lease(SET NX PX)로 leader 선출 | 기각 | 이미 `LeaderLease`가 PostgreSQL advisory lock + `leader_epochs`로 구현·테스트됨. PostgreSQL이 ledger의 단일 진실이므로 fencing token도 같은 곳에 있어야 한다. Redis 장애가 leader 손실로 번지는 경로를 만들지 않는다. |
| 3.3 | 두 시장을 하나의 WebSocket으로 구독 | 기각 | 160 topic > 100 topic/연결(계약). 불가능. |
| 3.4 | 시장별 프로세스 두 개(KR 프로세스, US 프로세스) | 기각 | 3.1과 같은 이유. 또 각 프로세스가 연결 1개씩 열면 인계 중 4개가 되어 계정 한도(2)를 넘는다. |
| 3.5 | 롤링 배포(새 프로세스 먼저 기동, 준비되면 이전 종료) | 기각 | 새 프로세스가 연결을 열면 3번째·4번째 연결이 되고 provider가 가장 오래된 연결을 끊어 이전 leader가 비정상 종료된다. 배포 가이드가 이미 금지한다. stop-then-start만 허용. |
| 3.6 | 인계 중 새 leader가 `lock_timeout`으로 대기 포기 후 종료 | 기각 | 대기 포기는 재시작 루프를 만들고, 그 사이 취소조차 불가능하다. 새 프로세스는 lease를 **무기한 대기**하되 그 동안 `CANCEL_ONLY`로 HTTP를 서비스한다(§6.3). 대기 시간은 메트릭·알림으로 관측한다. |
| 3.7 | 테스트에서 `fetch`/socket factory를 인메모리로 mock | 부분 채택 | 단위 테스트는 기존 방식(인메모리 `FetchLike`, `TossSocketFactory`) 유지. 그러나 어댑터 통합과 인계 드릴은 **실제 TCP를 듣는 로컬 가짜 서버**를 사용한다. 두 OS 프로세스가 같은 가짜 provider를 공유해야 연결 개수를 셀 수 있고, 실제 HTTP/WS 스택(헤더, 101 handshake, close frame)을 지나야 한다. |
| 3.8 | 라이브 Toss에서 녹화한 replay 픽스처 | 기각 | 녹화 자체가 라이브 접속이다. 계약 예시(`examples`)와 기존 `fixtures/toss/*.json`만 사용한다. |
| 3.9 | provider 실패 시 프로세스 종료(orchestrator 재시작) | 기각 | 종료하면 취소마저 불가능해진다. provider 실패는 시장 incident + 재시도로 흡수하고, 프로세스는 `CANCEL_ONLY`로 살아 있어야 한다. 종료는 설정·DB·불변식 실패에만 허용(§8). |
| 3.10 | Node 24 내장 `WebSocket` 클라이언트 | 기각 | 내장 클라이언트는 handshake에 임의 헤더(`Authorization: Bearer`)를 붙일 수 없다. `ws` 패키지를 채택한다(§5.7). |

## 4. 아키텍처 개요

```text
                 SIGTERM/SIGINT
                       │
┌──────────────────────▼──────────────────────────────────────────────┐
│ ProductionRuntime (apps/paper-api/src/runtime/production-runtime.ts) │
│                                                                      │
│  RuntimeStateMachine ── AdmissionLatch ── TradingCapabilities        │
│        │                                                             │
│  StartupCoordinator ─┬─ restore/verifyInvariants (UnitOfWork)        │
│                      ├─ LeaseRegistry.acquire(KR), acquire(US)       │
│                      └─ SupervisedRecovery(KR), (US)                 │
│                              │                                       │
│  MarketRuntime[KR]           │           MarketRuntime[US]           │
│   ├ MarketDataStream (1 WS)  │            ├ MarketDataStream (1 WS)  │
│   ├ MarketHealthMachine      │            ├ MarketHealthMachine      │
│   ├ MarketStateStore         │            ├ MarketStateStore         │
│   ├ RecoveryCoordinator      │            ├ RecoveryCoordinator      │
│   ├ MarketEventLoop          │            ├ MarketEventLoop          │
│   ├ KeepaliveLoop            │            ├ KeepaliveLoop            │
│   └ ReconnectSupervisor      │            └ ReconnectSupervisor      │
│                              ▼                                       │
│  PaperEngine ── UnitOfWork ── PostgreSQL (orders/fills/outbox/audit) │
│                                                                      │
│  OutboxPublisherLoop ── StreamHub ── StreamSession (per user WS)     │
│  StreamHeartbeatLoop (1 timer) ─┘                                    │
│  ShutdownCoordinator                                                 │
└─────────────────────────────────────────────────────────────────────-┘
          │ provider ports (MarketDataStream, MarketSnapshotSource, …)
┌─────────▼───────────────────────────────────────────────────────────┐
│ ProviderBundle                                                       │
│  toss: OAuthTokenProvider + TossRestClient + TossWebSocketMarketData │
│  fake: FakeMarketData + FakeSnapshotSource (test/dev only)           │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 컴포넌트 소유권

| 컴포넌트 | 위치 (신규 `+` / 기존) | 소유 단계 | 소유하는 것 |
|---|---|---|---|
| `ProductionRuntime` | `+ apps/paper-api/src/runtime/production-runtime.ts` | A | 위 도표의 모든 조립, 상태 기계, 타이머, AbortController |
| `RuntimeStateMachine` | `+ apps/paper-api/src/runtime/runtime-state.ts` | A | §6.1 프로세스 상태, 전이 감사, `runtime_state` 메트릭 |
| `AdmissionLatch` | `+ apps/paper-api/src/runtime/admission-latch.ts` | A | 프로세스 로컬 admission/matching 게이트 (`StartupLatch`/`ShutdownLatch` 구현) |
| `TradingCapabilities` | `+ apps/paper-api/src/runtime/trading-capabilities.ts` | A | `(market) → Set<Capability>` 계산 (§6.4) |
| `LeaseRegistry` | `+ apps/paper-api/src/runtime/lease-registry.ts` | A | 시장별 `LeaderLease` 멱등 획득·보유·해제, lease 손실 감지, `LeaseAuditPort` 구현 주입(§5.4) |
| `LeaseAuditPort` | `+ apps/paper-api/src/runtime/lease-audit.ts` | A | lease 연결의 **같은 트랜잭션** 위에 `LEADER_ACQUIRED`/`LEADER_RELEASED` 감사 행을 쓰는 포트(§5.4). `appendAuditEvent`와 같은 컬럼·JSON 규칙 |
| `StreamHeartbeatLoop` | `+ apps/paper-api/src/modules/stream/stream-heartbeat-loop.ts` | A | 프로세스당 **하나**의 30 s 타이머가 `StreamHub.heartbeat(serverTime)`을 호출(§7.6). 소켓별 타이머 없음 |
| 웹 스트림 훅 프로토콜 정렬 | `apps/web/src/features/portfolio/use-portfolio-stream.ts` (기존) | A | `streamUrl(afterSequence)` 쿼리 인코딩, `onopen` 프레임 전송 제거(§7.5 “프론트 정렬”, §2.2 예외) |
| `MarketRuntime` | `+ apps/paper-api/src/runtime/market-runtime.ts` | A | 시장 하나의 stream/health/state/recovery/event loop/keepalive/reconnect |
| `SupervisedRecovery` | `MarketRuntime` 내부 | A | `RecoveryCoordinator.recover`를 감싸 provider 오류를 incident로 변환(§8.2) |
| `StreamHub` | `+ apps/paper-api/src/modules/stream/stream-hub.ts` | A | 접속 중 `StreamSession` 레지스트리, sessionId별 durable event 전달, 시세 fan-out, `heartbeat(serverTime)`, `closeAll`, `size` |
| 스트림 upgrade 브리지 | `+ apps/paper-api/src/modules/stream/stream-upgrade.ts` | A | `ws` noServer 기반 `server.on('upgrade')` 핸들러: 경로·쿼리·Origin·세션 쿠키·인증·rate-limit 검사, closing latch·pending 소켓 추적, `handleUpgrade`, `StreamSession` 생성(§7.5) |
| `cookieValueFromHeader` | `apps/paper-api/src/plugins/session-auth.ts` (기존 파일에 분리) | A | route와 upgrade 브리지가 공유하는 헤더 수준 쿠키 파서 |
| `OutboxPublisherLoop` | `+ apps/paper-api/src/modules/stream/outbox-publisher-loop.ts` | A | `OutboxPublisher.pollOnce` 주기 실행, prune, drain |
| `ProviderBundle` 선택 | `+ apps/paper-api/src/runtime/provider-bundle.ts` | A (인터페이스) / B (toss 구현) | `MARKET_DATA_ADAPTER`에 따른 포트 구현 묶음 |
| `OAuthTokenProvider` | `+ packages/market-data/src/toss/oauth-token-provider.ts` | B | `POST /oauth2/token` client credentials, 캐시, 갱신, 무효화 처리 |
| `TossWebSocketMarketData` 수정 | `packages/market-data/src/toss/toss-websocket.ts` | B | §1.1 결함 1·2·3 해소, `ws` socket factory |
| `TossRestClient` 유지 | `packages/market-data/src/toss/toss-rest.ts` | B | 가짜 서버 대비 검증, `429` `Retry-After` 존중 추가 |
| `FakeTossRestServer`, `FakeTossWsServer` | `+ packages/market-data/testing/fake-toss/` | B | §9 |
| 인계 드릴 | `+ apps/paper-api/src/runtime/leader-handoff.drill.integration.test.ts` | C | §10 |
| 드릴 하네스 | `+ apps/paper-api/src/runtime/testing/two-process-harness.ts` | C | Testcontainers + 가짜 서버 + 두 `node dist/main.js` 자식 프로세스 |
| `003_leader_release.sql` | `+ apps/paper-api/src/db/migrations/003_leader_release.sql` | A | `leader_epochs.released_at` |

`main.ts`는 A 이후 다음 세 줄 수준의 책임만 가진다: `loadConfig()` → `createProviderBundle(config)` → `ProductionRuntime.start()`. 기존 `startProductionServer()` 안의 취소 전용 `execute` 구현, `cancelOnly` 불리언, 스텁 `engine`은 삭제한다.

## 5. 설정, 비밀, 연결 모델

### 5.1 환경 변수 (전체)

`apps/paper-api/src/config.ts`의 zod 스키마를 다음으로 확장한다. 표에 없는 변수는 존재하지 않는다.

| 변수 | 필수 | 기본값 | 검증 규칙 |
|---|---|---|---|
| `NODE_ENV` | 예 | `development` | `development \| test \| production` |
| `HOST`, `PORT` | 예 | `127.0.0.1`, `3000` | 기존 |
| `PUBLIC_ORIGIN` | 예 | — | URL |
| `DATABASE_URL` | 예 | — | URL, 비밀 |
| `REDIS_URL` | 예 | — | URL |
| `SESSION_HASH_KEYS` | 예 | — | 기존 |
| `CSRF_SECRET` | 예 | — | ≥ 32 |
| `ADMIN_API_KEY` | production에서 예 | — | ≥ 32 |
| `MARKET_DATA_ADAPTER` | production에서 예 | production: 없음. development/test: `fake` | `toss \| fake`. `NODE_ENV=production`에서 누락·빈 문자열이면 **시작 실패**(`ConfigError: MARKET_DATA_ADAPTER must be set explicitly in production`); production에서 `fake`이면 **시작 실패**(`ConfigError: fake adapter is forbidden in production`). 그 외 값은 항상 시작 실패. |
| `TOSS_CLIENT_ID` | adapter=`toss`일 때 예 | — | 비밀. 정규식 `^c_[A-Za-z0-9]{8,}$` (계약 예시 형식) |
| `TOSS_CLIENT_SECRET` | adapter=`toss`일 때 예 | — | 비밀. 길이 ≥ 16 |
| `TOSS_REST_BASE_URL` | 아니오 | `https://openapi.tossinvest.com` | URL. §5.3 loopback 규칙 |
| `TOSS_WS_URL` | 아니오 | `wss://openapi-ws.tossinvest.com/ws/v1` | URL. §5.3 loopback 규칙 |
| `SHUTDOWN_DRAIN_DEADLINE_MS` | 아니오 | `30000` | 정수 `5000..40000`. `stop_grace_period`(45 s)보다 작아야 한다 |
| `RECOVERY_STABILITY_MS` | 아니오 | `5000` | 정수 `0..30000`. 드릴과 테스트가 짧게 설정 |

기본값은 pinned 계약의 `servers`에서 그대로 가져온 값이다(OpenAPI `servers[0].url`, AsyncAPI `servers.production`). 기본값을 코드 상수 `TOSS_CONTRACT_SERVERS`로 두고 계약 파일과 일치하는지 테스트가 단언한다.

`MARKET_DATA_ADAPTER`는 production에서 **암묵적 기본값이 없다**. 프로덕션 시세 소스는 설정 파일에 글자로 적혀 있어야 하며, `infra/compose.yaml`의 `paper-api` 서비스는 `MARKET_DATA_ADAPTER: toss`를 리터럴로 선언하고 `scripts/check-deployment-contract.mjs`가 그 리터럴을 단언한다(§5.6). development/test에서만 누락 시 `fake`로 해석한다. `MARKET_DATA_ADAPTER=fake`는 기존과 같이 e2e와 개발 전용이며, `FakeMarketData`와 `FakeSnapshotSource`(현재 e2e `start-system.ts`에 있는 결정적 스냅샷 소스를 `@skipjack/market-data/testing`으로 승격)를 묶는다. `fake`일 때도 lease·recovery·outbox·shutdown 경로는 `toss`와 완전히 같다. 다른 것은 provider 포트 구현만이다.

### 5.2 연결 모델

- 프로세스는 시장당 **정확히 하나**의 provider WebSocket을 연다: `KR` 1개, `US` 1개. 각 연결은 해당 시장 40 종목 × {`trade`, `orderbook`} = 80 topic을 선언한다(`buildSubscriptionPlan`).
- 연결은 오직 **해당 시장의 lease를 보유한 동안만** 열려 있을 수 있다. lease 손실 → 즉시 소켓 종료(§6.5).
- REST 호출(스냅샷, FX, 캘린더, 종목)은 연결 수에 포함되지 않으나, **lease 보유 프로세스만** 수행한다. 새 프로세스는 lease를 얻기 전에 REST를 호출하지 않는다(토큰 발급 포함).
- 따라서 정상 운영 시 provider 연결은 2개, 인계 중 최대 2개, 그 외 시각에는 0개다. 계정 한도(2)를 초과할 정상 경로는 존재하지 않는다.

### 5.3 provider URL loopback 규칙

`TOSS_REST_BASE_URL`·`TOSS_WS_URL`을 기본값과 다르게 설정하는 것은 다음 둘 중 하나일 때만 허용된다. 그렇지 않으면 시작 실패다.

1. `NODE_ENV !== 'production'`.
2. URL의 host가 loopback(`127.0.0.1`, `::1`, `localhost`)이다.

이 규칙으로 프로덕션 비밀이 도달할 수 있는 host는 Toss 공식 host 또는 자기 자신만이다. 인계 드릴(C)은 `NODE_ENV=production`으로 실제 프로덕션 코드 경로를 실행하면서 loopback 가짜 서버를 가리킬 수 있다.

### 5.4 리더 lease와 `LeaseRegistry`

- `LeaseRegistry.acquire(market)`: 보유 중이고 `isHeld`인 lease가 있으면 그것을 반환한다. 없으면 `LeaderLease.acquire(market, { connectionString, leaderId })`를 호출한다. 동시에 두 호출자가 오면 같은 promise를 공유한다. 이로써 `StartupCoordinator`와 `RecoveryCoordinator`의 이중 획득(§1.1-4)이 epoch를 한 번만 올린다.
- `leaderId`는 프로세스 시작 시 생성한 UUID 하나를 전 시장에 공유한다. 로그·감사·메트릭 라벨에 그대로 사용한다.
- `LeaderLease.acquire`는 `pg_advisory_lock(hashtext(market))`에서 **블로킹**한다. 이전 leader가 lock을 쥐고 있으면 새 프로세스는 여기서 대기한다. 이것이 stop-then-start 인계의 직렬화 지점이다. 대기 시간은 `leader_lease_wait_seconds{market}` 게이지로 노출한다.
- lease 전용 연결의 `error`/`end` 이벤트 → `LeaseRegistry`가 `onLost(market)` 콜백을 호출한다(§6.5).
- `LeaderLease.acquire`의 upsert는 `on conflict (market_code) do update set …, released_at = null`로 **`released_at`을 반드시 null로 되돌린다**(§13 migration). 현재 행은 “지금 leader가 누구이고 아직 놓지 않았는가”만 뜻한다.
- **lease 감사 포트.** `LeaderLeaseOptions.audit?: LeaseAuditPort`를 추가한다. `LeaseAuditPort = { recordAcquired(query, ctx), recordReleased(query, ctx) }`, 여기서 `query`는 **lease 연결 자신의 `query` 함수**이고 `ctx = {market, epoch, fencingToken, leaderId}`다. 구현(`+ runtime/lease-audit.ts`, `LeaseRegistry`가 주입)은 `audit_events`에 `appendAuditEvent`와 같은 컬럼(`id, session_reference=null, order_id=null, event_type, payload::jsonb, occurred_at=now()`)으로 `LEADER_ACQUIRED {market, epoch, fencingToken, leaderId}` / `LEADER_RELEASED {market, epoch, leaderId}` 행을 **한 줄 insert**한다. 포트가 lease 연결 위에서 실행되므로 감사 행과 `leader_epochs` 변경은 **하나의 PostgreSQL 트랜잭션**에 들어가고, 별도 UnitOfWork·별도 연결을 쓰지 않는다.
- `LeaderLease.acquire`의 트랜잭션은 `begin` → `pg_advisory_lock(hashtext($1))` → upsert(`released_at = null` 포함) → `audit.recordAcquired(query, ctx)` → `commit` 순이다. **`acquire`는 `commit`이 성공한 뒤에만 반환**하므로, 반환 시점에 `LEADER_ACQUIRED`는 이미 내구성 있게 기록되어 있다. `MarketRuntime.connect()`는 그 반환 뒤에 토큰 발급·REST·WS를 시작하므로(§5.5) provider 호출 이전에 감사가 존재한다는 순서가 구조적으로 보장된다. 감사 insert 실패는 upsert와 함께 롤백되고 `acquire`는 예외로 실패하며(lock은 `rollback` 뒤 `pg_advisory_unlock`, 연결 종료), epoch는 증가하지 않는다.
- `LeaderLease.release()`는 **lock을 아직 쥔 lease 연결 위에서, `pg_advisory_unlock` 전에** 다음을 하나의 트랜잭션으로 실행한다: `begin` → `update leader_epochs set released_at = now() where market_code = $1 and leader_id = $2 and released_at is null` → `audit.recordReleased(query, ctx)` → `commit`. 그 다음 `pg_advisory_unlock(hashtext($1))`, 마지막에 연결을 닫는다. 순서가 이래야 하는 이유: unlock 뒤에 쓰면 다음 leader의 `acquire`가 먼저 lock을 얻어 upsert와 `LEADER_ACQUIRED`를 커밋할 수 있고, 그러면 `LEADER_RELEASED`가 `LEADER_ACQUIRED` **뒤**에 기록되어 §10.2-5·8의 순서 단언이 타이밍 의존이 된다. lock 아래에서 커밋하면 “P1 `LEADER_RELEASED` 커밋 → unlock → P2 lock 획득 → P2 `LEADER_ACQUIRED` 커밋”이 같은 lock의 직렬화 순서를 따르므로 두 감사 행의 `occurred_at`(각 트랜잭션 안의 `now()`)과 커밋 순서가 결정적이다. 트랜잭션이 실패하면 `rollback` 후 로그 `lease.release_mark_failed {market, epoch, leaderId, error}`만 남기고(이 경우 `released_at`도 감사 행도 남지 않는다 — 둘은 항상 함께 있거나 함께 없다), **`finally`에서 unlock과 연결 종료를 반드시 진행**한다 — lock 해제가 인계의 본질이고 감사·`released_at`은 증거다. 이미 `isHeld === false`(연결 사망)면 트랜잭션·unlock을 시도하지 않고 연결 종료만 한다.
- `LeaseRegistry.release(market)`는 `LeaderLease.release()`를 호출하고 그 완료 후 로그 `lease.released {market, epoch, leaderId, auditPersisted}`만 남긴다(§12.4). **감사 행은 쓰지 않는다** — `LEADER_RELEASED`는 위 트랜잭션에서 이미 커밋되었거나(`auditPersisted:true`) 롤백되어 존재하지 않는다(`false`). unlock 이후에 두 번째 `LEADER_RELEASED`를 쓰는 경로는 없다(그러면 P2의 `LEADER_ACQUIRED` 뒤에 나타날 수 있다). 마찬가지로 `LeaseRegistry.acquire`는 실제로 `LeaderLease.acquire`를 호출한 경우에만 로그 `lease.acquired`를 남기고, 보유 중 lease를 반환하는 멱등 경로에서는 감사도 로그도 추가하지 않는다. `LEADER_RELEASED`가 인계 드릴이 P1의 해제를 증명하는 **내구성 있는 증거**다(§10.2-5). 현재 `leader_epochs` 행은 P2가 재획득하는 순간 `released_at = null`로 덮어써지므로 “해제됨”의 증거로 쓸 수 없다.
- `leader-lease.integration.test.ts`(Testcontainers PG)에 다음 여섯 테스트를 둔다. 모두 `LeaseConnection` 래퍼로 lease 연결의 query 호출 순서를 기록하고, 기본 `LeaseAuditPort` 구현을 주입한다.
  1. **first acquire**: 빈 테이블에서 `acquire('KR')` → 행 1개, `epoch=1`, `leader_id`=호출자, `released_at is null`; `audit_events`에 `LEADER_ACQUIRED {market:'KR', epoch:1, leaderId}` 1건; 기록된 순서가 `begin` → `pg_advisory_lock` → `insert … on conflict` → `insert into audit_events` → `commit`이며 `acquire` promise는 `commit` 뒤에 해결된다.
  2. **release**: 같은 lease `release()` → 같은 행 `released_at is not null`, `leader_id` 불변, `epoch` 불변; `audit_events`에 `LEADER_RELEASED {market:'KR', epoch:1, leaderId}` **정확히 1건**; 기록된 순서가 `begin` → `update leader_epochs … released_at` → `insert into audit_events` → `commit` → `pg_advisory_unlock` → `end`; `pg_locks`에 해당 advisory lock 없음; 연결 종료됨.
  3. **reacquire**: 다른 `leaderId`로 `acquire('KR')` → `epoch=2`, `leader_id`=새 값, **`released_at is null`**(null 리셋 증명), `LEADER_ACQUIRED{epoch:2}` 1건. 다시 `release()` → not null, `LEADER_RELEASED{epoch:2}` 1건.
  4. **no race**: P1이 lease를 쥔 채 P2가 `acquire('KR')`를 시작(블로킹 확인: 500 ms 뒤에도 미해결). P1 `release()`. 단언: (a) P2 promise는 P1의 `pg_advisory_unlock` 이후에만 해결되고, 해결 직후 행은 `leader_id`=P2, `released_at is null`, `epoch=2`; (b) 제3의 관찰 연결에서 P1의 `LEADER_RELEASED`가 **P2 promise 해결 전에 이미 보인다**(P1 `commit` 직후 폴링); (c) `audit_events`를 `occurred_at, id` 순으로 읽으면 `LEADER_ACQUIRED(P1,1)` → `LEADER_RELEASED(P1,1)` → `LEADER_ACQUIRED(P2,2)`이고 각 종류가 정확히 1건; (d) P2 획득 전 임의 시점에 “`leader_id`=P2인데 `released_at`이 not null”인 행이 관측되지 않는다(P2 획득 후 100회 폴링).
  5. **release audit failure**: `recordReleased`가 던지는 포트를 주입 → `release()`는 예외 없이 완료; 행 `released_at is null`(롤백), `LEADER_RELEASED` 0건, 로그 `lease.release_mark_failed` 1건; `pg_locks`에 lock 없음(finally unlock), 연결 종료됨; 이후 다른 `leaderId`의 `acquire`가 즉시 성공.
  6. **acquire audit failure**: `recordAcquired`가 던지는 포트를 주입 → `acquire()`가 거부됨; `leader_epochs` 행·epoch 불변(빈 테이블이면 여전히 없음), `LEADER_ACQUIRED` 0건, `pg_locks`에 lock 없음, 연결 종료됨.
- Epoch/fencing token 의미는 기존과 같다: 새 leader는 항상 더 큰 값을 받고, `MarketStateStore.beginEpoch`와 `PaperEngine.currentFencingToken`이 이 값을 사용해 이전 epoch 이벤트와 fill을 거부한다.

### 5.5 OAuth 토큰 provider (B)

`OAuthTokenProvider implements TokenProvider`:

- 요청: `POST {TOSS_REST_BASE_URL}/oauth2/token`, `Content-Type: application/x-www-form-urlencoded`, 본문 `grant_type=client_credentials&client_id=…&client_secret=…`. 응답은 BFF envelope가 아닌 OAuth2 표준 `{access_token, token_type, expires_in}`이다. 계약 예시 `expires_in`은 86400이다.
- 캐시: 메모리 단일 슬롯 `{token, expiresAt}`. `getAccessToken(signal)`은 남은 수명이 `TOKEN_REFRESH_LEAD_MS = 300_000`(5분) 이상이면 캐시를 반환하고, 아니면 재발급한다. 동시 호출은 하나의 in-flight promise를 공유한다.
- 무효화 처리: 계약상 client당 유효 토큰은 1개이며 재발급 시 이전 토큰은 즉시 무효다. 어댑터가 `401`을 받으면 `tokenProvider.invalidate()` 후 **정확히 1회** 재발급·재시도한다. 두 번째 `401`은 오류로 전파되어 시장 incident `PROVIDER_AUTH_FAILED`가 된다.
- 속도: `AUTH` rate-limit 그룹 보호를 위해 재발급 간 최소 간격 `TOKEN_MIN_REISSUE_INTERVAL_MS = 10_000`. 그 안의 요청은 `MarketDataError('PONG_FAILED')`가 아니라 새 코드 `AUTH_THROTTLED`로 거부된다(`MarketDataErrorCode`에 `AUTH_FAILED`, `AUTH_THROTTLED` 추가).
- `403 access_denied`(허용 IP 미등록)는 재시도하지 않고 `PROVIDER_IP_NOT_ALLOWED` incident가 된다. 이는 운영자 조치가 필요한 상태다.
- 토큰 문자열은 `Authorization` 헤더 조립 외 어디에도 복사되지 않는다. 로거 redaction 규칙에 `access_token`, `client_secret`, `Authorization`을 추가한다(§12).
- **토큰은 lease 획득 뒤에만 발급된다.** `MarketRuntime.connect()`가 `LeaseRegistry.acquire` 완료 뒤 처음 `tokenProvider.getAccessToken`을 호출한다. 이전 leader가 아직 살아 있을 때 새 프로세스가 토큰을 재발급해 이전 leader의 REST를 무효화하는 사고를 구조적으로 막는다.

### 5.6 비밀 취급 원칙

- 비밀은 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`, access token, `DATABASE_URL`, `SESSION_HASH_KEYS`, `CSRF_SECRET`, `ADMIN_API_KEY`다.
- 주입은 플랫폼 secret store만 사용한다. `infra/compose.yaml`은 `TOSS_CLIENT_ID: "${TOSS_CLIENT_ID:?…}"`, `TOSS_CLIENT_SECRET: "${TOSS_CLIENT_SECRET:?…}"`를 필수 보간으로, `MARKET_DATA_ADAPTER: toss`를 보간 없는 리터럴로 추가한다. `scripts/check-deployment-contract.mjs`는 두 비밀 변수를 필수 보간 목록에 추가하고, `paper-api` 환경의 `MARKET_DATA_ADAPTER`가 정확히 리터럴 `toss`인지(보간·누락·`fake` 모두 실패) 단언하며, `web` 서비스 환경과 CI 워크플로에서 `TOSS_`가 등장하면 실패하도록 유지·확장한다.
- 어떤 테스트도 실제 client id/secret를 필요로 하지 않는다. 가짜 서버는 하네스가 생성한 임의 자격증명(`c_test…`, 32바이트 랜덤 secret)을 받아들인다.

### 5.7 의존성 추가

- `ws` `8.18.1`을 `@skipjack/market-data`(Toss 클라이언트 socket factory, 가짜 WS 서버)와 `@skipjack/paper-api`(사용자 스트림 upgrade 브리지, §7.5) 런타임 의존성으로 추가한다. `@types/ws` `8.18.1`은 devDependency. 두 버전은 Plan 2(`2026-08-22-skipjack-market-data-and-paper-engine.md`)에서 이미 승인된 값을 그대로 쓴다. 채택 이유는 §3.10. `@fastify/websocket`은 추가하지 않는다 — upgrade 브리지는 `ws`의 `noServer` 모드로 충분하다.
- 다른 새 런타임 의존성은 없다. 가짜 REST 서버는 `node:http`로 작성한다.

## 6. 라이프사이클 상태 기계

### 6.1 프로세스 상태

```text
BOOTING ──config/db ok──▶ RESTORING ──invariants ok──▶ ACQUIRING_LEASES
   │                          │                               │ both leases held
   │ config/db error          │ invariant/audit error         ▼
   ▼                          ▼                          RECOVERING(all)
 EXIT(1)               FAILED_CLOSED ─▶ EXIT(1)               │
                                                              ▼
              ┌────────────────────────────────────── SERVING ◀────────────┐
              │  (admission open; trading mode per market from §6.2)        │
              │                                                             │
              └── SIGTERM/SIGINT ──▶ DRAINING ──▶ STOPPED ──▶ EXIT(0)      │
                                       │ deadline exceeded                  │
                                       └──▶ STOPPED(forced) ──▶ EXIT(0)     │
```

- `BOOTING`: `loadConfig`, `createDatabase`, `migrateToLatest`, Fastify 빌드, `app.listen`. **listen은 `RESTORING` 전에 수행**한다. 그래야 새 프로세스가 lease를 기다리는 동안 `/health/*`, 조회, 취소를 서비스할 수 있다.
- `RESTORING`: `StartupCoordinator.restore` = 활성 incident 로드, `market_states` 로드, 열려 있는 주문·예약 로드; `verifyInvariants` = 기존 ledger 불변식 검사(예약 합계, 지갑 음수 금지, OCO 쌍 정합). 실패 → `FAILED_CLOSED`: 수동 incident `STARTUP_INVARIANT_OR_AUDIT_FAILURE`(GLOBAL, 모든 capability 차단, `source=MANUAL`) 기록 후 **프로세스 종료 코드 1**. 재시작 후에도 이 incident가 남아 `CANCEL_ONLY`를 강제하고, 운영자가 `/admin/incidents/:id/resolve`로 해제해야 한다.
- `ACQUIRING_LEASES`: `LeaseRegistry.acquire('KR')`, `acquire('US')`를 병렬로 호출하고 **둘 다** 완료될 때까지 대기한다. 이 상태의 trading 응답은 `reasons: ['CANCEL_ONLY','ACQUIRING_LEASES']`.
- `RECOVERING(all)`: 두 시장의 `SupervisedRecovery`가 병렬로 실행된다. provider 오류는 프로세스 상태를 바꾸지 않고 시장 incident가 된다(§8.2).
- `SERVING`: admission latch 열림. 이 시점부터 각 시장의 거래 모드는 §6.2 시장 상태 기계가 결정한다. 프로세스는 두 시장이 모두 `DEGRADED`여도 `SERVING`이다(취소는 가능).
- `DRAINING`: §6.6.
- 모든 전이는 `audit_events`에 `RUNTIME_STATE_CHANGED {from, to, leaderId}`로 기록되고, `runtime_state{state}` 게이지를 갱신한다.

### 6.2 시장 상태 (시장당 하나)

기존 `MarketHealthMachine`의 `HEALTHY/DEGRADED/RECOVERING`을 그대로 사용하며, 사용자에게 보이는 이름은 기존 매핑을 따른다: `HEALTHY→NORMAL`, `DEGRADED→DEGRADED`, `RECOVERING→RECOVERING`. `CANCEL_ONLY`는 시장 상태가 아니라 §6.4 capability 결과다.

```text
        connect+declare ok, snapshots ok, stability elapsed, CAS resolve ok
RECOVERING ─────────────────────────────────────────────────────────▶ HEALTHY
   ▲  ▲                                                                 │
   │  │ reconnect attempt begins                                        │ transportClosed | 2 missed pongs
   │  └──────────────── DEGRADED ◀──────────────────────────────────────┘
   │                        │ subscription rejected | snapshot failed | provider auth failed
   │                        ▼
   └──── ReconnectSupervisor schedules retry (backoff, §8.3) ── 3 failures in 5 min ──▶ MANUAL HOLD
```

- `MANUAL HOLD`는 별도 상태가 아니라 `DEGRADED` + 수동 incident `RECOVERY_RETRY_EXHAUSTED`(MARKET scope, `source=MANUAL`)다. 자동 재시도는 멈추고, 운영자가 incident를 해제하면 `ReconnectSupervisor`가 다시 시작한다.
- 시장 incident는 원인별로 독립 행이며 §9.1(선행 문서)의 CAS 규칙으로만 해제된다.

### 6.3 lease 대기 중 서비스 계약

`ACQUIRING_LEASES` 동안:

- `/health/live` 200, `/health/ready` 200 (db+audit 기준 유지). 즉 로드밸런서는 트래픽을 보내고, 사용자는 조회·취소를 할 수 있다.
- `/api/v1/health/trading` → `{placement:false, cancellation:true, fx:false, reasons:['CANCEL_ONLY','ACQUIRING_LEASES']}`.
- `/health/market-data` → 각 시장 `{state:'RECOVERING', reasons:['LEADER_LEASE_PENDING']}`.
- 주문 생성/정정/FX 요청은 기존 `CANCEL_ONLY`(409) 도메인 오류로 거부된다.

### 6.4 유효 capability 계산

`TradingCapabilities.for(market)`:

```text
if admission latch closed            → {CANCEL}
else                                 → ALL_CAPABILITIES − ⋃ denied(active incidents with scope GLOBAL, LOCAL, MARKET=market)
```

- 심볼·계정 scope incident는 기존처럼 `OrderPlacementService`와 `PaperEngine`이 해당 scope에서 적용한다.
- 시장이 `DEGRADED`/`RECOVERING`이면 `MarketHealthMachine`이 만든 MARKET incident가 `PLACE, AMEND, MATCH, TRIGGER`를 차단하므로 그 시장만 배치 불가, 다른 시장은 정상이다.
- `/api/v1/health/trading`의 `placement`는 두 시장 중 하나라도 `PLACE`가 허용되면 `true`이고, `reasons`에 차단된 시장이 `MARKET_DEGRADED:KR` 형식으로 나열된다. `fx`는 GLOBAL/LOCAL incident와 admission latch에만 의존한다.

### 6.5 lease 손실

`LeaseRegistry.onLost(market)`이 호출되면 `MarketRuntime[market]`은 **다음 순서를 동기적으로 시작**한다(각 단계는 이전 단계 실패와 무관하게 실행).

1. 시장 AbortController abort → event loop, keepalive, 진행 중 recovery 취소.
2. `stream.close()` — provider 연결 종료. 이 단계가 “세 번째 연결 금지”의 핵심이다: lease 없는 프로세스는 연결을 가질 수 없다.
3. matching latch(해당 시장) 닫기, `MarketHealthMachine.onClose('LEASE_LOST')` → `DEGRADED` + incident `LEADER_LEASE_LOST`.
4. `ReconnectSupervisor`가 `LeaseRegistry.acquire(market)`부터 다시 시작하는 recovery를 예약한다(§8.3 backoff). 재획득하면 새 epoch로 `RECOVERING → HEALTHY`.

잔여 위험: PostgreSQL 연결 사망 감지까지의 지연 동안 이전 프로세스의 소켓이 살아 있고 새 leader가 연결을 열면 provider가 가장 오래된 연결(이전 프로세스)을 끊는다. 이 경우에도 (a) 새 leader의 연결은 유지되고, (b) 이전 프로세스의 fill은 fencing token 불일치로 DB에서 거부되며, (c) `provider_connections_open` 합계가 2를 넘는 순간이 알림으로 남는다. 이는 이중 leader가 아니라 감지 지연이며, 허용된 잔여 위험으로 기록한다.

### 6.6 종료 시퀀스 (`ShutdownCoordinator.drain`)

`SIGTERM`/`SIGINT` 수신 시 기존 `ShutdownCoordinator`가 다음 콜백으로 구성된다. deadline은 `now + SHUTDOWN_DRAIN_DEADLINE_MS`(기본 30 s).

| 순서 | 콜백 | `ProductionRuntime`이 주입하는 구현 |
|---|---|---|
| 1 | `cancelOnly()` | 상태 `DRAINING`; `/health/ready`가 503 `{code:'NOT_READY', details:{draining:true}}`를 반환하도록 플래그; trading `reasons`에 `DRAINING` 추가; 감사 `RUNTIME_DRAINING`. |
| 2 | `admission.close()` | admission latch 닫기 → 모든 시장 `{CANCEL}`. 두 시장의 matching latch 닫기(새 fill 없음). |
| 3 | `drainInflight(deadline)` | `UnitOfWork` in-flight 카운터가 0이 될 때까지 50 ms 폴링, deadline 초과 시 진행. |
| 4 | `drainOutbox(deadline)` | `OutboxPublisherLoop.drain(deadline)`: `pollOnce`를 반복해 `claimed === 0`이 두 번 연속이면 종료. deadline 초과 시 남은 행 개수를 `outbox_drain_remaining` 게이지에 기록하고 진행(행은 DB에 남아 새 leader가 발행한다 — at-least-once). |
| 5 | `closeSockets()` | 시장 AbortController abort; 두 provider `stream.close()`; `StreamHeartbeatLoop.stop()`; upgrade 브리지 `detach()`(closing latch + pending 핸드셰이크 파괴) → `closeAll(1012, 'SERVICE_RESTART')`(`STREAM_CLOSE_GRACE_MS = 2000` 상한, 잔여는 `terminate()`) → `wss.close()` 순으로 사용자 WebSocket 종료(§7.5 정리; 브라우저는 재접속 후 REST 스냅샷으로 조정). 이 단계의 상한은 `STREAM_CLOSE_GRACE_MS`이며 drain deadline과 무관하게 종료를 막을 수 없다. |
| 6 | `releaseLeases()` | `LeaseRegistry.releaseAll()` — **모든 소켓이 닫힌 뒤에만** 실행. 그래야 새 leader가 lock을 얻는 순간 이전 연결이 0개다. 각 시장의 `LEADER_RELEASED`는 §5.4대로 unlock 전에 커밋된다. |

그 뒤 `server.ts`의 기존 흐름대로 `app.close()`, 마지막에 `database.destroy()`. 종료 코드 0. deadline 초과로 강제 진행한 경우도 종료 코드는 0이며 `RUNTIME_STOPPED {forced:true, remainingOutbox}` 감사와 `shutdown_forced_total` 카운터를 남긴다.

두 번째 신호는 무시된다(`ShutdownCoordinator.#draining` 가드). `SIGKILL`은 orchestrator의 `stop_grace_period`(45 s) 이후에만 오며, 그 경우 lease는 PostgreSQL 연결 종료로 자동 해제된다.

## 7. 데이터·이벤트·outbox 흐름

### 7.1 시세 인바운드

```text
provider WS ─▶ TossWebSocketMarketData.events(signal)
            ─▶ MarketEventLoop[market]
                 ├ trade      → MarketStateStore.applyEvent → PaperEngine.onTrade(envelope)
                 ├ orderBook  → MarketStateStore.applyEvent → PaperEngine.onOrderBook(envelope)
                 │                                          → StreamHub.publishQuote(envelope)
                 └ transportClosed → MarketHealthMachine.onClose(reason) → ReconnectSupervisor
```

- `MarketStateStore.applyEvent`는 현재 epoch/fencing token으로 봉투를 만들고 심볼별 단조 증가 버전을 부여한다. provider는 시퀀스를 주지 않으므로 버전은 프로세스 로컬 도착 순서다(`marketDataVersion`). 이전 epoch 봉투는 `ORDER_STATE_CONFLICT`로 거부된다(기존 동작).
- `PaperEngine.onTrade/onOrderBook`은 fill이 생기면 `onFill` 콜백으로 `UnitOfWork` 트랜잭션을 실행한다. 트랜잭션은 `currentFencingToken(market)`과 `leader_epochs.fencing_token`을 비교해 불일치 시 롤백한다(기존 규칙).
- `StreamHub.publishQuote`는 해당 심볼을 구독한 `StreamSession`에만 in-process로 전달한다. Redis는 관여하지 않는다.
- 이벤트 처리 중 예외(파싱 불가, `UNSUPPORTED_DATA`)는 이벤트 하나를 버리고 `market_event_rejected_total{market,reason}`을 올린다. 연속 20개 거부 시 `onClose('EVENT_REJECTION_BURST')`로 degrade한다.

### 7.2 복구 (`SupervisedRecovery`)

`RecoveryCoordinator.recover(market, signal)`의 기존 절차를 유지한다: lease(멱등) → `beginEpoch` → `stream.connect` → `declare` + ack 검증 → 심볼별 rate-limited REST 스냅샷(`SnapshotRateLimiter` 10/s) → `replaceBaseline` → 안정화 대기(`RECOVERY_STABILITY_MS`) → 반환. `ProductionRuntime`은 반환값을 받아:

1. `recoveryTriggers`를 `PaperEngine.onRecoveryOrderBook`/조건 발동 경로로 넘긴다. 결과 fill은 `source:'RECOVERY_REST'`, `recoveryFill=true`로 기록된다(기존 의미론, 선행 문서 §7.4).
2. `blockedSymbols`마다 SYMBOL incident `RECOVERY_SNAPSHOT_FAILED`가 이미 활성화되어 있으므로 시장 자체는 `markHealthy(epoch)`로 CAS 해제한다. 심볼 incident는 다음 성공한 스냅샷에서 개별 CAS 해제한다.
3. `MarketEventLoop`와 `KeepaliveLoop`를 시작한다.
4. `recovery_duration_seconds{market}`, `leader_epoch{market}` 갱신, 감사 `RECOVERY_COMPLETED {market, epoch, recovered, blocked}`.

### 7.3 Keepalive

`KeepaliveLoop[market]`: 60 s마다 `stream.ping()` → 성공 시 `health.onPong(true)`, 실패(타임아웃 30 s, `PONG_FAILED`) 시 `health.onPong(false)`. 두 번 연속 실패면 health machine이 `DEGRADED`가 되고 loop는 `stream.close()`를 호출해 §7.1의 `transportClosed` 경로로 수렴한다. 계약의 180 s 서버 idle 종료보다 충분히 짧다. 어댑터는 타이머를 소유하지 않는다(§1.1-3).

### 7.4 사용자 이벤트 outbox

```text
UnitOfWork tx: orders/fills/wallets + audit_events + outbox_events (원자적)
        │
OutboxPublisherLoop (200 ms 주기, batch 100)
        ├ claimPendingOutbox (FOR UPDATE SKIP LOCKED, 짧은 tx)
        ├ publish(event) = StreamHub.deliver(sessionId, event)   ← 접속 없으면 no-op 성공
        ├ markOutboxPublished(id)
        └ 매 10분 prunePublishedOutbox(1000)   (published_at < now() − 24h)
```

- 발행은 “접속 중인 세션에 전달 시도”이며, 미접속 세션은 재접속 시 `afterSequence`로 REST/스트림에서 따라잡는다. 이것이 outbox가 at-least-once인 이유이고 브라우저 dedupe가 존재하는 이유다.
- `outbox_oldest_pending_seconds` 게이지는 매 poll마다 `min(created_at) where published_at is null`로 갱신한다. 알림 `OutboxLagHigh`(> 30 s)는 기존 규칙.
- 인계 중: 이전 leader의 `drainOutbox`가 대부분을 발행하고, 남은 행은 새 leader의 loop가 첫 poll에서 발행한다. 중복 발행은 브라우저 `eventId` dedupe로 흡수된다.

### 7.5 사용자 스트림 (`ws` noServer upgrade 브리지)

**전제 사실**: Node HTTP 서버의 `upgrade` 이벤트는 Fastify 라우팅을 **거치지 않는다**. `server.on('upgrade')`로 들어온 요청은 `GET /api/v1/stream` 라우트 핸들러도, `preHandler`/`onRequest` 훅도, `registerStreamRoutes`의 origin·세션·rate-limit 검사도 실행하지 않는다. 따라서 upgrade 경로의 인증·검사는 브리지가 **직접** 수행해야 하며, “기존 route 코드가 검사한다”는 가정은 틀렸다. `@fastify/websocket`은 도입하지 않는다(§5.7).

구성요소 `+ apps/paper-api/src/modules/stream/stream-upgrade.ts`:

```ts
createStreamUpgradeHandler({
  server,            // app.server (node:http)
  publicOrigin,      // config.publicOrigin
  sessionService,    // SessionService.authenticate(token)
  limiter,           // LayeredRateLimiter
  hub,               // StreamHub
  source,            // DurableEventSource
  tradableSymbols,   // ReadonlySet<string> — 허용 목록(canonical `MARKET:SYMBOL`), 요청 구독이 아님
  maxPayloadBytes,   // 상수 STREAM_MAX_PAYLOAD_BYTES = 4096 (클라이언트→서버 프레임 상한)
  closeGraceMs,      // 상수 STREAM_CLOSE_GRACE_MS = 2000 (closeAll 상한)
}): { attach(): void; detach(): void; closeAll(code, reason): Promise<void>; pendingCount(): number }
```

내부에 `new WebSocketServer({ noServer: true, maxPayload })` 하나, `closing` 불리언 latch 하나, 핸드셰이크 진행 중(인증 대기 중) 원시 소켓의 `Set<Duplex>` `pending` 하나를 둔다. `attach()`는 `closing = false`로 두고 `server.on('upgrade', onUpgrade)`를 등록하며 `app.ready()` 뒤 `app.listen` 전에 호출한다.

**클라이언트→서버 프로토콜은 쿼리 문자열 하나다.** 접속 URL은 `/api/v1/stream?afterSequence=<n>&quoteSymbols=<v1,v2,…>`이며 두 쿼리는 모두 선택이다. WebSocket이 열린 뒤 클라이언트가 보낼 수 있는 프레임은 **없다**(§1.1-8). 규칙:

- `afterSequence`: 정규식 `^(0|[1-9][0-9]{0,18})$`(부호·공백·소수점 없음, `bigint` 범위). 위반 또는 중복 키 → 400 `BAD_REQUEST`. 생략 시 `StreamSession.open`에 전달하지 않는다(전체 replay 규칙은 기존과 같다).
- `quoteSymbols`: 쉼표 구분, canonical 값은 `StreamSession.subscribeQuote`가 쓰는 키와 같은 `<MARKET>:<SYMBOL>`(`KR:005930`, `US:AAPL`; `MARKET ∈ {KR, US}`, `SYMBOL`은 `^[A-Z0-9.]{1,12}$`). 빈 항목·중복·형식 위반 → 400 `BAD_REQUEST`. 항목 수 > 5 → 400 `BAD_REQUEST`(`StreamSession`의 구독 상한과 같은 값 `STREAM_MAX_QUOTE_SUBSCRIPTIONS = 5`). `tradableSymbols` 허용 목록에 없는 값 → 400 `BAD_REQUEST`. 허용 목록(`tradableSymbols`, 화이트리스트 전체)과 **요청 구독**(쿼리 값)은 다른 것이다: 허용 목록은 `StreamSession.open`의 `quoteSymbols` 옵션으로, 요청 구독은 open 뒤 `subscribeQuote` 호출로 각각 전달한다.
- 그 외 쿼리 키는 무시한다.
- 파서는 `+ modules/stream/stream-query.ts`의 `parseStreamQuery(url): { afterSequence?: string; quoteSymbols: readonly {market, symbol}[] }`로 분리하고 브리지가 사용한다. 이 파싱·검증은 **`handleUpgrade` 전에** 끝나야 하며, 실패 시 소켓은 101을 받지 않는다.

`onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer)`는 다음 순서로 동기 검사 → 비동기 인증 → 핸드셰이크를 수행한다. 각 거부는 `rejectUpgrade(socket, status, code, message, extraHeaders?)`로 원시 HTTP 응답(`HTTP/1.1 <status> <reason>\r\nContent-Type: application/json\r\nConnection: close\r\n…\r\n\r\n{"code","message","retryable"}`)을 쓰고 `socket.destroy()`한다. Fastify 요청 객체가 없으므로 `requestId`는 포함하지 않는다. 브리지는 예외를 이벤트 밖으로 절대 던지지 않는다(전체를 `try/catch`로 감싸고, 예상 밖 오류는 500 + destroy + `stream.upgrade_failed` 로그).

| 순서 | 검사 | 실패 응답 |
|---|---|---|
| 0 | `closing === true`이면 아무 응답 없이 `socket.destroy()` | — |
| 1 | `request.headers.upgrade?.toLowerCase() === 'websocket'`, `Connection` 헤더에 `upgrade` 포함 | 426 `UPGRADE_REQUIRED` |
| 2 | `new URL(request.url ?? '/', 'http://placeholder').pathname === '/api/v1/stream'` (다른 경로의 upgrade는 이 서버가 지원하지 않음) | 404 `NOT_FOUND` |
| 3 | `parseStreamQuery(url)` — 위 규칙으로 `afterSequence`·`quoteSymbols` 검증 | 400 `BAD_REQUEST` |
| 4 | `request.headers.origin === publicOrigin` (문자열 완전 일치, 누락도 실패) | 403 `FORBIDDEN` |
| 5 | 세션 쿠키: `cookieValueFromHeader(request.headers.cookie, SESSION_COOKIE)` — `plugins/session-auth.ts`의 `cookieValue(request, name)`에서 헤더 문자열만 받는 함수를 분리해 **route와 브리지가 같은 파서를 공유**한다(`cookieValue`는 이 함수의 얇은 래퍼가 된다). 누락 → | 401 `SESSION_EXPIRED` |
| 6 | `pending.add(socket)`; `socket.once('close', () => pending.delete(socket))`; `await sessionService.authenticate(token)`; 세션 오류(`statusCode === 401`인 예외: 무효·만료·폐기 토큰) 또는 `session.status !== 'ACTIVE'` → 401. 그 외 예외(DB 오류 등)는 U8의 500 경로. 어느 경로든 `pending.delete(socket)` | 401 `SESSION_EXPIRED` |
| 7 | `limiter.checkWebsocketConnection(session.id)` (5회/1 s, 기존 값) 불허 → | 429 `RATE_LIMITED` + `Retry-After` |
| 8 | 요청 구독 개수 `n = quoteSymbols.length`로 `limiter.checkSubscription(session.id, n)` 불허 → | 429 `RATE_LIMITED` + `Retry-After` |
| 9 | **`handleUpgrade` 직전 재검사**: `closing === true` 또는 `socket.destroyed`이면 아무 응답 없이 `socket.destroy()`하고 종료. 6~8의 `await` 동안 `detach()`가 호출되었거나 클라이언트가 떠난 경우를 잡는다 | — |
| 10 | `wss.handleUpgrade(request, socket, head, onOpen)` — 101은 `ws`가 쓴다 | 핸드셰이크 실패는 `ws`가 400을 쓰고 socket을 닫음 |

`onOpen(ws)`:

1. `ws`를 `StreamSocket`으로 감싼다: `send(text)`, `close(code, reason)`, `bufferedAmount` getter. 이 어댑터는 `apps/e2e/start-system.ts`의 수제 구현을 대체하며 e2e도 같은 브리지와 §7.6의 `StreamHeartbeatLoop`를 쓴다.
2. `StreamSession.open({ sessionId: session.id, source, socket, afterSequence?, quoteSymbols: tradableSymbols })` — `afterSequence`는 3단계에서 검증한 값. `open` 실패(`OUTBOX_GAP`은 `StreamSession`이 이미 4009로 닫음; 그 외) 시 `ws.close(1011, 'STREAM_OPEN_FAILED')` 후 로그.
3. 요청 구독마다 `await streamSession.subscribeQuote(market, symbol)`. 3단계 검증을 통과했으므로 여기서 예외는 불변식 위반이며 `ws.close(1011, 'STREAM_OPEN_FAILED')` + 로그로 처리한다.
4. `hub.register(session.id, streamSession, ws)`. `ws.on('close')` → `hub.unregister`, `ws.on('error')` → 로그 후 `ws.terminate()`. 클라이언트→서버 프레임은 스트림 계약에 없다(시세 구독은 쿼리로만 정해진다). 따라서 `ws.on('message')`는 종류·내용을 보지 않고 `ws.close(1003, 'UNSUPPORTED_DATA')`로 닫고 `stream.inbound_rejected` 로그를 남긴다. `maxPayload` 초과는 `ws`가 1009로 닫는다.

**프론트 정렬**(§2.2 예외, A 범위): `use-portfolio-stream.ts`의 `streamUrl(afterSequence?: string)`는 `afterSequence`가 정의되어 있고 `^(0|[1-9][0-9]{0,18})$`에 맞을 때만 `url.searchParams.set('afterSequence', afterSequence)`한다(맞지 않으면 쿼리를 생략하고 전체 replay에 맡긴다). `connect()`는 `streamUrl(stateRef.current?.snapshot.accountSequence)`로 소켓을 만들고, `onopen`은 `attempt.current = 0`만 수행한다 — **`socket.send`는 삭제**한다. `quoteSymbols` 쿼리는 현재 프론트가 쓰지 않으므로 보내지 않는다. 그 외 훅 로직(heartbeat 타임아웃, 재접속 backoff, 리듀서)은 변경하지 않는다.

**HTTP 폴백**: `registerStreamRoutes(app, { principal, source, quoteSymbols: tradableSymbols, limiter })`는 `upgrade` 의존성 **없이** 등록한다. 브라우저가 아닌 클라이언트가 평범한 `GET /api/v1/stream`을 보내면 기존 route가 origin·세션·rate-limit 검사 후 426 `UPGRADE_REQUIRED`를 돌려준다. 이 route의 `upgrade` 콜백 분기는 프로덕션에서 사용되지 않으며 삭제하지 않는다(단위 테스트 호환).

**정리(cleanup)**: §6.6-5 `closeSockets()`가 순서대로 실행한다.

- (a) `detach()`: `closing = true` → `server.removeListener('upgrade', onUpgrade)` → `pending`의 모든 원시 소켓을 `destroy()`하고 비운다. 이후 새 upgrade는 Node 기본 동작(연결 파괴)으로 떨어지고, 이미 인증을 기다리던 핸드셰이크는 소켓이 파괴되어 9단계 재검사에서 종료된다. `detach()`는 멱등이다.
- (b) `closeAll(1012, 'SERVICE_RESTART')`: 등록된 모든 `ws.close(1012, reason)`를 보내고 각 소켓의 `close` 이벤트를 기다리되 **전체 상한 `STREAM_CLOSE_GRACE_MS`(2 s)** 를 둔다. 상한 안에 close 핸드셰이크가 끝나지 않은 소켓은 `ws.terminate()`로 끊는다. 모든 `StreamSession`은 `hub.unregister`로 해제된다. 반환 후 `hub.size() === 0`, `pendingCount() === 0`이 불변식이다.
- (c) `wss.close()`.

이후 `app.close()`가 남은 HTTP 연결을 닫는다. `closeSockets()`는 (a)~(c)를 합쳐 `STREAM_CLOSE_GRACE_MS + 500 ms` 안에 끝나며, 클라이언트가 close 프레임에 응답하지 않아도 종료가 걸리지 않는다.

**테스트** `stream-upgrade.test.ts`(vitest, `127.0.0.1` 임시 포트에 실제 listen, `ws` 클라이언트, 인메모리 `SessionService`/`DurableEventSource`, 결정적 지연을 위해 `authenticate`를 수동 해결 가능한 `Deferred`로 감싼 픽스처):

- U1. 유효 쿠키 + 일치 Origin, 쿼리 없음 → 101, `ready` 뒤 durable 이벤트 전체 수신, `hub.size()===1`; 클라이언트 close → `hub.size()===0`.
- U1b. `?afterSequence=2` → `ready` 뒤 `accountSequence > 2`인 이벤트만 replay(source 호출 인자가 `'2'`); `?afterSequence=-1`, `=1.5`, `= 1`, `=abc`, 20자리 초과, 키 중복 → 400 `BAD_REQUEST`, 101 없음, `hub.size()===0`.
- U1c. `?quoteSymbols=US:AAPL,KR:005930` (둘 다 허용 목록) → 101, 이후 `hub.publishQuote`로 두 심볼 quote가 도달하고 허용 목록에는 있으나 요청하지 않은 심볼의 quote는 도달하지 않음; `quoteSymbols=US:ZZZZ`(허용 목록 밖), `US:AAPL,US:AAPL`(중복), `aapl`(형식), 6개 → 400.
- U2. 경로 `/other` → 404, socket 종료.
- U3. Origin 누락 / 불일치 → 403.
- U4. 쿠키 누락 → 401; 만료·폐기 세션(`authenticate` 거부) → 401; `status='REVOKED'` → 401.
- U5. 같은 세션 1 s 내 6번째 연결 → 429 + `Retry-After`; 허용 목록 안 5개를 요청해도 `checkSubscription`이 불허하면 → 429.
- U6. `Upgrade: h2c` 등 비-websocket upgrade → 426.
- U7. 평범한 `GET /api/v1/stream`(Fastify) → 426 `UPGRADE_REQUIRED` with `requestId`.
- U8. `authenticate`가 예상 밖 예외(DB 오류) → 500, socket destroyed, 프로세스 `uncaughtException` 없음.
- U8b. 클라이언트가 텍스트 프레임(`{"afterSequence":"3"}` 포함) 또는 바이너리 프레임 전송 → 서버가 1003으로 닫음, `stream.inbound_rejected` 로그 1건.
- U9. `closeAll(1012)` → 접속 중 클라이언트 모두 close code 1012 수신; `detach()` 후 `server.listenerCount('upgrade')===0`; 이후 upgrade 시도는 연결 종료.
- U9b. **종료 경합**: `authenticate`를 `Deferred`로 막은 채 클라이언트 접속(`pendingCount()===1`) → `detach()` 호출 → 원시 소켓이 파괴되어 클라이언트가 101 없이 연결 종료를 관측, `pendingCount()===0` → 그 뒤 `Deferred`를 해결 → `handleUpgrade`가 호출되지 않음(`wss.handleUpgrade` spy 0회), `hub.size()===0`, 예외·`uncaughtException` 없음.
- U9c. **재검사 경합**: `Deferred` 대기 중 `closing`만 먼저 `true`가 되는 순서(`detach()` 내부 순서를 spy로 관측)에서도 9단계 재검사가 `handleUpgrade`를 막는다 — `detach()`의 listener 제거와 pending 파괴 사이에 인증이 해결되는 경우를 `Deferred` 해결 시점으로 재현.
- U9d. **닫기 상한**: `close` 프레임에 응답하지 않는 클라이언트(원시 TCP로 101만 받고 close echo를 보내지 않음) 2개 접속 → `closeAll(1012)`가 `STREAM_CLOSE_GRACE_MS + 500 ms` 안에 해결되고 `hub.size()===0`, 두 소켓 모두 `terminate` 호출 관측(fake timer로 상한 경과 주입).
- U10. `cookieValueFromHeader`와 `cookieValue`가 같은 입력(`a=1; sid=x%3Dy; b=2`)에 같은 결과 — 파서 공유 회귀 테스트.

**웹 테스트** `+ apps/web/src/features/portfolio/use-portfolio-stream.test.tsx`(vitest + `@testing-library/react`, `webSocketFactory` 주입, `vi.useFakeTimers`):

- W1. `queryClient.setQueryData(PORTFOLIO_QUERY_KEY, …)`로 `accountSequence: '42'` 스냅샷을 시드한 뒤 훅 마운트 → 팩토리가 받은 URL의 `searchParams.get('afterSequence') === '42'`; 가짜 소켓 `send` 호출 0회(`onopen` 이후에도).
- W1b. 스냅샷 없음(`accountSequence` 미정) 또는 `'abc'` → URL에 `afterSequence` 키 없음, `send` 0회.
- W2. 재접속: 이벤트로 `accountSequence`가 `'45'`가 된 뒤 소켓을 닫음 → backoff 후 두 번째 팩토리 호출 URL의 `afterSequence === '45'`.
- W3. 연결 생존: `ready{heartbeatIntervalMs:30000}` 수신 후 가짜 서버가 30 s마다 `heartbeat` 프레임을 보내면 5분(10주기) 동안 `close` 호출 0회, 팩토리 호출 1회. heartbeat를 멈추면 마지막 heartbeat로부터 60 s에 `close(4000, 'heartbeat timeout')` 1회 후 재접속 팩토리 호출.

### 7.6 사용자 스트림 heartbeat (`StreamHeartbeatLoop`)

`StreamSession.open`이 `ready` 프레임에 광고하는 `heartbeatIntervalMs`(현재 모듈 내부 상수 `HEARTBEAT_MS = 30_000`; A가 `export const STREAM_HEARTBEAT_MS`로 이름을 바꿔 export한다)는 서버가 실제로 그 주기로 `{type:'heartbeat', serverTime}`을 보낼 때만 의미가 있다(§1.1-9). 웹 훅은 두 주기(60 s) 안에 `heartbeat`(또는 다른 프레임)가 없으면 `close(4000, 'heartbeat timeout')`하므로, heartbeat가 없으면 모든 사용자 스트림이 60 s마다 끊긴다.

- **타이머는 프로세스에 하나다.** `+ modules/stream/stream-heartbeat-loop.ts`의 `StreamHeartbeatLoop({ hub, intervalMs: STREAM_HEARTBEAT_MS, clock })`는 `setInterval` 하나로 매 `intervalMs`마다 `hub.heartbeat(clock().toISOString())`를 호출한다. `StreamSession`도 브리지도 소켓별 타이머를 갖지 않는다(`ports.ts`의 “no port owns a timer of its own” 규칙과 같은 정신). `STREAM_HEARTBEAT_MS`는 `stream-session.ts`에서 export하는 **하나의 상수**이며 `ready.heartbeatIntervalMs`와 loop 주기가 같은 값을 참조한다(둘이 갈라지면 테스트 H1이 실패한다).
- `StreamHub.heartbeat(serverTime)`은 등록된 모든 `StreamSession`에 `session.heartbeat(serverTime)`을 호출한다. `StreamSession.heartbeat(serverTime)`은 `#send({type:'heartbeat', serverTime})`이며 `#closed`면 무시한다. 백프레셔 큐(`deliver`의 `bufferedAmount` 검사)는 거치지 않는다 — heartbeat는 순서 보장이 필요한 계정 이벤트가 아니고, 소켓이 막혀 있으면 `bufferedAmount`가 늘어 다음 `deliver`가 `BACKPRESSURE`로 닫는다.
- 수명: `ProductionRuntime.start()`가 `attach()` 직후(`app.listen` 전)에 `loop.start()`하고, §6.6-5 `closeSockets()`가 `detach()` 전에 `loop.stop()`한다(`clearInterval`, 멱등). `ACQUIRING_LEASES`·`DRAINING`을 포함해 소켓이 존재할 수 있는 모든 프로세스 상태에서 loop는 돌고 있다. e2e `start-system.ts`도 같은 loop를 시작한다.
- 웹 훅은 변경하지 않는다. 훅은 이미 `heartbeat`를 파싱하고 타임아웃을 재설정한다.

**테스트**

- H1. `stream-heartbeat-loop.test.ts`(fake timer): 인메모리 `StreamHub`에 세션 3개 등록 → `start()` → 30 s 진행마다 각 세션의 소켓이 `{type:'heartbeat', serverTime}` 1건씩 수신(`serverTime`이 주입 clock의 ISO 문자열); 90 s 동안 각 3건, `setInterval` 호출 1회(소켓별 타이머 없음 증명: `vi.getTimerCount() === 1`); `stop()` 후 진행 시 추가 프레임 0건; `stop()` 두 번 호출 무해. 그리고 `STREAM_HEARTBEAT_MS === ready.heartbeatIntervalMs`(실제 `StreamSession.open`이 보낸 `ready` 프레임에서 읽은 값)를 단언.
- H2. `stream-upgrade.test.ts`에 추가: 실제 `ws` 클라이언트 접속 후 fake timer 30 s 진행 → 클라이언트가 `heartbeat` 프레임 수신; 닫힌 세션(`hub.unregister` 뒤)에는 `send`가 호출되지 않음.
- H3. §11.1 A5의 종료 순서 spy가 `loop.stop()`이 `detach()` 앞에서 호출됨을 기록하고, 종료 후 `vi.getTimerCount()`(또는 `process.getActiveResourcesInfo()`)에 heartbeat 타이머가 남지 않음을 단언.
- W3(§7.5 웹 테스트)가 클라이언트 쪽 생존을 증명한다. 실시간 30 s를 기다리는 테스트는 두지 않는다.

## 8. Fail-closed 오류 처리

원칙: **불확실하면 거래를 막고 취소는 남긴다.** 프로세스 종료는 “거래를 막을 수단마저 신뢰할 수 없을 때”만 허용된다.

### 8.1 오류 분류

| 분류 | 예 | 처리 | 프로세스 |
|---|---|---|---|
| 설정 오류 | 필수 env 누락, production에서 `MARKET_DATA_ADAPTER` 누락, production에서 `fake`, 비-loopback URL 덮어쓰기 | `ConfigError` 로그(비밀 값 미출력) | **EXIT 1**, 네트워크 접속 전 |
| 저장소 오류(시작) | DB 접속 실패, migration 실패 | 로그 | **EXIT 1** |
| 불변식/감사 오류(시작) | `verifyInvariants` 실패, audit 테이블 불가 | 수동 GLOBAL incident 기록 시도 후 | **EXIT 1** |
| provider 오류 | 토큰 401/403/429, WS 연결 실패, 선언 거부, 스냅샷 실패, `server-shutdown`, 2 missed pong | MARKET(또는 SYMBOL) incident, `DEGRADED`, 재시도(§8.3) | 계속 실행, `CANCEL_ONLY`(해당 시장) |
| lease 손실(운영 중) | lease 연결 `error`/`end` | §6.5 | 계속 실행 |
| 저장소 오류(운영 중) | `UnitOfWork` 연속 실패, `/health/ready` db false | 기존 `TransactionErrors` 알림; admission latch는 그대로(DB가 곧 gate이므로 DB 불가 = 거래 불가) | 계속 실행; readiness 503으로 트래픽 차단 |
| 불변식 위반(운영 중) | `InvariantViolation` 도메인 오류 | 기존 emergency latch(LOCAL incident) 활성화, 알림 | 계속 실행, 운영자 롤백 판단(배포 가이드) |

### 8.2 `SupervisedRecovery`

`RecoveryCoordinator.recover`를 감싸서:

- `MarketDataError`, OAuth 오류, `AbortError` 이외의 네트워크 오류를 잡아 `causeCode`로 변환한다: `PROVIDER_AUTH_FAILED`(401×2), `PROVIDER_IP_NOT_ALLOWED`(403), `PROVIDER_RATE_LIMITED`(429), `PROVIDER_CONNECT_FAILED`(WS 연결 실패), `SUBSCRIPTION_REJECTED`, `PROVIDER_UNAVAILABLE`(그 외).
- incident를 활성화하고 `ReconnectSupervisor`에 재시도를 예약한 뒤 **정상 반환**한다. `StartupCoordinator`는 예외를 보지 않으므로 admission을 열고 `SERVING`으로 간다. 시장은 incident 덕분에 `CANCEL_ONLY`다.
- 불변식·감사 오류(`InvariantViolation`, `TransactionalAuditFailure`)는 잡지 않고 던진다 → `StartupCoordinator`가 `STARTUP_INVARIANT_OR_AUDIT_FAILURE`로 처리 → EXIT 1.

### 8.3 `ReconnectSupervisor` backoff

- 지연: `reconnectDelayMs(attempt)` (기존 함수: full jitter, base 250 ms, cap 30 s).
- 창: 5분 슬라이딩 창에서 3회 실패 시 자동 재시도 중단 + 수동 incident `RECOVERY_RETRY_EXHAUSTED`(선행 문서 §7.3-9). 실패 = `SupervisedRecovery`가 incident를 만든 경우.
- `server-shutdown` 에러 프레임 수신 시 첫 재시도 지연은 1 s 고정(계약 권고 1s→2s→4s와 일치하도록 `attempt=2`부터 시작).
- 재시도 성공은 `feed_reconnect_total{market}` 카운터 증가 후 `RECOVERING → HEALTHY`.

### 8.4 provider 오류 코드 매핑 (B)

| provider 신호 | 어댑터 오류 | 런타임 causeCode |
|---|---|---|
| WS handshake 401 | `AUTH_FAILED` | `PROVIDER_AUTH_FAILED` |
| WS handshake 403 / REST 403 | `AUTH_FAILED` | `PROVIDER_IP_NOT_ALLOWED` |
| REST 429 | `RATE_LIMITED`(신규 코드), `Retry-After` 존중 후 최대 2회 재시도 | `PROVIDER_RATE_LIMITED` |
| error frame `rate-limit-exceeded` | `SUBSCRIPTION_REJECTED` (1 s 후 재선언 1회) | `SUBSCRIPTION_REJECTED` |
| error frame `too-many-topics`, `wrong-format`, `no-type`, `invalid-type`, `no-codes`, `too-many` | `SUBSCRIPTION_REJECTED` | `SUBSCRIPTION_REJECTED` |
| error frame `server-shutdown` | `TRANSPORT_CLOSED` 이벤트 | `TRANSPORT_CLOSED` |
| error frame `internal-error` | `TRANSPORT_CLOSED` | `PROVIDER_UNAVAILABLE` |
| ack `rejected[]` 일부 | `declare()` 반환값 | `SUBSCRIPTION_REJECTED` (RecoveryCoordinator 기존 동작: 거부가 하나라도 있으면 실패) |
| 2 missed pong | `PONG_FAILED` | `PONG_FAILED` |
| 비정상 close (코드 없음) | `TRANSPORT_CLOSED` | `TRANSPORT_CLOSED` |

## 9. 가짜 provider 계약 전략 (B)

### 9.1 원칙

- 가짜 서버는 `packages/market-data/contracts/toss/openapi.json`, `asyncapi.json`(SHA-256이 `provenance.json`과 일치해야 함)에서 파생된 **행동 모델**이다. 테스트 시작 시 두 파일의 해시를 단언하고, 불일치면 전체 스위트가 실패한다(기존 규칙 유지).
- 응답 본문은 계약의 `examples`와 기존 `fixtures/toss/*.json`에서만 만든다. 가짜 서버는 새 필드를 발명하지 않는다.
- 가짜 서버는 `127.0.0.1`의 임의 포트에만 바인드한다. `0.0.0.0` 바인드는 코드상 불가능하게 한다(host 인자 없음).

### 9.2 `FakeTossRestServer` (`node:http`)

지원 경로와 행동:

| 경로 | 행동 |
|---|---|
| `POST /oauth2/token` | form 본문 검증(`grant_type=client_credentials`, 등록된 `client_id/secret`). 성공: `{access_token, token_type:'Bearer', expires_in}`(`expires_in`은 제어 API로 설정, 기본 86400). 재발급 시 이전 토큰을 무효화(client당 1개). 실패: 계약 예시대로 `400 invalid_request/unsupported_grant_type`, `401 invalid_client` + `WWW-Authenticate: Basic realm="openapi"`, `403 access_denied`, `429`. |
| `GET /api/v1/prices`, `/api/v1/orderbook`, `/api/v1/stocks/all`, `/api/v1/market-calendar/{KR\|US}`, `/api/v1/exchange-rate` | `Authorization: Bearer` 검증(무효/만료/무효화된 토큰 → 401). 응답은 하네스가 시드한 심볼별 현재가·호가(결정적, `lossy-recovery.json`과 같은 시드 규칙). envelope `{success:true, result}`. |
| 그 외 | 404. 주문·계좌 경로는 **구현하지 않는다**(호출되면 404 → 테스트 실패로 드러남). |

제어 API(in-process, HTTP 아님): `issueCredentials()`, `setTokenTtl(seconds)`, `invalidateAllTokens()`, `failNext(path, status, count)`, `setRetryAfter(seconds)`, `seedSnapshot(market, symbol, price, book)`, `requests()`(경로·상태·Authorization 존재 여부만 기록, 토큰 값은 기록하지 않음).

### 9.3 `FakeTossWsServer` (`ws`)

| 계약 규칙 | 가짜 서버 행동 |
|---|---|
| handshake `Authorization: Bearer` | 없음/무효 → HTTP 401로 upgrade 거부; 미등록 IP 시뮬레이션 플래그 → 403 |
| 계정당 동시 연결 2개, 초과 시 가장 오래된 연결 종료 | 정확히 구현. `peakConcurrentConnections`, `evictions` 카운터 노출 |
| 선언 = JSON 배열 텍스트 프레임, full-replace, `[]`는 전체 해제 | 구현. 객체 프레임 → `error wrong-format` |
| 연결당 100 topic | 초과 → `error too-many-topics` |
| 선언 5회/초 | 초과 → `error rate-limit-exceeded` |
| ack `{"type":"subscriptions","subscribed":[...],"rejected":[...],"id"?}`가 데이터보다 먼저 | 구현. `rejectTopics()` 제어로 `symbol-market-mismatch` 등 거부 주입 |
| 텍스트 `PING` → `{"type":"pong"}` | 구현. `failNextPongs(n)`으로 무응답 주입 |
| 180 s 클라이언트 무수신 시 종료 | 구현(하네스 가상 시계로 단축 가능) |
| `server-shutdown` 에러 프레임 후 종료 | `announceShutdownAndClose()` 제어 |
| 데이터 프레임 `{"type":"message","topic":"trade:us:AAPL","data":{...}}` | `emitTrade`, `emitOrderBook`, `dropNext(n)`, `emitOutOfOrder([...])` — 기존 conformance 하네스 동사와 1:1 |

`runMarketDataConformance`(기존 `adapter-conformance.ts`)를 `TossWebSocketMarketData + FakeTossWsServer` 조합으로 실행하는 것이 B의 1차 수용 기준이다. 이는 §1.1-1의 프레임 결함을 자동으로 드러낸다.

### 9.4 테스트 계층

| 계층 | 도구 | provider |
|---|---|---|
| 단위(어댑터 파서/토큰 캐시) | vitest, 인메모리 `FetchLike`/`TossSocketFactory` | 없음 |
| 어댑터 통합 | vitest + `FakeTossRestServer/WsServer`(실 TCP loopback) | 가짜 |
| 런타임 통합(A) | vitest + Testcontainers PG/Redis + `FakeMarketData` 번들 | 가짜(인메모리) |
| 런타임 통합(B) | 위 + `toss` 번들 + 가짜 서버 | 가짜(TCP) |
| 인계 드릴(C) | vitest + Testcontainers + 가짜 서버 + 두 자식 프로세스 | 가짜(TCP) |
| e2e(Playwright) | 기존 `MARKET_DATA_ADAPTER=fake` | 가짜(인메모리) |

### 9.5 라이브 provider 접속 금지 규칙 (명시)

1. 저장소의 어떤 테스트, CI 잡, 스크립트, 픽스처 생성기, 드릴도 `openapi.tossinvest.com`, `openapi-ws.tossinvest.com` 또는 그 외 비-loopback provider host에 접속하지 않는다.
2. 강제 수단:
   - vitest 전역 setup(`packages/market-data`, `apps/paper-api`)이 `globalThis.fetch`와 `ws` 클라이언트 생성을 감싸 대상 host가 loopback이 아니면 `Error('LIVE_PROVIDER_FORBIDDEN: <host>')`를 던진다. Testcontainers는 Docker 소켓/loopback만 사용하므로 영향 없다.
   - `scripts/check-deployment-contract.mjs`가 CI 워크플로의 `TOSS_` 참조를 금지한다(기존). 테스트 소스에서 `tossinvest.com` 문자열이 계약 파일·이 문서·`TOSS_CONTRACT_SERVERS` 상수 이외에 등장하면 실패하도록 검사를 추가한다.
   - `provenance.json` 해시 단언(기존).
3. 계약 갱신은 사람이 `curl`로 파일을 받아 `provenance.json`의 `retrievedAt`·`sha256`을 갱신하는 수동 커밋이다. 자동화하지 않으며, 갱신 커밋은 가짜 서버·어댑터 테스트가 통과할 때만 병합된다.
4. 실제 자격증명은 개발자 머신·CI·테스트 어디에도 필요하지 않다. 프로덕션 secret store에만 존재한다.
5. 이 규칙의 예외는 없다. “한 번만 확인”도 금지다. 라이브 검증은 배포 후 운영 관측(§12)으로만 이루어진다.

## 10. 우아한 인계 드릴 (C)

### 10.1 구성

- 하네스가 PostgreSQL 17, Redis 7 Testcontainer, `FakeTossRestServer`, `FakeTossWsServer`를 띄우고 자격증명을 발급한다.
- 프로세스 P1, P2는 `node apps/paper-api/dist/main.js`를 `child_process.spawn`으로 실행한다(빌드된 산출물, 프로덕션 진입점). 공통 env: `NODE_ENV=production`, `MARKET_DATA_ADAPTER=toss`, `TOSS_REST_BASE_URL=http://127.0.0.1:<rest>`, `TOSS_WS_URL=ws://127.0.0.1:<ws>/ws/v1`, `RECOVERY_STABILITY_MS=500`, `SHUTDOWN_DRAIN_DEADLINE_MS=10000`, 그리고 §5.1의 필수 비밀(하네스가 생성). `PORT`는 각각 다른 임의 포트, `PUBLIC_ORIGIN`은 동일.
- 하네스는 `/health/*`, `/api/v1/health/trading`, `/health/market-data`를 폴링(100 ms)해 관측 로그 `[{t, process, endpoint, body}]`를 만든다.

### 10.2 절차와 단언

| 단계 | 행위 | 단언 |
|---|---|---|
| 1 | P1 시작 | 20 s 내 `/health/ready` 200; 두 시장 `NORMAL`; `placement:true`; 가짜 WS `connections===2`, `leader_epochs.epoch` = (KR:1, US:1) |
| 2 | 익명 세션 생성, MARKET 주문 1건 체결, LIMIT 주문 1건 대기 | 체결 outbox 이벤트가 사용자 WS로 전달됨(하네스 클라이언트) |
| 3 | P2 시작 | 5 s 내 P2 `/health/ready` 200, trading `reasons ⊇ ['CANCEL_ONLY','ACQUIRING_LEASES']`; 가짜 WS `connections===2`(변화 없음), `peakConcurrentConnections===2`; P2의 REST 요청 기록 0건(토큰 요청 포함) |
| 4 | P1에 `SIGTERM` | 200 ms 내 P1 trading `reasons ⊇ ['CANCEL_ONLY','DRAINING']`, `/health/ready` 503; 드레인 중 P1으로 보낸 취소 요청(대기 LIMIT) 200; 신규 주문 요청 409 `CANCEL_ONLY` |
| 5 | P1 종료 관측 | 종료 코드 0, `SHUTDOWN_DRAIN_DEADLINE_MS + 5 s` 내; 종료 시점에 `outbox_events where published_at is null` 개수 0; 가짜 WS `connections===0`인 순간이 P2 연결 전에 존재; P1 해제 증명은 **현재 `leader_epochs` 행이 아니라** 내구성 있는 흔적으로 한다: `audit_events`에 P1 `leaderId`의 `LEADER_RELEASED` 2건(KR, US)이 존재하고, 시장별로 P1 `LEADER_RELEASED{market}`의 `occurred_at`이 P2 `LEADER_ACQUIRED{market}`보다 앞선다 — §5.4대로 P1의 해제 감사가 unlock 전에 커밋되고 P2의 획득 감사가 같은 lock 아래에서 커밋되므로 이 순서는 타이밍이 아니라 lock 직렬화가 보장한다; P1 stdout 로그에 `lease.released {auditPersisted:true}` 2건. 하네스가 100 ms `leader_epochs` 폴링으로 `{leader_id:P1, released_at not null}` 전이를 포착했다면 증거 JSON에 기록하되 **단언하지 않는다**(P2 재획득이 그 행을 즉시 덮어쓰므로 포착은 타이밍 의존) |
| 6 | P2 인계 | P1 종료 후 15 s 내 P2 두 시장 `RECOVERING` 관측 → `NORMAL`; `leader_epochs` 현재 행 두 개 모두 `epoch=2`, `leader_id`=P2 leaderId, **`released_at is null`**; P2 REST 기록에 `/oauth2/token` 1건이 P2 `LEADER_ACQUIRED` 두 건 **모두의 `occurred_at` 이후** 타임스탬프(§5.4: `acquire`는 감사 커밋 뒤 반환, 토큰은 그 뒤); 가짜 WS `connections===2`, `peakConcurrentConnections===2`, `evictions===0` |
| 7 | P2에서 신규 MARKET 주문 | 체결, `fills.recovery_epoch = 2`, fencing token = P2 값 |
| 8 | 감사 검증 | `audit_events`를 `occurred_at, id`로 정렬하면 P1: `RUNTIME_DRAINING` → `LEADER_RELEASED×2` → `RUNTIME_STOPPED{forced:false}`; P2: `LEADER_ACQUIRED×2` → `RECOVERY_COMPLETED×2` → `RUNTIME_STATE_CHANGED(→SERVING)`; 시장별 P1 `LEADER_RELEASED{market}` < P2 `LEADER_ACQUIRED{market}`; 전체에서 `LEADER_RELEASED`는 P1 leaderId로 정확히 2건(`LeaseRegistry`가 두 번째 해제 감사를 쓰지 않음을 증명). 하네스 관측 로그에서 P1 `/health/ready` 503 첫 관측 < P2 `RECOVERING` 첫 관측 |
| 9 | 부정 경로 | P2를 `SIGKILL`로 죽인 뒤 P3 시작 → advisory lock이 자동 해제되어 P3가 epoch 3으로 `NORMAL` 도달(비정상 종료 복구 증명) |

전체 드릴 시간 상한 120 s. 드릴은 `pnpm --filter @skipjack/paper-api test -- leader-handoff.drill` 로 실행되며 Docker가 필요하다. Docker 없는 환경에서는 skip이 아니라 **실패**한다(릴리스 증거이므로).

### 10.3 산출 증거

드릴은 `apps/paper-api/test-results/leader-handoff/<utc>.json`에 관측 로그, 연결 카운터, epoch 테이블, 종료 코드를 기록한다(untracked). 릴리스 체크리스트 갱신 시 이 파일의 요약(시각, 커밋, peak=2, evictions=0)을 인용한다.

## 11. A/B/C 경계와 수용 기준

### 11.1 Stage A — ProductionRuntime (provider-neutral)

범위: §4.1의 A 소유 컴포넌트, `main.ts` 축소, `003_leader_release.sql`과 `LeaderLease` acquire/release 수정 + `LeaseAuditPort`(§5.4), `/health/*` 확장, `registerStreamRoutes`(426 폴백) + `ws` noServer upgrade 브리지 + `parseStreamQuery` + 웹 훅 `streamUrl(afterSequence)` 정렬(§7.5), `StreamHeartbeatLoop`(§7.6), `config.ts`의 `MARKET_DATA_ADAPTER` 명시 규칙(§5.1), 문서 드리프트 수정(§1.1-7), `check:deployment` 확장(`TOSS_CLIENT_*` 필수 보간 — 값은 아직 사용되지 않아도 계약으로 선언 — 과 compose `MARKET_DATA_ADAPTER: toss` 리터럴 단언), `release-drill.integration.test.ts`의 “unavailable” 케이스를 `MARKET_DATA_ADAPTER=toss` + `TOSS_CLIENT_*` 누락 → `ConfigError` EXIT 1로 재정의(A에서는 `toss adapter is not available in this build`, B 이후에는 자격증명 누락 오류 — 둘 다 EXIT 1). 자동 테스트의 provider는 `fake` 번들만 사용.

수용 기준:

- A1. `MARKET_DATA_ADAPTER=fake`, Testcontainers PG/Redis로 `ProductionRuntime`을 시작하면 `BOOTING→…→SERVING`, 두 시장 `NORMAL`, `leader_epochs` 두 행, `placement:true`.
- A2. 가짜 스트림 `deliverTransportClose` → 해당 시장만 `DEGRADED`(다른 시장 `NORMAL`, 배치 가능) → 자동 recovery → `NORMAL`; epoch +1; `feed_reconnect_total` +1.
- A3. 5분 창 3회 실패 시 `RECOVERY_RETRY_EXHAUSTED` 수동 incident, 자동 재시도 중단; 해제 시 재시도 재개.
- A4. lease 연결 강제 종료(`pg_terminate_backend`) → 300 ms 내 `stream.close()` 호출 관측, `LEADER_LEASE_LOST` incident, 재획득 후 새 epoch.
- A5. `SIGTERM` → §6.6 순서대로 콜백 호출(순서를 기록하는 spy), outbox 잔여 0, lease 해제, 종료 코드 0, 소요 < deadline.
- A6. outbox: 트랜잭션에 append된 이벤트가 접속 중 `StreamSession`에 1 s 내 도달; 미접속 세션 이벤트는 `published_at` 기록 후 재접속 시 `afterSequence`로 회수.
- A7. `verifyInvariants` 실패 주입 → `STARTUP_INVARIANT_OR_AUDIT_FAILURE` incident 행 존재, 종료 코드 1; 재시작 시 incident 때문에 `CANCEL_ONLY` 유지.
- A8. production + `fake` → 시작 실패; production + `MARKET_DATA_ADAPTER` 누락 → 시작 실패(`ConfigError: MARKET_DATA_ADAPTER must be set explicitly in production`); development/test + 누락 → `fake`로 시작; 비-loopback URL 덮어쓰기 → 시작 실패. `check:deployment`가 compose의 `MARKET_DATA_ADAPTER: toss` 리터럴을 단언하고, 리터럴을 제거·보간·`fake`로 바꾼 임시 사본에서 실패함을 테스트로 증명.
- A9. 기존 게이트 전부 통과: `pnpm check`, `typecheck`, `test`, `check:deployment`, `build`, e2e 18/18.
- A10. `RecoveryCoordinator`가 시작 중 lease를 재획득해도 `leader_epochs.epoch`가 1만 증가(멱등 증명).
- A11. §5.4의 lease 테스트 6건(first acquire, release, reacquire, no race, release audit failure, acquire audit failure) 통과; `acquire()`의 query 순서가 `begin` → `pg_advisory_lock` → upsert → `insert audit_events(LEADER_ACQUIRED)` → `commit`이고 promise가 `commit` 뒤 해결; `release()`의 query 순서가 `begin` → `update released_at` → `insert audit_events(LEADER_RELEASED)` → `commit` → `pg_advisory_unlock` → 연결 종료; `LeaseRegistry`가 감사 행을 직접 쓰지 않음(`audit_events` insert 호출 지점이 `LeaseAuditPort` 구현 하나뿐임을 정적 검사).
- A12. §7.5의 upgrade 브리지 테스트 U1~U10(U1b·U1c·U8b·U9b·U9c·U9d 포함)과 §7.6 H1~H3 통과; 프로덕션 `main.ts` 경로로 기동한 런타임 통합 테스트에서 `ws` 클라이언트가 쿠키 인증 + `?afterSequence=<n>` 쿼리로 101을 받고 outbox 이벤트를 수신하며(A6과 같은 픽스처), 접속 후 텍스트 프레임을 보내면 1003으로 닫힘.
- A13. 웹 테스트 W1~W3(§7.5) 통과; `use-portfolio-stream.ts` diff가 `streamUrl` 시그니처·`connect()`의 URL 인자·`onopen`의 `send` 제거 외 변경을 포함하지 않음(리뷰 항목); e2e 18/18은 e2e `start-system.ts`가 브리지 + `StreamHeartbeatLoop`로 전환된 뒤 통과(A9와 동일 게이트).

Codex 검증 항목: 상태 전이 순서 spy 테스트를 독립 재실행; §6.6 순서 위반 여지 코드 리뷰; upgrade 브리지가 Fastify 훅에 의존하지 않고 모든 검사를 직접 수행하는지·거부 경로가 socket을 반드시 destroy하는지·`handleUpgrade` 직전에 `closing`/`socket.destroyed`를 재검사하는지·`closeAll`이 상한 안에 `terminate`로 수렴하는지 코드 리뷰; 웹 훅이 open 뒤 프레임을 전혀 보내지 않고 서버가 모든 인바운드 프레임을 1003으로 닫는 양쪽 정합 확인; heartbeat 타이머가 프로세스에 정확히 하나이고 `ready.heartbeatIntervalMs`와 같은 상수를 쓰는지 확인; `acquire`/`release`가 감사를 lease 연결의 같은 트랜잭션에서 커밋하고 unlock이 `finally`에 있는지, `LeaseRegistry`에 두 번째 감사 경로가 없는지 확인; `cancelOnly` 불리언·스텁 엔진 삭제 확인; `main.ts`가 조립 이외 로직을 갖지 않음; 새 코드 mutation 테스트(기존 리뷰 관례).

### 11.2 Stage B — OAuth + Toss REST/WS 어댑터, 가짜 서버

범위: §5.5, §5.7, §8.4, §9, §1.1-1·2·3 결함 수정, `toss` 번들, `TossRestClient` 429/`Retry-After`.

수용 기준:

- B1. `runMarketDataConformance`가 `TossWebSocketMarketData + FakeTossWsServer`로 전부 통과.
- B2. 선언 프레임이 계약 배열 형식; 가짜 서버가 객체 프레임을 `wrong-format`으로 거부하는 회귀 테스트 존재.
- B3. `transportClosed.market`이 어댑터 인스턴스 시장과 일치.
- B4. 어댑터에 `setInterval` 없음(정적 검사 테스트); `KeepaliveLoop` 주도 ping이 가짜 서버 pong 기록과 1:1.
- B5. 토큰: 캐시 히트, 5분 전 갱신, 401→1회 재발급→성공, 401×2→`AUTH_FAILED`, 403→재시도 없음, 10 s 재발급 스로틀, 동시 호출 단일 in-flight.
- B6. REST 429 + `Retry-After: 2` → 2 s 대기 후 재시도, 최대 2회.
- B7. 런타임 통합(B): `toss` 번들 + 가짜 서버로 A1~A5 동등 시나리오 통과. 특히 `server-shutdown` 프레임 → 1 s 후 재연결 → `NORMAL`.
- B8. 로그 캡처 전체에서 정규식 `Bearer\s+\S+`, `client_secret=`, 발급된 토큰 문자열 등장 0건.
- B9. 라이브 접속 가드(§9.5-2) 테스트: 비-loopback fetch 시도가 `LIVE_PROVIDER_FORBIDDEN`으로 실패.
- B10. 계약 해시 단언과 `TOSS_CONTRACT_SERVERS` 상수 일치 테스트.

Codex 검증 항목: 가짜 서버 행동 표(§9.3)와 AsyncAPI 원문 대조; 어댑터가 계약 밖 필드에 의존하지 않음; 토큰 무효화 경합(재발급 중 401) 코드 리뷰; 비밀 문자열 로그 grep 독립 재실행.

### 11.3 Stage C — 2-프로세스 인계 드릴

범위: §10 하네스와 드릴, 릴리스 체크리스트·배포 가이드 증거 갱신, 런북 “Verification” 절에 드릴 명령 추가.

수용 기준: §10.2의 1~9 전부. 추가로:

- C1. 드릴 3회 연속 통과(플래키 방지), 각 실행 `peakConcurrentConnections===2`, `evictions===0`.
- C2. 드릴 산출 JSON(§10.3)이 생성되고 체크리스트가 그 요약을 인용.
- C3. 릴리스 체크리스트의 미완 항목을 `[x]`로 바꾸는 커밋은 C의 마지막 커밋이며, Codex 검증 통과 후에만 작성.

Codex 검증 항목: 드릴을 독립 실행해 동일 결과; 단계 3에서 P2의 REST 기록 0건과 단계 6의 토큰 타임스탬프 순서 재확인; 단계 5·8의 해제 증명이 현재 `leader_epochs` 행에 의존하지 않음(감사·로그 기반)과 `LEADER_RELEASED`→`LEADER_ACQUIRED` 순서가 §5.4의 lock 아래 커밋에서 나오는지(3회 반복에서 시장별 순서 역전 0건) 확인; 하네스가 프로덕션 진입점(`dist/main.js`)을 쓰는지 확인(테스트 전용 진입점 금지).

### 11.4 단계 간 규칙

- A는 B 없이 병합 가능하다(`toss` 번들 선택 시 A 상태에서는 `ConfigError: toss adapter is not available in this build`로 시작 실패 — fail-closed). B 병합 후 이 오류 경로가 삭제된다. compose가 `MARKET_DATA_ADAPTER: toss`를 리터럴로 갖고 production은 `fake`를 금지하므로, **A만 병합된 이미지는 프로덕션에 배포할 수 없다**(기동 즉시 EXIT 1). 이는 의도된 fail-closed이며, 프로덕션 배포는 B 이후에만 한다. A9의 `check:deployment`는 정적 검사이므로 A에서 통과한다.
- C는 B에 의존한다. C 전에는 체크리스트 항목이 미완으로 남는다.
- 각 단계는 별도 커밋 시리즈이며, 단계 시작 전 이 문서와의 편차가 발견되면 이 문서를 먼저 수정하는 `docs:` 커밋을 만든다.

## 12. 보안과 관측성

### 12.1 보안

- 비밀 경계는 §5.6. 브라우저 번들·`web` 서비스 env·CI에 `TOSS_` 금지는 `check:deployment`가 강제.
- provider IP 허용 목록: Toss는 등록 IP만 허용한다. 배포 가이드에 “`paper-api`의 egress IP는 고정이어야 하며 secret store 옆에 기록”을 추가한다. `403`은 코드가 아니라 운영 설정 문제이므로 `PROVIDER_IP_NOT_ALLOWED` 런북 항목을 `market-data-degraded.md`에 추가한다.
- 로거 redaction: 기존 규칙에 `authorization`, `access_token`, `client_secret`, `TOSS_CLIENT_SECRET` 키와 `Bearer\s+\S+` 값 패턴을 추가한다. 감사 payload에는 토큰·client id를 넣지 않는다(leaderId만).
- 가짜 서버는 loopback 전용, 테스트 프로세스 수명과 함께 종료. 자격증명은 매 실행 생성.
- 관리자 API(`/admin/*`)는 변경 없음. 수동 incident 해제가 인계 복구의 유일한 사람 개입 지점이다.

### 12.2 메트릭 (추가/확정)

| 이름 | 종류 | 라벨 |
|---|---|---|
| `runtime_state` | gauge(0/1) | `state` |
| `market_data_health` | gauge(0/1) | `market`, `state` (기존 알림 사용) |
| `leader_epoch` | gauge | `market` |
| `leader_lease_held` | gauge(0/1) | `market` |
| `leader_lease_wait_seconds` | gauge | `market` |
| `provider_connections_open` | gauge | 없음(프로세스 합계) |
| `provider_token_refresh_total` | counter | `result` = `ok\|auth_failed\|throttled\|error` |
| `feed_reconnect_total` | counter | `market` (기존 알림) |
| `recovery_duration_seconds` | gauge | `market` (기존 알림) |
| `market_event_rejected_total` | counter | `market`, `reason` |
| `outbox_oldest_pending_seconds` | gauge | 없음 (기존 알림) |
| `outbox_published_total` | counter | 없음 |
| `outbox_drain_remaining` | gauge | 없음 |
| `stream_sessions_open` | gauge | 없음 (`StreamHub.size()`, heartbeat마다 갱신) |
| `shutdown_drain_seconds` | gauge | `phase` = `inflight\|outbox\|sockets\|leases` |
| `shutdown_forced_total` | counter | 없음 |

### 12.3 알림 추가 (`infra/monitoring/prometheus-alerts.yaml`)

- `ProviderConnectionsAboveLimit`: `provider_connections_open > 2` for 0m → 즉시, 런북 `redis-or-leader-loss.md`.
- `LeaderLeaseWaitLong`: `leader_lease_wait_seconds > 60` → 런북 `redis-or-leader-loss.md` (“이전 프로세스가 종료되지 않음” 절 추가).
- `ProviderAuthFailed`: `increase(provider_token_refresh_total{result="auth_failed"}[10m]) > 0` → 런북 `market-data-degraded.md`.
- `ShutdownForced`: `increase(shutdown_forced_total[1h]) > 0` → 런북 `postgres-or-outbox-lag.md`.

### 12.4 로그 이벤트

구조화 로그 키 `event`: `runtime.state`, `lease.acquired`, `lease.released`(`auditPersisted` 포함), `lease.release_mark_failed`, `lease.lost`, `provider.connect`, `provider.close`, `provider.token.refresh`, `recovery.start`, `recovery.complete`, `outbox.drain`, `stream.upgrade_failed`, `stream.inbound_rejected`, `shutdown.phase`. 공통 필드 `leaderId`, `market`, `epoch`, `requestId`(해당 시). 비밀 필드 없음.

## 13. 마이그레이션과 롤백

- 스키마: `003_leader_release.sql` — `alter table leader_epochs add column released_at timestamptz;` 단 하나. nullable additive이며 이전 이미지(97921b7)는 이 컬럼을 읽지도 쓰지도 않으므로 호환된다. 새 이미지의 `acquire`는 upsert에서 `released_at = null`을 쓰고 `release`는 unlock 전에 `now()`와 `LEADER_RELEASED` 감사를 같은 트랜잭션으로 쓴다(§5.4). `audit_events` 스키마 변경은 없다(`LEADER_ACQUIRED`/`LEADER_RELEASED`는 `event_type` 값일 뿐이다). 이전 이미지가 획득한 행은 `released_at`이 null인 채 남지만, 새 이미지의 다음 `acquire`가 어차피 null로 덮어쓰므로 데이터 정리가 필요 없다. 기존 규칙대로 배포 전에 one-off job으로 실행한다.
- 설정: `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`을 secret store에 추가한 뒤 배포한다. `MARKET_DATA_ADAPTER=toss`는 compose 리터럴이므로 운영자가 따로 넣을 값이 없고, 빠뜨릴 수도 없다. 비밀 누락 시 새 이미지는 §8.1에 따라 EXIT 1이며 readiness가 켜지지 않으므로 이전 프로세스를 먼저 종료하지 않았다면 영향이 없다(stop-then-start이므로 실제로는 이전 프로세스가 이미 종료된 상태 → 취소만 가능한 공백이 생기며, 이는 배포 전 `docker compose config`/secret 존재 검증으로 예방).
- 배포 절차: 배포 가이드의 stop-then-start를 그대로 따른다. 이 문서가 그 절차를 처음으로 코드로 보증한다.
- 롤백: 이전 이미지로 같은 stop-then-start. 이전 이미지는 provider를 조립하지 않으므로 `CANCEL_ONLY`로 시작한다(fail-closed, 알려진 동작). 이전 이미지는 `MARKET_DATA_ADAPTER`를 `'fake'`인지만 비교하므로 compose의 `toss` 리터럴과 `TOSS_CLIENT_*`는 무시된다. `released_at` 컬럼도 무시된다. Redis 데이터는 rate-limit뿐이므로 롤백에 영향이 없다.
- 롤백 트리거는 배포 가이드 기존 규칙 + “새 프로세스가 `ACQUIRING_LEASES`에서 60 s 이상 머무르고 이전 프로세스가 이미 종료됨”(lock 잔존 의심 → `pg_locks` 확인 후 `pg_terminate_backend`).

## 14. 미해결 없음 — 결정 사항 요약

- Redis는 lease·fan-out에 쓰지 않는다. 런북·라벨의 드리프트는 A가 고친다.
- 시장당 WS 1개, 프로세스당 2개, 계정 한도 2개. 인계는 stop-then-start만.
- 새 프로세스는 lease를 무기한 대기하며 그동안 `CANCEL_ONLY`로 서비스한다. 토큰 발급은 lease 획득 뒤다.
- provider 실패는 프로세스를 죽이지 않는다. 설정·DB·불변식 실패만 종료한다.
- 모든 자동 검증은 loopback 가짜 서버(또는 인메모리 `fake` 번들)로만 수행한다. 예외 없음.
- production의 `MARKET_DATA_ADAPTER`는 compose 리터럴 `toss`로 명시하며 암묵적 기본값이 없다. development/test 기본값만 `fake`.
- 사용자 스트림 upgrade는 Fastify 라우트가 아니라 `ws` noServer 브리지가 직접 인증·검사한다. `GET /api/v1/stream`은 426 폴백.
- 클라이언트→서버 프로토콜은 쿼리 문자열(`afterSequence`, `quoteSymbols`)만이다. 열린 뒤 인바운드 프레임은 전부 1003. 웹 훅은 `streamUrl(afterSequence)`로 정렬하고 `onopen` 전송을 삭제한다 — 이것이 유일한 프론트 변경이다.
- heartbeat는 프로세스당 하나의 `StreamHeartbeatLoop`가 30 s마다 `StreamHub.heartbeat`로 보낸다. 소켓별 타이머 없음. `ready.heartbeatIntervalMs`와 같은 상수.
- 브리지 종료는 closing latch + pending 소켓 파괴 + `handleUpgrade` 직전 재검사 + `closeAll` 2 s 상한(`terminate`)으로 경합·행 없이 끝난다.
- `released_at`과 `LEADER_RELEASED` 감사는 lock 아래에서 같은 트랜잭션으로 unlock 전에 커밋하고, `LEADER_ACQUIRED`는 `acquire`가 반환하기 전에 커밋한다. 재획득 시 `released_at`은 null로 리셋한다. 해제 증명은 감사·로그로 하며, 감사 순서는 lock 직렬화가 보장한다.
- `ws 8.18.1` + `@types/ws 8.18.1`(dev) 추가. 다른 런타임 의존성 추가 없음. `@fastify/websocket` 없음.
- `RECOVERY_STABILITY_MS`, `SHUTDOWN_DRAIN_DEADLINE_MS`만 조정 가능하게 노출하고, 나머지 시간 상수(60 s ping, 30 s pong 타임아웃, 30 s 스트림 heartbeat, 2 s 스트림 close 상한, 200 ms outbox 주기, 5분/3회 창, 5분 토큰 리드, 10 s 토큰 스로틀)는 코드 상수다.

## 15. 자기 검토 결과

- 모순 점검: §6.6(소켓 종료 후 lease 해제)와 §5.4(lease 획득 후 연결)와 §10.2-5(연결 0인 순간 존재)가 같은 불변식을 세 관점에서 말하며 충돌하지 않는다. §8.2(provider 오류는 정상 반환)와 `StartupCoordinator`의 catch(불변식 오류만 도달)가 정합한다. §6.3(`/health/ready` 200 while `ACQUIRING_LEASES`)와 §6.6-1(`DRAINING`에서 503)은 서로 다른 상태에 대한 규칙이며 충돌하지 않는다.
- 범위 점검: 실계좌·주문 채널·다중 replica·Redis lease를 명시적으로 제외했고, 프론트 변경은 §2.2의 단일 예외(`streamUrl(afterSequence)` 정렬)로 좁혀 §1.1-8·§4.1·§7.5·A13이 같은 편집을 가리킨다. 모든 신규 컴포넌트에 소유 단계가 있다.
- 스트림 프로토콜 점검(Codex 2차 리뷰 반영): 클라이언트→서버는 쿼리만이라는 규칙이 §1.1-8·§7.5(파서·3단계·U1b·U1c·U8b·프론트 정렬·W1·W2)·§14에서 같다. `tradableSymbols`(허용 목록)와 `quoteSymbols` 쿼리(요청 구독)는 §7.5 옵션 주석·규칙·`onOpen` 2·3단계·U1c에서 일관되게 구분된다. heartbeat는 §1.1-9·§7.6(단일 타이머, `STREAM_HEARTBEAT_MS` 공유)·§6.6-5(`loop.stop()`)·H1~H3·W3·§12.2·§14가 하나의 설계를 말한다.
- 종료 경합 점검: §7.5 0단계(`closing`)·6단계(`pending`)·9단계(재검사)·정리 (a)(b)와 §6.6-5의 순서(`loop.stop()` → `detach()` → `closeAll` 상한 → `wss.close()`)가 일치하고, U9b·U9c·U9d·H3가 각 경합을 하나씩 덮는다. `closeAll` 상한 덕분에 §6.6의 종료는 클라이언트 협조 없이도 끝난다.
- lease 감사 점검: §5.4(같은 트랜잭션, unlock 전 커밋, `finally` unlock, `LeaseRegistry` 무감사)·§6.6-6·§10.2-5·6·8·A11·§11.3 Codex 항목·§13·§14가 같은 순서 “P1 `LEADER_RELEASED` 커밋 → unlock → P2 lock → P2 `LEADER_ACQUIRED` 커밋 → P2 토큰”을 말하며, 순서 단언의 근거가 타이밍이 아니라 lock 직렬화임을 §5.4와 §10.2-5 양쪽에 적었다.
- 계약 점검: 연결 2개·topic 100·선언 5/s·PING 60 s·180 s idle·`server-shutdown`·토큰 단일 유효성은 모두 pinned 계약 원문에서 확인한 값이다.
- 정합 점검(Codex 리뷰 반영): §5.4(unlock 전 `released_at` 기록, acquire 시 null 리셋)와 §10.2-5·6(해제 증명은 감사·로그, 현재 행은 P2·null 단언)과 §13(컬럼 의미)이 일치한다. §7.5(브리지가 직접 검사)와 §1.1-5·§4.1·§6.6-5·A12가 같은 컴포넌트를 가리킨다. `ws`/`@types/ws` 버전은 §5.7·§14 모두 8.18.1이다. `MARKET_DATA_ADAPTER` 규칙은 §5.1·§5.6·§8.1·A8·§11.4·§13에서 같은 문장(production 명시 필수, compose 리터럴 `toss`, dev/test 기본 `fake`, production `fake` 금지)을 말한다. 자동 테스트는 여전히 fake 번들·가짜 서버만 쓴다(§9.5).
- 잔여 위험(허용): lease 손실 감지 지연 중 일시적 3번째 연결(§6.5), deadline 초과 시 outbox 잔여 행의 at-least-once 재발행(§6.6-4).
