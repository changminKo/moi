# Moi

Moi는 한국 및 미국 주식을 위한 익명 기반의 결정론적(deterministic) 모의투자(paper-trading) 애플리케이션입니다. 세션, 지갑, 주문, 체결, 감사(audit) 기록 및 사용자 이벤트 아웃박스(outbox)에 대한 신뢰할 수 있는 단일 소스(authoritative source)로 PostgreSQL을 사용하며, 브라우저는 REST 스냅샷을 통해 상태를 동기화하고 WebSocket 전송은 최소 1회(at-least-once) 전달을 보장하는 가속 레이어로 취급합니다.

본 저장소는 시뮬레이션 거래 전용으로 구현되었습니다. 투자 조언, 증권 중개 서비스가 아니며, 모의투자 결과가 실제 시장에서 재현될 수 있음을 보장하지 않습니다.

## 공개 MVP 지원 기능

- 기본 지원금 KRW 10,000,000 및 USD 0과 가상 환전(FX)을 제공하는 익명 세션.
- 허용 목록(allow-list)에 등록된 한국 주식 40종목 및 미국 주식 40종목 검색.
- 시장가(MARKET), 지정가(LIMIT), 스탑(STOP), 익절(TAKE_PROFIT), OCO 모의 주문 지원 (온주(whole-share) 유효성 검증, 결정론적 수수료 계산, 증거금 예약, 부분 체결 및 슬리피지 모델 포함).
- `NORMAL`, `DEGRADED`, `RECOVERING`, `CANCEL_ONLY`의 직관적인 시스템 안전 상태 표시.
- 사용자 스트림 이벤트 중복 또는 유실 발생 시 REST 스냅샷 복구 기능.
- PostgreSQL 기반의 멱등성(idempotency), 감사 추적, 아웃박스, 리더 펜싱(leader fencing), 헬스 프로브(health probes), 메트릭, 알림 및 운영 런북 제공.

승인된 아키텍처 문서는 [`docs/superpowers/specs/2026-08-21-moi-paper-trading-architecture-design.md`](docs/superpowers/specs/2026-08-21-moi-paper-trading-architecture-design.md)에 정리되어 있습니다.
배포 토폴로지 및 롤백 규칙은 [`docs/operations/deployment.md`](docs/operations/deployment.md)에 있으며, 릴리스 검증 결과는 [`docs/operations/release-checklist.md`](docs/operations/release-checklist.md)에서 확인할 수 있습니다.

## 로컬 개발 환경 구축

Node 24.19.0을 설치하고 고정된 패키지 매니저 버전을 활성화합니다:

```bash
nvm use 24
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

브라우저 개발 서버는 `http://localhost:3000`을 대상으로 `/api` 프록시를 사용합니다.
Playwright 테스트 하네스는 일회용 PostgreSQL 및 Redis 컨테이너와 결정론적 가상 시세(fake market-data) 피드를 실행하며, 토스(Toss)나 실제 브로커에 절대 접속하지 않습니다:

```bash
pnpm --filter @moi/e2e test:e2e
```

특정 프로바이더에 종속되지 않는 컨테이너 구성을 실행하려면, 배포 가이드에 설명된 필수 런타임 시크릿을 설정한 후 다음을 실행합니다:

```bash
docker compose -f infra/compose.yaml up --build
```

`MARKET_DATA_ADAPTER`는 시세 제공자를 선택하며, 프로덕션 환경에서는 암묵적인 기본값이 없습니다: `infra/compose.yaml`은 `toss`로 명시되어 있으며, 프로덕션 프로세스는 `fake`로 설정되거나 해당 환경 변수가 누락된 경우 시작을 거부합니다.
`MARKET_DATA_ADAPTER=fake`는 결정론적 테스트 및 개발 전용입니다.
프로바이더 인증 정보(`TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`), 데이터베이스 URL, Redis URL, 관리자 인증 정보, 세션 시크릿은 런타임 전용 값이며 브라우저 번들에 절대 포함되어서는 안 됩니다.

런타임 시 단일 `paper-api` 프로세스가 HTTP API, 시장별 격리된 리더 임대(PostgreSQL advisory lock 기반), 시장별 프로바이더 WebSocket 연결, 모의투자 엔진, 아웃박스 발행자(publisher), 사용자 스트림을 관리합니다. 프로바이더 장애 발생 시 영향을 받는 시장은 `CANCEL_ONLY` 상태로 강등(degrade)되어 재시도하며, 설정 오류, 데이터베이스 장애 또는 불변 조건(invariant) 위반 시에만 프로세스가 종료됩니다. 배포는 Stop-then-Start 방식으로 진행됩니다: 기존 프로세스가 드레인되는 동안 새 프로세스는 `CANCEL_ONLY` 상태에서 임대 번들을 대기하므로 프로바이더에 3개 이상의 연결이 동시에 생성되지 않습니다. 이를 검증하는 2개 프로세스 드릴 테스트는 루프백 가상 프로바이더를 대상으로 실행됩니다(`pnpm --filter @moi/paper-api test:drill`). 자동화된 테스트는 토스에 접근하지 않습니다. 검증 증거는 릴리스 체크리스트를 참조하세요.

## 시뮬레이션 한계

- 모든 사용자는 화면에 표시된 호가창(order-book depth) 유동성을 독립적으로 재사용합니다. 익명 모의 계좌 간에 유동성이 전역적으로 공유되어 소진되지 않습니다.
- 따라서 집계된 모의 체결량이 동일한 순간 실제 시장에 노출된 유동성을 초과할 수 있습니다.
- 거래소 체결 대기열 순서, 숨은 유동성(hidden liquidity), 주문 라우팅(venue routing), 실제 거래소의 주문 승인(acknowledgement) 메커니즘은 모델링되지 않습니다.
- 복구 시에는 현재 REST 가격과 호가창을 사용합니다. 유실된 피드 구간에 대해 소급 체결(retroactive fills)을 임의로 생성하지 않으며, 복구로 인해 발생한 체결에는 라벨이 표시됩니다.
- 결정론적 피드에서 관찰된 성능은 실제 계좌에서의 체결 품질, 지연 시간, 수수료, 세금 또는 수익률을 예측하거나 보장하지 않습니다.

## 실계좌 경계 (Real-account boundary)

본 공개 저장소에는 실제 계좌 인증 정보, 실제 증권사 주문 라우팅 또는 실제 주문 실행 구현이 포함되어 있지 않습니다. 비공개 실거래 봇 저장소는 완전히 분리된 프로젝트 및 신뢰 경계(trust boundary)이며, Moi의 브라우저, 관리자 API, 익명 세션 인증 정보 또는 배포 시크릿을 공유하지 않습니다.

## 라이선스 및 안전 수칙

본 소프트웨어는 직접 제어할 수 있는 환경에서만 사용해야 합니다. 모의 잔고 및 투자 결과는 어떠한 금전적 가치도 갖지 않습니다. 관련 없는 실거래 시스템을 구축하기 전에 항상 현지 법률, 세금, 시세 데이터 라이선스 및 증권사 규정을 독립적으로 검증하시기 바랍니다.
