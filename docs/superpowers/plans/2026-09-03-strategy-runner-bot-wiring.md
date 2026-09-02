# Strategy Runner Bot Wiring (#93, phase D 배선) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 러너가 실제로 뜬다 — GHCR 이미지, 호스트 스택 생명주기 편입(`COMPOSE_PROFILES=bot`), Discord 트레이드 채널 배선, 마스커 통일(#92), 운영자 예시 설정의 실행 검증.

**Architecture:** `apps/strategy-runner/Dockerfile` 이 paper-api 와 같은 4단계 이미지를 만들고 `publish.yml` 이 세 번째 매트릭스 항목으로 발행한다. `compose.override.yaml` 이 bot 을 GHCR 이미지로 바꾼다. 호스트는 `/etc/moi/moi.env` 의 `COMPOSE_PROFILES=bot` 으로 켠다 — systemd·deploy.sh 가 이미 그 파일을 읽으므로 스크립트 변경은 verify 한 줄이다. 러너 `main.ts` 는 새 모듈 `runner/reporter-wiring.ts` 로 라인 리포터와 Discord 리포터를 팬아웃하고, `redact.ts` 는 `@moi/strategy-reporter` 의 `maskOutbound` 로 대체된다.

**Tech Stack:** Docker multi-stage(node:24.19.0-alpine3.23, pnpm 11.22.0 corepack, `pnpm deploy --prod --legacy`), GitHub Actions matrix, docker compose profiles, vitest, node:test(계약 체커).

**Spec:** 러너 설계 `docs/superpowers/specs/2026-08-30-moi-strategy-runner-design.md` §3(경계)·§7.3·§7.4·§8.1·§11 D; 사용자 승인 결정(2026-09-03): 생명주기는 `COMPOSE_PROFILES=bot`, 범위는 이미지+배선+Discord+#92. 편차 행 **§16.49**(러너가 `@moi/strategy-reporter` 에 의존).

## Global Constraints

