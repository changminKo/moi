# Moi Strategy Runner — Discord 운영자 명령 (슬래시 명령으로 봇을 멈추고, 풀고, 들여다본다) Design

작성 2026-09-04. 상태: 사용자 검토 대기. 선행 스펙:
`2026-09-02-moi-strategy-runner-kill-switch-design.md`(킬 스위치),
`2026-08-27-moi-production-runtime-and-provider-handoff-design.md`(운영 런타임, §16 편차표).

## 0. 승인된 결정 (사용자, 2026-09-04)

1. **범위는 전략 러너만.** 사람 사용자의 웹 거래는 건드리지 않는다. paper-api 의
   GLOBAL 인시던트·`/admin/cancel-all` 은 이 기능의 대상이 아니다.
2. **수신은 Discord Gateway + 슬래시 명령.** 봇 컨테이너가 아웃바운드 WSS 로
   Gateway 에 붙어 `INTERACTION_CREATE` 를 받는다. Discord 웹훅은 받기 전용이라
   메시지를 우리 서버로 보낼 수 없고, Interactions HTTP 엔드포인트는 새 공개
   표면(Caddy·서명 검증·레이트리밋)을 열어야 하며 러너로 명령을 다시 전달해야
   해서 택하지 않았다.
3. **명령 세트(1차)**: `halt`, `resume`, `cancel-all`, `pause`, `resume-strategy`,
   `status`.
4. **권한은 허용리스트만.** `runner.json` 의 Discord 사용자 ID 배열. 확인 버튼·
   2인 확인 없음. 허용리스트가 비어 있으면 모든 명령을 거부한다.
5. **접근 A**: Gateway 프로토콜을 Node 24 내장 `WebSocket` 위에 직접 구현한다
   (러너의 `stream-client.ts` 가 `ws` 없이 사는 것과 같은 이유). `discord.js`
   류 의존성은 시크릿을 쥔 컨테이너에 큰 트리를 들이므로 배제. 별도
   프로세스 + 파일 래치 방식은 `resume`·`status` 가 프로세스 간 파일 프로토콜이
   되어 배제.

## 1. 배경

킬 스위치 스펙 §2.1 은 해제를 "사람이 `kill-switch.json` 을 지우고 재시작한다"
로 못박았고 운영자 트립도 파일 쓰기다(`docs/operations/deployment.md`
"Strategy runner" 절). 둘 다 SSH 와 `docker exec` 가 필요하다. 운영자는 이미
Discord 에서 봇의 보고(`packages/strategy-reporter`)를 읽는다 — 같은 자리에서
멈추고 풀 수 있어야 한다. 2026-09-04 #122(캘린더 디코더가 항상 `HOLIDAY`)
때처럼 봇이 이상하게 굴 때 첫 동작은 "일단 멈춤" 이고, 그 시간을 분 단위에서
초 단위로 줄이는 것이 이 기능의 목적이다.

이 스펙은 두 가지를 바꾼다. (1) 킬 스위치에 런타임 해제(`disengage`)가 생긴다
— 킬 스위치 스펙 §2.1 의 "해제는 재시작" 원칙의 개정이며 §16 에 행을 받는다.
(2) 전략 단위 정지(`pause`)라는 새 상태가 생긴다 — 전체 배리어와 독립이다.

## 2. 구성 요소

```
Discord Gateway (wss) ──INTERACTION_CREATE──▶ packages/discord-gateway
                                                   │ (프로토콜만: Hello/Identify/Heartbeat/Resume/Dispatch)
                                                   ▼
                              apps/strategy-runner/src/commands/
                                   dispatcher ── 허용리스트·guild·중복 검사
                                   handlers  ── halt · resume · cancel-all · pause · resume-strategy · status
                                                   │ (틱 사이에 직렬 적용)
                                                   ▼
                              KillSwitch(engage/disengage) · StrategyPauses(JsonCell) · OrderGateway · 포트폴리오
                                                   │
                              Discord REST ◀── deferred ACK(3 s 내) → follow-up(한국어)
```

