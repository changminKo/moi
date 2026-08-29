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
| 3.6 | 인계 중 새 leader가 `lock_timeout`으로 대기 포기 후 종료 | 기각 | 대기 포기는 재시작 루프를 만들고, 그 사이 취소조차 불가능하다. 새 프로세스는 lease를 **논리적으로 무기한 대기**하되 그 동안 `CANCEL_ONLY`로 HTTP를 서비스한다(§6.3). 대기는 세션을 점유하는 `pg_advisory_lock` 블로킹이 아니라 `pg_try_advisory_lock`을 250 ms 고정 주기로 폴링하는 **취소 가능한** 루프다(§5.4): `SIGTERM`이 오면 `AbortSignal`로 즉시 중단하고 종료 코드 0으로 끝난다. 대기 시간은 메트릭·알림으로 관측한다. |
| 3.11 | 시장별 lease를 독립적으로 획득·재획득(시장 로컬 재선출) | 기각 | 두 프로세스가 각각 한 시장의 lease만 쥐는 **부분 lease 교착**을 만든다: P1이 US, P2가 KR을 쥐면 둘 다 `ACQUIRING_LEASES`에서 상대를 기다리고 어느 쪽도 `SERVING`이 되지 못한다. lease는 KR+US **번들**로만 의미가 있으며, 어느 한 시장이라도 잃으면 전역 재선출로 번들 전체를 놓고 다시 얻는다(§5.4, §6.5). provider 전송 장애는 시장 로컬로 남는다. |
| 3.12 | 여러 프로세스가 동시에 사용자 WS·outbox 발행을 수행 | 기각 | Redis fan-out은 비목표(§2.2)다. in-process `StreamHub`만 있으므로 outbox 이벤트를 발행한 프로세스에 그 사용자의 소켓이 없으면 이벤트는 유실 표시(`published_at`)만 남는다. 따라서 **두 lease를 모두 쥐고 `SERVING`인 프로세스 하나만** 사용자 WS upgrade를 받고 `OutboxPublisherLoop`의 주기 스케줄링을 돌린다(§6.3, §7.4). 유일한 추가 claim 경로는 그 프로세스가 `SERVING`에서 `DRAINING`으로 내려간 뒤 lease를 아직 쥔 채 수행하는 유계 one-shot `shutdownDrain`(§6.6-4)이다. |
| 3.13 | 종료 시 admission latch만 닫고 HTTP 요청은 계속 받으며 drain | 기각 | latch는 도메인 capability만 바꾸므로 `DRAINING` 중 도착한 요청이 새 `UnitOfWork`를 시작해 drain 카운터가 0으로 수렴하지 않을 수 있다. 종료는 먼저 **HTTP 인그레스를 울타리**(`RequestAdmissionGate`, §6.6)로 막아 새 비즈니스 요청을 503으로 거부하고, 이미 허용된 요청만 drain한다. 인계 중 취소 가용성은 이미 `ACQUIRING_LEASES`에서 준비된 P2가 제공한다(§10). |
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
│        │              └─ RequestAdmissionGate (HTTP ingress fence)   │
│  StartupCoordinator ─┬─ restore/verifyInvariants (UnitOfWork)        │
│                      ├─ LeaseRegistry.acquireAll(signal) (KR→US 순차) │
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
| `RuntimeStateMachine` | `+ apps/paper-api/src/runtime/runtime-state.ts` | A | §6.1 프로세스 상태, 전이 감사, `runtime_state` 메트릭. `enterServing()`/`leaveServing(to)`의 **동기 순서**(§6.1)를 소유하며 `StreamGate.isOpen()`은 이 기계의 `current === 'SERVING'`에서 파생된다 |
| `AdmissionLatch` | `+ apps/paper-api/src/runtime/admission-latch.ts` | A | 프로세스 로컬 admission/matching 게이트 (`StartupLatch`/`ShutdownLatch` 구현) |
| `RequestAdmissionGate` | `+ apps/paper-api/src/runtime/request-admission-gate.ts` | A | HTTP 인그레스 울타리(§6.6). Fastify **콜백형 동기 `onRequest(request, reply, done)`** 훅에서 **닫힘 검사와 비즈니스 요청 in-flight 증가를 하나의 동기 단계로** 수행하고, `onResponse`/`onError`/**`onRequestAbort`** 세 훅 중 **먼저 오는 하나**가 `request.admitted` 플래그를 소비해 정확히 한 번 감소한다(`onResponse`는 응답을 보낸 뒤에만 오고 클라이언트 abort는 별도 훅이므로 세 훅이 모두 필요하다). 닫힌 뒤 도착한 비즈니스 요청은 503 `NOT_READY` + `Retry-After`로 거부되어 `UnitOfWork`를 시작할 수 없다. `/health/*`는 제외되어 항상 관측 가능하다. `drain(deadline)`은 허용된 요청 수가 0이 될 때까지 대기 |
| `TradingCapabilities` | `+ apps/paper-api/src/runtime/trading-capabilities.ts` | A | `(market) → Set<Capability>` 계산 (§6.4) |
| `LeaseRegistry` | `+ apps/paper-api/src/runtime/lease-registry.ts` | A | KR+US **번들** 획득 `acquireAll(signal)`(KR→US 순차, 취소 가능, 세대(generation) 단위 in-flight promise 공유, 부분 획득 역순 해제), 시장별 `LeaderLease` 보유·해제, **`HELD` 상태 lease의 비의도적 손실만** 세대당 1회 전역 재선출로 승격(의도적 release/abort/rollback 경로는 억제, §5.4 “손실 판정”), `LeaseAuditPort` 구현 주입(§5.4, §6.5) |
| `LeaseAuditPort` | `+ apps/paper-api/src/runtime/lease-audit.ts` | A | lease 연결의 **같은 트랜잭션** 위에 `LEADER_ACQUIRED`/`LEADER_RELEASED` 감사 행을 쓰는 포트(§5.4). `appendAuditEvent`와 같은 컬럼·JSON 규칙 |
| `StreamHeartbeatLoop` | `+ apps/paper-api/src/modules/stream/stream-heartbeat-loop.ts` | A | 프로세스당 **하나**의 30 s 타이머가 `StreamHub.heartbeat(serverTime)`을 호출(§7.6). 소켓별 타이머 없음 |
| 웹 스트림 훅 프로토콜 정렬 | `apps/web/src/features/portfolio/use-portfolio-stream.ts` (기존) | A | `streamUrl(afterSequence)` 쿼리 인코딩, `onopen` 프레임 전송 제거(§7.5 “프론트 정렬”, §2.2 예외) |
| `MarketRuntime` | `+ apps/paper-api/src/runtime/market-runtime.ts` | A | 시장 하나의 stream/health/state/recovery/event loop/keepalive/reconnect |
| `SupervisedRecovery` | `MarketRuntime` 내부 | A | `RecoveryCoordinator.recover`를 감싸 provider 오류를 incident로 변환(§8.2) |
| `StreamHub` | `+ apps/paper-api/src/modules/stream/stream-hub.ts` | A | 접속 중 세션 레지스트리(`OPENING`/`LIVE` 상태 항목), sessionId별 durable event 전달(`OPENING`이면 상한 있는 큐에 적재, `LIVE`면 즉시 전달), replay→live 장벽 `promoteToLive(sessionId, handle, openResult)`(`StreamSession.open`이 돌려준 `replayedUpTo`/`replayedEventIds`로 dedupe, “스냅샷→비움→정렬→순차 전달” 라운드 반복, **큐가 비어 있음을 관측한 동기 구간에서만 `OPENING→LIVE`**), 시세 fan-out, `heartbeat(serverTime)`, `closeAll`, `size`(§7.5) |
| 스트림 upgrade 브리지 | `+ apps/paper-api/src/modules/stream/stream-upgrade.ts` | A | `ws` noServer 기반 `server.on('upgrade')` 핸들러: 스트림 게이트(`SERVING`만 허용, 그 외 503 `NOT_READY` + `Retry-After`)·경로·쿼리·Origin·세션 쿠키·인증·rate-limit 검사, closing latch·pending 소켓 추적, `handleUpgrade`, `OPENING` 등록 → `StreamSession` 생성 → `LIVE` 전환(§7.5) |
| `cookieValueFromHeader` | `apps/paper-api/src/plugins/session-auth.ts` (기존 파일에 분리) | A | route와 upgrade 브리지가 공유하는 헤더 수준 쿠키 파서 |
| `OutboxPublisherLoop` | `+ apps/paper-api/src/modules/stream/outbox-publisher-loop.ts` | A | `OutboxPublisher.pollOnce` 주기 실행, prune, 종료 drain. **주기 스케줄링은 번들 소유자가 `SERVING`일 때만 실행** — `start()`(총함수·비throw·동기)는 `RuntimeStateMachine.enterServing()`의 동기 순서 안에서만 호출되고(`RECOVERING`에서는 시작하지 않는다), `SERVING`을 떠나는 모든 경로(재선출·drain)의 `leaveServing(to)` 동기 구간이 `pauseScheduling()`으로 타이머를 지우고 `isRunning=false`를 세우며 진행 중 poll 하나를 포착한다. 종료 시에만 `shutdownDrain(deadline)` — 유계 one-shot drain(주기 루프 아님, §6.6-4) — 을 별도로 실행하는 단일 소유자 발행기(§6.1, §7.4). 두 연산은 `outbox_claims_total{mode}`·`outbox.poll{mode}`로 구분된다(§12.2) |
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
- REST 호출(스냅샷, FX, 캘린더, 종목)은 연결 수에 포함되지 않으나, **KR+US lease 번들을 모두 보유한 프로세스만** 수행한다. 새 프로세스는 번들을 얻기 전에 REST를 호출하지 않는다(토큰 발급 포함). 한 시장 lease만 쥔 순간(§5.4 순차 획득의 중간)에도 provider 호출은 0건이다.
- 따라서 정상 운영 시 provider 연결은 2개, 인계 중 최대 2개, 그 외 시각에는 0개다. 계정 한도(2)를 초과할 정상 경로는 존재하지 않는다.

### 5.3 provider URL loopback 규칙

`TOSS_REST_BASE_URL`·`TOSS_WS_URL`을 기본값과 다르게 설정하는 것은 다음 둘 중 하나일 때만 허용된다. 그렇지 않으면 시작 실패다.

1. `NODE_ENV !== 'production'`.
2. URL의 host가 loopback(`127.0.0.1`, `::1`, `localhost`)이다.

이 규칙으로 프로덕션 비밀이 도달할 수 있는 host는 Toss 공식 host 또는 자기 자신만이다. 인계 드릴(C)은 `NODE_ENV=production`으로 실제 프로덕션 코드 경로를 실행하면서 loopback 가짜 서버를 가리킬 수 있다.

### 5.4 리더 lease와 `LeaseRegistry`

- **번들 획득이 유일한 획득 API다.** `LeaseRegistry.acquireAll(signal): Promise<LeaseBundle>`은 **항상 `KR` 다음 `US` 순서로 순차** 획득한다. 두 시장을 동시에 시도하지 않는다 — 동시 시도는 두 프로세스가 각각 한 시장만 쥐는 부분 lease 교착(§3.11)을 만든다. 고정 순서는 두 프로세스가 같은 lock 순서로 경쟁하게 하여 “P1이 KR, P2가 US”가 구조적으로 불가능하게 한다. 시장별 `acquire(market)` 공개 API는 없다. `RecoveryCoordinator.recover`가 호출하는 `acquireLease(market)` 포트는 `LeaseRegistry.held(market)`로 구현되어 **보유 중 lease를 반환만** 하고, 없으면 `LeaseNotHeldError`를 던진다(§7.2 — recovery는 번들 보유 뒤에만 시작하므로 정상 경로에서는 항상 보유 중이다). 이로써 `StartupCoordinator`와 `RecoveryCoordinator`의 이중 획득(§1.1-4)은 epoch를 한 번만 올린다.
- **세대(generation)와 in-flight 공유.** `acquireAll`은 진행 중 획득이 있으면 같은 promise를 반환한다. 각 획득 시도는 `generation`(단조 증가 정수)을 가지며 `{generation, controller: AbortController, pending: Market | null, held: LeaderLease[]}`를 레지스트리가 추적한다. 호출자 `signal`이 abort되면 레지스트리는 해당 세대의 `controller.abort()`를 호출한다. `abortPending()`은 진행 중 세대를 abort하고 그 promise가 정리를 마칠 때까지 기다린다(§6.5, §6.6). 완료된 세대의 promise는 재사용되지 않는다 — 번들을 잃으면 다음 `acquireAll`이 새 세대를 만든다.
- `leaderId`는 프로세스 시작 시 생성한 UUID 하나를 전 시장에 공유한다. 로그·감사·메트릭 라벨에 그대로 사용한다.
- **취소 가능한 무기한 대기.** `LeaderLease.acquire(market, { connectionString, leaderId, signal, pollIntervalMs: LEASE_POLL_INTERVAL_MS })`는 시장당 **하나의 lease 전용 연결**을 열고 다음 루프를 돈다: `select pg_try_advisory_lock(hashtext($1))` → `true`면 탈출, `false`면 `signal.aborted` 검사 후 `LEASE_POLL_INTERVAL_MS = 250`(고정, 지터 없음) 대기 → 반복. 루프 앞뒤와 대기 중 `signal`이 abort되면 `AbortError`로 거부하고 연결을 닫는다. `pg_advisory_lock`(세션 블로킹)은 **쓰지 않는다** — 블로킹 호출은 대기 중 SIGTERM을 받아도 PostgreSQL 세션이 lock 대기열에 남아 취소가 연결 파괴에 의존하게 된다. 논리적으로 “무기한”이지만 매 250 ms `AbortSignal`을 검사하므로 종료는 항상 한 주기 안에 관측된다. 이것이 stop-then-start 인계의 직렬화 지점이다. 대기 시간은 `leader_lease_wait_seconds{market}` 게이지로 노출한다. `pg_try_advisory_lock`은 같은 세션에서 두 번 성공하면 lock 카운트가 2가 되므로 루프는 `true`를 받은 뒤 절대 다시 호출하지 않는다.
- **abort/lock 경합.** `pg_try_advisory_lock`이 `true`를 반환한 **직후** `signal.aborted`를 다시 검사한다. abort되어 있으면 즉시 같은 연결에서 `pg_advisory_unlock(hashtext($1))`을 실행하고 연결을 닫은 뒤 `AbortError`로 거부한다 — `begin`·upsert·감사·provider 호출은 **하나도 실행하지 않는다**. 이 검사 뒤에 abort가 오면 획득은 성공으로 완료되고 `acquireAll`이 그 lease를 부분 획득으로 취급해 역순 해제한다(아래). 두 경로 모두 결과는 “lock 없음, epoch 불변, `LEADER_ACQUIRED` 없음”이다.
- **부분 획득 해제.** `acquireAll`이 KR을 쥔 뒤 US 획득이 abort 또는 실패(연결 오류, 감사 insert 실패)하면 `held`의 lease를 **역순**(US가 있으면 US, 그 다음 KR)으로 `LeaderLease.release()`한다. 각 release는 §5.4 해제 규칙(`released_at` + `LEADER_RELEASED` 커밋 → unlock → 연결 종료)을 그대로 따른다. 부분 획득 상태에서는 `MarketRuntime.connect()`가 호출되지 않으므로 provider 호출·토큰 발급은 0건이다. 해제가 끝난 뒤 `acquireAll`은 원래 오류(`AbortError` 또는 실패 원인)로 거부된다.
- **손실 판정(의도적 종료 억제 + 1회 latch).** `LeaderLease`는 내부 상태 `ACQUIRING → HELD → RELEASING → RELEASED` 또는 `HELD → LOST`를 가진다(`isHeld === (state === 'HELD')`). lease 연결의 `error`/`end`(그리고 `pg` 클라이언트의 `end` 뒤 `error`) 핸들러는 **하나의 `#reportLost()`** 로 모이고, 이 함수는 `state === 'HELD'`일 때만 `state = 'LOST'`로 바꾸고 `onLost(market)`을 **정확히 1회** 호출한다(`error` 다음 `end`가 와도 두 번째 호출은 이미 `LOST`라 무시). 다음 경로는 모두 **의도적**이며 `onLost`를 올리지 않는다: (a) `release()` — 첫 query 전에 `state = 'RELEASING'`으로 표시하므로 이후 unlock·`end`는 손실이 아니다; (b) acquire 중 abort(대기 중 abort, abort/lock 경합의 즉시 unlock + `end`) — 상태가 `ACQUIRING`이라 `HELD`가 아니다; (c) acquire 트랜잭션 rollback(감사 insert 실패) 뒤 unlock + `end` — 마찬가지로 `HELD`에 도달하지 않았다; (d) `LeaseRegistry`의 부분 획득 역순 해제 — (a)와 같다. `ACQUIRING` 중의 연결 `error`는 `onLost`가 아니라 `acquire` promise의 거부로 나타난다. `LeaseRegistry.onLost(market)`은 세대 단위로 한 번만 승격한다: 같은 세대에서 두 시장이 잇달아 `onLost`를 내도(예: DB 재시작으로 KR·US 연결이 동시에 죽음) `ProductionRuntime.reelect`는 1회만 호출되고 두 번째는 진행 중 재선출에 합류한다(§6.5). 콜백은 시장 로컬 재획득이 아니라 **전역 재선출**을 시작한다(§6.5); 번들이 아직 완성되지 않은 세대(`pending !== null`)에서 이미 쥔 lease를 잃으면 재선출이 아니라 그 세대의 abort다(§6.5 “부분 획득 중 손실”).
- `LeaderLease.acquire`의 upsert는 `on conflict (market_code) do update set …, released_at = null`로 **`released_at`을 반드시 null로 되돌린다**(§13 migration). 현재 행은 “지금 leader가 누구이고 아직 놓지 않았는가”만 뜻한다.
- **lease 감사 포트.** `LeaderLeaseOptions.audit?: LeaseAuditPort`를 추가한다. `LeaseAuditPort = { recordAcquired(query, ctx), recordReleased(query, ctx) }`, 여기서 `query`는 **lease 연결 자신의 `query` 함수**이고 `ctx = {market, epoch, fencingToken, leaderId}`다. 구현(`+ runtime/lease-audit.ts`, `LeaseRegistry`가 주입)은 `audit_events`에 `appendAuditEvent`와 같은 컬럼(`id, session_reference=null, order_id=null, event_type, payload::jsonb, occurred_at=now()`)으로 `LEADER_ACQUIRED {market, epoch, fencingToken, leaderId}` / `LEADER_RELEASED {market, epoch, leaderId}` 행을 **한 줄 insert**한다. 포트가 lease 연결 위에서 실행되므로 감사 행과 `leader_epochs` 변경은 **하나의 PostgreSQL 트랜잭션**에 들어가고, 별도 UnitOfWork·별도 연결을 쓰지 않는다.
- `LeaderLease.acquire`의 순서는 [폴링 루프: `select pg_try_advisory_lock(hashtext($1))` × n, 마지막이 `true`] → abort 재검사 → `begin` → upsert(`released_at = null` 포함) → `audit.recordAcquired(query, ctx)` → `commit` 이다. advisory lock은 **세션 수준**이므로 트랜잭션 밖에서 얻고 `commit`/`rollback`에 영향받지 않는다. **`acquire`는 `commit`이 성공한 뒤에만 반환**하므로, 반환 시점에 `LEADER_ACQUIRED`는 이미 내구성 있게 기록되어 있다. `MarketRuntime.connect()`는 `acquireAll`이 **두 시장 모두** 반환한 뒤에 토큰 발급·REST·WS를 시작하므로(§5.5) provider 호출 이전에 두 감사가 존재한다는 순서가 구조적으로 보장된다. 감사 insert 실패는 upsert와 함께 롤백되고 `acquire`는 예외로 실패하며(`rollback` 뒤 `pg_advisory_unlock`, 연결 종료), epoch는 증가하지 않는다.
- `LeaderLease.release()`는 **lock을 아직 쥔 lease 연결 위에서, `pg_advisory_unlock` 전에** 다음을 하나의 트랜잭션으로 실행한다: `begin` → `update leader_epochs set released_at = now() where market_code = $1 and leader_id = $2 and released_at is null` → `audit.recordReleased(query, ctx)` → `commit`. 그 다음 `pg_advisory_unlock(hashtext($1))`, 마지막에 연결을 닫는다. 순서가 이래야 하는 이유: unlock 뒤에 쓰면 다음 leader의 `acquire`가 먼저 lock을 얻어 upsert와 `LEADER_ACQUIRED`를 커밋할 수 있고, 그러면 `LEADER_RELEASED`가 `LEADER_ACQUIRED` **뒤**에 기록되어 §10.2-5·8의 순서 단언이 타이밍 의존이 된다. lock 아래에서 커밋하면 “P1 `LEADER_RELEASED` 커밋 → unlock → P2 lock 획득 → P2 `LEADER_ACQUIRED` 커밋”이 같은 lock의 직렬화 순서를 따르므로 두 감사 행의 `occurred_at`(각 트랜잭션 안의 `now()`)과 커밋 순서가 결정적이다. 트랜잭션이 실패하면 `rollback` 후 로그 `lease.release_mark_failed {market, epoch, leaderId, error}`만 남기고(이 경우 `released_at`도 감사 행도 남지 않는다 — 둘은 항상 함께 있거나 함께 없다), **`finally`에서 unlock과 연결 종료를 반드시 진행**한다 — lock 해제가 인계의 본질이고 감사·`released_at`은 증거다. 이미 `isHeld === false`(연결 사망)면 트랜잭션·unlock을 시도하지 않고 연결 종료만 한다.
- `LeaseRegistry.releaseAll()`은 보유 중 lease를 **역순(US → KR)** 으로 `LeaderLease.release()`하고 각 완료 후 로그 `lease.released {market, epoch, leaderId, auditPersisted}`만 남긴다(§12.4). **감사 행은 쓰지 않는다** — `LEADER_RELEASED`는 위 트랜잭션에서 이미 커밋되었거나(`auditPersisted:true`) 롤백되어 존재하지 않는다(`false`). unlock 이후에 두 번째 `LEADER_RELEASED`를 쓰는 경로는 없다(그러면 P2의 `LEADER_ACQUIRED` 뒤에 나타날 수 있다). 이미 잃은 lease(`isHeld === false`)는 연결 종료만 하고 건너뛴다. 마찬가지로 `LeaseRegistry.acquireAll`은 실제로 `LeaderLease.acquire`를 호출한 시장에만 로그 `lease.acquired`를 남기고, `held(market)`의 멱등 경로에서는 감사도 로그도 추가하지 않는다. `LEADER_RELEASED`가 인계 드릴이 P1의 해제를 증명하는 **내구성 있는 증거**다(§10.2-5). 현재 `leader_epochs` 행은 P2가 재획득하는 순간 `released_at = null`로 덮어써지므로 “해제됨”의 증거로 쓸 수 없다.
- `leader-lease.integration.test.ts`(Testcontainers PG)에 다음 열 테스트를 둔다. 모두 `LeaseConnection` 래퍼로 lease 연결의 query 호출 순서를 기록하고, 기본 `LeaseAuditPort` 구현을 주입하며, 폴링 주기는 fake timer가 아닌 실제 250 ms로 둔다(PostgreSQL 왕복이 실제이므로).
  1. **first acquire**: 빈 테이블에서 `acquire('KR')` → 행 1개, `epoch=1`, `leader_id`=호출자, `released_at is null`; `audit_events`에 `LEADER_ACQUIRED {market:'KR', epoch:1, leaderId}` 1건; 기록된 순서가 `select pg_try_advisory_lock`(1회, `true`) → `begin` → `insert … on conflict` → `insert into audit_events` → `commit`이며 `acquire` promise는 `commit` 뒤에 해결된다. `pg_advisory_lock`(블로킹형) 호출은 0회.
  2. **release**: 같은 lease `release()` → 같은 행 `released_at is not null`, `leader_id` 불변, `epoch` 불변; `audit_events`에 `LEADER_RELEASED {market:'KR', epoch:1, leaderId}` **정확히 1건**; 기록된 순서가 `begin` → `update leader_epochs … released_at` → `insert into audit_events` → `commit` → `pg_advisory_unlock` → `end`; `pg_locks`에 해당 advisory lock 없음; 연결 종료됨.
  3. **reacquire**: 다른 `leaderId`로 `acquire('KR')` → `epoch=2`, `leader_id`=새 값, **`released_at is null`**(null 리셋 증명), `LEADER_ACQUIRED{epoch:2}` 1건. 다시 `release()` → not null, `LEADER_RELEASED{epoch:2}` 1건.
  4. **no race**: P1이 lease를 쥔 채 P2가 `acquire('KR')`를 시작(대기 확인: 1 s 뒤에도 미해결이고 그 사이 `pg_try_advisory_lock` `false` 반환이 ≥ 3회 기록됨). P1 `release()`. 단언: (a) P2 promise는 P1의 `pg_advisory_unlock` 이후에만 해결되고(다음 폴링 주기, 즉 unlock 후 ≤ 250 ms + 왕복), 해결 직후 행은 `leader_id`=P2, `released_at is null`, `epoch=2`; (b) 제3의 관찰 연결에서 P1의 `LEADER_RELEASED`가 **P2 promise 해결 전에 이미 보인다**(P1 `commit` 직후 폴링); (c) `audit_events`를 `occurred_at, id` 순으로 읽으면 `LEADER_ACQUIRED(P1,1)` → `LEADER_RELEASED(P1,1)` → `LEADER_ACQUIRED(P2,2)`이고 각 종류가 정확히 1건; (d) P2 획득 전 임의 시점에 “`leader_id`=P2인데 `released_at`이 not null”인 행이 관측되지 않는다(P2 획득 후 100회 폴링).
  5. **release audit failure**: `recordReleased`가 던지는 포트를 주입 → `release()`는 예외 없이 완료; 행 `released_at is null`(롤백), `LEADER_RELEASED` 0건, 로그 `lease.release_mark_failed` 1건; `pg_locks`에 lock 없음(finally unlock), 연결 종료됨; 이후 다른 `leaderId`의 `acquire`가 즉시 성공.
  6. **acquire audit failure**: `recordAcquired`가 던지는 포트를 주입 → `acquire()`가 거부됨; `leader_epochs` 행·epoch 불변(빈 테이블이면 여전히 없음), `LEADER_ACQUIRED` 0건, `pg_locks`에 lock 없음, 연결 종료됨.
  7. **abort while waiting**: P1이 lease를 쥔 채 P2가 `acquire('KR', {signal})`로 대기 → 700 ms 뒤 `controller.abort()` → P2 promise가 `AbortError`로 거부되는 시점이 abort 후 ≤ 250 ms + 왕복; P2 연결 종료됨; `leader_epochs`·`audit_events` 불변(P2의 `LEADER_ACQUIRED` 0건); P1 lease는 그대로 `isHeld`; `pg_locks`에 P2 세션의 lock 없음.
  8. **abort/lock race**: `pg_try_advisory_lock`이 `true`를 반환한 직후(`LeaseConnection` 래퍼가 그 query의 해결을 가로채는 훅)에 `controller.abort()` → 기록된 순서가 `select pg_try_advisory_lock`(`true`) → `select pg_advisory_unlock` → `end`이고 `begin`·upsert·`insert into audit_events` 호출 0회; promise는 `AbortError`로 거부; `pg_locks`에 lock 없음; `leader_epochs`·`audit_events` 불변; 이후 다른 `leaderId`의 `acquire`가 첫 폴링에서 성공.
  9. **bundle partial release** (`lease-registry.integration.test.ts`): 관찰자가 US lock만 쥔 상태에서 `LeaseRegistry.acquireAll(signal)` → KR은 즉시 획득(`LEADER_ACQUIRED{KR,1}` 1건), US 대기 중(`pending === 'US'`) → `controller.abort()` → `acquireAll`이 `AbortError`로 거부; 그 전에 KR lease가 `release()`되어 `LEADER_RELEASED{KR,1}` 1건, `pg_locks`에 KR·US 모두 이 프로세스의 lock 없음, 두 lease 연결 모두 종료; `MarketRuntime.connect` spy 0회, `tokenProvider.getAccessToken` spy 0회. 같은 시나리오를 US 획득 중 `recordAcquired` 실패(테스트 6의 포트)로 반복 → KR 역순 해제 뒤 원래 오류로 거부.
  10. **bundle order and sharing** (`lease-registry.integration.test.ts`): 빈 테이블에서 `acquireAll(signal)` 두 번 동시 호출 → 같은 promise 객체 반환, `LeaderLease.acquire` 호출 순서가 정확히 `['KR','US']`(동시 호출 0회, 두 번째 시장의 첫 `pg_try_advisory_lock`은 첫 시장의 `commit` 뒤에 기록됨), epoch가 시장별로 1만 증가; 이후 `releaseAll()`의 `release()` 순서가 `['US','KR']`.
  11. **intentional release is not loss**: `onLost` spy를 주입한 lease를 `acquire` → `release()` → 연결 `end`까지 기다린 뒤 `onLost` 호출 0회, `state === 'RELEASED'`; 같은 검사를 (b) 대기 중 abort, (c) abort/lock 경합(테스트 8 훅), (d) `recordAcquired` 실패(테스트 6 포트)에 반복 → 모두 `onLost` 0회이고 `acquire`만 거부됨. `LeaseRegistry` 수준: 테스트 9의 부분 역순 해제와 `releaseAll()` 동안 `ProductionRuntime.reelect` spy 0회.
  12. **loss reported once**: `HELD` lease의 backend를 `pg_terminate_backend` → `onLost` 정확히 1회(`error`와 `end`가 모두 관측되어도), `state === 'LOST'`, `isHeld === false`; 그 뒤 `release()`는 트랜잭션·unlock 없이 연결 종료만 하고 `LEADER_RELEASED` 0건, 예외 없음. `LeaseRegistry` 수준: 두 시장 backend를 같은 tick에 종료 → `reelect` spy 1회, `leader_reelection_total` +1.
  13. **loss during partial acquire** (`lease-registry.integration.test.ts`): 관찰자가 US lock을 쥔 채 `acquireAll(signal)` → KR 획득, US 폴링 중(`pending === 'US'`) → KR backend를 `pg_terminate_backend` → `acquireAll`이 ≤ 250 ms + 왕복 안에 `LeaseLostError{market:'KR'}`로 거부; `reelect` spy 0회(재선출 아님); KR 연결 종료, `LEADER_RELEASED{KR}` 0건(연결 사망); `pg_locks`에 이 프로세스 lock 없음(US는 얻지 못했고 KR 세션은 죽음); `MarketRuntime.connect`·`tokenProvider.getAccessToken` spy 0회; 관찰자가 US를 놓은 뒤 새 `acquireAll` → 새 세대로 KR(epoch 2)→US 획득 성공.
- Epoch/fencing token 의미는 기존과 같다: 새 leader는 항상 더 큰 값을 받고, `MarketStateStore.beginEpoch`와 `PaperEngine.currentFencingToken`이 이 값을 사용해 이전 epoch 이벤트와 fill을 거부한다.

### 5.5 OAuth 토큰 provider (B)

`OAuthTokenProvider implements TokenProvider`:

- 요청: `POST {TOSS_REST_BASE_URL}/oauth2/token`, `Content-Type: application/x-www-form-urlencoded`, 본문 `grant_type=client_credentials&client_id=…&client_secret=…`. 응답은 BFF envelope가 아닌 OAuth2 표준 `{access_token, token_type, expires_in}`이다. 계약 예시 `expires_in`은 86400이다.
- 캐시: 메모리 단일 슬롯 `{token, expiresAt}`. `getAccessToken(signal)`은 남은 수명이 `TOKEN_REFRESH_LEAD_MS = 300_000`(5분) 이상이면 캐시를 반환하고, 아니면 재발급한다. 동시 호출은 하나의 in-flight promise를 공유한다.
- 무효화 처리: 계약상 client당 유효 토큰은 1개이며 재발급 시 이전 토큰은 즉시 무효다. 어댑터가 `401`을 받으면 `tokenProvider.invalidate()` 후 **정확히 1회** 재발급·재시도한다. 두 번째 `401`은 오류로 전파되어 시장 incident `PROVIDER_AUTH_FAILED`가 된다.
- 속도: `AUTH` rate-limit 그룹 보호를 위해 재발급 간 최소 간격 `TOKEN_MIN_REISSUE_INTERVAL_MS = 10_000`. 그 안의 요청은 `MarketDataError('PONG_FAILED')`가 아니라 새 코드 `AUTH_THROTTLED`로 거부된다(`MarketDataErrorCode`에 `AUTH_FAILED`, `AUTH_THROTTLED` 추가).
- `403 access_denied`(허용 IP 미등록)는 재시도하지 않고 `PROVIDER_IP_NOT_ALLOWED` incident가 된다. 이는 운영자 조치가 필요한 상태다.
- 토큰 문자열은 `Authorization` 헤더 조립 외 어디에도 복사되지 않는다. 로거 redaction 규칙에 `access_token`, `client_secret`, `Authorization`을 추가한다(§12).
- **토큰은 KR+US lease 번들 획득 뒤에만 발급된다.** `MarketRuntime.connect()`가 `LeaseRegistry.acquireAll` 완료 뒤 처음 `tokenProvider.getAccessToken`을 호출한다. 번들 대기 중이거나 부분 획득 상태에서 abort되면 토큰 요청은 0건이다. 이전 leader가 아직 살아 있을 때 새 프로세스가 토큰을 재발급해 이전 leader의 REST를 무효화하는 사고를 구조적으로 막는다.

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
BOOTING ──config/db ok──▶ RESTORING ──invariants ok──▶ ACQUIRING_LEASES ◀──────────────┐
   │                          │                               │ KR then US held          │
   │ config/db error          │ invariant/audit error         ▼                          │
   ▼                          ▼                          RECOVERING(all)                 │
 EXIT(1)               FAILED_CLOSED ─▶ EXIT(1)          (gate closed; publisher         │
                                                          NOT started; claim = 0)        │
                                                              │ both recoveries returned │
                                                              ▼ enterServing() (sync)    │
              ┌────────────────────────────────────── SERVING ──any lease lost──▶ RE_ELECTING
              │  (admission open; stream gate open;              (tear down both markets,
              │   outbox publisher running)                       release survivor, then
              │                                                   acquireAll again)
              └── SIGTERM/SIGINT ──▶ DRAINING ──▶ STOPPED ──▶ EXIT(0)
                                       │ deadline exceeded
                                       └──▶ STOPPED(forced) ──▶ EXIT(0)

  SIGTERM/SIGINT in ACQUIRING_LEASES / RE_ELECTING(polling) ──▶ DRAINING (abort pending acquire
  generation, release partial leases, provider calls = 0 in total) ──▶ STOPPED ──▶ EXIT(0)
  SIGTERM/SIGINT in RECOVERING ──▶ DRAINING (abort active recovery; no NEW provider call after
  abort; close provider sockets; release bundle) ──▶ STOPPED ──▶ EXIT(0)
  lease lost in RECOVERING ──▶ RE_ELECTING (same as SERVING; active recovery aborted first)
  lease lost while ACQUIRING_LEASES (partial bundle) ──▶ stays ACQUIRING_LEASES (generation aborted,
  new generation via process supervisor; provider calls = 0)
```

- `BOOTING`: `loadConfig`, `createDatabase`, `migrateToLatest`, Fastify 빌드, `RequestAdmissionGate.open()`, `app.listen`. **listen은 `RESTORING` 전에 수행**한다. 그래야 새 프로세스가 lease를 기다리는 동안 `/health/*`, 조회, 취소를 서비스할 수 있다.
- `RESTORING`: `StartupCoordinator.restore` = 활성 incident 로드, `market_states` 로드, 열려 있는 주문·예약 로드; `verifyInvariants` = 기존 ledger 불변식 검사(예약 합계, 지갑 음수 금지, OCO 쌍 정합). 실패 → `FAILED_CLOSED`: 수동 incident `STARTUP_INVARIANT_OR_AUDIT_FAILURE`(GLOBAL, 모든 capability 차단, `source=MANUAL`) 기록 후 **프로세스 종료 코드 1**. 재시작 후에도 이 incident가 남아 `CANCEL_ONLY`를 강제하고, 운영자가 `/admin/incidents/:id/resolve`로 해제해야 한다.
- `ACQUIRING_LEASES`: `LeaseRegistry.acquireAll(runtimeSignal)`을 한 번 호출하고 **KR 다음 US가 순차로** 획득되어 번들이 완성될 때까지 대기한다(§5.4). 이 상태의 trading 응답은 `reasons: ['CANCEL_ONLY','ACQUIRING_LEASES']`. 스트림 게이트는 닫혀 있고(`SERVING`이 아니므로 WS upgrade는 503 `NOT_READY`, §6.3) `OutboxPublisherLoop`는 시작되지 않는다(outbox claim 0건). 대기 중 이미 쥔 lease(KR)의 연결이 죽으면 §6.5 “부분 획득 중 손실”대로 현재 세대를 abort하고 같은 상태에서 새 세대를 시작한다. 이 상태에서 `SIGTERM`이 오면 §6.6의 순서로 `DRAINING`에 들어가며, `releaseLeases()` 단계가 `LeaseRegistry.abortPending()`으로 진행 중 세대를 abort하고 부분 lease를 역순 해제한다. 대기 중이던 프로세스는 다음 250 ms 폴링 경계 안에 lease 루프를 빠져나오고, 토큰·REST·WS 호출 0건으로 종료 코드 0을 낸다.
- `RECOVERING(all)`: 번들이 완성된 뒤 두 시장의 `SupervisedRecovery`가 병렬로 실행된다. **이 상태에서 `OutboxPublisherLoop`는 시작되지 않고**(claim 0건, `outbox.poll` 로그 없음) 스트림 게이트도 닫혀 있다(WS upgrade 503 `NOT_READY`). 사용자 이벤트는 `published_at is null`로 쌓이고 `SERVING` 진입 직후 첫 poll이 발행한다(§7.4). provider 오류는 프로세스 상태를 바꾸지 않고 시장 incident가 된다(§8.2). 두 recovery가 반환하면 `enterServing()`. 이 상태에서 lease를 잃으면 §6.5(진행 중 recovery는 3단계의 AbortController abort로 취소), `SIGTERM`이 오면 §6.6 “`RECOVERING` 중 종료”.
- **`enterServing()` — 상태·발행기·게이트의 결정적 순서.** `RuntimeStateMachine.enterServing()`은 **`await`가 없는 하나의 동기 함수**로 다음을 이 순서로 실행한다: (1) `current = 'SERVING'`(상태 전이, `runtime_state` 게이지 갱신, `runtime.state {to:'SERVING'}` 로그); (2) admission latch 열기, 두 시장 matching latch 열기; (3) `OutboxPublisherLoop.start()` — 동기적으로 `running = true`를 세우고 타이머를 등록한다(첫 `pollOnce`는 다음 tick); (4) 스트림 게이트 열림은 별도 플래그가 아니라 `StreamGate.isOpen() := runtimeState.current === 'SERVING'`으로 **파생**되므로 (1)에서 이미 결정된다. 순서가 문제되지 않는 이유: (1)~(3) 사이에 `await`가 없어 어떤 I/O 이벤트(WS upgrade, HTTP 요청, 타이머)도 “`SERVING`인데 발행기가 꺼져 있음”을 관측할 수 없다 — upgrade 핸들러가 `gate.isOpen() === true`를 보는 첫 순간에 `publisher.isRunning() === true`다. **`start()`는 총함수(total)다** — 필드 대입(`running = true`)과 타이머 등록(`setTimeout`)만 수행하고 DB·hub·로거 등 주입 의존성을 호출하지 않으며 `throw`·`await`·`try`가 없다. 던질 수 없으므로 “(1)·(2)는 끝났는데 (3)이 예외로 빠져 게이트는 열리고 발행기는 꺼진 채 `SERVING`에 머무는” 반쯤 열린 상태가 구조적으로 존재하지 않는다(별도 fail-closed 분기가 필요 없는 이유). 이 불변식은 A17이 정적(소스에 `await`·`throw`·`try` 없음, 의존성 메서드 호출 없음, `constructor.name === 'Function'`)·동적(모든 주입 의존성을 던지는 스텁으로 바꿔도 `start()`가 반환하고 `isRunning() === true`)으로 단언한다. 감사 `RUNTIME_STATE_CHANGED{to:'SERVING'}`은 (3) 뒤에 비동기로 커밋하며(순서 증거는 감사가 아니라 동기 함수 자체), 실패해도 상태는 되돌리지 않고 로그만 남긴다.
- **`leaveServing(to)` — 주기 스케줄링의 동기 일시정지.** 반대 방향 `leaveServing(to)`(`RE_ELECTING`·`DRAINING` 진입)도 **`await`가 없는 하나의 동기 함수**다: (1) `current = to`(게이트는 파생이므로 즉시 닫힘 — 이후 upgrade는 503), 이전 상태를 `leftFrom`으로 기록; (2) admission latch·두 시장 matching latch 닫기; (3) `OutboxPublisherLoop.pauseScheduling()` — **동기적으로** 타이머를 `clearTimeout`하고 `running = false`를 세워 이후 어떤 tick도 새 `pollOnce`를 시작하지 못하게 하며(tick 콜백은 첫 `await` 전에 `running`을 동기 검사하고 `false`면 즉시 반환), 이미 진행 중인 `pollOnce` promise가 있으면 **그 하나**를 반환한다(없으면 `null`). 진행 중 poll이 최대 하나인 이유: 루프는 `setInterval`이 아니라 “`pollOnce` 완료 뒤 `setTimeout(200 ms)` 재등록”이므로 두 poll이 겹치지 않는다. `leaveServing`은 이 promise를 `RuntimeStateMachine.pendingPoll`에 보관하고 반환한다 — 호출자(§6.5-2, §6.6-4)가 그 뒤 비동기로 기다린다. `pauseScheduling()`은 멱등이며 두 번째 호출은 같은 promise(또는 `null`)를 돌려준다. `pollOnce`는 `claimPendingOutbox`를 첫 `await` 앞에서 동기적으로 발행하고 그 시점에 `outbox_claims_total{mode:'periodic'}`을 올리므로, 포착된 in-flight poll의 꼬리에는 **claim이 없고** publish·`markOutboxPublished`만 남는다. 따라서 “게이트 열림 ⇔ `isRunning()`”은 **모든 시각에 양방향으로** 성립하고(둘 다 같은 동기 스택에서 바뀐다), `SERVING` 밖에서 관측될 수 있는 것은 `hasInFlightPoll() === true`인 꼬리 하나뿐이다 — 그 꼬리는 §6.5-2·§6.6-4가 lease 해제 전에 기다린다. `pauseScheduling()`은 발행기가 시작되지 않았으면(`RECOVERING`에서 떠나는 경우) no-op이고 `null`을 반환한다.
- `SERVING`: admission latch 열림, 스트림 게이트 열림(사용자 WS upgrade 허용), `OutboxPublisherLoop` 실행 중. 이 시점부터 각 시장의 거래 모드는 §6.2 시장 상태 기계가 결정한다. 프로세스는 두 시장이 모두 `DEGRADED`여도 `SERVING`이다(취소는 가능). **두 lease를 모두 쥐고 `SERVING`인 프로세스만** 사용자 WS를 받고 outbox를 발행한다(§3.12, §7.4). 어느 한 시장의 lease를 잃으면 `RE_ELECTING`.
- `RE_ELECTING`: §6.5의 전역 재선출. 두 시장을 모두 내리고(스트림 게이트·admission·matching 닫기와 outbox 주기 스케줄링 일시정지는 `leaveServing` 동기 구간, 포착된 in-flight poll 대기, 두 provider 루프·소켓 abort/종료), 살아 있는 lease를 해제한 뒤 `ACQUIRING_LEASES`로 돌아가 번들을 다시 획득한다. trading 응답은 `reasons: ['CANCEL_ONLY','RE_ELECTING']`. `/health/ready`는 200을 유지한다(db+audit 기준, 취소는 계속 가능).
- `DRAINING`: §6.6.
- 모든 전이는 `audit_events`에 `RUNTIME_STATE_CHANGED {from, to, leaderId}`로 기록되고, `runtime_state{state}` 게이지를 갱신한다. `SERVING`에 도달할 때마다 `RUNTIME_STATE_CHANGED{to:'SERVING'}`이 새로 기록되므로 재선출 뒤에는 이 감사가 2건 이상일 수 있다.

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

`ACQUIRING_LEASES`(그리고 `RE_ELECTING`) 동안 — 아래 WS upgrade·outbox claim 두 규칙은 `RECOVERING`에도 그대로 적용된다(`SERVING`이 아닌 모든 상태):

- `/health/live` 200, `/health/ready` 200 (db+audit 기준 유지). 즉 로드밸런서는 트래픽을 보내고, 사용자는 조회·취소를 할 수 있다. 이것이 인계 중 취소 가용성의 출처다: P1이 `DRAINING`으로 HTTP 인그레스를 닫는 동안(§6.6) 이미 준비된 P2가 취소를 받는다(§10.2-4).
- `/api/v1/health/trading` → `{placement:false, cancellation:true, fx:false, reasons:['CANCEL_ONLY','ACQUIRING_LEASES']}`(재선출 중이면 `'RE_ELECTING'`).
- `/health/market-data` → 각 시장 `{state:'RECOVERING', reasons:['LEADER_LEASE_PENDING']}`.
- 주문 생성/정정/FX 요청은 기존 `CANCEL_ONLY`(409) 도메인 오류로 거부된다.
- **사용자 WS upgrade는 받지 않는다.** 스트림 게이트가 닫혀 있으므로 `/api/v1/stream` upgrade는 503 `{code:'NOT_READY', message, retryable:true}` + `Retry-After: 1`로 거부된다(§7.5 표 0b단계). Redis fan-out이 없으므로(§2.2) 이 프로세스에 소켓이 붙어 있어도 outbox 이벤트를 전달할 발행기가 없고, 그 소켓은 조용히 이벤트를 놓친다 — 그래서 아예 받지 않는다. 브라우저 훅은 기존 backoff로 재접속하며 `SERVING`이 된 뒤 `afterSequence`로 따라잡는다.
- **outbox claim은 0건이다.** `OutboxPublisherLoop`는 시작되지 않았다(`RECOVERING`에서도 마찬가지다). 사용자 이벤트는 `outbox_events`에 `published_at is null`로 쌓이고, 번들 소유자가 `SERVING`에 들어간 직후 첫 poll이 발행한다(§6.1 `enterServing`, §7.4).

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

**lease 손실은 시장 로컬 사건이 아니라 전역 사건이다.** 어느 한 시장의 **`HELD` 상태** lease 연결이 비의도적으로 `error`/`end`를 내면(§5.4 “손실 판정” — 의도적 release/abort/rollback 경로는 손실이 아니다) `LeaderLease`가 `onLost`를 **정확히 1회** 올리고, `LeaseRegistry.onLost(market)`이 `ProductionRuntime.reelect(reason)`을 호출한다. 프로세스는 `leaveServing('RE_ELECTING')`(§6.1, 동기)으로 전이한 뒤 **다음 순서를 동기적으로 시작**한다(각 단계는 이전 단계 실패와 무관하게 실행; 같은 세대에 대한 동시·중복 `reelect` 호출은 첫 호출에 합류하고 `leader_reelection_total`은 1만 증가한다). 이 절차는 **`SERVING`과 `RECOVERING` 어느 상태에서 잃어도 같다** — `RECOVERING`이면 1단계의 게이트·latch는 이미 닫혀 있고 발행기는 시작되지 않았으므로 `pauseScheduling()`은 no-op(`null`)이며 2단계는 즉시 끝나고, 3단계가 진행 중 recovery를 abort한다.

1. `leaveServing('RE_ELECTING')`(§6.1, 동기): 상태 전이(스트림 게이트는 상태에서 파생되어 즉시 닫힘 — 새 WS upgrade 503 `NOT_READY`), admission latch 닫기(모든 시장 `{CANCEL}`), 두 시장 matching latch 닫기, **`OutboxPublisherLoop.pauseScheduling()`** — 타이머 제거·`running = false`·새 claim 차단이 이 동기 스택 안에서 끝나고, 진행 중 `pollOnce`가 있으면 그 하나가 `pendingPoll`로 포착된다. 이 프로세스는 이 순간부터 새 claim을 하지 않는다. `RequestAdmissionGate`는 **닫지 않는다** — HTTP 조회·취소는 계속 받는다(재선출은 종료가 아니다).
2. `await pendingPoll` — 1단계가 포착한 in-flight `pollOnce`(publish·`markOutboxPublished` 꼬리, claim 없음)가 끝나기를 기다린다. `null`이면 즉시 진행. 이 단계에는 `shutdownDrain`이 **없다**(재선출은 종료가 아니고, 남은 행은 다음 leader의 첫 periodic poll이 발행한다). `RECOVERING`에서 잃었다면 발행기는 원래 꺼져 있어 `pendingPoll === null`이다.
3. **두 시장** `MarketRuntime`의 AbortController abort → event loop, keepalive, 진행 중 recovery(토큰 발급·스냅샷·`connect` 대기 포함) 취소; 두 provider `stream.close()`. abort 이후 **새 provider 호출은 0건**이다(이미 날아간 요청의 응답은 버린다). 잃지 않은 시장의 소켓도 닫는다 — 번들의 일부만 쥔 프로세스는 provider 연결을 가질 수 없다는 규칙(§5.2)이 “세 번째 연결 금지”의 핵심이다.
4. `LeaseRegistry.abortPending()` — 진행 중 획득 세대가 있으면 abort하고 부분 lease가 정리될 때까지 기다린다. `SERVING`·`RECOVERING`에서는 번들이 이미 완성되어 있으므로 보통 no-op이다(부분 획득 중 손실은 아래 별도 문단).
5. `LeaseRegistry.releaseAll()` — 살아 있는 lease를 §5.4 규칙으로 해제한다(잃은 lease는 연결 종료만). release는 lease를 `RELEASING`으로 표시한 뒤 진행하므로 **해제 과정의 `end`는 `onLost`를 다시 올리지 않는다**(재선출이 재선출을 부르는 루프 없음). 이 시점에 이 프로세스는 lock을 하나도 쥐지 않는다. 해제는 3단계(소켓 종료) **직후**, incident 기록보다 **앞**에 온다: §5.2(“lease 보유 중에만 연결”)는 소켓이 먼저 닫혀 지켜지고, incident의 DB 쓰기가 생존 lease 해제를 늦추지 않아 후속자가 KR을 잡은 뒤 이 프로세스가 US를 아직 쥔 채로 보이는 창(§10.2-10 (e)의 “부분 lease 상태”)이 DB 왕복 하나 미만으로 줄어든다.
6. `MarketHealthMachine[KR|US].onClose('LEASE_LOST')` → 두 시장 `DEGRADED` + incident `LEADER_LEASE_LOST{market}`(잃은 시장) / `LEADER_BUNDLE_BROKEN{market}`(살아 있던 시장). 실패해도 다음 단계로 진행한다(DB 자체가 죽은 경우).
7. `ReconnectSupervisor`(프로세스 단위 인스턴스)가 `ACQUIRING_LEASES`로의 전이를 예약한다(§8.3 backoff, 첫 시도 즉시). 전이 뒤 `LeaseRegistry.acquireAll(runtimeSignal)`이 KR→US 번들을 다시 획득하고 `RECOVERING(all)` → 두 시장 모두 새 epoch로 복구 → `SERVING`. 재획득 실패는 §8.3 창에 기록되고 3회 소진 시 `RECOVERY_RETRY_EXHAUSTED`(GLOBAL scope, `source=MANUAL`)로 자동 재시도가 멈춘다.

**부분 획득 중 손실(`ACQUIRING_LEASES`, KR 보유 + US 폴링 중 KR 연결 사망).** 이 경우 `RE_ELECTING`으로 가지 않는다 — 내릴 시장도 발행기도 없다. `LeaseRegistry.onLost('KR')`은 현재 세대가 `pending !== null`임을 보고 (a) 그 세대의 `controller.abort()`(US 폴링 루프가 다음 250 ms 경계에서 `AbortError`), (b) KR은 `isHeld === false`이므로 연결 종료만, (c) `acquireAll` promise를 `LeaseLostError{market:'KR'}`로 거부한다. `ProductionRuntime`은 `ACQUIRING_LEASES`에 머물며 프로세스 단위 `ReconnectSupervisor`(§8.3)로 새 세대 `acquireAll`을 예약한다(첫 시도 즉시). provider 호출·토큰 발급은 전 구간 0건이다. 감사 `LEADER_ACQUIRED{KR}`은 이미 커밋되어 있고 `LEADER_RELEASED{KR}`은 없다(연결 사망) — §10.2-10의 P3 KR과 같은 흔적이다. 이 사건도 `leader_reelection_total`이 아니라 `lease_lost_total{market, phase:'ACQUIRING'}`로 센다(§12.2).

시장 로컬 재획득이 없는 이유는 §3.11의 부분 lease 교착이다. 대신 **provider 전송 장애는 시장 로컬로 남는다**: `transportClosed`, 2 missed pong, 선언 거부, 스냅샷 실패는 해당 시장의 `MarketHealthMachine`·`ReconnectSupervisor`만 움직이고 lease·다른 시장·프로세스 상태는 건드리지 않는다(§6.2, §8.1).

**epoch 간격.** 정상 인계는 시장별 epoch가 정확히 1 증가한다(§10.2-6). 실패 경로(재선출, 부분 획득 뒤 abort, `RECOVERING` 중 손실)에서는 한 프로세스가 같은 시장의 lease를 두 번 이상 획득할 수 있으므로 **epoch 간격이 1을 넘을 수 있다**. 불변식은 “새 leader의 epoch는 이전 어떤 epoch보다 크다”이며 “정확히 +1”은 정상 경로의 관측값이지 계약이 아니다. 테스트는 실패 경로에서 `epoch_after > epoch_before`만 단언한다.

**P1이 US를 쥔 채 KR을 잃고, P2가 동시에 대기 중인 시나리오**(A16, §10.2-10). P1 `SERVING`, P2 `ACQUIRING_LEASES`에서 KR 폴링 중. P1의 KR lease 연결을 `pg_terminate_backend`로 죽인다.
- P1: 300 ms 내 위 1~6 실행. US 소켓도 닫혀 P1의 provider 연결은 0개. US lease 해제(`LEADER_RELEASED{US}`), KR은 연결 종료만. 그 뒤 7에 따라 `acquireAll` 재시도 → KR 폴링 대기(P2가 먼저 KR을 잡았다면).
- P2: KR lock이 풀리는 순간(P1의 KR 세션 종료) 다음 폴링에서 KR 획득, 이어 US 폴링 → P1의 US 해제 뒤 획득 → 번들 완성 → `RECOVERING(all)` → `SERVING`. P2의 provider 연결은 번들 완성 뒤에만 열리므로 P1 연결 0개인 시점 이후다.
- 결과: 두 프로세스가 각각 한 시장만 쥐고 서로 기다리는 상태가 **존재하지 않는다**(P1은 잃은 즉시 US를 놓는다). 새 leader(P2)가 `SERVING`에 도달하는 시간은 P1 해제 시간(≤ 1 s) + 폴링 2주기(≤ 500 ms) + recovery 시간(`RECOVERY_STABILITY_MS` 포함)으로 **유계**다. `peakConcurrentConnections ≤ 2`, `evictions === 0`. P1은 `RE_ELECTING`에서 KR·US 폴링을 계속하며 P2가 살아 있는 동안 `CANCEL_ONLY`로 서비스한다. P1이 `SIGTERM`을 받으면 §6.6대로 `abortPending()`으로 빠져나온다. KR epoch는 P2 획득 시 이전보다 크기만 하면 된다(간격 > 1 허용).

잔여 위험: PostgreSQL 연결 사망 감지까지의 지연 동안 이전 프로세스의 소켓이 살아 있고 새 leader가 연결을 열면 provider가 가장 오래된 연결(이전 프로세스)을 끊는다. 이 경우에도 (a) 새 leader의 연결은 유지되고, (b) 이전 프로세스의 fill은 fencing token 불일치로 DB에서 거부되며, (c) `provider_connections_open` 합계가 2를 넘는 순간이 알림으로 남는다. 이는 이중 leader가 아니라 감지 지연이며, 허용된 잔여 위험으로 기록한다.

### 6.6 종료 시퀀스 (`ShutdownCoordinator.drain`)

`SIGTERM`/`SIGINT` 수신 시 기존 `ShutdownCoordinator`가 다음 콜백으로 구성된다. deadline은 `now + SHUTDOWN_DRAIN_DEADLINE_MS`(기본 30 s).

| 순서 | 콜백 | `ProductionRuntime`이 주입하는 구현 |
|---|---|---|
| 1 | `cancelOnly()` | **`leaveServing('DRAINING')`(§6.1, 동기)**: 상태 `DRAINING`(스트림 게이트는 파생이므로 같은 순간 닫힘 — 새 WS upgrade 503 `NOT_READY`), `leftFrom`에 이전 상태 기록, admission latch 닫기 → 모든 시장 `{CANCEL}`, 두 시장 matching latch 닫기(새 fill 없음), **`OutboxPublisherLoop.pauseScheduling()`** — 상태가 바뀌는 같은 동기 스택에서 타이머 제거·`running = false`·새 periodic claim 차단, 진행 중 `pollOnce` 하나를 `pendingPoll`로 포착. 같은 동기 구간에서 `/health/ready`가 503 `{code:'NOT_READY', details:{draining:true}}`를 반환하도록 플래그, trading `reasons`에 `DRAINING` 추가. 감사 `RUNTIME_DRAINING`은 그 뒤 비동기. `SERVING`이 아닌 상태에서 시작했다면 latch·발행기는 이미 닫혀/꺼져 있어 각 호출이 no-op이다. |
| 2 | `admission.close()` | **인그레스 울타리.** `RequestAdmissionGate.close()` — 이후 도착하는 비즈니스 HTTP 요청은 `onRequest`에서 503 `NOT_READY` + `Retry-After: 1`로 거부되고 핸들러·`UnitOfWork`에 도달하지 않는다(`/health/*` 제외). 스트림 게이트·admission latch·matching latch는 1단계 동기 구간에서 이미 닫혔다. 게이트를 latch와 별도로 닫아야 하는 이유: latch는 `{CANCEL}`을 남기므로 latch만으로는 이미 라우팅된 취소 요청이 계속 새 `UnitOfWork`를 시작해 3단계 카운터가 수렴하지 않을 수 있다. 취소 가용성은 이미 준비된 P2가 제공한다(§3.13, §6.3). |
| 3 | `drainInflight(deadline)` | 먼저 `RequestAdmissionGate.drain(deadline)` — 2단계 전에 허용된 비즈니스 요청의 in-flight 수가 0이 될 때까지 50 ms 폴링. 그 다음 `UnitOfWork` in-flight 카운터가 0이 될 때까지 50 ms 폴링(허용된 요청이 시작한 트랜잭션과 엔진 fill 트랜잭션의 꼬리). 두 카운터 모두 deadline 초과 시 진행. 게이트가 닫힌 뒤에는 새 `UnitOfWork`를 시작할 HTTP 경로가 없으므로 두 카운터는 단조 감소한다. |
| 4 | `drainOutbox(deadline)` | 두 하위 단계. **(4a) `await pendingPoll`** — 1단계가 포착한 in-flight periodic `pollOnce`(claim 없는 publish·`markOutboxPublished` 꼬리)가 끝나기를 기다린다(`null`이면 즉시). **(4b) `OutboxPublisherLoop.shutdownDrain(deadline)` — 명시적 유계 one-shot 종료 drain.** `leftFrom === 'SERVING'`일 때만 실행한다(이 프로세스가 직전까지 유일한 발행자였고 두 lease를 여전히 쥐고 있다 — 해제는 6단계). 전제조건 `isRunning() === false && hasInFlightPoll() === false`를 단언하고, `pollOnce({mode:'shutdown_drain'})`을 **직접 반복 호출**해 `claimed === 0`이 두 번 연속이거나 deadline이면 반환한다. 타이머를 등록하지 않고 `running`을 바꾸지 않으므로 **주기 루프가 아니며**, 반환 뒤에는 어떤 종류의 claim도 없다(멈출 것이 없다). 각 반복은 `outbox_claims_total{mode:'shutdown_drain'}`·`outbox.poll{mode:'shutdown_drain'}`으로 기록되고 마지막에 `outbox.drain{rounds, claimed, remaining, deadlineHit}` 요약 로그 1건. deadline 초과 시 남은 행 개수를 `outbox_drain_remaining` 게이지에 기록하고 진행(행은 DB에 남아 새 leader가 발행한다 — at-least-once). `pollOnce`는 자기 claim 배치의 마지막 `markOutboxPublished`까지 끝낸 뒤 반환하므로 “claim했지만 발행 안 함”으로 끝나는 행은 없다(claim tx는 짧고 row lock은 tx 종료 시 풀린다). `leftFrom !== 'SERVING'`(`ACQUIRING_LEASES`·`RECOVERING`·`RE_ELECTING`에서 종료)이면 (4b)는 실행하지 않고 `outbox.drain{skipped:true, leftFrom}`만 남긴다 — 번들 소유자가 아니거나 `SERVING`에 도달한 적 없는 프로세스는 claim을 하지 않는다는 규칙(§7.4)이 종료 경로에서도 유지된다. |
| 5 | `closeSockets()` | 시장 AbortController abort; 두 provider `stream.close()`; `StreamHeartbeatLoop.stop()`; upgrade 브리지 `detach()`(closing latch + pending 핸드셰이크 파괴) → `closeAll(1012, 'SERVICE_RESTART')`(`STREAM_CLOSE_GRACE_MS = 2000` 상한, 잔여는 `terminate()`) → `wss.close()` 순으로 사용자 WebSocket 종료(§7.5 정리; 브라우저는 재접속 후 REST 스냅샷으로 조정). `OPENING` 상태 세션도 `closeAll`이 함께 닫고 큐를 버린다. 이 단계의 상한은 `STREAM_CLOSE_GRACE_MS`이며 drain deadline과 무관하게 종료를 막을 수 없다. |
| 6 | `releaseLeases()` | `LeaseRegistry.abortPending()` → `LeaseRegistry.releaseAll()`(역순 US→KR) — **모든 소켓이 닫힌 뒤에만** 실행. 그래야 새 leader가 lock을 얻는 순간 이전 연결이 0개다. 각 시장의 `LEADER_RELEASED`는 §5.4대로 unlock 전에 커밋된다. 프로세스가 `ACQUIRING_LEASES`/`RE_ELECTING`에서 `SIGTERM`을 받았다면 `abortPending()`이 진행 중 세대를 abort하고 부분 lease 역순 해제를 기다린다(§5.4). |

그 뒤 `server.ts`의 기존 흐름대로 `app.close()`, 마지막에 `database.destroy()`. 종료 코드 0. deadline 초과로 강제 진행한 경우도 종료 코드는 0이며 `RUNTIME_STOPPED {forced:true, remainingOutbox}` 감사와 `shutdown_forced_total` 카운터를 남긴다.

**lease 대기 중 종료.** `ACQUIRING_LEASES`에서 `SIGTERM`을 받은 프로세스는 위 순서를 그대로 지나지만 3~5단계는 즉시 끝난다(허용된 비즈니스 요청 꼬리 외에 in-flight 없음, outbox loop 미시작 → 1단계 `pauseScheduling()` no-op·`pendingPoll === null`, 4단계는 `leftFrom !== 'SERVING'`이므로 `shutdownDrain` 미실행(`outbox.drain{skipped:true}`), provider 소켓·사용자 소켓 없음). 6단계의 `abortPending()`이 폴링 루프를 다음 250 ms 경계에서 깨우므로 전체 종료는 `1 s + 허용 요청 꼬리` 안에 끝난다. 토큰·REST·WS 호출은 **총 0건**이고 종료 코드는 0이다(A15, §10.2-11). “provider 호출 0건”은 이 경우(`ACQUIRING_LEASES`, `RE_ELECTING`의 폴링 구간, 부분 번들 대기)에만 성립하는 문장이다.

**`RECOVERING` 중 종료.** 번들을 쥐고 recovery가 진행 중인 프로세스가 `SIGTERM`을 받으면 provider 호출은 이미 발생했을 수 있다(토큰 1건, 스냅샷 일부, WS `connect`). 규칙은 “0건”이 아니라 **“abort 이후 새 호출 0건”**이다: 1~2단계는 위와 같고(게이트·발행기는 원래 닫혀/꺼져 있음 — `pauseScheduling()` no-op), 3단계는 허용된 HTTP 요청 꼬리만 기다리며, 4단계는 `pendingPoll === null`이고 `leftFrom === 'RECOVERING'`이므로 `shutdownDrain`을 실행하지 않는다(claim 0건), 5단계 `closeSockets()`가 두 시장 AbortController를 abort해 진행 중 `SupervisedRecovery`(스냅샷 루프·안정화 대기·`connect` 대기)를 `AbortError`로 끝내고 provider 소켓을 닫는다 — abort 뒤 `tokenProvider.getAccessToken`·REST·`connect` 호출 수는 증가하지 않는다(진행 중이던 단일 요청의 응답은 버린다). 6단계가 번들을 역순 해제한다. `RECOVERY_COMPLETED` 감사는 남지 않고 `RUNTIME_STOPPED{forced:false}`만 남는다(A15 변형 2).

**`RequestAdmissionGate` 규격**(`+ runtime/request-admission-gate.ts`):

- 상태: `closed: boolean`, `inFlight: number`. Fastify 훅으로 등록: `onRequest`(가장 먼저, Origin 검사 훅보다 앞), `onResponse`, `onError`, **`onRequestAbort`**. 네 훅은 `fastify.addHook`으로 루트 스코프에 한 번씩 등록한다.
- **원자성 — 콜백형 동기 `onRequest`.** `onRequest`는 `(request, reply, done) => void` 시그니처의 **동기 함수**다(`async` 아님, 본문에 `await` 없음): `if (isHealthPath(request)) { done(); return; } if (closed) { reply.code(503).header('Retry-After','1').send(rejectBody(request)); return; /* done() 호출 안 함 — 응답으로 라이프사이클 종료 */ } inFlight += 1; request.admitted = true; done();`. Node 단일 스레드에서 닫힘 검사와 증가 사이에 `await`도 `done()`도 없으므로 `close()`가 그 사이에 끼어들 수 없다 — “검사 통과 후 증가 전에 닫힘”으로 drain이 요청 하나를 놓치는 경합이 구조적으로 없다. `close()`도 동기다(`closed = true`). 콜백형을 쓰는 이유: `async` 훅은 반환된 promise 해결까지 마이크로태스크 경계가 생겨 정적 검사 “`await` 없음”만으로는 원자성을 말하기 어렵고, 콜백형은 `done()` 이전 구간이 문자 그대로 하나의 동기 스택이다.
- **정확히 한 번 감소.** 감소 지점은 세 훅이다: `onResponse`(응답이 **전송된 뒤**에만 호출됨), `onError`(핸들러·훅 예외), `onRequestAbort`(클라이언트가 응답 전에 연결을 끊음 — Fastify는 이 경우 `onResponse`를 호출하지 않고 이 훅만 호출한다). 세 훅은 모두 같은 `settle(request)` 헬퍼를 부른다: `if (request.admitted) { request.admitted = false; inFlight -= 1; }`. 플래그를 소비하므로 한 요청에서 두 훅이 모두 와도(예: abort 뒤 핸들러가 던져 `onError`, 또는 `onError` 뒤 오류 응답 전송으로 `onResponse`) 감소는 총 1회다. 거부된 요청(503)은 `admitted`가 세워지지 않으므로 그 응답의 `onResponse`는 no-op이다.
- 제외 경로: `/health/live`, `/health/ready`, `/health/market-data`, `/api/v1/health/trading`, `/metrics`. 이들은 닫힌 뒤에도 정상 응답하며 카운터에 포함되지 않는다(관측성이 종료 중에도 살아 있어야 드릴과 운영자가 `DRAINING`을 볼 수 있다). `/admin/*`은 비즈니스 요청으로 취급한다.
- 거부 응답: `503 {code:'NOT_READY', message:'Server is draining', retryable:true, requestId}` + `Retry-After: 1`. 기존 오류 envelope와 같은 형식이다.
- `drain(deadline)`: `inFlight === 0`이면 즉시, 아니면 50 ms 폴링, deadline 초과 시 `http_admission_drain_remaining` 게이지에 잔여를 기록하고 반환.
- 테스트 `request-admission-gate.test.ts`(Fastify inject + 실제 listen 둘 다): G1. 열림 상태에서 요청 → 200, 응답 후 `inFlight === 0`; G2. 핸들러가 `Deferred`로 막힌 요청 1건(`inFlight === 1`) → `close()` → 그 뒤 도착한 비즈니스 요청 → 503 `NOT_READY` + `Retry-After`, 핸들러 spy 0회, `UnitOfWork` spy 0회, `inFlight`는 여전히 1 → `Deferred` 해결 → 첫 요청 200, `inFlight === 0`, `drain()` 해결; G3. 닫힌 뒤 `/health/ready`·`/health/live`·`/api/v1/health/trading` → 정상 응답(ready는 §6.6-1의 503 `draining:true`), `inFlight` 불변; G4. 핸들러가 던지는 요청 → `onError` 경로에서 감소 1회, 그 뒤 오류 응답 전송으로 `onResponse`가 와도 감소 총 1회; G5. **클라이언트 abort**(실제 listen, 핸들러를 `Deferred`로 막은 채 원시 TCP 소켓을 `destroy()`) → `onRequestAbort` 훅이 호출되어 즉시 감소 1회(`inFlight === 0`), `onResponse` 미호출; 그 뒤 `Deferred`를 해결해 핸들러가 끝나도 감소 추가 0회(`inFlight`가 음수가 되지 않음); `drain()`은 abort 직후 해결됨; G5b. abort 뒤 핸들러가 던지는 순서(`onRequestAbort` → `onError`) → 감소 총 1회; G6. 원자성: `onRequest` 훅 함수가 `AsyncFunction`이 아니고(`constructor.name === 'Function'`), `length === 3`(`done` 매개변수)이며 본문에 `await`가 없음(정적 검사), 그리고 `close()`를 `onRequest` 진입 직전·직후에 끼운 두 순서에서 각각 503 / 허용+카운트 결과만 나오고 “허용됐는데 미카운트”가 없음; G7. 503 거부 응답의 `onResponse`는 `inFlight`를 바꾸지 않음(`admitted` 미설정), 그리고 네 훅이 루트 스코프에 각 1개씩 등록되어 있음(`fastify[kHooks]` 또는 `printPlugins`/훅 목록 spy로 단언).

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

`RecoveryCoordinator.recover(market, signal)`의 기존 절차를 유지한다: lease(`LeaseRegistry.held(market)` — 보유 중 lease 반환만, 획득 없음, §5.4) → `beginEpoch` → `stream.connect` → `declare` + ack 검증 → 심볼별 rate-limited REST 스냅샷(`SnapshotRateLimiter` 10/s) → `replaceBaseline` → 안정화 대기(`RECOVERY_STABILITY_MS`) → 반환. `ProductionRuntime`은 반환값을 받아:

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
OutboxPublisherLoop
  ├ 주기 스케줄링 (pollOnce 완료 뒤 setTimeout 200 ms 재등록, batch 100;
  │   번들 소유자가 SERVING인 동안만 — start()/pauseScheduling()은 enterServing/leaveServing 동기 구간)
  └ shutdownDrain(deadline) (SERVING→DRAINING 4단계에서만, 타이머 없는 유계 one-shot 반복, mode:'shutdown_drain')
        │
        pollOnce({mode})
        ├ claimPendingOutbox (FOR UPDATE SKIP LOCKED, 짧은 tx; 첫 await 앞에서 발행, outbox_claims_total{mode} +1)
        ├ publish(event) = StreamHub.deliver(sessionId, event)
        │     ← 세션 없음: no-op 성공 / LIVE: 즉시 send / OPENING: 큐 수락(성공) 또는 overflow(세션 종료 후 성공)
        ├ markOutboxPublished(id)      ← deliver가 해결된 뒤에만
        └ 매 10분 prunePublishedOutbox(1000)   (published_at < now() − 24h)
```

- **단일 소유자, `SERVING`에서만.** Redis fan-out이 없으므로(§2.2) 발행기와 사용자 소켓은 같은 프로세스에 있어야 한다. `OutboxPublisherLoop.start()`는 **오직 `RuntimeStateMachine.enterServing()`의 동기 순서 안에서만**(§6.1) 호출된다 — 번들을 쥐었지만 아직 `RECOVERING`인 프로세스는 발행기를 돌리지 않는다(사용자의 불변식: 발행기는 번들 소유자가 `SERVING`일 때만 실행). 주기 스케줄링의 종료는 **두 개의 서로 다른 연산**이다. (1) **`pauseScheduling()`** — `SERVING`을 떠나는 `leaveServing(to)` 동기 구간(§6.1)에서 호출되어 타이머 제거·`running = false`·새 periodic claim 차단을 상태 전이와 같은 동기 스택에서 끝내고, 진행 중 `pollOnce` 하나를 포착해 돌려준다. 호출자는 그 promise를 §6.5-2(재선출)·§6.6-4a(종료)에서 **lease 해제 전에** 기다린다. (2) **`shutdownDrain(deadline)`** — §6.6-4b에서만, `SERVING`에서 `DRAINING`으로 내려온 프로세스가 lease를 아직 쥔 채 실행하는 유계 one-shot drain이다. 타이머를 만들지 않고 `running`을 바꾸지 않으며 `pollOnce({mode:'shutdown_drain'})`을 직접 반복한다 — 주기 루프의 재시작이 아니다. 따라서 어느 시각에도 outbox를 claim하는 프로세스는 두 lease를 쥔 프로세스 하나이며, 그 claim은 `SERVING`의 periodic poll이거나 `SERVING`→`DRAINING` 4b단계의 shutdown drain이다. `ACQUIRING_LEASES`·`RECOVERING`·`RE_ELECTING`, 그리고 `SERVING`을 거치지 않은 `DRAINING`의 프로세스는 claim 0건이고, `SERVING`에서 온 `DRAINING`도 4b 반환 뒤에는 claim 0건이다. `pollOnce`는 `claimPendingOutbox`를 첫 `await` 앞에서 동기 발행하므로 포착된 in-flight poll의 꼬리에는 claim이 없다(publish·`markOutboxPublished`만). `start()`는 총함수·비throw·동기(§6.1), `pauseScheduling()`은 동기·멱등, `shutdownDrain`은 전제조건(`!isRunning() && !hasInFlightPoll()`)을 단언하며, 루프는 `isRunning()`·`hasInFlightPoll()`을 노출한다. `stop()`·`drain()`이라는 이름의 메서드는 없다(두 연산을 하나로 뭉치면 “주기 루프가 `SERVING` 밖에서 돈다”와 “종료 drain은 정당하다”를 구분할 수 없기 때문이다).
- **`published_at`의 의미는 “이 프로세스가 전달 책임을 다했다”다.** `StreamHub.deliver(sessionId, event)`는 (a) 등록된 세션이 없으면 즉시 해결(미접속 사용자는 재접속 시 `afterSequence`로 따라잡는다), (b) `LIVE` 세션이면 `StreamSession.deliver`(백프레셔 큐 포함) 뒤 해결, (c) `OPENING` 세션이면 replay 장벽 큐에 넣고 **수락 시점**에 해결한다(§7.5). `markOutboxPublished`는 이 promise가 해결된 뒤에만 실행되므로 “published로 표시했지만 OPENING 큐에도 없고 replay에도 없음”인 이벤트는 존재하지 않는다. (c)에서 큐가 넘치면 hub가 그 세션에 `resync-required`를 보내고 닫은 뒤 해결한다 — 그 사용자는 재접속 replay로 이벤트를 다시 받는다.
- 발행은 “접속 중인 세션에 전달 시도”이며, 미접속 세션은 재접속 시 `afterSequence`로 REST/스트림에서 따라잡는다. 이것이 outbox가 at-least-once인 이유이고 브라우저 dedupe가 존재하는 이유다.
- `outbox_oldest_pending_seconds` 게이지는 매 poll마다 `min(created_at) where published_at is null`로 갱신한다. 알림 `OutboxLagHigh`(> 30 s)는 기존 규칙. 인계 중 P2가 대기하는 동안 이 값은 자연히 커지며, 그 지속 시간은 P1 drain + P2 recovery 시간으로 유계다.
- 인계 중: 이전 leader의 `shutdownDrain`(§6.6-4b)이 대부분을 발행하고 반환하며, 남은 행과 인계 공백(새 leader의 `ACQUIRING_LEASES`·`RECOVERING`) 동안 쌓인 행은 새 leader의 loop가 `SERVING` 진입 직후 첫 periodic poll에서 발행한다. **이전 leader가 shutdown drain 중에도 다른 프로세스가 만든 행(예: P2가 `ACQUIRING_LEASES`에서 처리한 취소)을 claim할 수 있다** — 4b단계가 반환할 때까지 P1은 여전히 lease를 쥔 유일한 발행자이므로 이것은 정상이며(의도된 drain이라 `OutboxClaimsOutsideServing`의 대상이 아니다, §12.3), 그 이벤트는 P1 소켓으로 전달되거나(P1 4b 반환 전) P2가 `SERVING` 뒤 발행/재접속 replay로 전달된다(§10.2-4·5·6). 중복 발행은 서버 hub의 `eventId` dedupe(§7.5)와 브라우저 `eventId` dedupe로 흡수된다.

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
  gate,              // StreamGate — { isOpen(): boolean } : ProductionRuntime이 SERVING에서만 open (§6.1, §6.3)
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
| 0b | `gate.isOpen() === false`(프로세스가 `SERVING`이 아님: `ACQUIRING_LEASES`, `RECOVERING`, `RE_ELECTING`, `DRAINING`) → 이 프로세스는 발행자가 아니므로 소켓을 받지 않는다(§3.12, §6.3). 1~9단계 어디에서도 `await` 뒤에 게이트가 닫힐 수 있으므로 **9단계 재검사에도 포함**한다 | 503 `NOT_READY` + `Retry-After: 1` |
| 1 | `request.headers.upgrade?.toLowerCase() === 'websocket'`, `Connection` 헤더에 `upgrade` 포함 | 426 `UPGRADE_REQUIRED` |
| 2 | `new URL(request.url ?? '/', 'http://placeholder').pathname === '/api/v1/stream'` (다른 경로의 upgrade는 이 서버가 지원하지 않음) | 404 `NOT_FOUND` |
| 3 | `parseStreamQuery(url)` — 위 규칙으로 `afterSequence`·`quoteSymbols` 검증 | 400 `BAD_REQUEST` |
| 4 | `request.headers.origin === publicOrigin` (문자열 완전 일치, 누락도 실패) | 403 `FORBIDDEN` |
| 5 | 세션 쿠키: `cookieValueFromHeader(request.headers.cookie, SESSION_COOKIE)` — `plugins/session-auth.ts`의 `cookieValue(request, name)`에서 헤더 문자열만 받는 함수를 분리해 **route와 브리지가 같은 파서를 공유**한다(`cookieValue`는 이 함수의 얇은 래퍼가 된다). 누락 → | 401 `SESSION_EXPIRED` |
| 6 | `pending.add(socket)`; `socket.once('close', () => pending.delete(socket))`; `await sessionService.authenticate(token)`; 세션 오류(`statusCode === 401`인 예외: 무효·만료·폐기 토큰) 또는 `session.status !== 'ACTIVE'` → 401. 그 외 예외(DB 오류 등)는 U8의 500 경로. 어느 경로든 `pending.delete(socket)` | 401 `SESSION_EXPIRED` |
| 7 | `limiter.checkWebsocketConnection(session.id)` (5회/1 s, 기존 값) 불허 → | 429 `RATE_LIMITED` + `Retry-After` |
| 8 | 요청 구독 개수 `n = quoteSymbols.length`로 `limiter.checkSubscription(session.id, n)` 불허 → | 429 `RATE_LIMITED` + `Retry-After` |
| 9 | **`handleUpgrade` 직전 재검사**: `closing === true` 또는 `socket.destroyed`이면 아무 응답 없이 `socket.destroy()`하고 종료; `gate.isOpen() === false`이면 503 `NOT_READY` + destroy. 6~8의 `await` 동안 `detach()`·재선출이 일어났거나 클라이언트가 떠난 경우를 잡는다 | — / 503 |
| 10 | `wss.handleUpgrade(request, socket, head, onOpen)` — 101은 `ws`가 쓴다 | 핸드셰이크 실패는 `ws`가 400을 쓰고 socket을 닫음 |

`onOpen(ws)`:

1. `ws`를 `StreamSocket`으로 감싼다: `send(text)`, `close(code, reason)`, `bufferedAmount` getter. 이 어댑터는 `apps/e2e/start-system.ts`의 수제 구현을 대체하며 e2e도 같은 브리지와 §7.6의 `StreamHeartbeatLoop`를 쓴다.
2. **`OPENING` 등록이 durable 읽기보다 먼저다.** `const handle = hub.registerOpening(session.id, ws)` — hub는 `{state:'OPENING', ws, queue: DurableAccountEvent[], sessionId}` 항목을 만든다. 이 시점부터 `OutboxPublisherLoop`가 이 sessionId로 `hub.deliver`하는 이벤트는 **큐에 적재**된다(상한 `STREAM_OPENING_QUEUE_MAX = 200`). 등록이 `source.latest`/`replay` 앞에 있어야 하는 이유: 등록 전에 발행된 이벤트는 replay가 읽고, 등록 후에 발행된 이벤트는 큐가 잡는다 — 두 집합의 합이 빠짐없이 전체가 되는 것은 등록 시점이 `latest` 읽기 시점보다 앞일 때만 성립한다(반대 순서면 `latest` 읽기와 등록 사이에 발행된 이벤트가 replay에도 큐에도 없다). `ws.on('close')`는 이 시점에 붙여 `hub.unregister(session.id, handle)`로 어느 상태에서 닫혀도 항목이 제거되게 한다.
3. `const opened = await StreamSession.open({ sessionId: session.id, source, socket, afterSequence?, quoteSymbols: tradableSymbols })` — `afterSequence`는 3단계에서 검증한 값. `open`은 `ready{accountSequence: latest}`와 replay 이벤트를 소켓에 쓰고 **명시적 replay 메타데이터를 반환**한다: `StreamOpenResult = { session: StreamSession; replayedUpTo: string; replayedEventIds: ReadonlySet<string> }`. `replayedUpTo`는 replay한 마지막 이벤트의 `accountSequence`(replay가 비었으면 `ready.accountSequence`, 즉 `latest`), `replayedEventIds`는 replay로 소켓에 쓴 모든 `eventId`의 집합이다. 이 두 값은 5단계 dedupe의 **유일한 입력**이며, hub가 `StreamSession` 내부를 들여다보지 않는다(기존 `open`이 `StreamSession`만 반환했다면 A가 반환형을 이 객체로 바꾸고 기존 호출자·단위 테스트를 `opened.session`으로 정렬한다). 실패(`OUTBOX_GAP`은 `StreamSession`이 이미 4009로 닫음; 그 외 → `ws.close(1011, 'STREAM_OPEN_FAILED')`) 시 `hub.unregister(session.id, handle)`로 `OPENING` 항목과 큐를 버리고 로그. 큐에 있던 이벤트는 이미 `published_at`이 찍혔지만 사용자는 재접속 replay로 다시 받는다(outbox는 `published_at`과 무관하게 `stream_sequence`로 replay되므로 손실이 아니다).
4. 요청 구독마다 `await opened.session.subscribeQuote(market, symbol)`. 3단계 검증을 통과했으므로 여기서 예외는 불변식 위반이며 `hub.unregister` + `ws.close(1011, 'STREAM_OPEN_FAILED')` + 로그로 처리한다.
5. **replay→live 장벽 — 라운드 반복 flush, 빈 큐 관측 시 동기 전환.** `const live = await hub.promoteToLive(session.id, handle, opened)` (`opened: StreamOpenResult`). 알고리즘:

   ```text
   flushed = new Set<eventId>()                       // 이 promote가 이미 소켓에 쓴 eventId
   loop:
     entry = registry.get(handle); if (!entry || entry.state !== 'OPENING') return false   // 닫혔거나 제거됨
     if (entry.queue.length === 0):                   // ── 동기 구간 시작 ──
       entry.state = 'LIVE'; entry.session = opened.session; return true   // 빈 큐 검사와 전이 사이에 await 없음
     batch = entry.queue; entry.queue = []            // 스냅샷 + 비움 (동기)
     batch = dedupe(sort(batch by accountSequence asc), e =>
               e.accountSequence <= opened.replayedUpTo || opened.replayedEventIds.has(e.eventId) || flushed.has(e.eventId))
     for e of batch: flushed.add(e.eventId); await opened.session.deliver(e)   // 순차 전달, 백프레셔 규칙 그대로
     rounds += 1; if (rounds > STREAM_PROMOTE_MAX_ROUNDS) → overflow 경로(resync-required, 4010, 항목 제거), return false
   ```

   규칙: (a) dedupe의 입력은 `opened.replayedUpTo`·`opened.replayedEventIds`(replay와 큐 양쪽에 같은 이벤트가 있는 것이 **정상 경합**)와 이 promote가 이미 흘려보낸 `flushed`다; (b) `await deliver` 동안 도착한 `hub.deliver`는 상태가 여전히 `OPENING`이므로 **새 큐에 적재**되고 다음 라운드가 집는다 — 이것이 순서를 지키는 이유다. **`LIVE`로 먼저 바꾸고 남은 큐를 나중에 flush하는 방식은 금지**한다: 전환 직후 도착한 `LIVE` 경로 전달이 아직 flush되지 않은 옛 큐 항목을 추월한다; (c) `OPENING → LIVE` 전이는 “큐 길이 0을 관측한 동기 구간” 안에서만 일어나며 그 구간에 `await`가 없으므로 전환 순간 큐는 정의상 비어 있다; 전환 뒤 `deliver`는 `LIVE` 경로로 `session.deliver`에 직접 간다; (d) 소켓이 닫혀 `unregister`가 항목을 제거했으면 다음 라운드 첫 검사에서 `false`를 돌려주고 남은 batch는 버린다(예외 없음); (e) 라운드 상한 `STREAM_PROMOTE_MAX_ROUNDS = 20`은 발행 속도가 전달 속도를 계속 앞지르는 병적 세션을 `REPLAY_OVERFLOW`로 수렴시키기 위한 것이며(큐 상한 200과 같은 결과), 정상 부하에서는 1~2 라운드에 끝난다; (f) 라운드 안 정렬은 배치 내부 순서만 보장한다. 배치 간 순서는 발행기가 세션당 이벤트를 `stream_sequence` 순으로 **순차** `deliver`하는 기존 `pollOnce` 성질(§7.4)에서 나오며, 이는 `LIVE` 경로가 이미 의존하는 성질과 같다 — 장벽이 새 순서 가정을 추가하지 않는다.
6. `ws.on('error')` → 로그 후 `ws.terminate()`. 클라이언트→서버 프레임은 스트림 계약에 없다(시세 구독은 쿼리로만 정해진다). 따라서 `ws.on('message')`는 종류·내용을 보지 않고 `ws.close(1003, 'UNSUPPORTED_DATA')`로 닫고 `stream.inbound_rejected` 로그를 남긴다. `maxPayload` 초과는 `ws`가 1009로 닫는다.

**`StreamHub` 상태 규칙**(`+ modules/stream/stream-hub.ts`):

- 항목: `sessionId → { state: 'OPENING' | 'LIVE', handle, ws, queue, session?: StreamSession }`. 같은 sessionId의 두 번째 접속은 새 handle로 **별도 항목**을 가지며(사용자가 탭 두 개를 열 수 있다) 레지스트리는 `sessionId → Set<entry>`다. `deliver(sessionId, event)`는 그 세션의 모든 항목에 전달한다.
- `deliver(sessionId, event): Promise<void>` — 항목마다: `LIVE` → `await session.deliver(event)`; `OPENING` → `queue.length < STREAM_OPENING_QUEUE_MAX`이면 push(수락), 아니면 **overflow**: `ws.send({type:'resync-required', reason:'REPLAY_OVERFLOW'})` → `ws.close(4010, 'REPLAY_OVERFLOW')` → 항목 제거. 어느 경로든 promise는 해결된다(발행기는 `markOutboxPublished`로 진행, §7.4). overflow는 `stream_replay_overflow_total` 카운터에 남는다.
- `unregister(sessionId, handle)` — 상태 무관 항목 제거, 큐 버림, `session?.close()`는 호출하지 않는다(소켓은 이미 닫힘). 멱등.
- `promoteToLive(sessionId, handle, opened): Promise<boolean>` — 위 `onOpen` 5단계의 라운드 알고리즘. `true`면 항목이 `LIVE`, `false`면 항목이 이미 제거되었거나 overflow로 닫혔다. 테스트용 `stateOf(handle)`과 `queueDepth(handle)`를 노출한다.
- **정리 불변식**: 모든 실패(open 실패, subscribe 실패, `promoteToLive === false`), gap(4009), overflow(4010), 소켓 close/error 뒤에 그 handle의 항목은 레지스트리에 없다. `size()`는 `LIVE`+`OPENING` 항목 수이고 `closeAll` 뒤 0이다.
- `heartbeat(serverTime)`은 `LIVE` 항목에만 보낸다(`OPENING`은 `ready` 직후이므로 훅 타임아웃 60 s 안에 전환된다; 전환이 그보다 늦으면 클라이언트가 4000으로 닫고 재접속하는 것이 올바른 결과다). `publishQuote`도 `LIVE`에만 전달한다.
- `closeAll(code, reason)`: `OPENING` 항목은 큐를 버리고 `ws.close(code, reason)`, `LIVE`는 기존 규칙.

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
- U11. **장벽 경합(flush 중 도착 포함)**: `source.replay`를 `Deferred`로 막은 채 접속 → `hub.size()===1`이고 항목 상태 `OPENING`(테스트용 `hub.stateOf(handle)`) → 그 상태에서 `hub.deliver(sessionId, E5)`(`accountSequence:'5'`, replay 범위 밖) 호출 → promise가 **replay 완료 전에** 해결됨(publisher가 막히지 않음을 증명) → `Deferred`를 `[E3, E4]`로 해결 → `promoteToLive` 1라운드가 `session.deliver(E5)`를 `await`하는 동안(픽스처가 `session.deliver`를 `Deferred`로 한 번 막음) `hub.deliver(sessionId, E6)` 호출 → 이 시점 `stateOf(handle) === 'OPENING'`이고 `queueDepth(handle) === 1`(E6가 새 큐에 적재됨, `session.deliver` 직접 호출 0회) → `E5`의 `Deferred` 해결 → 2라운드가 E6를 flush → 3라운드가 빈 큐를 관측해 `LIVE` → 클라이언트 수신 순서가 정확히 `ready` → `E3` → `E4` → `E5` → `E6`(**total order**), 각 1회; `promoteToLive`가 `true`로 해결; 이후 `hub.deliver(E7)`는 큐를 거치지 않고 즉시 도달(`session.deliver` spy 직접 호출, `queueDepth === 0`). 추가 단언: `stateOf(handle)`이 `LIVE`가 되는 순간의 `queueDepth`는 0(전이 직전 관측기를 hub 내부 훅으로 기록).
- U11b. **dedupe**: replay가 `[E3, E4]`를 반환하기 직전에 `hub.deliver(E4)`(같은 `eventId`)와 `hub.deliver(E4')`(다른 `eventId`, 같은 `accountSequence:'4'`) → 클라이언트는 `E4`를 1회만 수신하고 `E4'`도 수신하지 않음(`accountSequence ≤ opened.replayedUpTo`); `opened.replayedEventIds`에 `E3`·`E4`의 id가 있고 `opened.replayedUpTo === '4'`임을 `StreamSession.open` 반환값에서 직접 단언. 순서 뒤섞인 큐(`E7`, `E5`, `E6` 순 적재) → flush 순서 `E5, E6, E7`. 라운드 간 dedupe: 1라운드가 E5를 flush한 뒤 2라운드 큐에 E5가 다시 들어와도(발행기 재시도) 클라이언트 수신 1회.
- U11c. **overflow**: replay를 막은 채 `STREAM_OPENING_QUEUE_MAX + 1`건 `deliver` → 마지막 `deliver`가 해결되고 클라이언트가 `resync-required{reason:'REPLAY_OVERFLOW'}` 뒤 close code 4010 수신, `hub.size()===0`, `stream_replay_overflow_total` +1; `Deferred` 해결 뒤 `promoteToLive`가 `false`로 해결(항목 없음), 예외 없음, `session.deliver` 호출 0회. 변형: 매 라운드 `session.deliver` 대기 중 새 이벤트 1건을 계속 주입 → `STREAM_PROMOTE_MAX_ROUNDS` 라운드 뒤 같은 4010 경로, `promoteToLive === false`.
- U11d. **정리**: (i) replay 중 클라이언트 close → `hub.size()===0`, 이후 `Deferred` 해결 시 `promoteToLive === false`·예외 없음; (ii) `open`이 `OUTBOX_GAP`(4009)로 실패 → 항목 없음; (iii) `subscribeQuote`가 던지는 픽스처 → 1011 + 항목 없음; (iv) 각 경우 뒤 `hub.deliver(sessionId, E)`는 no-op으로 해결.
- U12. **게이트**: `gate.isOpen()`이 `false`인 픽스처로 접속 → 503 `NOT_READY` + `Retry-After: 1`, 101 없음, `hub.size()===0`, `authenticate` 호출 0회(0b단계는 인증 앞); 인증 `Deferred` 대기 중 게이트가 닫히는 순서 → 9단계 재검사에서 503, `handleUpgrade` spy 0회.
- U13. **heartbeat 대상**: `OPENING` 항목에는 `hub.heartbeat`가 프레임을 보내지 않고 `LIVE` 전환 뒤부터 보냄.

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
| lease 손실(운영 중, 어느 한 시장) | lease 연결 `error`/`end` | §6.5 전역 재선출: 두 시장 내리기(`leaveServing` 동기 구간의 `pauseScheduling` 포함) → 포착된 in-flight poll 대기 → 살아 있는 lease 해제 → KR+US 번들 재획득 → 두 시장 복구. **시장 로컬 재획득 없음** | 계속 실행, 전 시장 `CANCEL_ONLY`(`RE_ELECTING`) |
| 종료 중 도착한 비즈니스 요청 | `RequestAdmissionGate` 닫힘 뒤 HTTP 요청 | 503 `NOT_READY` + `Retry-After`, `UnitOfWork` 미시작(§6.6-2). `/health/*`는 계속 응답 | `DRAINING` 계속 |
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
- 인스턴스는 세 개다: 시장별 두 개(provider 전송 장애의 시장 로컬 재연결)와 프로세스 단위 한 개(§6.5 재선출의 `acquireAll` 재시도). 프로세스 단위 인스턴스의 첫 시도는 지연 0이며, 실패 3회 소진 시 GLOBAL scope `RECOVERY_RETRY_EXHAUSTED`를 만든다. `acquireAll`이 대기 중인 동안은 실패가 아니라 대기다(폴링은 무기한, 실패는 연결 오류·감사 실패·abort만).

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
- 하네스는 `/health/*`, `/api/v1/health/trading`, `/health/market-data`를 폴링(100 ms)해 관측 로그 `[{t, process, endpoint, body}]`를 만든다. 또 `outbox_events`를 관찰 연결로 폴링해 프로세스별 claim 흔적(`pg_stat_activity`의 `for update skip locked` 쿼리 + P2 stdout `outbox.poll` 로그 부재)을 기록한다.
- **배포 전제조건(드릴이 그대로 재현).** P1에 `SIGTERM`을 보내는 것은 **P2가 `/health/ready` 200이고 trading `reasons ⊇ ['ACQUIRING_LEASES']`를 보인 뒤**에만 한다. 이 전제가 인계 중 취소 가용성의 조건이다 — P1은 `DRAINING` 2단계에서 HTTP 인그레스를 닫으므로(§6.6) 그 뒤 취소를 받을 프로세스는 P2다. 배포 가이드의 stop-then-start 절차에 같은 문장을 추가한다(§13).

### 10.2 절차와 단언

| 단계 | 행위 | 단언 |
|---|---|---|
| 1 | P1 시작 | 20 s 내 `/health/ready` 200; 두 시장 `NORMAL`; `placement:true`; 가짜 WS `connections===2`, `leader_epochs.epoch` = (KR:1, US:1) |
| 2 | 익명 세션 생성, MARKET 주문 1건 체결, LIMIT 주문 1건 대기 | 체결 outbox 이벤트가 사용자 WS로 전달됨(하네스 클라이언트) |
| 3 | P2 시작 | 5 s 내 P2 `/health/ready` 200, trading `reasons ⊇ ['CANCEL_ONLY','ACQUIRING_LEASES']`; 가짜 WS `connections===2`(변화 없음), `peakConcurrentConnections===2`; P2의 REST 요청 기록 0건(토큰 요청 포함); **P2 outbox claim 0건**(P2 stdout에 `outbox.poll` 로그 0건, 관찰 연결에서 P2 backend의 `for update skip locked` 0회, P1 발행 지연 없음); **P2로의 사용자 WS upgrade → 503 `NOT_READY` + `Retry-After`**, 101 없음; P2가 `pg_try_advisory_lock` 폴링 중임을 P2 stdout `lease.waiting {market:'KR'}` 로그로 확인(US 폴링 로그는 아직 없음 — 순차) |
| 3b | 전제조건 확인 | 하네스는 3단계 단언이 모두 통과한 뒤에만 4단계로 간다(§10.1 배포 전제조건). |
| 4 | P1에 `SIGTERM` | 200 ms 내 P1 trading `reasons ⊇ ['CANCEL_ONLY','DRAINING']`, `/health/ready` 503(`draining:true`), `/health/live` 200; **P1으로 보낸 신규 비즈니스 요청(주문 생성·취소 모두) → 503 `NOT_READY` + `Retry-After`**, P1 stdout에 해당 `requestId`의 `UnitOfWork` 시작 로그 0건; **대기 LIMIT의 취소 요청은 P2로 보내 200**(P2는 `ACQUIRING_LEASES`에서 취소를 서비스한다, §6.3), P2에서 신규 주문 요청 → 409 `CANCEL_ONLY`; 취소 결과 outbox 행(`eventId = C`)은 P2가 만들지만 **P1이 아직 4b단계 `shutdownDrain`을 끝내지 않았다면 P1이 claim해 하네스 클라이언트의 P1 소켓으로 전달할 수 있다**(P1은 `shutdownDrain` 반환 전까지 lease를 쥔 유일한 발행자, §7.4). 따라서 이 단계는 C의 전달 위치를 단언하지 않고 **두 경로 중 하나**만 허용한다: (i) P1 `shutdownDrain` 반환 전 P1 소켓으로 도달(`published_at` 기록, P1 `outbox.poll` 로그에 C 포함 — 보통 `mode:'shutdown_drain'`이지만, `SERVING`에서 발행된 마지막 periodic claim 쿼리가 DB에서 C 삽입 뒤에 실행됐다면 `mode:'periodic'`일 수도 있다; 어느 경우든 그 poll의 claim은 `runtime.state {to:'DRAINING'}` **전에 발행**된 것이다) 또는 (ii) P1 exit 시 `published_at is null`로 남아 6단계 뒤 P2가 발행/재접속 replay로 도달. 하네스는 어느 경로였는지를 증거 JSON에 기록한다 |
| 5 | P1 종료 관측 | 종료 코드 0, `SHUTDOWN_DRAIN_DEADLINE_MS + 5 s` 내; 종료 시점에 `outbox_events where published_at is null`이 **0건 또는 1건**이고, 1건이면 그것은 4단계의 C다(P1이 만든 행은 전부 published; C는 P1 drain 타이밍에 따라 P1이 발행했거나(경로 i) 남아 있다(경로 ii) — 정확히 1건을 요구하지 않는 이유는 P1이 `shutdownDrain` 반환 전까지 C를 claim할 수 있는 정당한 발행자이기 때문이다, §7.4); **두 연산의 분리 증거**: P1 stdout에서 `runtime.state {to:'DRAINING'}` 뒤의 `outbox.poll{mode:'periodic'}`은 최대 1건(포착된 in-flight 꼬리)이고 그것이 있으면 첫 `outbox.poll{mode:'shutdown_drain'}`보다 앞이며, `outbox.poll{mode:'shutdown_drain'}`은 마지막 두 건이 `claimed:0`, 그 뒤 `outbox.drain{skipped:false}` 요약 1건, 그 뒤 어떤 `mode`의 `outbox.poll`도 없음; 하네스의 100 ms `/metrics` 폴링은 `outbox_claims_total{mode}` 두 시계열을 증거 JSON에 기록하되 타이밍 의존이므로 **단언하지 않는다**(분리 단언은 stdout 로그 순서로 한다); 관찰 연결에서 P1 backend의 마지막 `for update skip locked` 시각 < P1 `LEADER_RELEASED{US}` `occurred_at`(`stop()`이 lease 해제 앞); 가짜 WS `connections===0`인 순간이 P2 연결 전에 존재; P1 해제 증명은 **현재 `leader_epochs` 행이 아니라** 내구성 있는 흔적으로 한다: `audit_events`에 P1 `leaderId`의 `LEADER_RELEASED` 2건(KR, US)이 존재하고, 시장별로 P1 `LEADER_RELEASED{market}`의 `occurred_at`이 P2 `LEADER_ACQUIRED{market}`보다 앞선다 — §5.4대로 P1의 해제 감사가 unlock 전에 커밋되고 P2의 획득 감사가 같은 lock 아래에서 커밋되므로 이 순서는 타이밍이 아니라 lock 직렬화가 보장한다; P1 stdout 로그에 `lease.released {auditPersisted:true}` 2건. 하네스가 100 ms `leader_epochs` 폴링으로 `{leader_id:P1, released_at not null}` 전이를 포착했다면 증거 JSON에 기록하되 **단언하지 않는다**(P2 재획득이 그 행을 즉시 덮어쓰므로 포착은 타이밍 의존) |
| 6 | P2 인계 | P1 종료 후 15 s 내 P2 두 시장 `RECOVERING` 관측 → `NORMAL`; `leader_epochs` 현재 행 두 개 모두 `epoch=2`, `leader_id`=P2 leaderId, **`released_at is null`**; P2 REST 기록에 `/oauth2/token` 1건이 P2 `LEADER_ACQUIRED` 두 건 **모두의 `occurred_at` 이후** 타임스탬프(§5.4: `acquire`는 감사 커밋 뒤 반환, 토큰은 그 뒤); 가짜 WS `connections===2`, `peakConcurrentConnections===2`, `evictions===0`; **P2가 `RECOVERING`인 동안** P2 stdout에 `outbox.poll` 로그 0건·관찰 연결에서 P2 backend `for update skip locked` 0회·P2로의 WS upgrade 503(발행기는 `SERVING`에서만, §6.1); P2 stdout `outbox.poll` 첫 로그의 시각이 P2 `runtime.state {to:'SERVING'}` 로그 **뒤**(그리고 당연히 `RECOVERY_COMPLETED×2` 뒤); P2 `SERVING` 뒤 사용자 WS upgrade → 101; **C의 exactly-once는 하네스 클라이언트에서 판정한다**: 하네스 클라이언트는 P1 소켓과 P2 소켓(재접속 `afterSequence` 포함)에서 받은 모든 이벤트를 `eventId`로 dedupe하며, C는 dedupe 후 **정확히 1회**(경로 i면 P1 소켓에서 이미 받았고 P2 replay는 dedupe로 흡수, 경로 ii면 P2 첫 poll 발행 또는 replay로 도달); P2 `SERVING` 뒤 2 s 안에 `outbox_events where published_at is null`이 **0건**으로 수렴(5단계에서 1건이었다면 P2 첫 poll이 발행) |
| 7 | P2에서 신규 MARKET 주문 | 체결, `fills.recovery_epoch = 2`, fencing token = P2 값 |
| 8 | 감사 검증 | `audit_events`를 `occurred_at, id`로 정렬하면 P1: `RUNTIME_DRAINING` → `LEADER_RELEASED×2` → `RUNTIME_STOPPED{forced:false}`; P2: `LEADER_ACQUIRED×2` → `RECOVERY_COMPLETED×2` → `RUNTIME_STATE_CHANGED(→SERVING)`; 시장별 P1 `LEADER_RELEASED{market}` < P2 `LEADER_ACQUIRED{market}`; P2 stdout의 첫 `outbox.poll` 시각 > P2 `runtime.state {to:'SERVING'}` 시각(발행기 시작이 `SERVING` 진입 안에 있음); C의 `published_at`은 (경로 i) P1 `RUNTIME_STOPPED` 전 또는 (경로 ii) P2 `RUNTIME_STATE_CHANGED(→SERVING)` 후 — 그 사이 구간에 찍힌 `published_at`은 어떤 행에도 없음(발행자 공백 증명); 전체에서 `LEADER_RELEASED`는 P1 leaderId로 정확히 2건(`LeaseRegistry`가 두 번째 해제 감사를 쓰지 않음을 증명). 하네스 관측 로그에서 P1 `/health/ready` 503 첫 관측 < P2 `RECOVERING` 첫 관측 |
| 9 | 부정 경로 | P2를 `SIGKILL`로 죽인 뒤 P3 시작 → advisory lock이 자동 해제되어 P3가 epoch 3으로 `NORMAL` 도달(비정상 종료 복구 증명); 4단계 취소 이벤트와 7단계 체결 이벤트는 P3 `SERVING` 뒤 사용자 WS 재접속(`afterSequence`)으로 1회씩 수신(P2 발행분과 중복 없음) |
| 10 | **부분 lease 손실 + 동시 대기자** (§6.5 시나리오) | P3 `NORMAL` 상태에서 P4 시작 → P4 `ACQUIRING_LEASES`(KR 폴링, REST 0건) → 관찰 연결에서 P3의 **KR** lease backend만 `pg_terminate_backend` → 단언: (a) P3 stdout에 `runtime.state {to:'RE_ELECTING'}` 300 ms 내, 가짜 WS에서 P3 연결 2개 모두 종료(US 포함), `LEADER_RELEASED{US, leaderId:P3}` 1건, KR은 `LEADER_RELEASED` 없음(연결 사망); (b) P4가 15 s 내 KR·US 순으로 획득 → `RECOVERING` → `NORMAL`, `leader_epochs` 두 행 `leader_id=P4`, KR·US epoch 모두 P3 값보다 큼(**정확한 간격은 단언하지 않음**); (c) P4 토큰 요청 1건이 P4 `LEADER_ACQUIRED` 2건 뒤; (d) 전 구간 `peakConcurrentConnections===2`, `evictions===0`, `connections===0`인 순간이 P4 연결 전에 존재; (e) P3는 `RE_ELECTING`에서 `/health/ready` 200, 취소 200, 신규 주문 409, WS upgrade 503을 유지하고 `lease.waiting {market:'KR'}`을 로그 — 두 프로세스가 각 한 시장만 쥔 상태(`leader_epochs`의 `released_at is null`인 두 행의 `leader_id`가 서로 다름)가 100 ms 폴링에서 **연속 500 ms 이상 지속**되는 구간 0회(§3.11의 교착 부재가 불변식이다; 죽은 backend의 KR lock은 즉시 풀리므로 후속자 획득과 패자의 US 해제 사이 수 ms 창은 존재할 수 있고 단발 샘플로 잡힐 수 있다) |
| 11 | **대기 중 종료** | 10단계 뒤 P3(`RE_ELECTING`, 폴링 중)에 `SIGTERM` → 종료 코드 0, `SIGTERM`부터 exit까지 ≤ 3 s; P3 REST 기록은 10단계 이전 값에서 증가 0(토큰 포함), 가짜 WS에 P3 신규 연결 0; `audit_events`에 P3의 `RUNTIME_DRAINING` → `RUNTIME_STOPPED{forced:false}`, 그 사이 `LEADER_ACQUIRED` 없음; `pg_locks`에 P3 backend 없음 |

전체 드릴 시간 상한 180 s. 드릴은 `pnpm --filter @skipjack/paper-api test -- leader-handoff.drill` 로 실행되며 Docker가 필요하다. Docker 없는 환경에서는 skip이 아니라 **실패**한다(릴리스 증거이므로).

### 10.3 산출 증거

드릴은 `apps/paper-api/test-results/leader-handoff/<utc>.json`에 관측 로그, 연결 카운터, epoch 테이블, 종료 코드를 기록한다(untracked). 릴리스 체크리스트 갱신 시 이 파일의 요약(시각, 커밋, peak=2, evictions=0)을 인용한다.

## 11. A/B/C 경계와 수용 기준

### 11.1 Stage A — ProductionRuntime (provider-neutral)

범위: §4.1의 A 소유 컴포넌트, `main.ts` 축소, `003_leader_release.sql`과 `LeaderLease` acquire(`pg_try_advisory_lock` 250 ms 폴링 + `AbortSignal`)/release 수정 + `LeaseAuditPort` + `LeaseRegistry.acquireAll` 번들(§5.4), 전역 재선출(§6.5), `RequestAdmissionGate`(§6.6), `StreamHub` `OPENING`/`LIVE` 장벽과 스트림 게이트(§7.5), 단일 소유자 `OutboxPublisherLoop`(§7.4), `/health/*` 확장, `registerStreamRoutes`(426 폴백) + `ws` noServer upgrade 브리지 + `parseStreamQuery` + 웹 훅 `streamUrl(afterSequence)` 정렬(§7.5), `StreamHeartbeatLoop`(§7.6), `config.ts`의 `MARKET_DATA_ADAPTER` 명시 규칙(§5.1), 문서 드리프트 수정(§1.1-7), `check:deployment` 확장(`TOSS_CLIENT_*` 필수 보간 — 값은 아직 사용되지 않아도 계약으로 선언 — 과 compose `MARKET_DATA_ADAPTER: toss` 리터럴 단언), `release-drill.integration.test.ts`의 “unavailable” 케이스를 `MARKET_DATA_ADAPTER=toss` + `TOSS_CLIENT_*` 누락 → `ConfigError` EXIT 1로 재정의(A에서는 `toss adapter is not available in this build`, B 이후에는 자격증명 누락 오류 — 둘 다 EXIT 1). 자동 테스트의 provider는 `fake` 번들만 사용.

수용 기준:

- A1. `MARKET_DATA_ADAPTER=fake`, Testcontainers PG/Redis로 `ProductionRuntime`을 시작하면 `BOOTING→…→SERVING`, 두 시장 `NORMAL`, `leader_epochs` 두 행, `placement:true`.
- A2. 가짜 스트림 `deliverTransportClose` → 해당 시장만 `DEGRADED`(다른 시장 `NORMAL`, 배치 가능) → 자동 recovery → `NORMAL`; epoch +1; `feed_reconnect_total` +1.
- A3. 5분 창 3회 실패 시 `RECOVERY_RETRY_EXHAUSTED` 수동 incident, 자동 재시도 중단; 해제 시 재시도 재개.
- A4. **KR** lease 연결만 강제 종료(`pg_terminate_backend`) → 300 ms 내 **두 시장** `stream.close()` 호출 관측(US 포함), `runtime.state {to:'RE_ELECTING'}`, `OutboxPublisherLoop.pauseScheduling()` spy가 `runtime.state {to:'RE_ELECTING'}`과 **같은 동기 스택**(둘 사이 마이크로태스크 0개)이고 반환 직후 `isRunning() === false`, 포착된 in-flight poll(있으면)의 해결이 두 시장 abort·`releaseAll` 앞, `shutdownDrain` spy 0회, `LEADER_RELEASED{US}` 1건, `LEADER_LEASE_LOST{KR}` + `LEADER_BUNDLE_BROKEN{US}` incident, 스트림 게이트 닫힘(WS upgrade 503), 취소 HTTP 200 유지; `releaseAll` 중 US lease 연결의 `end`가 `onLost`·`reelect`를 다시 부르지 않음(`reelect` spy 총 1회, `leader_reelection_total` +1); 그 뒤 `acquireAll` 재획득(`LeaderLease.acquire` 순서 `['KR','US']`) → `RECOVERING`(이 구간 `OutboxPublisherLoop.start` 0회·`claimPendingOutbox` 0회) → 두 시장 새 epoch(이전보다 큼, 간격 단언 없음) → `SERVING`, `RUNTIME_STATE_CHANGED{to:'SERVING'}` 2건째, `start` 2회째가 그 전이의 동기 구간 안. 시장 로컬 `acquire` 호출 경로가 없음을 정적 검사(`LeaseRegistry`에 공개 `acquire(market)` 없음). **변형 A4b(`RECOVERING` 중 손실)**: 두 시장 recovery의 스냅샷을 `Deferred`로 막아 `RECOVERING`에 머무는 동안 KR lease backend 종료 → 같은 §6.5 순서, recovery promise가 `AbortError`로 끝남, `RECOVERY_COMPLETED` 0건, abort 뒤 `tokenProvider`·REST·`connect` spy 증가 0, `reelect` 1회, 재획득 뒤 `SERVING`.
- A5. `SIGTERM` → §6.6 순서대로 콜백 호출(순서를 기록하는 spy: `cancelOnly` = `leaveServing('DRAINING')` 동기 스택[상태 `DRAINING`(게이트 파생 닫힘) → admission latch → matching latch → `pauseScheduling`] → `RequestAdmissionGate.close` → `RequestAdmissionGate.drain` → UoW drain → `await pendingPoll` → `OutboxPublisherLoop.shutdownDrain` → `closeSockets` → `abortPending` → `releaseAll`), outbox 잔여 0, lease 해제, 종료 코드 0, 소요 < deadline. **두 연산 분리**: `publish`를 `Deferred`로 막은 periodic poll이 진행 중일 때 `SIGTERM` → `pauseScheduling` 반환 시점에 `isRunning() === false`·`hasInFlightPoll() === true`, `shutdownDrain` spy는 `Deferred` 해결 **뒤**에만 호출되고 그 사이 `claimPendingOutbox` 호출 0회; `shutdownDrain` 중 `setTimeout` 등록 0회(fake timers로 단언)와 `isRunning() === false` 유지; 반환 뒤 `claimPendingOutbox` 추가 호출 0회. `outbox_claims_total{mode="periodic"}`은 `runtime.state {to:'DRAINING'}` 뒤 증가 0, `{mode="shutdown_drain"}`은 4b 구간에서만 증가. **변형 A5b(`SERVING` 미도달 종료)**: `RECOVERING`·`ACQUIRING_LEASES`에서 `SIGTERM` → `shutdownDrain` spy 0회, `outbox.drain{skipped:true, leftFrom}` 로그 1건, `outbox_claims_total` 두 `mode` 모두 증가 0. `RequestAdmissionGate.close` 뒤 inject한 비즈니스 요청 → 503 `NOT_READY`, `UnitOfWork` spy 0회; `/health/ready` → 503 `draining:true`, `/health/live` → 200.
- A14. `RequestAdmissionGate` 테스트 G1~G7(§6.6, G5·G5b의 `onRequestAbort` 경로 포함) 통과; 게이트 `onRequest` 훅이 Fastify 훅 목록의 첫 번째이고 콜백형(`length === 3`) 동기 함수임을 단언; `onResponse`·`onError`·`onRequestAbort` 세 훅이 모두 등록되어 같은 `settle` 헬퍼를 부름을 단언.
- A15. **대기 중 종료**: 관찰 연결이 KR lock을 쥔 채 런타임 시작 → `ACQUIRING_LEASES`(`lease.waiting{KR}` 로그, `pg_try_advisory_lock` 폴링 ≥ 3회 기록) → `SIGTERM` → 종료 코드 0, `SIGTERM`부터 exit까지 ≤ 2 s; `tokenProvider.getAccessToken`·provider `connect`·REST spy 0회; `LEADER_ACQUIRED` 0건; `pg_locks`에 런타임 세션 lock 없음; 감사 `RUNTIME_DRAINING` → `RUNTIME_STOPPED`. 변형 1: US lock만 관찰자가 쥠 → KR 획득 뒤 US 폴링 중 `SIGTERM` → KR `LEADER_RELEASED` 1건, 나머지 동일. **변형 2(`RECOVERING` 중 종료, §6.6)**: 번들 획득 뒤 두 시장 recovery의 스냅샷을 `Deferred`로 막은 채 `SIGTERM` → 종료 코드 0, ≤ deadline; `SIGTERM` 시점의 `tokenProvider.getAccessToken`·REST·`connect` spy 횟수를 기록하고 abort 뒤 **증가 0**(“총 0건”이 아니라 “abort 뒤 새 호출 0건”); recovery promise `AbortError`; `RECOVERY_COMPLETED` 0건; `OutboxPublisherLoop.start` 0회(`RECOVERING`에서는 시작 안 함); `LEADER_RELEASED` 2건(KR·US); provider 소켓 `close` 2회.
- A16. **부분 손실 + 동시 대기자**(§6.5 시나리오, 단일 vitest 프로세스 안의 두 `ProductionRuntime` 인스턴스 + 공유 Testcontainers PG + 인메모리 fake 번들에 연결 카운터 추가): R1 `SERVING`, R2 `ACQUIRING_LEASES` → R1 KR lease backend 종료 → R1 `RE_ELECTING`(US 포함 소켓 0개, `LEADER_RELEASED{US}`), R2가 KR→US 순으로 획득해 15 s 내 `SERVING`; fake 번들 `peakConcurrentConnections ≤ 2`; `released_at is null`인 두 행의 `leader_id`가 서로 다른 순간 0회(100 ms 폴링); R2의 두 epoch가 R1 값보다 큼(간격 단언 없음); R1은 `RE_ELECTING`에서 R2가 살아 있는 동안 폴링 지속, 그 뒤 R1 `stop()` → 종료 ≤ 2 s, provider 호출 증가 0. **A16b(부분 획득 중 손실, §6.5)**: 관찰자가 US lock을 쥔 채 런타임 시작 → KR 획득·US 폴링 중 KR backend 종료 → `runtime.state`는 `ACQUIRING_LEASES` 유지(`RE_ELECTING` 0회, `reelect` spy 0회), `lease_lost_total{market:'KR',phase:'ACQUIRING'}` +1, 현재 세대 `acquireAll`이 `LeaseLostError`로 거부되고 프로세스 단위 supervisor가 새 세대 시작(`lease.waiting{KR}` 로그 재등장), provider·토큰 spy 0회; 관찰자 unlock → KR(epoch 2)·US 획득 → `SERVING`.
- A17. **스트림 게이트·단일 발행자**: `ACQUIRING_LEASES`(관찰자가 KR lock 보유)인 런타임에 WS upgrade → 503 `NOT_READY` + `Retry-After`, `OutboxPublisherLoop.start` spy 0회, `claimPendingOutbox` spy 0회, 취소 HTTP 200; 관찰자가 unlock → 번들 획득 → **`RECOVERING` 동안**(스냅샷 `Deferred`로 고정) 같은 upgrade → 여전히 503 `NOT_READY`, `start` spy 0회, `claimPendingOutbox` 0회, `outbox.poll` 로그 0건 → `Deferred` 해결 → `enterServing` → 같은 upgrade → 101, `start` 1회, 대기 중 쌓인 outbox 행이 첫 poll에서 발행되어 소켓에 도달. 순서 spy: `runtime.state {to:'SERVING'}` → `publisher.start` 가 **같은 동기 스택**(둘 사이 마이크로태스크·매크로태스크 0개; `queueMicrotask`로 끼운 관측자가 두 호출 사이에 실행되지 않음)이고, upgrade 핸들러가 `gate.isOpen() === true`를 처음 관측한 시점에 `publisher.isRunning() === true`; 역방향도 단언 — `leaveServing` 직후 `gate.isOpen() === false`를 처음 관측한 시점에 `publisher.isRunning() === false`(`queueMicrotask` 관측자가 두 값을 동시에 읽어 불일치 0회). 재선출(A4) 중에도 `claimPendingOutbox` 호출 0회. **`start()` 총함수 불변식**: 정적 — `OutboxPublisherLoop.start` 소스에 `await`·`throw`·`try`·`async`가 없고(`constructor.name === 'Function'`), 호출식이 `setTimeout` 하나뿐(주입 의존성의 메서드 호출 0개); 동적 — DB·hub·로거·메트릭 스텁을 전부 `throw`하는 구현으로 주입해도 `start()`가 예외 없이 반환하고 `isRunning() === true`, 두 번 호출해도 타이머 1개(멱등); 그 상태에서 첫 tick의 `pollOnce`가 던지면 루프는 그 오류를 로그하고 다음 tick을 재등록한다(발행기 오류는 상태 기계를 건드리지 않음). `enterServing`에 fail-closed 분기가 없는 근거가 이 항목이다(§6.1).
- A18. §7.5 U11~U13(장벽 경합 — flush 중 도착 이벤트의 total order 포함, dedupe, overflow·라운드 상한, 정리, 게이트, heartbeat 대상) 통과; `StreamSession.open`이 `{session, replayedUpTo, replayedEventIds}`를 반환하고 `promoteToLive`가 그 객체만 입력으로 받음(타입 검사); `promoteToLive` 소스에 “`LIVE` 대입 뒤 큐 flush” 순서가 없고 `LIVE` 대입이 `queue.length === 0` 분기 안에만 있음(정적 검사); `markOutboxPublished` spy가 `hub.deliver` 해결 전에 호출되지 않음(순서 기록); `OutboxPublisherLoop.pauseScheduling()`이 진행 중 `pollOnce`를 포착함(`Deferred`로 `publish`를 막은 채 `pauseScheduling()` → **동기 반환**하며 반환값은 pending promise, 반환 직후 `isRunning() === false`·`hasInFlightPoll() === true`, 그 promise는 `Deferred` 해결 뒤에만 해결되고 그 사이 `claim` 추가 호출 0회; fake timers를 200 ms 이상 진행시켜도 tick이 새 `pollOnce`를 시작하지 않음; 두 번째 `pauseScheduling()`은 같은 promise를 반환; 진행 중 poll이 없을 때는 `null` 반환); `shutdownDrain`은 `isRunning() === true` 또는 `hasInFlightPoll() === true`에서 호출하면 전제조건 위반으로 거부(claim 0회)됨.
- A6. outbox: 트랜잭션에 append된 이벤트가 접속 중 `StreamSession`에 1 s 내 도달; 미접속 세션 이벤트는 `published_at` 기록 후 재접속 시 `afterSequence`로 회수.
- A7. `verifyInvariants` 실패 주입 → `STARTUP_INVARIANT_OR_AUDIT_FAILURE` incident 행 존재, 종료 코드 1; 재시작 시 incident 때문에 `CANCEL_ONLY` 유지.
- A8. production + `fake` → 시작 실패; production + `MARKET_DATA_ADAPTER` 누락 → 시작 실패(`ConfigError: MARKET_DATA_ADAPTER must be set explicitly in production`); development/test + 누락 → `fake`로 시작; 비-loopback URL 덮어쓰기 → 시작 실패. `check:deployment`가 compose의 `MARKET_DATA_ADAPTER: toss` 리터럴을 단언하고, 리터럴을 제거·보간·`fake`로 바꾼 임시 사본에서 실패함을 테스트로 증명.
- A9. 기존 게이트 전부 통과: `pnpm check`, `typecheck`, `test`, `check:deployment`, `build`, e2e 18/18.
- A10. `RecoveryCoordinator`가 시작 중 `acquireLease(market)` 포트를 호출해도 `LeaseRegistry.held(market)`가 보유 lease를 반환만 하여 `leader_epochs.epoch`가 시장별 1만 증가(멱등 증명); 번들 미보유 상태에서 호출하면 `LeaseNotHeldError`.
- A11. §5.4의 lease 테스트 13건(first acquire, release, reacquire, no race, release audit failure, acquire audit failure, abort while waiting, abort/lock race, bundle partial release, bundle order and sharing, intentional release is not loss, loss reported once, loss during partial acquire) 통과; `LeaderLease`의 `error`/`end` 핸들러가 단일 `#reportLost`로 모이고 `HELD`에서만 `onLost`를 올리며 `release()`가 첫 query 전에 `RELEASING`을 세움(정적 검사 + 테스트 11·12); `acquire()`의 query 순서가 `select pg_try_advisory_lock`(×n, 마지막 `true`) → `begin` → upsert → `insert audit_events(LEADER_ACQUIRED)` → `commit`이고 promise가 `commit` 뒤 해결, `pg_advisory_lock`(블로킹형) 호출 0회(정적 검사: 소스에 `pg_advisory_lock(` 문자열 없음, `pg_try_advisory_lock(`·`pg_advisory_unlock(`만 존재); `release()`의 query 순서가 `begin` → `update released_at` → `insert audit_events(LEADER_RELEASED)` → `commit` → `pg_advisory_unlock` → 연결 종료; `LeaseRegistry`가 감사 행을 직접 쓰지 않음(`audit_events` insert 호출 지점이 `LeaseAuditPort` 구현 하나뿐임을 정적 검사).
- A12. §7.5의 upgrade 브리지 테스트 U1~U10(U1b·U1c·U8b·U9b·U9c·U9d 포함)과 §7.6 H1~H3 통과; 프로덕션 `main.ts` 경로로 기동한 런타임 통합 테스트에서 `ws` 클라이언트가 쿠키 인증 + `?afterSequence=<n>` 쿼리로 101을 받고 outbox 이벤트를 수신하며(A6과 같은 픽스처), 접속 후 텍스트 프레임을 보내면 1003으로 닫힘.
- A13. 웹 테스트 W1~W3(§7.5) 통과; `use-portfolio-stream.ts` diff가 `streamUrl` 시그니처·`connect()`의 URL 인자·`onopen`의 `send` 제거 외 변경을 포함하지 않음(리뷰 항목); e2e 18/18은 e2e `start-system.ts`가 브리지 + `StreamHeartbeatLoop`로 전환된 뒤 통과(A9와 동일 게이트).

Codex 검증 항목: 상태 전이 순서 spy 테스트를 독립 재실행; §6.6 순서 위반 여지 코드 리뷰; upgrade 브리지가 Fastify 훅에 의존하지 않고 모든 검사를 직접 수행하는지·거부 경로가 socket을 반드시 destroy하는지·`handleUpgrade` 직전에 `closing`/`socket.destroyed`를 재검사하는지·`closeAll`이 상한 안에 `terminate`로 수렴하는지 코드 리뷰; 웹 훅이 open 뒤 프레임을 전혀 보내지 않고 서버가 모든 인바운드 프레임을 1003으로 닫는 양쪽 정합 확인; heartbeat 타이머가 프로세스에 정확히 하나이고 `ready.heartbeatIntervalMs`와 같은 상수를 쓰는지 확인; `acquire`/`release`가 감사를 lease 연결의 같은 트랜잭션에서 커밋하고 unlock이 `finally`에 있는지, `LeaseRegistry`에 두 번째 감사 경로가 없는지 확인; `LeaderLease.acquire`가 `pg_try_advisory_lock` 폴링(250 ms 고정)만 쓰고 `true` 직후 abort 재검사 → 즉시 unlock 경로가 있으며 그 경로에서 `begin`·upsert·감사·provider 호출이 없는지 코드 리뷰; `LeaseRegistry.acquireAll`이 KR→US 순차이고 시장별 공개 `acquire`가 없으며 부분 획득이 역순 해제되는지, 세대 promise가 공유·재사용되지 않는지 확인; lease 손실 콜백이 시장 로컬 재획득이 아니라 `reelect`로 가고 재선출이 `pauseScheduling`(동기)·in-flight poll 대기·두 시장 소켓·`abortPending`·`releaseAll`을 lease 재획득 앞에 두고 `shutdownDrain`을 호출하지 않는지 확인; `RequestAdmissionGate.onRequest`가 콜백형 동기(`done` 매개변수)이고 닫힘 검사와 증가 사이에 `await`·`done()`이 없는지, 감소가 `onResponse`·`onError`·`onRequestAbort` 세 훅 모두에서 같은 `settle`로 플래그 소비 1회인지, `/health/*`·`/metrics`만 제외되는지, `close`가 admission latch 앞인지 확인; `OutboxPublisherLoop.start`의 호출 지점이 `RuntimeStateMachine.enterServing` 동기 구간 **하나뿐**이고(`RECOVERING` 진입 경로에 없음), `pauseScheduling`의 호출 지점이 `leaveServing` 동기 구간 하나뿐이며 그 안에 `await`가 없는지, `shutdownDrain`의 호출 지점이 `ShutdownCoordinator` 4b단계 하나뿐이고 `leftFrom === 'SERVING'` 가드와 `await pendingPoll` 뒤에 있는지, `shutdownDrain` 본문에 `setTimeout`·`running` 대입이 없는지, `pollOnce`가 `claimPendingOutbox`를 첫 `await` 앞에서 호출하고 `outbox_claims_total{mode}`를 같은 동기 구간에서 올리는지, tick 콜백이 첫 `await` 앞에서 `running`을 검사하는지, 루프 소스에 `setInterval`·`stop(`·`drain(` 이름이 없는지, `start` 본문이 대입과 `setTimeout` 하나뿐이고 `throw`·`try`·의존성 호출이 없는지 호출 지점·정적 전수 확인; `StreamGate.isOpen`이 상태 기계에서 파생되고 별도 플래그가 없는지 확인; `StreamHub`의 `registerOpening`이 `source.latest`/`replay` 앞이고 `promoteToLive`가 라운드 반복 뒤 빈 큐 관측 동기 구간에서만 `LIVE`로 바꾸며(“`LIVE` 뒤 flush” 없음) `StreamSession.open`의 반환 메타데이터만으로 dedupe하는지, 모든 실패·gap·overflow·close 경로가 항목을 제거하는지, `markOutboxPublished`가 `deliver` 해결 뒤인지 확인; `LeaderLease`의 손실 판정이 `HELD`에서만 1회이고 `release`·abort·rollback 경로가 `onLost`를 올리지 않으며 `LeaseRegistry`가 세대당 1회만 `reelect`하는지, 부분 획득 중 손실이 재선출이 아니라 세대 abort로 가는지 확인; A15(변형 1)·A16에서 provider spy 0회 단언이 실제 `tokenProvider`·`connect`·REST 경로 전부를 덮고, A15 변형 2·A4b에서는 “abort 뒤 증가 0”으로 단언이 바뀌어 있는지 확인; `cancelOnly` 불리언·스텁 엔진 삭제 확인; `main.ts`가 조립 이외 로직을 갖지 않음; 새 코드 mutation 테스트(기존 리뷰 관례).

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

수용 기준: §10.2의 1~11 전부(3b 전제조건 포함). 추가로:

- C1. 드릴 3회 연속 통과(플래키 방지), 각 실행 `peakConcurrentConnections===2`, `evictions===0`, 10단계에서 “두 프로세스가 각 한 시장만 보유”인 관측 0회, 11단계 종료 ≤ 3 s.
- C2. 드릴 산출 JSON(§10.3)이 생성되고 체크리스트가 그 요약을 인용.
- C3. 릴리스 체크리스트의 미완 항목을 `[x]`로 바꾸는 커밋은 C의 마지막 커밋이며, Codex 검증 통과 후에만 작성.

Codex 검증 항목: 드릴을 독립 실행해 동일 결과; 단계 3에서 P2의 REST 기록 0건·outbox claim 0건·WS upgrade 503과 단계 6의 토큰 타임스탬프 순서 재확인; 단계 4에서 P1 비즈니스 요청 503과 `UnitOfWork` 미시작, 취소가 P2에서 200인지 재확인; 단계 4~6·8의 C 단언이 “P1 exit 시 정확히 1건”이나 “P2 소켓에서만 도달”을 요구하지 않고 하네스 클라이언트의 `eventId` dedupe 후 exactly-once + P1 exit 시 pending 0/1 + P2 `SERVING` 뒤 pending 0 수렴만 요구하는지, 그리고 3회 반복에서 경로 (i)·(ii)가 섞여 나와도 통과하는지 확인; 단계 6에서 P2 `RECOVERING` 구간의 `outbox.poll` 0건과 첫 `outbox.poll`이 `runtime.state {to:'SERVING'}` 뒤인지 재확인; 단계 10에서 부분 lease 상태 관측 0회와 epoch 단언이 “이전보다 큼”만인지, 단계 11에서 P3 provider 호출 증가 0인지 재확인; 단계 5·8의 해제 증명이 현재 `leader_epochs` 행에 의존하지 않음(감사·로그 기반)과 `LEADER_RELEASED`→`LEADER_ACQUIRED` 순서가 §5.4의 lock 아래 커밋에서 나오는지(3회 반복에서 시장별 순서 역전 0건) 확인; 하네스가 프로덕션 진입점(`dist/main.js`)을 쓰는지 확인(테스트 전용 진입점 금지).

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
| `shutdown_drain_seconds` | gauge | `phase` = `http\|inflight\|outbox\|sockets\|leases` |
| `shutdown_forced_total` | counter | 없음 |
| `leader_reelection_total` | counter | `market`(잃은 시장) |
| `leader_lease_poll_total` | counter | `market` (`pg_try_advisory_lock` 호출 수; 대기 중이면 4/s로 증가) |
| `http_admission_rejected_total` | counter | 없음 (`RequestAdmissionGate` 503 수) |
| `http_admission_inflight` | gauge | 없음 |
| `http_admission_drain_remaining` | gauge | 없음 |
| `stream_upgrade_rejected_total` | counter | `reason` = `not_ready\|closing\|auth\|rate_limited\|bad_request\|forbidden` |
| `stream_replay_queue_depth` | gauge | 없음 (`OPENING` 항목 큐 길이 합, heartbeat마다 갱신) |
| `stream_replay_overflow_total` | counter | 없음 |
| `outbox_claims_total` | counter | `mode` = `periodic\|shutdown_drain` (`claimPendingOutbox` 호출 수; `pollOnce`가 첫 `await` 앞에서 올린다. `periodic`은 `SERVING`에서만 증가해야 하고 — `pauseScheduling`이 상태 전이와 같은 동기 스택이라 `SERVING` 밖 증가는 0이어야 한다 — `shutdown_drain`은 `SERVING`에서 내려온 `DRAINING`의 §6.6-4b 구간에서만 증가한다) |
| `outbox_shutdown_drain_rounds` | gauge | 없음 (마지막 `shutdownDrain`의 `pollOnce` 반복 수; 종료 직전 값) |
| `lease_lost_total` | counter | `market`, `phase` = `SERVING\|RECOVERING\|ACQUIRING` (`HELD` lease의 비의도적 손실만; 의도적 release는 세지 않음) |

### 12.3 알림 추가 (`infra/monitoring/prometheus-alerts.yaml`)

- `ProviderConnectionsAboveLimit`: `provider_connections_open > 2` for 0m → 즉시, 런북 `redis-or-leader-loss.md`.
- `LeaderLeaseWaitLong`: `leader_lease_wait_seconds > 60` → 런북 `redis-or-leader-loss.md` (“이전 프로세스가 종료되지 않음” 절 추가).
- `ProviderAuthFailed`: `increase(provider_token_refresh_total{result="auth_failed"}[10m]) > 0` → 런북 `market-data-degraded.md`.
- `ShutdownForced`: `increase(shutdown_forced_total[1h]) > 0` → 런북 `postgres-or-outbox-lag.md`.
- `LeaderReelection`: `increase(leader_reelection_total[10m]) > 0` → 런북 `redis-or-leader-loss.md`(“한 시장 lease 손실은 전역 재선출” 절 추가: 두 시장이 함께 `CANCEL_ONLY`가 되는 것이 정상이며, `runtime_state{state="RE_ELECTING"}`이 60 s 이상 1이면 `pg_locks`에서 다른 프로세스의 lock 잔존 확인).
- `LeaderBundleSplit`: `count(leader_lease_held == 1) by (instance)`가 두 인스턴스에서 동시에 1인 상태 2m → 즉시, 런북 `redis-or-leader-loss.md`(설계상 발생 불가 — 발생하면 §5.4 순차 규칙 위반이므로 두 프로세스 중 늦게 시작한 쪽을 재시작).
- `HttpAdmissionRejectedOutsideDrain`: `increase(http_admission_rejected_total[5m]) > 0 and runtime_state{state="DRAINING"} == 0` → 런북 `postgres-or-outbox-lag.md`(게이트가 `DRAINING` 밖에서 닫혀 있으면 버그).
- `OutboxClaimsOutsideServing`: `increase(outbox_claims_total{mode="periodic"}[2m]) > 0 unless runtime_state{state="SERVING"} == 1` for 1m → 즉시, 런북 `redis-or-leader-loss.md`(단일 발행자 규칙 위반: **주기 스케줄링**은 번들 소유자가 `SERVING`일 때만 돈다. `mode="periodic"`만 보므로 §6.6-4b의 의도된 shutdown drain은 이 알림을 울리지 않는다. `min(leader_lease_held) == 0`인데 periodic claim이 있으면 같은 알림이 잡는다 — `SERVING`은 두 lease 보유를 함의한다).
- `OutboxShutdownDrainOutsideDraining`: `increase(outbox_claims_total{mode="shutdown_drain"}[2m]) > 0 unless runtime_state{state="DRAINING"} == 1` for 1m → 즉시, 런북 `redis-or-leader-loss.md`(`shutdownDrain`이 §6.6-4b 밖에서 호출됨 — 버그. 프로세스가 `DRAINING` 뒤 곧 종료해 스크랩이 놓칠 수 있으므로 best-effort이며, 정확한 분리 증거는 드릴 §10.2-5의 로그 순서다).
- `StreamReplayOverflow`: `increase(stream_replay_overflow_total[10m]) > 5` → 런북 `postgres-or-outbox-lag.md`(replay가 200건 이상 느린 것은 outbox 지연 또는 DB 지연 신호).

### 12.4 로그 이벤트

구조화 로그 키 `event`: `runtime.state`, `lease.waiting`(폴링 시작 시 1회 + 매 10 s, `{market, waitedMs, polls}`), `lease.acquired`, `lease.acquire_aborted`(`{market, lockedThenUnlocked: boolean}` — abort/lock 경합에서 `true`), `lease.partial_released`, `lease.released`(`auditPersisted` 포함), `lease.release_mark_failed`, `lease.lost`, `runtime.reelect`(`{lostMarket, survivingMarket}`), `http.admission_rejected`(`{requestId, path}`), `provider.connect`, `provider.close`, `provider.token.refresh`, `recovery.start`, `recovery.complete`, `outbox.poll`(`{mode:'periodic'|'shutdown_drain', claimed, published, failed}` — `mode:'periodic'`은 `SERVING`에서 claim된 poll에만 존재하며(`leaveServing` 뒤 포착된 꼬리 1건까지 허용), `mode:'shutdown_drain'`은 `SERVING`→`DRAINING` 4b 구간에만 존재; `RECOVERING`·`ACQUIRING_LEASES`·`RE_ELECTING`에서는 어느 `mode`도 0건), `outbox.drain`(`{skipped, leftFrom?, rounds?, claimed?, remaining?, deadlineHit?}` — 4단계 종료 시 정확히 1건), `stream.upgrade_rejected`(`{reason}`; `not_ready` 포함), `stream.upgrade_failed`, `stream.inbound_rejected`, `stream.replay_overflow`, `shutdown.phase`. 공통 필드 `leaderId`, `market`, `epoch`, `requestId`(해당 시). 비밀 필드 없음.

## 13. 마이그레이션과 롤백

- 스키마: `003_leader_release.sql` — `alter table leader_epochs add column released_at timestamptz;` 단 하나. nullable additive이며 이전 이미지(97921b7)는 이 컬럼을 읽지도 쓰지도 않으므로 호환된다. 새 이미지의 `acquire`는 upsert에서 `released_at = null`을 쓰고 `release`는 unlock 전에 `now()`와 `LEADER_RELEASED` 감사를 같은 트랜잭션으로 쓴다(§5.4). `audit_events` 스키마 변경은 없다(`LEADER_ACQUIRED`/`LEADER_RELEASED`는 `event_type` 값일 뿐이다). 이전 이미지가 획득한 행은 `released_at`이 null인 채 남지만, 새 이미지의 다음 `acquire`가 어차피 null로 덮어쓰므로 데이터 정리가 필요 없다. 기존 규칙대로 배포 전에 one-off job으로 실행한다.
- 설정: `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`을 secret store에 추가한 뒤 배포한다. `MARKET_DATA_ADAPTER=toss`는 compose 리터럴이므로 운영자가 따로 넣을 값이 없고, 빠뜨릴 수도 없다. 비밀 누락 시 새 이미지는 §8.1에 따라 EXIT 1이며 readiness가 켜지지 않으므로 이전 프로세스를 먼저 종료하지 않았다면 영향이 없다(stop-then-start이므로 실제로는 이전 프로세스가 이미 종료된 상태 → 취소만 가능한 공백이 생기며, 이는 배포 전 `docker compose config`/secret 존재 검증으로 예방).
- 배포 절차: 배포 가이드의 stop-then-start를 따르되 **전제조건 한 줄을 추가**한다: “새 프로세스(P2)가 `/health/ready` 200이고 `/api/v1/health/trading`의 `reasons`에 `ACQUIRING_LEASES`가 보이기 전에는 이전 프로세스(P1)에 `SIGTERM`을 보내지 않는다.” P1은 `DRAINING` 2단계에서 HTTP 인그레스를 닫아 신규 비즈니스 요청(취소 포함)을 503으로 거부하므로(§6.6), 그 사이 취소를 받는 프로세스는 P2다(§6.3, §10.1). P2가 `ACQUIRING_LEASES`에 있는 동안 provider 호출·outbox claim·사용자 WS는 0이므로 P2를 먼저 띄우는 것은 “세 번째 연결 금지”와 충돌하지 않는다. 이 문서가 그 절차를 처음으로 코드로 보증한다.
- P1 `SIGTERM` 뒤 P2가 `SERVING`이 되기까지의 공백(P1 drain ≤ `SHUTDOWN_DRAIN_DEADLINE_MS` + P2 폴링 ≤ 250 ms + recovery)에는 사용자 WS가 어느 프로세스에도 붙지 못하고(503 → 훅 backoff 재접속) outbox 이벤트는 `published_at is null`로 쌓인다(P2가 `RECOVERING`인 동안도 포함 — 발행기는 `SERVING`에서만 돈다). P2 `SERVING` 진입 직후 첫 poll이 발행하고 재접속 replay가 따라잡는다. 이 공백은 `OutboxLagHigh` 임계(30 s) 안이어야 하며, 드릴 §10.2-6이 15 s 안을 단언한다.
- 롤백: 이전 이미지로 같은 stop-then-start. 이전 이미지는 provider를 조립하지 않으므로 `CANCEL_ONLY`로 시작한다(fail-closed, 알려진 동작). 이전 이미지는 `MARKET_DATA_ADAPTER`를 `'fake'`인지만 비교하므로 compose의 `toss` 리터럴과 `TOSS_CLIENT_*`는 무시된다. `released_at` 컬럼도 무시된다. Redis 데이터는 rate-limit뿐이므로 롤백에 영향이 없다.
- 롤백 트리거는 배포 가이드 기존 규칙 + “새 프로세스가 `ACQUIRING_LEASES`에서 60 s 이상 머무르고 이전 프로세스가 이미 종료됨”(lock 잔존 의심 → `pg_locks` 확인 후 `pg_terminate_backend`; 새 프로세스는 다음 250 ms 폴링에서 획득한다) + “`RE_ELECTING`이 60 s 이상 지속”(`LeaderReelection` 알림) + “`DRAINING`이 아닌데 `http_admission_rejected_total`이 증가”(`HttpAdmissionRejectedOutsideDrain`). 새 프로세스를 롤백하려면 `SIGTERM` 한 번으로 충분하다 — lease 대기 중이어도 §6.6대로 ≤ 2 s 안에 종료 코드 0으로 끝나며 provider 호출을 남기지 않는다(`SIGKILL` 불필요).

## 14. 미해결 없음 — 결정 사항 요약

- Redis는 lease·fan-out에 쓰지 않는다. 런북·라벨의 드리프트는 A가 고친다.
- 시장당 WS 1개, 프로세스당 2개, 계정 한도 2개. 인계는 stop-then-start만.
- 새 프로세스는 lease를 논리적으로 무기한 대기하며 그동안 `CANCEL_ONLY`로 서비스한다. 대기는 `pg_try_advisory_lock` 250 ms 폴링 + `AbortSignal`이며 `pg_advisory_lock` 블로킹은 쓰지 않는다. `SIGTERM`은 대기 중(`ACQUIRING_LEASES`·`RE_ELECTING` 폴링, 부분 번들)에도 ≤ 2 s 안에 종료 코드 0으로 끝나고 provider 호출 **총 0건**을 남긴다. `RECOVERING` 중 `SIGTERM`은 진행 중 recovery를 abort하고 **abort 뒤 새 provider 호출 0건**으로 끝난다(총 0건은 아니다). 토큰 발급은 KR+US 번들 획득 뒤다.
- lease는 KR→US 순차 번들(`LeaseRegistry.acquireAll`)로만 획득한다. 시장별 공개 획득 API는 없다. 부분 획득은 abort/실패 시 역순 해제한다. `pg_try_advisory_lock` 성공 직후 abort면 즉시 unlock하고 upsert·감사·provider 호출을 하지 않는다.
- lease 손실 판정: `LeaderLease`는 `ACQUIRING/HELD/RELEASING/RELEASED/LOST` 상태를 가지며 `error`/`end`는 `HELD`에서만, 세대당 1회만 `onLost`로 승격된다. `release()`·abort·rollback·부분 역순 해제는 의도적 종료라 재선출을 부르지 않는다. `SERVING`·`RECOVERING`에서의 손실은 같은 전역 재선출이고(`RECOVERING`이면 진행 중 recovery abort), 부분 획득 중(`ACQUIRING_LEASES`) 손실은 재선출이 아니라 세대 abort + 새 세대다.
- 어느 한 시장의 `HELD` lease 손실은 전역 재선출(`RE_ELECTING`)이다: `leaveServing` 동기 구간(스트림 게이트·admission·matching 닫기 + `pauseScheduling`) → 포착된 in-flight poll 대기(shutdown drain 없음) → 두 시장 provider 루프·소켓 abort/종료 → 진행 중 획득 세대 abort → 살아 있는 lease 해제 → 번들 재획득 → 두 시장 복구. 시장 로컬 lease 재획득은 없다. provider 전송 장애는 시장 로컬로 남는다. 실패 경로의 epoch 간격은 1을 넘을 수 있고 불변식은 “이전보다 큼”이다.
- 두 lease를 모두 쥐고 `SERVING`인 프로세스 하나만 사용자 WS upgrade를 받고 `OutboxPublisherLoop`를 돌린다. 그 외 상태의 upgrade는 503 `NOT_READY` + `Retry-After`. 취소 HTTP는 `ACQUIRING_LEASES`에서도 가능하다. **발행기는 번들 소유자가 `SERVING`일 때만 돈다** — `RECOVERING`에서는 시작하지 않고, `RuntimeStateMachine.enterServing()`의 `await` 없는 동기 순서(상태 전이 → latch 열기 → `publisher.start()`; 게이트는 상태에서 파생) 안에서만 시작한다. `start()`는 총함수·비throw·동기라 반쯤 열린 `SERVING`이 없다(A17). `SERVING`을 떠나는 것도 두 연산으로 나뉜다: `leaveServing(to)` 동기 구간의 **`pauseScheduling()`**(타이머 제거·`running=false`·새 periodic claim 차단, in-flight poll 최대 하나 포착 — 재선출·종료 공통, `isRunning() ⇔ SERVING`이 모든 시각에 성립)과 종료 전용 **`shutdownDrain(deadline)`**(§6.6-4b, `SERVING`에서 내려온 `DRAINING`만, lease를 쥔 채, 타이머 없는 유계 one-shot). 재선출에는 shutdown drain이 없다. 두 연산은 `outbox_claims_total{mode}`·`outbox.poll{mode}`로 구분되고, `OutboxClaimsOutsideServing`은 `mode="periodic"`만 본다.
- `StreamHub`는 세션을 durable `latest`/`replay` 읽기 **앞에** `OPENING`으로 등록하고, replay 중 도착한 live 이벤트를 상한 200의 큐에 받는다. `StreamSession.open`은 `{session, replayedUpTo, replayedEventIds}`를 반환하고 `promoteToLive`는 그 메타데이터로 “스냅샷→비움→정렬→dedupe→순차 전달” 라운드를 반복하다가 **큐가 비어 있음을 관측한 동기 구간에서만** `OPENING→LIVE`로 바꾼다(`LIVE` 뒤 flush 금지 — 새 `LIVE` 전달이 옛 큐를 추월한다). 발행기는 `OPENING` 큐 수락 뒤에만 `published`를 찍는다. 실패·gap·overflow·close는 모두 항목을 제거하고, overflow는 `resync-required` 후 4010으로 닫는다.
- 종료는 HTTP 인그레스를 먼저 울타리로 막는다: `leaveServing('DRAINING')` 동기 구간(상태·게이트 파생 닫힘·latch·`pauseScheduling`)/readiness 503 → `RequestAdmissionGate` 닫기(콜백형 동기 `onRequest(request, reply, done)`에서 닫힘 검사와 in-flight 증가가 동기 원자, `/health/*`·`/metrics` 제외; 감소는 `onResponse`·`onError`·`onRequestAbort` 중 먼저 오는 하나가 플래그를 소비해 정확히 1회) → 허용된 요청 drain → `UnitOfWork` drain → 포착된 in-flight poll 대기 → `shutdownDrain`(`SERVING`에서 온 경우만) → 소켓 → lease. 닫힌 뒤 요청은 503이고 `UnitOfWork`를 시작할 수 없다. 인계 중 취소 가용성은 이미 준비된 P2가 제공하며, 배포 전제조건은 “P2가 `ACQUIRING_LEASES`로 준비될 때까지 P1에 `SIGTERM`을 보내지 않는다”이다.
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
- 동시성 점검(Codex 3차 리뷰 반영, 네 블로커): (1) **취소 가능한 번들 획득** — §3.6·§5.4(폴링 루프, abort 재검사, 부분 역순 해제, 테스트 7~10)·§6.1(`ACQUIRING_LEASES`에서 `SIGTERM`)·§6.6-6(`abortPending`)·A11·A15·§10.2-11·§13(롤백은 `SIGTERM` 한 번)·§14가 같은 절차를 말하고, 세션 블로킹 lock 함수와 두 시장 동시 획득은 §5.4·A11의 금지문 외에 어디에도 남지 않았다. (2) **부분 lease 교착 방지** — §3.11·§5.4(순차 KR→US, 공개 `acquire(market)` 없음)·§6.1(`RE_ELECTING`)·§6.5(7단계 전역 재선출, P1-US/KR-lost + P2 동시 시나리오, epoch 간격 > 1 허용)·§7.2(`held(market)`)·§8.1·§8.3(프로세스 단위 supervisor)·A4·A10·A16·§10.2-10·§12.3(`LeaderBundleSplit`)이 일치하며, “시장 로컬 재획득”은 §3.11과 §6.5의 부정문으로만 등장한다. (3) **단일 소유자와 replay→live** — §3.12·§6.1(`SERVING`만 게이트 열림; 발행기 시작 시점은 4차 리뷰에서 `SERVING` 진입으로 확정 — 아래 “동시성 점검 2” (1))·§6.3(503 `NOT_READY`, claim 0건)·§6.5-1·2·§7.4(`published_at` 의미, `deliver` 세 경로)·§7.5(0b·9단계 게이트, `onOpen` 2~5단계, `StreamHub` 상태 규칙, U11~U13)·A17·A18·§10.2-3·4·6·§12.2·§12.3(`OutboxClaimsOutsideServing`)이 같은 규칙을 말한다. (4) **HTTP 인그레스 울타리** — §3.13·§4.1·§6.6(1단계 `leaveServing` 동기 구간에서 게이트·latch, 2단계 `RequestAdmissionGate.close` — 5차 리뷰에서 재배치, 3단계 두 카운터, `RequestAdmissionGate` 규격과 G1~G6)·§8.1·A5·A14·§10.1 전제조건·§10.2-3b·4·§12.2·§12.3(`HttpAdmissionRejectedOutsideDrain`)·§13이 일치하며, “드레인 중 P1이 취소를 받는다”는 문장은 남지 않았다(취소는 P2).
- 동시성 점검 2(Codex 4차 리뷰 반영, 여섯 블로커): (1) **발행기는 `SERVING`에서만** — §4.1(`RuntimeStateMachine`·`OutboxPublisherLoop` 행)·§6.1(도표의 `RECOVERING` 주석, `RECOVERING` 불릿, `enterServing`/`leaveServing` 동기 순서, 게이트는 상태에서 파생)·§6.3(`RECOVERING` 포함)·§7.4(도표·단일 소유자·인계 중)·§10.2-6·8(P2 `RECOVERING` 구간 claim 0, 첫 `outbox.poll` > `SERVING`)·A4·A15 변형 2·A17(같은 동기 스택 spy)·§11.1 Codex 항목·§12.2·§12.3(`OutboxClaimsOutsideServing`)·§12.4·§13·§14가 같은 문장을 말하고, “번들 획득 직후 시작”·“`RECOVERING(all)` 진입 시 `start()`” 문구는 남지 않았다. (2) **`onRequestAbort`** — §4.1·§6.6 규격(콜백형 `done`, 세 훅 + `settle` 플래그 소비)·G4·G5·G5b·G6·G7·A14·Codex 항목·§14가 일치하고, “클라이언트가 끊어도 `onResponse`가 호출된다”는 틀린 문장은 삭제했다. (3) **replay 장벽 API** — §4.1(`StreamHub` 행)·§7.5 `onOpen` 3단계(`StreamOpenResult`)·5단계(라운드 알고리즘, 빈 큐 관측 동기 전환, `LIVE` 뒤 flush 금지, `STREAM_PROMOTE_MAX_ROUNDS`)·`StreamHub` 규칙(`promoteToLive: Promise<boolean>`, `stateOf`/`queueDepth`)·U11(flush 중 도착 → total order)·U11b·U11c·U11d·A18·Codex 항목·§14가 하나의 설계이며 “CAS `OPENING→LIVE` 뒤 큐를 한 번 더 비운다”는 문구는 남지 않았다. (4) **드릴 종료 경합** — §7.4(P1이 P2가 만든 행을 claim할 수 있음)·§10.2-4(경로 i/ii)·5(pending 0 또는 1)·6(하네스 클라이언트 `eventId` dedupe 후 exactly-once, P2 `SERVING` 뒤 pending 0 수렴)·8(발행자 공백)·§11.3 Codex 항목이 일치하고 “정확히 1건”·“그 소켓에 1회 도달” 문구는 남지 않았다. (5) **`RECOVERING` 중 `SIGTERM`** — §6.1 도표(두 경로 분리)·§6.6(“총 0건”은 대기 구간에만, `RECOVERING`은 “abort 뒤 새 호출 0건”)·A15 변형 2·A4b·Codex 항목·§14가 일치한다. (6) **손실 판정** — §4.1(`LeaseRegistry` 행)·§5.4(“손실 판정”: 상태, `#reportLost` 1회 latch, 의도적 경로 (a)~(d), 세대당 1회 승격)·테스트 11~13·§6.1(`ACQUIRING_LEASES` 불릿, 도표)·§6.5(도입부, 6단계 `RELEASING`, “부분 획득 중 손실” 문단)·A4(`reelect` 1회)·A11·A16b·Codex 항목·§12.2(`lease_lost_total`)·§14가 일치한다.
- 동시성 점검 3(Codex 5차 리뷰 반영, 한 블로커 — **발행기 정지의 두 연산 분리**): 이전 판은 “발행기는 `SERVING`에서만”이라 쓰면서 `leaveServing`이 in-flight `pollOnce`를 허용하고, 종료 표는 4단계에서야 `stop()`하며, §7.4는 `DRAINING`을 “4단계 이후” claim 0으로 서술하고, `OutboxClaimsOutsideServing`은 의도된 종료 drain에도 울렸다. 이제 §4.1(`OutboxPublisherLoop` 행)·§3.12·§6.1(`enterServing`의 총함수 `start()`, `leaveServing` (3) `pauseScheduling` — 상태 전이와 같은 동기 스택, in-flight 최대 하나 포착, `isRunning() ⇔ SERVING`, `RE_ELECTING` 불릿)·§6.5(도입부, 1단계 `pauseScheduling`, 2단계 `await pendingPoll`, shutdown drain 없음)·§6.6(1단계 = `leaveServing('DRAINING')` 동기, 2단계 게이트만, 4a `await pendingPoll`, 4b `shutdownDrain` — `leftFrom === 'SERVING'` 가드·전제조건·타이머 없음·one-shot, 대기 중·`RECOVERING` 중 종료 문단의 skipped)·§7.4(도표의 두 가지, 단일 소유자 문단의 두 연산과 “`stop()`·`drain()` 없음”, 인계 중 문단)·§10.2-4·5(경로 (i) `mode`, 로그 순서 분리 증거, 메트릭은 기록만)·A4(`pauseScheduling` 같은 동기 스택, `shutdownDrain` 0회)·A5(spy 순서, `Deferred` 분리, fake timers, A5b)·A17(역방향 `isOpen() === false ⇒ isRunning() === false`, `start()` 정적·동적 총함수 단언)·A18(`pauseScheduling` 동기 반환·포착·멱등, `shutdownDrain` 전제조건)·§11.1 Codex 항목(호출 지점·정적 전수)·§12.2(`outbox_claims_total{mode}`, `outbox_shutdown_drain_rounds`)·§12.3(`OutboxClaimsOutsideServing`은 `mode="periodic"`만, 새 `OutboxShutdownDrainOutsideDraining`)·§12.4(`outbox.poll{mode}`, `outbox.drain` 필드)·§14 두 불릿이 같은 두 연산을 말한다. “`stop()`”·“`drain()`”·“4단계 이후 claim 0” 문구는 `StreamHeartbeatLoop.stop()`(§6.6-5, 다른 컴포넌트)을 제외하고 남지 않았다. `enterServing`은 fail-closed 분기를 두지 않는 대신 `start()`가 던질 수 없음을 A17이 정적·동적으로 단언한다 — 던질 수 있는 연산이 없으니 되돌릴 상태도 없다.
- 보존 확인: 자동 provider 테스트는 여전히 fake 번들·loopback 가짜 서버만 쓴다(§9.5, A16·A16b·A4b·A15 변형 2의 provider spy도 인메모리 fake 번들). `ws`/`@types/ws` 8.18.1 유지(§5.7). production `MARKET_DATA_ADAPTER` 명시 규칙 유지(§5.1). 이전 리뷰의 스트림(쿼리 전용 프로토콜, heartbeat 단일 타이머, closeAll 상한)·lease 감사(같은 트랜잭션, unlock 전 커밋, `finally` unlock) 수정은 그대로이며, 새 규칙은 그 위에 추가되었다(예: `acquire`의 lock 획득 단계만 `pg_try_advisory_lock` 폴링으로 바뀌고 트랜잭션 순서는 동일).
- 잔여 위험(허용): lease 손실 감지 지연 중 일시적 3번째 연결(§6.5), deadline 초과 시 outbox 잔여 행의 at-least-once 재발행(§6.6-4), 인계 공백 동안 사용자 WS 503과 outbox 지연(§13, 15 s 안, `OutboxLagHigh` 30 s 임계 아래), 폴링 250 ms로 인한 인계 지연 최대 한 주기.

## 16. 구현 편차 기록 (Task 10 A/B/C 구현 결과, 2026-08-28)

이 절은 §7의 “문서가 계약”이라는 원칙에 따라, 구현 중 이 문서의 문장과 코드가 갈라진 지점을 문서 쪽에서 확정한다. 각 항목은 해당 테스트로 고정되어 있다.

| # | 원문 | 확정 | 근거·테스트 |
|---|---|---|---|
| 16.1 | A2 “epoch +1” | provider 전송 재연결은 lease epoch를 바꾸지 않는다(§5.4 `held()` 멱등, A10). A2는 `NORMAL` 복귀와 `feed_reconnect_total{market}` 증가만 단언한다. | `production-runtime.integration.test.ts` A2 |
| 16.2 | `MarketHealthMachine.degrade`는 `HEALTHY`에서만 `DEGRADED` | §6.2 도표대로 `RECOVERING → DEGRADED`도 전이한다(복구 실패 = MANUAL HOLD 진입 조건). | `market-runtime.test.ts` A3 |
| 16.3 | `IncidentService.resolveCas`의 `recoveryEpoch` 완전일치 | health machine은 null epoch로 활성화하고 새 epoch로 해제하므로 런타임 어댑터가 **저장된 epoch**로 CAS를 호출한다(version CAS는 유지). DB 리포지토리는 `recovery_epoch = 0 ↔ null`을 매핑한다. | `production-runtime.ts` health adapter, `incident-db-repository.ts` |
| 16.4 | 복구 실패마다 MARKET incident | health machine은 degrade당 incident 1건을 유지하고 재시도 실패는 `recovery.failed` 로그로 남긴다. | `market-runtime.test.ts` |
| 16.5 | §6.5-7 재선출 재획득 “첫 시도 즉시” | lease를 잃은 프로세스는 재획득 전에 `REELECTION_YIELD_MS = 1000`을 양보한다. 그렇지 않으면 11 ms 해제가 250 ms 폴링 중인 후속자보다 먼저 KR을 다시 잡아 §10.2-10이 성립하지 않는다. | `leader-handoff.drill` 10단계, A16 |
| 16.6 | 재선출 중 trading `reasons: ['CANCEL_ONLY','RE_ELECTING']` | 두 시장을 내린 뒤 폴링 구간은 §6.1 도표대로 `ACQUIRING_LEASES`이며 reasons도 그 상태를 보인다. `RE_ELECTING`은 해제 구간에만 보인다. | 드릴 10단계는 둘 중 하나를 허용 |
| 16.7 | `StartupCoordinator.acquireLease(market)` | `acquireLeases(signal)`(번들)로 교체. `AbortError`는 수동 incident를 만들지 않는다. | `startup-coordinator.integration.test.ts` |
| 16.8 | 가짜 서버 위치 `packages/market-data/testing/` | `packages/market-data/src/testing/fake-toss/`. 패키지의 `--dir src` 테스트·typecheck 게이트에 포함하기 위함. 공개 경로는 `@skipjack/market-data/testing`. | B1~B4 |
| 16.9 | conformance “timestamp 없는 trade → null 유지” | Toss 계약은 trade `timestamp`를 필수로 한다. `runMarketDataConformance(factory, { nullableTradeTimestamp: false })`이면 하네스가 timestamp를 공급하고, 케이스는 “어댑터가 null을 만들어내지 않음”을 단언한다(스킵 아님). | `toss-websocket.conformance.test.ts` |
| 16.10 | `TokenProvider` 포트 | `invalidate?(): void` 추가(REST·WS의 401 → 1회 재발급 경로). `MarketDataError`에 `statusCode`/`retryAfterMs`, 코드 `AUTH_FAILED`/`AUTH_THROTTLED`/`RATE_LIMITED` 추가. | B5, B6 |
| 16.11 | 추가 seam | `StreamHub.sendControl(sessionId, frame)`(e2e resync 주입), `AppDependencies.registerIngress`(gate `onRequest`를 첫 훅으로), toss 번들 기본 심볼 `TOSS_SYMBOLS`(US=화이트리스트 17, KR=['005930'], `symbols`로 재정의 가능). | A7/A12, B4 |
| 16.14 | §10.2-10 (e) 부분 lease 상태 “0회 관측” | “연속 500 ms 이상 지속 0회”. KR lock은 backend 사망 즉시 풀리므로 후속자가 KR을 잡는 순간과 패자의 US 해제 커밋 사이 수 ms 창은 제거할 수 없다; 불변식은 교착 부재(§3.11)다. | 드릴 10단계 |
| 16.13 | §6.5 4~6단계 순서(incident 기록 → abortPending → releaseAll) | Codex 검증 Finding: 전체 모노레포 병렬 테스트 부하에서 후속자가 KR을 획득한 뒤 재선출 프로세스가 US를 아직 쥔 채 관측되는 100 ms 샘플 1건. 해제를 incident DB 쓰기 앞으로 옮겨(§6.5 4·5·6 재배열) 창을 줄였다. 소켓 종료는 여전히 해제 앞이다. | `production-runtime.ts` `#runReelection`, 드릴 10단계 |
| 16.15 | §6.1 RESTORING “열려 있는 주문·예약 로드” | `ProductionRuntime.#restoreOpenOrders()`가 `RECEIVED/OPEN/PARTIALLY_FILLED/TRIGGERED` 주문과 STOP/TAKE_PROFIT(단일·OCO 다리 모두 DB status `PENDING_TRIGGER`, §16.19)을 `PaperEngine.restoreOrder()`로 주입한다(상태·`filledQuantity`·version 보존, 즉시 매칭 없음). 예약은 DB가 진실이므로 엔진에 별도 로드하지 않는다. | `production-runtime.integration.test.ts` RESTORING |
| 16.16 | §7.2-1 recovery 결과 중 trigger만 엔진에 전달 | 복구된 모든 심볼의 REST baseline을 `onRecoveryOrderBook`(RECOVERY_REST)으로도 엔진에 준다 — 재연결 직후 첫 WS 프레임 전에도 대기 주문이 매칭되며, 그 fill은 `recoveryFill`로 라벨된다. | `market-runtime.test.ts` |
| 16.17 | 프로덕션 라우트 집합 | `/api/v1/instruments*`, `/api/v1/markets/:m/symbols/:s/quote`, `/api/v1/fx/*`를 런타임이 등록한다. 종목 카탈로그는 번들 심볼(이름=심볼), quote는 시장 상태 저장소의 현재 호가(발명 없음), 가상 FX 환율은 정적 표 `KRW:USD 0.0007 / USD:KRW 1428.57`(수수료 0)이며 환전은 지갑·감사·outbox(`FX_CONVERTED`)를 한 트랜잭션으로 기록한다. | `production-runtime.integration.test.ts` FX |
| 16.18 | 에러 계약 | 에러 핸들러가 안정 코드(`^[A-Z][A-Z_]*$`)를 가진 4xx 오류의 `code`·`message`를 보존한다(예: FX 라우트의 `CANCEL_ONLY` 409). 그 외는 `INTERNAL_ERROR`. | `error-handler.test.ts` |
| 16.12 | 드릴의 provider 호출 귀속 | 가짜 REST/WS는 프로세스 식별자가 없어 카운트·시간창으로 귀속한다. 2단계는 엔진에 호가가 필요하므로 가짜 WS로 호가 프레임을 먼저 흘린다. | `leader-handoff.drill` |
| 16.19 | §6.1 조건부 주문 트리거 영속화 | Codex 딥 리뷰 BLOCKER: `onConditionalTrigger`가 프로덕션에 배선되지 않았고, 단일 STOP/TAKE_PROFIT은 엔진에 등록조차 되지 않았다. 수정: (a) `OrderPlacementService.#placeSingle`이 조건부 단일을 `PENDING_TRIGGER`로 영속하고 `registerConditionalOrder`로 엔진에 등록, (b) `PaperEngine`은 트리거 시 `#orders`도 `TRIGGERED`로 갱신, (c) `createTriggerPersistence`(`runtime/trigger-persistence.ts`)가 `#buildMarket`에 배선되어 한 트랜잭션으로 fencing 재검사(§7.1) → 트리거 주문 `FILLED`(기준가 체결, `is_recovery_fill` 전파) → fills/positions → OCO면 형제 `CANCELLED`·`is_oco_winner`·`oco_groups RESOLVED`·그룹 예약 `released` → 감사·`account_sequences`·outbox(`ORDER_FILLED`/`ORDER_CANCELLED`/`OCO_RESOLVED`). 이미 종결된 주문 재트리거는 no-op. | `paper-engine.test.ts`, `production-runtime.integration.test.ts` "Codex BLOCKER" |
| 16.20 | 원장 예약·정산 (§ledger 계약) | Codex 딥 리뷰 후속으로 발견한 기존 공백: 단일 주문은 현금/포지션 예약 없이 접수되고, 체결 시 지갑 정산이 없었다(잔고 무한). 수정: (a) `OrderPlacementService.#placeSingle`이 `planReservation`으로 예약을 산정(BUY LIMIT=지정가 명목, BUY MARKET=현재 ask×1.05, BUY STOP/TAKE_PROFIT=트리거가×1.05, SELL=수량)해 `commitTradingMutation`에 `cash`/`position`+`reservationId`로 전달하고, uow가 `reservations` 행(order_id)을 같은 트랜잭션에 기록한다; MARKET BUY에 기준가가 없으면 `MARKET_DATA_DEGRADED`. (b) `runtime/fill-settlement.ts` `settleFill`이 fill/trigger 영속화 공용 정산: BUY는 지갑 total 차감·예약 소진(부족분은 available)·가중평균 원가로 포지션 증가, SELL은 포지션 감소·예약 소진·대금 입금; 종결 체결은 잔여 예약을 available로 반환하고 행을 `released`. (c) 취소(`#executeCancel`)는 락 순서(session→wallet/position→order→reservation)를 지키며 `findOrderReservations`→`releaseCash`/`releasePosition`으로 반환; OCO 공유 예약은 다른 다리가 모두 종결일 때만 해제. (d) `LEDGER_LOCK_ORDER`에 `reservations`(orders 다음) 추가 — 예약 갱신이 세션 row를 `for key share`로 핀함이 측정되어 선언에 포함. (e) 에러 계약 상태 매핑을 `httpStatusFor`로 통일(INSUFFICIENT_* → 409). (f) FxService는 loader가 있으면 항상 원장을 다시 읽는다. e2e 하네스는 세션 생성 시 USD 100,000을 주입한다(프로덕션은 FX 전까지 0). | `fill-settlement.test.ts`, `production-runtime.integration.test.ts` "reserves cash…", `unit-of-work.integration.test.ts` lock accounting |
| 16.21 | §8.1/§14 비밀 주입·egress allow-list 운영 | 보류분 구현: `infra/secrets.env.tpl`(1Password `op://` 참조만; sops 대안 문서화), `infra/provider-allowlist.yaml`(등록 egress IP·환경·일자·등록자 기록, 주소만), `scripts/preflight-deploy.mjs`(`pnpm preflight:deploy`: 필수 변수 존재·형식·플레이스홀더 검사, compose 리터럴 오버라이드 거부, `docker compose config`, 현재 egress IP의 allow-list 등록 확인; 값 미출력). 계약 체커가 두 infra 파일의 형태를 검증하고 배포 가이드에 preflight/allow-list 절을 요구한다. 릴리스 체크리스트에 미체크 항목으로 추가(인프라 미확보). | `scripts/preflight-deploy.test.mjs`, `check-deployment-contract` |