- Dockerfile 규칙(계약 체커가 파일이 생기는 순간 무조건 적용): `node:24.19.0`, `corepack prepare pnpm@11.22.0 --activate`, `pnpm install … --frozen-lockfile`, 마지막 `USER node`, `.env` 미복사, 워크스페이스 의존(dev 포함) 전부 COPY.
- 러너 경계(설계 §3): `@moi/paper-api`·`@moi/market-data`·`pg`·`kysely` 금지 그대로. 허용 의존은 `@moi/strategy-sdk`·`@moi/trading-core`·**`@moi/strategy-reporter`**(§16.49).
- 비밀은 로그·Discord·저장소에 없다. 웹훅 URL 은 환경변수로만, 러너는 `DISCORD_WEBHOOK_TRADE_URL` 만 읽는다(`DISCORD_WEBHOOK_URL` 절대 아님).
- 커밋은 한국어 conventional commit, 각 태스크 끝. **Task 1(Dockerfile)·Task 2(publish)·Task 3(override) 는 한 커밋**(#93: 셋이 갈라지면 존재하지 않는 이미지를 가리킨다).
- pnpm: `source ~/.nvm/nvm.sh && nvm use && corepack pnpm`. `git commit` 은 단독 명령으로(훅 오탐). 변이 확인 전 반드시 커밋.
- 게이트: `pnpm check` · `pnpm typecheck` · `pnpm --filter @moi/strategy-runner test` · `pnpm --filter @moi/strategy-reporter test` · `pnpm check:deployment` · `pnpm test:deployment` · `pnpm test:preflight` · `pnpm build` · 로컬 `docker build -f apps/strategy-runner/Dockerfile .`.

---

## File Structure

| 파일 | 역할 | 변경 |
|---|---|---|
| `apps/strategy-runner/Dockerfile` | 러너 이미지 | Create |
| `.github/workflows/publish.yml` | 매트릭스 3번째 항목 | Modify |
| `infra/oracle/compose.override.yaml` | bot 을 GHCR 이미지로 | Modify |
| `infra/oracle/deploy.sh` | verify: 프로필 켜져 있으면 bot running | Modify |
| `infra/oracle/bootstrap.sh` | moi.env 템플릿 주석 `COMPOSE_PROFILES` | Modify |
| `scripts/check-deployment-contract.mjs` | bot 이미지·publish 매트릭스·override·deploy verify 규칙 | Modify |
| `scripts/check-deployment-contract.test.mjs` | 위 규칙 변이 테스트 | Modify |
| `packages/strategy-reporter/src/index.ts` | `createDiscordReporter` export | Modify |
| `packages/strategy-reporter/src/discord-reporter.test.ts` | 드리프트 알람 정리(#92) | Modify |
| `apps/strategy-runner/package.json` | `@moi/strategy-reporter` 의존 | Modify |
| `apps/strategy-runner/src/package-surface.test.ts` | 허용 의존 3개 | Modify |
| `apps/strategy-runner/src/runner/reporter-wiring.ts` | **새 파일**: env → 리포터 조립(라인 + Discord 팬아웃) | Create |
| `apps/strategy-runner/src/runner/reporter-wiring.test.ts` | **새 파일** | Create |
| `apps/strategy-runner/src/main.ts` | 배선 사용, 종료 시 flush | Modify |
| `apps/strategy-runner/src/reporter.ts`, `runner/kill-switch.ts`, `backtest/report.ts`, `index.ts` | `redact` → `maskOutbound` | Modify |
| `apps/strategy-runner/src/transport/redact.ts`, `redact.test.ts` | 삭제 | Delete |
| `apps/strategy-runner/src/reporter.test.ts`, `feed/stream-client.test.ts` | 마스크 토큰 `***` | Modify |
| `apps/strategy-runner/src/config.test.ts` | `infra/bot/runner.example.json` 실제 로드 | Modify |
| `infra/bot/runner.example.json` | phase C 한도 추가 | Modify |
| `infra/bot/README.md`, `docs/operations/deployment.md`, `apps/strategy-runner/README.md`, `docs/operations/release-checklist.md`, 스펙 §16.49 | 문서 | Modify |

---

### Task 1: 이미지·발행·override (한 커밋)

**Files:**
- Create: `apps/strategy-runner/Dockerfile`
- Modify: `.github/workflows/publish.yml:33-38`, `infra/oracle/compose.override.yaml:40-52`
- Test: `scripts/check-deployment-contract.mjs`(기존 `bot` 검사가 Dockerfile 존재 시 규칙 적용) + 로컬 `docker build`

**Interfaces:**
- Produces: 이미지 `ghcr.io/changminko/moi-strategy-runner:{sha,main}`, `CMD ["node","apps/strategy-runner/dist/main.js"]`, 상태 디렉터리 `/var/lib/moi-bot`(node 소유).

- [ ] **Step 1: 실패 확인(RED)** — 지금 상태에서 `docker compose -f infra/compose.yaml -f infra/oracle/compose.override.yaml --profile bot config` 는 bot 의 `build` 를 가리키는데 Dockerfile 이 없다. 실행: `docker build -f apps/strategy-runner/Dockerfile .` → `failed to read dockerfile` 로 실패.

- [ ] **Step 2: Dockerfile 작성**

```dockerfile
# syntax=docker/dockerfile:1.7
# Multi-stage build for the strategy runner (자동매매 봇, design §3, §8.1). The
# runtime stage carries only production dependencies and compiled output, runs
# as the unprivileged `node` user, and owns the state directory the compose
# volume mounts — a named volume inherits the image's ownership on first use,
# which is what lets a read-only root filesystem still write NDJSON there.

FROM node:24.19.0-alpine3.23 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /workspace

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile

FROM fetch AS builder
COPY package.json tsconfig.base.json turbo.json biome.json ./
COPY scripts ./scripts
COPY packages ./packages
COPY apps/strategy-runner ./apps/strategy-runner
RUN pnpm install --offline --frozen-lockfile --filter @moi/strategy-runner...
RUN pnpm turbo run build --filter=@moi/strategy-runner...
RUN pnpm --filter @moi/strategy-runner deploy --prod --legacy /out/strategy-runner \
    && rm -rf /out/strategy-runner/src /out/strategy-runner/Dockerfile /out/strategy-runner/tsconfig.json /out/strategy-runner/tsconfig.test.json /out/strategy-runner/.turbo

FROM node:24.19.0-alpine3.23 AS runtime
# Pull in Alpine security updates (e.g. openssl) so the published image passes
# the Trivy gate in .github/workflows/publish.yml without waiting for a new
# upstream node tag.
RUN apk upgrade --no-cache
ENV NODE_ENV=production
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules \
    /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg /opt/yarn* \
    && mkdir -p /var/lib/moi-bot && chown node:node /var/lib/moi-bot
COPY --from=builder --chown=node:node /out/strategy-runner /app/apps/strategy-runner
USER node
# No EXPOSE: the runner serves nothing. It reaches paper-api over the compose
# network and posts to Discord; nothing reaches it.
CMD ["node", "apps/strategy-runner/dist/main.js"]
```

- [ ] **Step 3: publish.yml 매트릭스** — `- name: web` 항목 뒤에:

```yaml
          - name: strategy-runner
            dockerfile: apps/strategy-runner/Dockerfile
```

파일 머리 주석의 "Builds the two runtime images" → "three" 와 `moi-{paper-api,web,strategy-runner}` 로 고친다.

- [ ] **Step 4: override** — `paper-api:` 블록 뒤에:

```yaml
  # The bot (profile `bot`, design §7.3/§8.1). Same rule as the two above: the
  # host pulls, never builds. It starts only when the host's /etc/moi/moi.env
  # sets COMPOSE_PROFILES=bot — see docs/operations/deployment.md.
  bot:
    image: ghcr.io/changminko/moi-strategy-runner:${MOI_IMAGE_TAG:-main}
    build: !reset null
```

- [ ] **Step 5: 확인** — `corepack pnpm check:deployment`(기존 bot 검사가 새 Dockerfile 에 규칙 적용; 워크스페이스 의존 커버 검사는 Task 4 에서 `apps/strategy-runner` 를 목록에 넣는다), 그리고

```bash
docker build -f apps/strategy-runner/Dockerfile -t moi/strategy-runner:local . 2>&1 | tail -3
docker run --rm --read-only --tmpfs /tmp moi/strategy-runner:local 2>&1 | tail -3
```

Expected: 빌드 성공; 실행은 설정 없이 `[error] the strategy runner refused to run error=BOT_API_ORIGIN …` 로 exit 1(fail-closed 기동 거부 메시지가 그대로 보임 = 진입점이 맞다).

```bash
docker run --rm moi/strategy-runner:local sh -c 'id -u && stat -c %U /var/lib/moi-bot'
```

Expected: `1000` 와 `node`.

- [ ] **Step 6: 커밋**

```bash
git add apps/strategy-runner/Dockerfile .github/workflows/publish.yml infra/oracle/compose.override.yaml
git commit -m "feat(ops): 전략 러너 이미지 — Dockerfile·publish 매트릭스·override 를 한 커밋으로

셋이 갈라지면 override 가 존재하지 않는 GHCR 이미지를 가리키거나 publish 가 없는 Dockerfile 을 빌드한다(#93).
런타임은 paper-api 와 같은 4단계 비-root 이미지이고, /var/lib/moi-bot 을 node 소유로 만들어 이름 있는
볼륨이 그 소유권을 물려받게 한다 — read-only 루트에서 NDJSON 상태를 쓰는 유일한 길이다."
```

---

### Task 2: 호스트 생명주기 — `COMPOSE_PROFILES=bot`

**Files:**
- Modify: `infra/oracle/deploy.sh:86-102`(verify), `infra/oracle/bootstrap.sh:98-103`(moi.env 템플릿)
- Test: `scripts/check-deployment-contract.mjs` 규칙(Task 4)

- [ ] **Step 1: deploy.sh verify** — 성공 분기(`deploy_verified "$sha"` 직전)에:

```bash
    # The bot is opt-in through COMPOSE_PROFILES=bot in /etc/moi/moi.env. When
    # it is on, a release is not done until the runner is up: a configuration
    # it refuses (no runner.json, a limit outside exact money) is a container in
    # a restart loop, and that has to fail the deploy, not hide behind
    # `restart: unless-stopped`.
    if printf %s "${COMPOSE_PROFILES:-}" | tr ',' '\n' | grep -qx bot; then
      bot_up=0
      for _ in $(seq 1 20); do
        if withsecrets "${COMPOSE[*]} ps --status running --services" | grep -qx bot; then bot_up=1; break; fi
        sleep 3
      done
      [ "$bot_up" = 1 ] || { echo "FAIL: COMPOSE_PROFILES enables the bot but the bot container is not running:"; withsecrets "${COMPOSE[*]} logs --no-color --tail 20 bot"; exit 1; }
      echo "bot: running"
    fi
```

주의: `set -o pipefail` 환경이므로 `grep -qx` 가 조기 종료해도 `ps` 는 정상 종료한다(출력이 짧다). `withsecrets` 는 문자열을 `sops exec-env` 에 넘기므로 파이프는 바깥에 둔다.

- [ ] **Step 2: bootstrap.sh 템플릿** — `# MOI_IMAGE_TAG=<commit sha>` 줄 뒤에:

```bash
# COMPOSE_PROFILES=bot          # start the strategy runner with the stack (needs infra/bot/runner.json and DISCORD_WEBHOOK_TRADE_URL)
```

- [ ] **Step 3: 확인** — `bash -n infra/oracle/deploy.sh infra/oracle/bootstrap.sh`; 계약 체커 규칙은 Task 4.

- [ ] **Step 4: 커밋**

```bash
git add infra/oracle/deploy.sh infra/oracle/bootstrap.sh
git commit -m "feat(ops): COMPOSE_PROFILES=bot 이 켜져 있으면 배포 verify 가 러너 기동을 요구한다

bot 은 /etc/moi/moi.env 의 COMPOSE_PROFILES=bot 으로 켠다 — systemd 와 deploy.sh 가 이미 그 파일을
읽으므로 pull/up/stop 이 저절로 bot 을 포함한다. 켜진 채 러너가 설정을 거부하면 재시작 루프가 되는데,
그것을 restart: unless-stopped 뒤에 숨기지 않고 배포 실패로 드러낸다."
```

---

### Task 3: Discord 배선 + #92 마스커 통일

**Files:**
- Modify: `packages/strategy-reporter/src/index.ts`, `packages/strategy-reporter/src/discord-reporter.test.ts:14-28,83-91`
- Modify: `apps/strategy-runner/package.json`, `apps/strategy-runner/src/package-surface.test.ts:39-42`
- Create: `apps/strategy-runner/src/runner/reporter-wiring.ts`, `apps/strategy-runner/src/runner/reporter-wiring.test.ts`
- Modify: `apps/strategy-runner/src/main.ts`, `src/reporter.ts:34`, `src/runner/kill-switch.ts:210,425,440`, `src/backtest/report.ts:44,136`, `src/index.ts`(`redact` export 제거)
- Delete: `apps/strategy-runner/src/transport/redact.ts`, `redact.test.ts`
- Modify: `apps/strategy-runner/src/reporter.test.ts:32`, `src/feed/stream-client.test.ts:243`

**Interfaces:**
- Produces:
  ```ts
  // reporter-wiring.ts
  export interface ReporterWiring { readonly reporter: Reporter; readonly discord: boolean; close(): Promise<void>; }
  export function wireReporter(options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly write?: (line: string) => void;              // stdout 기본
    readonly secrets: () => readonly string[];             // 세션 쿠키·CSRF, 지연 조회
    readonly source?: string;                              // hostname
    readonly transport?: ReportTransport;                  // 테스트용
  }): ReporterWiring;                                       // 형식 오류 webhook → DomainError('INVALID_CONFIG'?) 확인: config.ts 의 invalid() 코드 재사용
  ```
  `@moi/strategy-reporter` index 가 `createDiscordReporter`, `type DiscordReporter`, `type RunnerReporter` 를 export.

- [ ] **Step 1: RED — 배선 테스트** `reporter-wiring.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { wireReporter } from './reporter-wiring.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456789/abcDEF_ghi-jkl';

describe('wireReporter', () => {
  it('writes lines only when no trade webhook is configured', async () => {
    const lines: string[] = [];
    const wiring = wireReporter({ env: {}, write: (line) => lines.push(line), secrets: () => [] });

    wiring.reporter.report('info', 'hello', { a: 1 });
    await wiring.close();

    expect(wiring.discord).toBe(false);
    expect(lines).toStrictEqual(['[info] hello a=1']);
  });

  it('fans out to Discord and stdout when the trade webhook is set, masking held secrets', async () => {
    const lines: string[] = [];
    const sent: string[] = [];
    const wiring = wireReporter({
      env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK },
      write: (line) => lines.push(line),
      secrets: () => ['cookie-value-0123456789'],
      source: 'test-host',
      transport: { send: async (body) => { sent.push(body); return { ok: true, status: 204 }; } },
    });

    wiring.reporter.report('error', 'the kill switch is engaged', { reason: 'cookie-value-0123456789 leaked' });
    await wiring.close();

    expect(wiring.discord).toBe(true);
    expect(lines).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('cookie-value-0123456789');
    expect(JSON.parse(sent[0] as string).embeds[0].color).toBe(15_026_253);
  });

  it('refuses a malformed trade webhook instead of starting silent', () => {
    expect(() =>
      wireReporter({ env: { DISCORD_WEBHOOK_TRADE_URL: 'http://not-discord.example' }, secrets: () => [] }),
    ).toThrow(/DISCORD_WEBHOOK_TRADE_URL must be an https Discord webhook URL/u);
  });

  it('refuses the operational webhook reused as the trade webhook', () => {
    expect(() =>
      wireReporter({
        env: { DISCORD_WEBHOOK_TRADE_URL: WEBHOOK, DISCORD_WEBHOOK_URL: WEBHOOK },
        secrets: () => [],
      }),
    ).toThrow(/must be a different channel/u);
  });
});
```

`ReportTransport` 의 정확한 시그니처(`send(body: string): Promise<SendResult>` 인지)는 `discord-transport.ts` 를 열어 맞춘다.

Run: `corepack pnpm --filter @moi/strategy-runner exec vitest run src/runner/reporter-wiring.test.ts` → 모듈 없음 FAIL.

- [ ] **Step 2: 의존·export** — `apps/strategy-runner/package.json` dependencies 에 `"@moi/strategy-reporter": "workspace:*"`; `corepack pnpm install` (lockfile 갱신 — 커밋에 포함); `package-surface.test.ts` 의 기대 배열에 `'@moi/strategy-reporter'` 를 추가하고 그 위 주석에 "and, since phase D, `@moi/strategy-reporter` — a pure text/HTTP adapter that reaches neither the ledger nor a provider (§16.49)" 를 더한다. `packages/strategy-reporter/src/index.ts` 에:

```ts
export {
  createDiscordReporter,
  type DiscordReporter,
  type RunnerReporter,
  type RunnerReportFields,
  type RunnerReportLevel,
} from './discord-reporter.js';
```

- [ ] **Step 3: `reporter-wiring.ts`**

```ts
import { hostname } from 'node:os';
import {
  createDiscordReporter,
  type ReportTransport,
  readReporterConfig,
} from '@moi/strategy-reporter';
import { DomainError } from '@moi/trading-core';
import { createLineReporter, type Reporter } from '../reporter.js';

/**
 * How the runner speaks (design §3, §7.4): always to stdout — `docker logs` is
 * the operator's first look — and, when `DISCORD_WEBHOOK_TRADE_URL` is set, to
 * the bot's own Discord channel as well. The two are fanned out here so that
 * every module keeps taking one `Reporter`.
 *
 * A malformed webhook refuses to start rather than starting silent: the
 * preflight makes the same judgement for a deploy, and a bot whose alerts go
 * nowhere is a bot nobody is watching. A *missing* webhook is not an error —
 * reporting may not be a reason a runner refuses to start (`readReporterConfig`).
 */
export interface ReporterWiring {
  readonly reporter: Reporter;
  readonly discord: boolean;
  /** Flushes what Discord has queued. For shutdown. */
  close(): Promise<void>;
}

export interface ReporterWiringOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly write?: (line: string) => void;
  /** Read at send time: the session cookie and CSRF token rotate. */
  readonly secrets: () => readonly string[];
  readonly source?: string;
  readonly transport?: ReportTransport;
}

export function wireReporter(options: ReporterWiringOptions): ReporterWiring {
  const lines = createLineReporter(options.write);
  const config = readReporterConfig(options.env);

  if (!config.ok) {
    throw new DomainError('INVALID_CONFIG', config.problem);
  }

  if (config.webhookUrl.length === 0 && options.transport === undefined) {
    return { reporter: lines, discord: false, close: async () => {} };
  }

  const discord = createDiscordReporter({
    ...(config.webhookUrl.length === 0 ? {} : { webhookUrl: config.webhookUrl }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    secrets: options.secrets,
    source: options.source ?? hostname(),
    onDiagnostic: (line) => lines.report('warn', line),
  });

  return {
    discord: true,
    reporter: {
      report: (level, message, fields) => {
        lines.report(level, message, fields);
        discord.report(level, message, fields);
      },
    },
    close: () => discord.close(),
  };
}
```

`'INVALID_CONFIG'` 가 `DomainErrorCode` 에 없으면 `config.ts` 의 `invalid()` 가 쓰는 코드를 그대로 쓴다(그 파일 상단 확인).

- [ ] **Step 4: `main.ts`**

```ts
export async function main(): Promise<void> {
  const config = loadRunnerConfig({ env: process.env, registry: DEFAULT_REGISTRY });
  let supervisor: RunnerSupervisor | null = null;
  const wiring = wireReporter({
    env: process.env,
    // The session cell is the runner's own file; read lazily because the
    // supervisor that owns it is built below, and the values rotate.
    secrets: () => {
      const session = supervisor?.state.session.read() as
        | { cookie?: unknown; csrfToken?: unknown }
        | null
        | undefined;

      return [session?.cookie, session?.csrfToken].filter(
        (value): value is string => typeof value === 'string',
      );
    },
  });
  const reporter = wiring.reporter;
  …(tickLog·supervisor 생성은 그대로, supervisor 변수에 대입)…
  reporter.report('info', 'the strategy runner is starting', { origin: config.apiOrigin, strategies: …, discord: wiring.discord });

  try {
    await supervisor.start();
    await supervisor.run();
  } finally {
    supervisor.close();
    await wiring.close();
  }
}
```

기동 거부(`catch` 아래)의 `createLineReporter().report(...)` 는 그대로 — 설정 실패는 Discord 이전에 일어난다. `loadRunnerConfig` 를 먼저 부르는 순서는 유지(리포터 배선의 오류도 같은 catch 로).

- [ ] **Step 5: #92** — `reporter.ts`: `import { maskOutbound } from '@moi/strategy-reporter'`, `formatReport` 가 `maskOutbound(...)`. 파일 머리 주석의 "Redaction is applied by the reporter itself" 단락에 "with the same `maskOutbound` the Discord side uses — one masker, not two (#92)" 를 더한다. `kill-switch.ts` 세 곳 `redact(` → `maskOutbound(`, import 교체. `backtest/report.ts` 두 곳 동일. `index.ts` 의 `export { redact } from './transport/redact.js';` 삭제. `transport/redact.ts`·`redact.test.ts` 삭제. 테스트 갱신: `reporter.test.ts:32` 기대를 `'[info] reusing moi_session=*** header=x-csrf-token: ***'` 로(정확한 출력은 실행해 확인 — `maskOutbound` 의 CSRF 규칙이 값을 `***` 로 바꾸는지), `stream-client.test.ts:243` 을 `.toContain('moi_session=***')` 로. `discord-reporter.test.ts` 의 `RUNNER_REDACTED` 상수와 "masks every shape the runner’s own redactor masks" 테스트를 지우고 그 자리에 한 줄 주석: "The runner uses this package's `maskOutbound` directly since phase D (#92); there is no second masker to drift from."

- [ ] **Step 6: 확인** — `corepack pnpm --filter @moi/strategy-reporter build && corepack pnpm --filter @moi/strategy-reporter test && corepack pnpm --filter @moi/strategy-runner typecheck && corepack pnpm --filter @moi/strategy-runner test` 전부 PASS. `grep -rn "redact" apps/strategy-runner/src` → 0.

- [ ] **Step 7: 커밋**

```bash
git add pnpm-lock.yaml apps/strategy-runner packages/strategy-reporter
git commit -m "feat(strategy-runner): Discord 트레이드 채널 배선과 마스커 통일

main 이 DISCORD_WEBHOOK_TRADE_URL 을 읽어 라인 리포터와 Discord 리포터를 팬아웃한다 — stdout 은
docker logs 용으로 남고, 형식이 틀린 웹훅은 preflight 와 같은 판정으로 기동을 거부한다(조용히 뜨는
봇은 지켜보는 사람이 없는 봇이다). 러너가 @moi/strategy-reporter 에 의존하게 되므로(§16.49) 두 벌이던
마스커를 maskOutbound 하나로 합친다(#92) — 오늘 moi_session 개행 유출을 양쪽에서 각각 고쳤던 비용이다."
```

---

### Task 4: 계약 체커 규칙 + 변이 테스트

**Files:**
- Modify: `scripts/check-deployment-contract.mjs`(`image build contexts` 루프에 `apps/strategy-runner`; 새 check 셋), `scripts/check-deployment-contract.test.mjs`(TRACKED 에 `apps/strategy-runner/Dockerfile`, `packages/strategy-reporter/package.json`; 변이 4건)

- [ ] **Step 1: RED — 변이 테스트 4건** (`botCases` 뒤, 같은 `describe` 안):

```js
  it('fails when the publish workflow does not build the strategy runner image', () => {
    const dir = copyRepo((d) => {
      const file = join(d, '.github/workflows/publish.yml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\n\s*- name: strategy-runner\n\s*dockerfile: apps\/strategy-runner\/Dockerfile/, ''));
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /publish\.yml must build an image for compose service bot/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails when the production overlay lets the bot build on the host', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/compose.override.yaml');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\n  bot:\n    image: [^\n]+\n    build: !reset null\n/, '\n'));
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /overlay must pull bot from GHCR/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails when the bot image runs something other than the runner entry point', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'apps/strategy-runner/Dockerfile');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/CMD \["node", "apps\/strategy-runner\/dist\/main\.js"\]/, 'CMD ["node", "apps/strategy-runner/dist/index.js"]'));
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /bot Dockerfile CMD must run apps\/strategy-runner\/dist\/main\.js/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails when deploy.sh stops checking that an enabled bot is running', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/oracle/deploy.sh');
      writeFileSync(file, readFileSync(file, 'utf8').replace(/COMPOSE_PROFILES/g, 'COMPOSE_PROFILE'));
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /deploy\.sh must fail the release when COMPOSE_PROFILES enables the bot/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
```

TRACKED 에 `'apps/strategy-runner/Dockerfile'`, `'packages/strategy-reporter/package.json'` 추가(워크스페이스 의존 커버 검사가 러너 매니페스트를 걸으며 리포터 패키지를 찾는다). Run: `node --test scripts/check-deployment-contract.test.mjs` → 4건 FAIL.

- [ ] **Step 2: 체커 규칙** — `image build contexts` 루프의 배열을 `['apps/paper-api', 'apps/web', 'apps/strategy-runner']` 로. 새 check 셋:

```js
check('bot image', () => {
  const instructions = checkDockerfile('apps/strategy-runner/Dockerfile');
  const cmd = instructions.filter((i) => i.instruction === 'CMD').at(-1);
  assert.ok(cmd, 'bot Dockerfile needs CMD');
  assert.match(cmd.args, /apps\/strategy-runner\/dist\/main\.js/, 'bot Dockerfile CMD must run apps/strategy-runner/dist/main.js');
  assert.match(cmd.args, /"node"/, 'bot CMD must use exec form with node');
  assert.ok(!instructions.some((i) => i.instruction === 'EXPOSE'), 'the bot serves nothing and must not EXPOSE a port');
  const runs = instructions.filter((i) => i.instruction === 'RUN').map((i) => i.args);
  assert.ok(runs.some((r) => /chown node:node \/var\/lib\/moi-bot/.test(r)), 'bot image must own /var/lib/moi-bot as node, or the read-only runtime cannot write its state volume');
});

check('publish workflow builds every image compose ships', () => {
  const workflow = readYaml('.github/workflows/publish.yml');
  const built = (workflow.jobs.images.strategy.matrix.include ?? []).map((entry) => entry.dockerfile);
  for (const [name, service] of Object.entries(compose.services)) {
    const dockerfile = service.build?.dockerfile;
    if (!dockerfile) continue;
    assert.ok(built.includes(dockerfile), `publish.yml must build an image for compose service ${name} (${dockerfile})`);
  }
});

check('production overlay pulls every built image from GHCR', () => {
  const overlay = readYaml('infra/oracle/compose.override.yaml');
  for (const [name, service] of Object.entries(compose.services)) {
    if (!service.build?.dockerfile) continue;
    const over = overlay.services?.[name];
    assert.ok(over, `overlay must pull ${name} from GHCR`);
    assert.match(String(over.image ?? ''), /^ghcr\.io\/changminko\/moi-[a-z-]+:\$\{MOI_IMAGE_TAG:-main\}$/, `overlay must pull ${name} from GHCR under MOI_IMAGE_TAG`);
    assert.equal(over.build, null, `overlay must reset ${name}'s build so the host never builds`);
  }
});