### 2.1 `packages/discord-gateway` (신규)

순수 프로토콜 패키지. Discord 를 모르는 곳(러너 명령 계층)과 Discord 만 아는 곳을
가른다.

- **연결 수명주기** (Gateway v10, 공식 문서 기준): `GET /gateway/bot` 로 URL 을
  받고 `?v=10&encoding=json` 으로 접속 → `Hello`(op 10, `heartbeat_interval`)
  → 첫 하트비트는 `interval × jitter(0..1)` 뒤 → `Identify`(op 2, `token`,
  `intents: 0`, `properties {os, browser: 'moi-strategy-runner', device}`) →
  `Ready`(`session_id`, `resume_gateway_url`) → 이후 `Heartbeat`(op 1, 마지막
  `s`) / `Heartbeat ACK`(op 11). ACK 없는 하트비트 1회면 좀비로 보고 끊는다
  (공식 권고).
- **재개**: 끊기면 `resume_gateway_url` 로 재접속해 `Resume`(op 6, `token`,
  `session_id`, `seq`). 서버가 `Reconnect`(op 7) 를 보내면 즉시 재개,
  `Invalid Session`(op 9) 은 `d === true` 면 재개, `false` 면 1–5 s 뒤 새
  Identify. 백오프는 러너의 `reconnect-policy.ts` 를 그대로 쓴다(지수, 상한,
  안정 후 리셋). 인텐트 0 이므로 `INTERACTION_CREATE` 외 이벤트는 오지 않고,
  오는 것은 버린다.
- **종료 코드**: `4004`(인증 실패)·`4010`·`4011`·`4013`·`4014` 는 재시도해도
  같으므로 **재접속하지 않고** `fatal` 로 위로 올린다. 나머지는 재개/재접속.
- **디스패치**: `INTERACTION_CREATE` 의 `d` 를 검증(zod: `id`, `token`,
  `type`, `application_id`, `guild_id?`, `member.user.id` 또는 `user.id`,
  `data.name`, `data.options[]` 재귀) 해 `Interaction` 값으로 넘긴다. 검증 실패는
  로그 1줄과 무시(응답 불가 — 토큰이 없을 수 있다).
- **REST 최소 클라이언트**: `POST /interactions/{id}/{token}/callback`(type 5
  deferred, `flags: 64` ephemeral 옵션), `PATCH
  /webhooks/{application_id}/{token}/messages/@original`(follow-up 본문). 429 는
  `retry_after` 만큼 1회 대기 후 재시도(리포터 전송기와 같은 규칙, 상한 5 s).
  토큰은 `Authorization: Bot …` 헤더에만 싣고 어느 로그에도 남기지 않는다.
- **공개 API**: `createGatewayClient({ token, applicationId, fetch?,
  socketFactory?, now?, wait?, onInteraction, onState })` → `{ start(), stop() }`.
  `onState` 는 `connecting | ready | resuming | backoff | fatal` 전이를 알린다.
- 파일 상한 400줄 규칙에 맞춰 `gateway-client.ts`(수명주기), `payloads.ts`(zod),
  `rest.ts`, `index.ts` 로 나눈다.

### 2.2 `apps/strategy-runner/src/commands/` (신규)

- **`dispatcher.ts`**: `Interaction` → 명령. 순서대로 (a) `type !== 2`
  (APPLICATION_COMMAND) 는 무시, (b) `guild_id !== config.discord.guildId` 또는
  DM(`guild_id` 없음) 은 ephemeral "이 서버의 명령이 아닙니다" 로 거부, (c)
  사용자 ID 가 `allowedUserIds` 에 없으면 ephemeral "권한 없음" + `warn` 보고
  (사용자 ID·명령명), (d) `interaction.id` 를 최근 처리 집합(크기 상한 1 000,
  15 분 만료 — 토큰 수명과 같다)에 넣고 중복은 무시, (e) 즉시 **deferred ACK**
  (op 5; 거부 응답만 즉시 type 4 ephemeral), (f) 명령을 **큐**에 넣는다.
