# 종목 한글·초성 검색 설계 (2026-08-30)

Issue: [#45](https://github.com/changminKo/moi/issues/45)
분류: bounded — 바꿀 흐름이 모두 저장소에 있고 `Instrument.name` 필드도 이미 존재한다.
상태: **설계 승인 대기.** 구현은 시작하지 않았다.

## 문제

API가 내주는 모든 종목의 이름이 티커와 같다. 목록은 `005930 (005930)`처럼
티커를 두 번 보여주고, `삼성`으로 검색하면 아무것도 나오지 않는다.

원인은 카탈로그를 설정된 심볼 목록만으로 만들면서 넣을 이름이 없어 심볼을
그대로 쓰는 것이다 (`apps/paper-api/src/runtime/production-runtime.ts` ~1084):

```ts
catalog: MARKETS.flatMap((market) =>
  symbols[market].map((symbol) => ({
    market,
    symbol,
    name: symbol,   // 표시명이 없다
```

검색 입력의 플레이스홀더는 `종목명 티커 검색`을 약속하고
(`apps/web/src/features/instruments/instrument-search.tsx`),
`InstrumentService.search`는 `` `${i.symbol} ${i.name}` ``에 대해 매칭하므로
`name === symbol`이면 티커 검색으로 축소된다. 필드가 하는 말과 동작이 다르다.

검색은 서버사이드다. `useInstruments`
(`apps/web/src/features/instruments/use-instruments.ts`)가 150ms 디바운스로
`GET /api/v1/instruments?q=…`를 호출하고, 필터링은
`InstrumentService.search` (`apps/paper-api/src/modules/instruments/instrument-service.ts:21`)에서 일어난다.

## 확인된 사실

- Toss 계약서에 표시명이 있다. `GET /api/v1/stocks`, `GET /api/v1/stocks/all`이
  `name`(한글)과 `englishName`을 준다. 미국 종목도 한글명을 받는다
  (`AAPL` → `애플`). 계약서의 예시는 예시일 뿐 검증 규칙이 아니다 (스펙 §16.26).
- 프로바이더 배관은 이미 있다. `TossRestClient.searchInstruments`
  (`packages/market-data/src/toss/toss-rest.ts:155`)가 `/api/v1/stocks/all`을
  호출하고 `name`을 그대로 매핑해 돌려준다. 포트는 `packages/market-data/src/ports.ts:85`.
  `#instrumentService()`가 이 경로를 쓰지 않을 뿐이다.
- `#instrumentService()`는 `#buildApp()`(async) 안 930행에서 호출되므로
  await 자리가 있다.
- `es-hangul` v2는 `hangulIncludes`와 `choseongIncludes`를 제거했다.
  남은 것으로 직접 조합해야 한다: `disassemble`, `getChoseong`,
  `convertQwertyToAlphabet`, `romanize`.

## 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 표시명 출처 | 프로바이더 조회 + 커밋된 스냅샷 폴백 | 실제 이름을 쓰면서도 조회 실패에 이름이 사라지지 않는다 |
| 매칭 범위 | 한글 부분일치 + 초성 | 한국 사용자가 기대하는 `ㅅㅅㅈㅈ`가 동작한다 |
| 매칭 위치 | 서버 (`InstrumentService`) | 검색이 이미 서버사이드다. 클라이언트로 옮기면 전체 카탈로그를 내려야 한다 |
| 영타 보정 | 하지 않는다 | 표면이 넓어지고 오작동 여지가 있다. 필요해지면 별건 |

## 설계

### 1. 표시명 조달

새 모듈 `apps/paper-api/src/modules/instruments/instrument-names.ts`.

```
loadInstrumentNames({ source, symbols, snapshot, signal, log })
  → ReadonlyMap<`${Market}:${string}`, string>
```

- 부팅 시 포트의 `searchInstruments('', signal)`를 한 번 호출하고 설정된
  심볼만 남긴다.
- 실패·타임아웃이면 커밋된 스냅샷을 쓰고 경고를 남긴다. 로그에 토큰이나
  자격증명은 넣지 않는다 (하드룰 2).
- 스냅샷에도 없는 심볼은 `name = symbol`로 떨어진다. 지금 동작이므로
  최악의 경우가 현재 상태와 같다.

스냅샷은 `instrument-names.snapshot.json`에 `{market, symbol, name}`만 담는다.
Toss 구독 상한이 심볼 40개라 손으로 커밋해도 부담이 없고, 프로바이더에
접촉하는 갱신 스크립트를 CI에 들이지 않아 하드룰 1과 충돌하지 않는다.

### 2. 한글 매칭

새 순수 모듈 `apps/paper-api/src/modules/instruments/hangul-match.ts`.

```
matchesInstrument(query, { symbol, name }) → boolean
```

- 질의를 트림·소문자 정규화한다. 빈 질의는 전부 통과.
- 심볼과 영문 부분일치는 지금 동작을 유지한다.
- 질의에 한글이 있으면 `disassemble(name).includes(disassemble(query))`.
  자모 단위라 `삼서`처럼 조합 중인 입력도 잡힌다.
- 질의가 호환 자모 자음만이면 `getChoseong(name).includes(query)`로
  초성 검색을 한다.

`InstrumentService.search`의 `` `${i.symbol} ${i.name}` `` 부분문자열 비교를
이 함수 호출로 바꾼다. `es-hangul`은 `apps/paper-api`의 의존성으로 추가한다.

### 3. 표시 중복 제거

`name === symbol`이면 괄호를 생략한다. 이름이 붙은 뒤에는
`삼성전자 (005930)`, 없으면 `005930`.

## 테스트

TDD로 간다. 실패하는 테스트를 먼저 쓰고, 실패를 확인하고, 구현한다.

| 대상 | 내용 |
|---|---|
| `hangul-match.test.ts` | 삼성 · 삼서 · ㅅㅅㅈㅈ · 005930 · 소문자 영문명 · 빈 질의 · 자모가 아닌 영문 |
| `instrument-names.test.ts` | 프로바이더 성공 / 실패→스냅샷 / 스냅샷 결손→심볼 |
| 기존 `instrument-service` 테스트 | 매칭 교체 반영 |
| 통합 | loopback fake-toss 경유. 실제 프로바이더에는 접촉하지 않는다 (하드룰 1) |
| web | 괄호 생략 렌더 테스트 |

## 범위 밖

- `englishName`을 EN 로케일에 쓰는 i18n. Toss가 미국 종목도 한글명을 주므로
  별건으로 다룬다.
- 종목 목록 페이징.
- 영타 보정 (`convertQwertyToAlphabet`).

## 게이트

`pnpm check` · `pnpm typecheck` · 관련 워크스페이스 `pnpm test`
(Testcontainers를 쓰므로 Docker가 필요하다).

## 작업 위치

브랜치 `feat/hangul-instrument-search`, 워크트리
`.claude/worktrees/hangul-search`. `workspaces/some-project2/skipjack`
워크트리는 다른 세션이 쓰는 중이므로 건드리지 않는다.