check('deploy verifies an enabled bot', () => {
  const script = read('infra/oracle/deploy.sh');
  assert.ok(/COMPOSE_PROFILES/.test(script) && /ps --status running --services/.test(script) && /grep -qx bot/.test(script), 'deploy.sh must fail the release when COMPOSE_PROFILES enables the bot but the container is not running');
});
```

`!reset null` 은 yaml 파서에서 `null` 로 읽히는지 확인(태그 `!reset` 을 모르는 파서는 던질 수 있다 — 그러면 `parseYaml` 에 `customTags` 로 `!reset` 을 `null` 로 매핑하거나 텍스트 정규식으로 검사한다). `compose` 변수는 이미 `infra/compose.yaml` 파싱 결과(라인 278).

- [ ] **Step 3: 확인** — `corepack pnpm check:deployment` → `Deployment contract holds.`; `corepack pnpm test:deployment` → 전부 PASS(새 4건 포함).

- [ ] **Step 4: 커밋**

```bash
git add scripts/check-deployment-contract.mjs scripts/check-deployment-contract.test.mjs
git commit -m "ci(ops): 배포 계약이 러너 이미지를 덮는다 — publish 매트릭스·GHCR overlay·CMD·상태 디렉터리 소유·배포 verify

compose 가 Dockerfile 을 가진 서비스마다 publish.yml 이 이미지를 짓고 overlay 가 GHCR 에서 끌어와야 한다는 것을
셋 사이의 관계로 검사한다(항목 이름을 따로 적는 대신). 각 규칙은 지우면 무는 변이 테스트를 갖는다."
```

---

### Task 5: 운영자 예시 설정의 실행 검증

**Files:**
- Modify: `infra/bot/runner.example.json`, `apps/strategy-runner/src/config.test.ts`

- [ ] **Step 1: RED** — `config.test.ts` 끝에:

```ts
/**
 * #93: the file an operator copies must be a file the runner accepts. Loaded
 * for real rather than compared by eye — phase C added two limits after the
 * example was written, and the example did not follow.
 */