- **틱 사이 직렬 적용**: 슈퍼바이저 cycle 의 step 0(운영자 파일 관찰 자리)에서
  큐를 비운다. 명령 핸들러는 슈퍼바이저 루프와 같은 "스레드" 에서만 상태를
  바꾼다 — 킬 스위치 스펙 §2.5 의 정지 자세와 경쟁하지 않는다. 큐가 비는 동안
  들어온 명령은 다음 cycle. `pollIntervalMs`(기본 5 s) 이내에 실행되므로
  deferred ACK 뒤 follow-up 은 15 분 토큰 수명 안에 넉넉하다.
- **핸들러** (`handlers/*.ts`, 각각 순수 함수 + 결과 메시지):
  - `halt reason`: `killSwitch.engage('operator', reason, { by: userId })`.
    이미 걸려 있으면 engage 는 no-op(기존 멱등) 이고 응답은 "이미 중단됨
    (source·reason·engagedAt)".
  - `resume reason`: `killSwitch.disengage({ by: userId, reason })`(§2.3).
    걸려 있지 않으면 "중단 상태가 아닙니다".
  - `cancel-all reason`: `killSwitch.sweep()` 을 공개해 배리어를 건드리지 않고
    잔여 주문만 취소. 응답은 pass 수·취소 건수·남은 건수. 취소 실패가 남으면
    `warn`.
  - `pause strategy reason` / `resume-strategy strategy`: `StrategyPauses`(§2.4)
    에 기록. 모르는 전략 이름은 거부(설정의 `strategies[].name` 목록을 응답에
    붙인다).
  - `status`: 읽기 전용. 킬 스위치(`engaged`, source, reason, engagedAt),
    전략별 pause, 러너(마지막 cycle 시각, API 런타임 상태, Gateway 상태), 포트폴
    리오(`portfolio()` — 포지션·미실현 손익·잔여 주문 수). 포트폴리오 조회 실패는
    그 칸만 "조회 실패" 로 채운다.
- **응답은 한국어**. 문장은 `packages/strategy-reporter/src/korean.ts` 의
  테이블 옆에 `COMMAND_REPLIES` 로 두고 `reporter-korean.test.ts` 와 같은
  방식으로 누락을 잡는다. 모든 명령 결과는 Discord 응답과 **동시에** `Reporter`
  로도 보고한다(트레이드 채널에 감사 흔적): `halt`/`resume` 은 `warn`,
  `cancel-all` 은 `warn`, `pause`/`resume-strategy` 는 `info`, `status` 는
  보고하지 않는다.

### 2.3 `KillSwitch.disengage` (킬 스위치 스펙 §2.1 개정)

```ts
disengage(by: { readonly by: string; readonly reason: string }): Promise<'released' | 'not-engaged'>
```

- 순서: 파일 래치 삭제(`JsonCell.remove` — **신규**, `ENOENT` 는 성공, 그 밖은
  던진다) → 메모리 `#engagement` 해제 → `warn` 보고(`kill-switch.released`,
  source 였던 것·by·reason). 파일을 먼저 지우는 이유: 메모리를 먼저 풀고 파일
  삭제가 실패하면 "도는 봇 + 재시작 시 다시 걸리는 파일" 이라는 반쪽 상태가
  되고, 그 반대는 "파일 없는데 배리어 닫힘" 으로 다음 `disengage` 나 재시작이
  풀 수 있다. 삭제가 던지면 반환값을 늘리지 않고 `error` 한 줄(오류 코드만)을
  낸 뒤 그 오류를 그대로 던진다 — 래치는 메모리·디스크 양쪽에 남는다.
- **자동 트립도 푼다**(사용자 결정 4). 단 `loss-limit` 은 `RiskGate.
  lossLimitBreach(now)` 가 같은 UTC 일에 계속 참이므로 **다음 cycle 에 즉시
  재걸린다** — 이것이 의도한 안전장치고 응답에 그대로 적는다("일 손실 한도가
  여전히 초과라 다음 틱에 다시 걸립니다"). `fill-wedge` 와
  `submission-failures` 는 원인이 그대로면 마찬가지로 재걸린다.
- 스윕은 하지 않는다(풀 때 취소할 것이 없다). pending 결정 정산 규칙(스펙
  §2.2 "킬 스위치가 잡은 결정은 죽은 결정")은 변하지 않는다 — 걸린 동안 halted
  로 정산된 결정은 부활하지 않는다.
- 운영자 파일 관찰(`observeOperatorFile`)은 그대로 살아 있다. 파일을 손으로
  써서 걸고 Discord 로 풀 수 있고, 반대도 된다. 프로세스가 도는 동안 파일이
  사라져도 래치가 풀리지 않는다는 규칙은 유지 — 푸는 길은 `disengage` 와
  재시작 둘뿐이다.

### 2.4 `StrategyPauses` (신규, `apps/strategy-runner/src/runner/strategy-pauses.ts`)

- `JsonCell('strategy-pauses.json')`, 형태 `{ [strategyName]: { pausedAt, by,
  reason } }`. 원자적 교체 쓰기(킬 스위치 래치와 같은 셀).
- `OrderGateway.submit` 앞의 배리어 질문에 전략 이름이 들어간다: `permits(kind,
  strategyName)` 은 킬 스위치 **그리고** 해당 전략 pause 둘 다 통과해야 `place`
  를 허용한다. `cancel` 은 항상 허용(킬 스위치와 대칭). 게이트웨이가 어느 쪽에
  막혔는지 알아야 정산 결과가 갈리므로 판정은 `BarrierVerdict = boolean |
  'paused'` — `false` 는 킬 스위치(`KILL_SWITCH`), `'paused'` 는 전략 정지
  (`STRATEGY_PAUSED`). 기존 `(kind) => boolean` 콜백은 그대로 대입 가능하다.
  전략 이름은 이미 `DecisionRecord.strategy`(= `ConfiguredStrategy.name`,
  설정이 중복을 거부)로 흐르므로 새 키는 없다.
- pause 된 전략은 틱을 **받는다**(지표 상태를 잃지 않기 위해) — 결정만
  `SubmissionOutcome = 'paused'` 로 정산되고 기록된다. `paused` 는 `halted` 와
  같이 "내보내지 않은" 결정이므로 일일 진입 예산(`dailyEntryNotional` 의
  `neverSent` 규칙)에서 제외한다 — 그렇지 않으면 다시 켠 전략이 쓰지도 않은
  예산에 막힌다. 잔여 주문은 건드리지 않는다.
- 재시작 시 생성자가 파일을 읽어 복원하고, 알림은 `start()` 가 부르는
  `announceRestored()` 가 `info` 로 한 번 낸다(킬 스위치와 같은 규칙: 생성은
  읽기만, 쓰기·보고는 시작 시). 파일이 읽히지 않으면 **통째로 버리고 `warn` 한
  줄** — 이 셀만 fail closed 가 아닌 이유: 깨진 정지 파일로 기동을 거부하면
  `restart: unless-stopped` 아래서 채팅으로 고칠 길이 없고, 최악의 결과는
  "정지가 풀린 전략" 인데 전체 킬 스위치가 그 위에 그대로 있다.

### 2.5 설정과 시크릿

`runner.json` 에 선택 섹션:

```json
"discord": {
  "applicationId": "1234…",
  "guildId": "5678…",
  "allowedUserIds": ["9012…"]
}
```

- 섹션이 없으면 명령 기능은 **꺼진다**(옵트인, 기존 동작 그대로). 섹션이 있는데
  `DISCORD_BOT_TOKEN` 환경변수가 없으면 **기동 거부**(`ConfigError`, fail
  closed). `allowedUserIds` 는 문자열 배열, 빈 배열 허용(전부 거부).
- `DISCORD_BOT_TOKEN` 은 `infra/secrets.env.tpl` 에 추가하고 compose 에서 **bot
  서비스에만** 넘긴다. `scripts/check-deployment-contract.mjs` 규칙: 그 변수가
  paper-api·web 서비스 `environment:` 에 나타나면 실패(운영 웹훅이 봇에 가면
  실패하는 기존 규칙 §7.4 의 대칭) + 변이 테스트.
- 리포터 마스킹 규칙(`masking.ts`)에 `Bot [A-Za-z0-9._-]+` 패턴과 정확값
  마스킹 대상으로 토큰을 추가한다. `live-guard.ts` 의 금지 호스트에
  `discord.com`·`gateway.discord.gg` 를 추가 — 테스트·CI 는 페이크만 본다.
- 명령 등록은 `pnpm bot:register-commands`(`apps/strategy-runner/scripts/
  register-commands.ts`): `PUT /applications/{applicationId}/guilds/{guildId}/
  commands` 로 `/moi` 하나에 서브커맨드 6개를 **덮어쓴다**. 운영자가 워크스테이션
  에서 토큰을 환경변수로 넘겨 1회 실행. 러너 기동 경로는 외부 호출을 늘리지
  않는다.

## 3. 실패 처리

| 상황 | 동작 |
| --- | --- |
| Gateway 끊김 | `reconnect-policy` 백오프로 재개/재접속. 거래는 무관(명령 채널은 보조). 10 분 이상 `ready` 가 아니면 `warn` 1회, 복구 시 `info` 1회(하트비트 패턴). |
| 기동 시 `4004` 등 치명 종료 | `fail` 보고 + 명령 채널 `fatal` 로 정지. **러너는 계속 거래한다** — 명령 수신 실패가 봇을 죽이면 안 된다. 파일 래치·재시작 경로는 그대로 남는다. |
| 3 s 시한 | 모든 수락 명령은 즉시 deferred ACK. ACK 자체가 실패(네트워크)하면 명령을 버리고 `warn`(사용자가 Discord 에서 "응답 없음" 을 본다 — 재시도는 사람이). |
| 중복 인터랙션 | `interaction.id` 집합으로 1회. 핸들러도 멱등(engage/disengage/pause 재호출 무해). |
| follow-up 실패 | 명령은 이미 적용됨. `warn` 로 남기고 리포터 보고가 감사 흔적 역할. |
| 허용리스트 밖 | ephemeral 거부 + `warn`(사용자 ID). 반복 시 리포터 레이트리밋이 묶는다. |
| Discord 측 명령 권한 | 문서로 안내: 서버 설정 → 연동 → 명령 권한을 운영자 역할로 제한. 우리 허용리스트가 최종 방어선이고 Discord 권한은 잡음 감소용. |

## 4. 문서·스펙

- 이 스펙. 킬 스위치 스펙 §2.1 "해제는 사람이 파일을 지우고 재시작한다" 에
  개정 주석(→ 이 스펙 §2.3). 운영 스펙 §16 에 행 1개: 런타임 `disengage` 도입,
  명령 채널 장애가 거래를 막지 않음, 전략 pause 상태 — 번호는 리드 배정.
- `docs/operations/deployment.md` "Strategy runner" 절: Discord 앱·봇 생성,
  서버 초대(권한: `applications.commands` 스코프만, 봇 권한 0), 토큰을 sops 에,
  `pnpm bot:register-commands`, `runner.json` `discord` 예시, `/moi` 사용법,
  해제가 이제 Discord 로 가능함(기존 `docker exec … rm` 절차는 대안으로 유지).
- `docs/runbooks/emergency-cancel-only.md` 에 "봇만 멈추기: `/moi halt`" 경로.
- `infra/bot/README.md`·`runner.example.json` 에 섹션 예시(주석으로 옵트인 표시).

## 5. 테스트

- `packages/discord-gateway`: 로컬 페이크 Gateway(`node:http` + 내장
  `WebSocketServer` 없으므로 `ws` 는 devDependency 로만 — 러너 런타임 의존성
  아님) 가 Hello→Identify→Ready, Heartbeat/ACK, Resume 성공/실패, op 7, op 9
  (true/false), 4004 종료, `INTERACTION_CREATE` 주입을 시나리오로 낸다. 페이크
  REST 는 callback/follow-up 을 기록. 좀비 연결(ACK 누락) 감지, 백오프 리셋 조건,
  토큰이 어느 로그·에러 메시지에도 없음을 단언.
- 러너 `commands/`: 디스패처 단위(guild 불일치·DM·허용리스트·중복·type≠2),
  핸들러 단위(각 명령의 상태 전이와 응답 문구), 슈퍼바이저 통합(큐가 cycle
  step 0 에서 비워지고 거래 경로에 반영: halt 뒤 `place` 가 halted 정산, resume
  뒤 통과, pause 전략의 결정이 `paused` 로 기록되고 다른 전략은 정상, `status`
  가 포트폴리오 실패에도 응답).
- `kill-switch.test.ts`: `disengage` — 파일 먼저 삭제, 보고, `not-engaged`,
  loss-limit 재걸림(같은 날), 파일 삭제 실패 시 메모리 유지.
- `strategy-pauses.test.ts`: 영구화·복원·`permits` 결합.
- 계약 체커·마스킹·live-guard·`reporter-korean` 누락 검사 각 변이 테스트.
- 변이 검사 관행(리뷰 2레인) 그대로.

## 6. 하지 않는 것

- paper-api 쪽 중단(GLOBAL 인시던트·cancel-all) — 별건.
- 확인 버튼·2인 확인·타임락 — 사용자 결정 4.
- 리스크 한도 변경·전략 추가 같은 설정 변경 명령 — `runner.json` 은 기동 시
  1회 로드이며 리로드 설계는 없다.
- Discord 메시지 인텐트(일반 채팅 파싱), DM 명령, 다중 길드.
- 명령 자동 등록(기동 경로 외부 호출 금지).

## 7. 구현 단계 (각각 PR, 리뷰 2레인)

1. `KillSwitch.disengage` + `StrategyPauses` + `permits(kind, strategy)` — 내부
   API 와 테스트만. §16 행·킬 스위치 스펙 개정 포함.
2. `packages/discord-gateway` — 프로토콜·REST·페이크·테스트. 러너 미배선.
3. 러너 `commands/` 디스패처 + `halt`·`status` + 설정·시크릿·계약 체커·마스킹·
   live-guard + 등록 스크립트.
4. `resume`·`cancel-all`·`pause`·`resume-strategy` + 문서·런북·배포.

## 8. 배포 순서 (운영자)

1. Discord Developer Portal 에서 앱 생성 → Bot 추가 → 토큰 발급(Privileged
   Intents 전부 끔) → OAuth2 URL(`applications.commands` 스코프, 봇 권한 0)로
   서버 초대.
2. 워크스테이션에서 `DISCORD_BOT_TOKEN=… pnpm bot:register-commands
   --application <id> --guild <id>`.
3. 호스트 sops 파일에 `DISCORD_BOT_TOKEN` 추가(`sops /etc/moi/secrets.enc.env`).
4. `runner.json` 에 `discord` 섹션.
5. 배포(`deploy.sh main`). 봇 로그에 `discord.gateway ready` 확인, `/moi status`
   로 왕복 확인.