describe('infra/bot/runner.example.json', () => {
  it('loads through loadRunnerConfig unchanged', () => {
    const example = readFileSync(
      fileURLToPath(new URL('../../../infra/bot/runner.example.json', import.meta.url)),
      'utf8',
    );
    const config = loadRunnerConfig({
      env: { BOT_API_ORIGIN: 'http://paper-api:3000', BOT_CONFIG_PATH: '/etc/moi-bot/runner.json', BOT_STATE_DIR: '/var/lib/moi-bot' },
      registry: DEFAULT_REGISTRY,
      readFile: () => example,
    });

    expect(config.strategies.map((each) => each.name)).toStrictEqual(['samsung-sma']);
    expect(config.risk.maxConsecutiveLosses).toBeGreaterThan(0);
  });
});
```

import 에 `readFileSync`(node:fs)·`fileURLToPath`(node:url). Run → `maxConsecutiveLosses` 누락으로 FAIL(정확한 메시지는 `readRiskLimits` 가 낸다).

- [ ] **Step 2: 예시 수정** — `risk` 에 `"maxConsecutiveLosses": 3, "maxDailyLoss": "200000"` 추가(README 예시와 같은 값).

- [ ] **Step 3: 확인** — 테스트 PASS. `corepack pnpm check:deployment` 도(예시 존재 검사).

- [ ] **Step 4: 커밋**

```bash
git add infra/bot/runner.example.json apps/strategy-runner/src/config.test.ts
git commit -m "fix(ops): 운영자 예시 설정이 실제로 로드된다 — phase C 손실 한도 두 개가 빠져 기동이 거부됐다

infra/bot/runner.example.json 을 loadRunnerConfig 에 그대로 넣는 테스트를 두어(#93), 예시가 스키마와
어긋나면 눈이 아니라 테스트가 잡는다."
```

---

### Task 6: 문서 + §16.49

**Files:**
- Modify: `docs/operations/deployment.md:330-354`, `infra/bot/README.md`, `apps/strategy-runner/README.md`(D 행·환경변수 표·"What is here"), `docs/operations/release-checklist.md`(이미지 Trivy 행을 3종으로), 스펙 `2026-08-27-…-design.md` §16 끝

- [ ] **Step 1: deployment.md** bot 절을 다시 쓴다:

```markdown
## Strategy runner (`bot`, opt-in)

The strategy runner is the compose service `bot`, behind the `bot` profile, built
from `apps/strategy-runner/Dockerfile` and published by
`.github/workflows/publish.yml` as `ghcr.io/changminko/moi-strategy-runner`
(amd64 + arm64, Trivy-gated, like the other two). The Oracle overlay pulls it under
the same `MOI_IMAGE_TAG`.

**A profile-gated service does not start on its own.** It joins the stack when
`/etc/moi/moi.env` says so:

```
COMPOSE_PROFILES=bot
```

systemd (`moi.service`) and `infra/oracle/deploy.sh` both read that file, so with
the line present `pull`, `up` and `stop` include the bot, a release restarts it
with the stack, and the deploy's verify step **fails unless the bot container is
running** — a runner that refuses its configuration is a restart loop, and that
must not hide behind `restart: unless-stopped`. Remove the line and restart to
take it out again.

Before enabling it:

1. `cp infra/bot/runner.example.json infra/bot/runner.json` on the host
   (`/opt/moi/infra/bot/`) and edit it — the runner has no default risk limits and
   refuses to start without the file. It is mounted read-only at `/etc/moi-bot`.
2. Put `DISCORD_WEBHOOK_TRADE_URL` in the sops file: the bot's **own** channel,
   never `DISCORD_WEBHOOK_URL` (the preflight and the contract checker both
   refuse the same URL under both names). Without it the bot still runs and
   reports to `docker logs` only.
3. `sudo /opt/moi/infra/oracle/deploy.sh main`.

Clearing the kill switch (`apps/strategy-runner/README.md`, "The kill switch"):
delete `kill-switch.json` from the `bot-state` volume and restart the bot —
`docker compose … exec bot rm /var/lib/moi-bot/kill-switch.json` then
`docker compose … restart bot`.
```

- [ ] **Step 2: infra/bot/README.md** — 실행 명령 블록을 `COMPOSE_PROFILES=bot` 방식으로(수동 `--profile bot up` 은 로컬 compose 용으로만 남긴다), Discord 웹훅 단락에 `DISCORD_WEBHOOK_TRADE_URL` 이름 명시.

- [ ] **Step 3: runner README** — "Deliberately not here" 표의 `Discord embeds, the compose service | D (#93)` 행을 "**here since phase D** — `runner/reporter-wiring.ts`, `Dockerfile`, `COMPOSE_PROFILES=bot`" 로; 설정 표에 `DISCORD_WEBHOOK_TRADE_URL`(선택, 형식 오류는 기동 거부) 행; 첫 단락 "phase D's kill-switch core" 를 "phase D (kill switch, image, Discord)" 로.

- [ ] **Step 4: release-checklist.md** — 119행 근처 "both final images" 를 "all three final images (`paper-api`, `web`, `strategy-runner`)" 로 하고 체크는 **비운 채**(`- [ ]`) 둔다 — 첫 발행의 Trivy 결과는 CI 가 낸 뒤 사람이 적는다.

- [ ] **Step 5: §16.49** — 16.48 행 아래 한 줄:

```markdown
| 16.49 | 전략 러너 설계 §3 "`apps/strategy-runner`는 `@moi/strategy-sdk`와 `@moi/trading-core`에만 의존한다" | **`@moi/strategy-reporter` 에도 의존한다.** §7.4 의 Discord 리포터는 그 패키지에 있고(#82), 러너가 그것을 조립하지 않으면 §11 D 의 "호스트에서 임베드 수신" 은 닫히지 않는다. 경계의 목적은 원장 내부(`@moi/paper-api`)와 프로바이더 어댑터(`@moi/market-data`)를 결정 경로에서 떼어 놓는 것이고 리포터 패키지는 둘 다 닿지 않는 순수 텍스트·HTTP 어댑터라(의존성 0), 금지 목록은 그대로다 — `package-surface.test.ts` 가 허용 셋과 금지 넷을 함께 고정한다. 같은 이유로 마스커도 그 패키지의 `maskOutbound` 하나로 합쳤다(#92): 두 벌이던 규칙을 각각 고치던 비용이 통일의 이유다(마스크 토큰이 `[redacted]` 에서 `***` 로 바뀐다). bot 이 스택에 붙는 방법은 설계에 없던 결정이다 — `/etc/moi/moi.env` 의 `COMPOSE_PROFILES=bot`: systemd 와 deploy.sh 가 이미 읽는 파일이라 pull/up/stop 이 저절로 포함하고, deploy verify 는 프로필이 켜져 있으면 bot 컨테이너의 running 을 요구한다(설정 거부의 재시작 루프를 `restart: unless-stopped` 뒤에 숨기지 않는다). 형식이 틀린 `DISCORD_WEBHOOK_TRADE_URL` 은 러너도 기동을 거부한다(preflight 와 같은 판정; 비어 있으면 stdout 만). | `package-surface.test.ts`, `reporter-wiring.test.ts`(팬아웃·마스킹·형식 오류 거부·동일 채널 거부), `config.test.ts` "infra/bot/runner.example.json loads", `check-deployment-contract.test.mjs`(publish 매트릭스·overlay·CMD·deploy verify 변이 4건), 로컬 `docker build` + 설정 없는 컨테이너의 fail-closed 거부 |
```

- [ ] **Step 6: 커밋**

```bash
git add docs apps/strategy-runner/README.md infra/bot/README.md
git commit -m "docs(ops): 러너를 켜는 절차 — COMPOSE_PROFILES=bot, 트레이드 웹훅, 킬 스위치 해제; §16.49"
```

---

### Task 7: 게이트·변이·PR

- [ ] **Step 1: 게이트** (`set -o pipefail`) — `pnpm check` · `pnpm typecheck` · `pnpm --filter @moi/strategy-runner test` · `pnpm --filter @moi/strategy-reporter test` · `pnpm check:deployment` · `pnpm test:deployment` · `pnpm test:preflight` · `pnpm build` · `docker build -f apps/strategy-runner/Dockerfile .` · paper-api 의 `strategy-runner*.integration.test.ts` 3건(마스커 교체가 통합 경로를 건드리므로; 단독 실행).
- [ ] **Step 2: 변이(커밋 뒤에만)** — `wireReporter` 의 팬아웃에서 `discord.report` 제거 → 배선 테스트 문다; `main.ts` 의 `await wiring.close()` 제거 → 고정 테스트가 없다면 배선 테스트에 "close flushes" 를 두어 문다; 계약 체커 규칙 4건은 Task 4 테스트가 문다.
- [ ] **Step 3: PR** — 제목 `feat(ops): 전략 러너 실배선 — 이미지·COMPOSE_PROFILES=bot·Discord 트레이드 채널·마스커 통일 (#93 #92)`. 본문: 무엇/어떻게/검증/리뷰 레인 2/후속(#86, #88, #89; **프로덕션에서 켜는 것은 별도 결정** — runner.json·웹훅·`COMPOSE_PROFILES`). `Closes #93`, `Closes #92`.
