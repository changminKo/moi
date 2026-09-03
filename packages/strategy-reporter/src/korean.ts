/**
 * The Korean the Discord channel speaks.
 *
 * The runner reports in English and keeps doing so: that line is the key the
 * aggregation dedupes on, the `kind` in the embed footer and the text in
 * `docker logs`, and every test that reads a recording reporter pins it. What
 * changes is the embed an operator reads. The title is rendered in Korean from
 * the table below, the original stays underneath behind a Discord spoiler
 * (`||…||`, the closest thing the client has to 펼쳐보기), and a field whose
 * name this file knows is labelled `사유 (reason)` — Korean first, the
 * original kept beside it so a runbook that names the field still matches.
 *
 * A message this file does not know is posted as it is. Better an English
 * embed than a wrong Korean one, and better still a new row in the table.
 * Every table entry is checked in `korean.test.ts` to be Korean and to differ
 * from its key.
 *
 * Nothing here touches masking: the Korean is produced *before* the reporter's
 * single `maskOutbound` choke point, so it is masked like everything else.
 */

/** Runner messages with no variable part, English → Korean. */
export const KOREAN_MESSAGES: Readonly<Record<string, string>> = {
  // main / wiring
  stopping: '러너를 멈춥니다',
  'the strategy runner is starting': '전략 러너를 시작합니다',
  'the strategy runner refused to run': '전략 러너가 실행을 거부했습니다',
  'the strategy runner stopped on an error': '전략 러너가 오류로 멈췄습니다',
  // strategy host
  'a strategy could not restore its state and is quarantined':
    '전략이 상태를 복원하지 못해 격리되었습니다',
  'a strategy could not be snapshotted': '전략 스냅샷을 저장하지 못했습니다',
  // kill switch
  'the kill switch is engaged; new orders are refused and resting orders are being cancelled':
    '킬 스위치가 걸렸습니다. 신규 주문은 거부되고 미체결 주문은 취소 중입니다',
  'the kill switch is still engaged': '킬 스위치가 아직 걸려 있습니다',
  'the kill-switch file could not be read and will be retried next cycle':
    '킬 스위치 파일을 읽지 못했습니다. 다음 사이클에 다시 시도합니다',
  'the kill switch could not be persisted; it holds in memory but a restart would come up trading':
    '킬 스위치를 저장하지 못했습니다. 메모리에서는 유지되지만 재시작하면 매매가 재개됩니다',
  'the cancel sweep failed': '취소 스윕이 실패했습니다',
  'the cancel sweep found no resting orders':
    '취소 스윕에서 미체결 주문이 없었습니다',
  'the cancel sweep left resting orders after its last pass':
    '취소 스윕 마지막 패스 뒤에도 미체결 주문이 남았습니다',
  // supervisor
  'a market-data gap was observed': '시세 데이터 공백이 관측되었습니다',
  'the market stream is ready': '시세 스트림이 준비되었습니다',
  'the paper API is not serving yet; waiting before the first connect':
    '페이퍼 API 가 아직 서빙 전이라 첫 연결을 기다립니다',
  'the paper API is serving': '페이퍼 API 가 서빙 중입니다',
  'the paper API did not reach SERVING before the wait ran out; connecting anyway':
    '페이퍼 API 가 대기 시간 안에 SERVING 에 도달하지 않아 그대로 연결합니다',
  'a runner cycle failed': '러너 사이클이 실패했습니다',
  'the risk gate refused an order': '리스크 게이트가 주문을 거부했습니다',
  // tick log
  'the tick log could not be written and recording has stopped; the run continues':
    '틱 로그를 기록하지 못해 기록을 중단했습니다. 실행은 계속됩니다',
  // market stream
  'the market stream has failed repeatedly and is retrying on a slow schedule':
    '시세 스트림이 반복 실패하여 느린 주기로 재시도합니다',
  'the market stream has no session to connect with yet':
    '시세 스트림에 연결할 세션이 아직 없습니다',
  'the market stream errored': '시세 스트림에 오류가 났습니다',
  'the market stream closed': '시세 스트림이 닫혔습니다',
  'the market stream stopped sending heartbeats and is being replaced':
    '시세 스트림의 하트비트가 끊겨 교체합니다',
  'the market stream could not re-baseline after connecting':
    '시세 스트림 연결 후 기준가를 다시 읽지 못했습니다',
  'the market stream demanded a resync; account events between the committed cursor and now were not delivered':
    '시세 스트림이 재동기화를 요구했습니다. 커밋된 커서와 현재 사이의 계정 이벤트가 전달되지 않았습니다',
  'the resync failed': '재동기화가 실패했습니다',
  'an account event arrived without its identity and was dropped':
    '식별자 없는 계정 이벤트가 도착하여 버렸습니다',
  'an account event could not be processed and will be replayed':
    '계정 이벤트를 처리하지 못해 다시 재생합니다',
  'a quote frame could not be read': '시세 프레임을 읽지 못했습니다',
  'a quote poll failed': '시세 폴링이 실패했습니다',
  // fills
  'a fill event carried no fill records; the cursor is held here until the ledger is fixed, so the event replays rather than being lost':
    '체결 이벤트에 체결 레코드가 없습니다. 원장이 고쳐질 때까지 커서를 여기서 멈춰 이벤트가 유실되지 않고 재생됩니다',
  'a fill record could not be read; the cursor is held here until the ledger is fixed, so the event replays rather than being lost':
    '체결 레코드를 읽지 못했습니다. 원장이 고쳐질 때까지 커서를 여기서 멈춰 이벤트가 유실되지 않고 재생됩니다',
  'a fill record named a different account sequence than the event carrying it; the cursor is held here until the ledger is fixed, so the event replays rather than being lost':
    '체결 레코드의 계정 시퀀스가 이벤트와 다릅니다. 원장이 고쳐질 때까지 커서를 여기서 멈춰 이벤트가 유실되지 않고 재생됩니다',
  'a fill could not be applied to the position the runner was tracking; realised PnL is discontinuous from here and the basis has been re-read from the ledger':
    '체결을 추적 중인 포지션에 적용하지 못했습니다. 실현 손익은 여기부터 불연속이며 기준가는 원장에서 다시 읽었습니다',
  'a fill was applied': '체결이 반영되었습니다',
  'the strategy answered a replayed fill differently':
    '전략이 재생된 체결에 다른 답을 냈습니다',
  'a resync was demanded but the ledger is not ahead of the committed cursor':
    '재동기화가 요구되었지만 원장이 커밋된 커서보다 앞서 있지 않습니다',
  'the account cursor was advanced over events that were never delivered; realised PnL from here is measured over an incomplete series':
    '전달되지 않은 이벤트를 건너뛰어 계정 커서를 옮겼습니다. 실현 손익은 여기부터 불완전한 계열로 계산됩니다',
  // session
  'the stored session has expired': '저장된 세션이 만료되었습니다',
  'reusing the stored session': '저장된 세션을 재사용합니다',
  'the trading session was replaced; the previous session’s open orders can no longer be cancelled by the bot':
    '매매 세션이 교체되었습니다. 이전 세션의 미체결 주문은 봇이 더는 취소할 수 없습니다',
  'created a trading session': '매매 세션을 만들었습니다',
  'session replaced': '세션이 교체되었습니다',
  // order gateway
  'resubmitting decisions that were recorded but never settled':
    '기록되었지만 확정되지 않은 결정을 다시 제출합니다',
};

/** `DecisionKind` in `apps/strategy-runner/src/gateway/order-gateway.ts`. */
const DECISION_KINDS: Readonly<Record<string, string>> = {
  place: '주문',
  cancel: '취소 주문',
};

/** The tail of `the ${kind} …` messages the order gateway reports. */
const DECISION_OUTCOMES: Readonly<Record<string, (kind: string) => string>> = {
  'was accepted': (kind) => `${kind}이 접수되었습니다`,
  'will be retried': (kind) => `${kind}을 다시 시도합니다`,
  'was halted by the kill switch': (kind) => `${kind}이 킬 스위치에 막혔습니다`,
  'could not be submitted and is left pending for the next start': (kind) =>
    `${kind}을 제출하지 못해 다음 시작까지 보류합니다`,
  'was rejected': (kind) => `${kind}이 거부되었습니다`,
};

/** `what` in `StrategyHost#contain`. */
const STRATEGY_CALLS: Readonly<Record<string, string>> = {
  'a tick': '틱',
  'a fill': '체결',
};

interface Template {
  readonly pattern: RegExp;
  readonly render: (match: RegExpMatchArray) => string | undefined;
}

/** Messages with a variable part, matched in order after the exact table. */
const TEMPLATES: readonly Template[] = [
  {
    pattern: /^the (\w+) (.+)$/,
    render: ([, kind = '', outcome = '']) => {
      const korean = DECISION_KINDS[kind];
      const render = DECISION_OUTCOMES[outcome];
      return korean === undefined || render === undefined
        ? undefined
        : render(korean);
    },
  },
  {
    pattern:
      /^a strategy threw on (\d+) consecutive calls and is quarantined; its open orders and position are untouched and need a person$/,
    render: ([, count = '']) =>
      `전략이 ${count}회 연속 예외를 던져 격리되었습니다. 미체결 주문과 포지션은 그대로이며 사람이 확인해야 합니다`,
  },
  {
    pattern: /^a strategy threw on (.+)$/,
    render: ([, what = '']) => {
      const korean = STRATEGY_CALLS[what];
      return korean === undefined
        ? undefined
        : `전략이 ${korean} 처리 중 예외를 던졌습니다`;
    },
  },
  {
    pattern:
      /^the kill switch is still engaged from a previous run; delete (.+) and restart to resume trading$/,
    render: ([, file = '']) =>
      `이전 실행의 킬 스위치가 아직 걸려 있습니다. 매매를 재개하려면 ${file} 을 삭제하고 재시작하세요`,
  },
];

/** The Korean for a runner message, or `undefined` when there is none. */
export function localizeMessage(message: string): string | undefined {
  const exact = KOREAN_MESSAGES[message];
  if (exact !== undefined) return exact;
  for (const { pattern, render } of TEMPLATES) {
    const match = message.match(pattern);
    if (match === null) continue;
    const rendered = render(match);
    if (rendered !== undefined) return rendered;
  }
  return undefined;
}

/**
 * The original, folded behind a Discord spoiler. A spoiler does not span a
 * newline, so the text is flattened onto one line first.
 */
export function withOriginal(original: string): string {
  return `||${original.replace(/\s*\n\s*/g, ' ')}||`;
}

/** Field names the runner reports, English → Korean. */
export const KOREAN_FIELD_LABELS: Readonly<Record<string, string>> = {
  signal: '신호',
  origin: 'API 주소',
  strategies: '전략 목록',
  discord: '디스코드',
  error: '오류',
  strategy: '전략',
  on: '시점',
  consecutiveFailures: '연속 실패',
  source: '출처',
  reason: '사유',
  engagedAt: '걸린 시각',
  code: '코드',
  passes: '패스 수',
  orderIds: '주문 ID 목록',
  instrument: '종목',
  sinceMs: '공백 (ms)',
  recoveryEpoch: '복구 세대',
  accountSequence: '계정 시퀀스',
  refusal: '거부 사유',
  path: '경로',
  failures: '실패 횟수',
  runtime: '런타임 상태',
  waitedMs: '대기 시간 (ms)',
  silentMs: '무응답 (ms)',
  eventType: '이벤트 종류',
  fillAccountSequence: '체결 계정 시퀀스',
  fillId: '체결 ID',
  side: '방향',
  quantity: '수량',
  price: '가격',
  realized: '실현 손익',
  decisionId: '결정 ID',
  answered: '응답',
  cursor: '커서',
  from: '시작',
  to: '끝',
  sessionId: '세션 ID',
  previousSessionId: '이전 세션 ID',
  'previous sessionId': '이전 세션 ID',
  count: '건수',
  orderId: '주문 ID',
  status: '상태',
  attempt: '시도',
};

/** `사유 (reason)` for a known field name; the name itself otherwise. */
export function fieldLabel(name: string): string {
  const korean = KOREAN_FIELD_LABELS[name];
  return korean === undefined ? name : `${korean} (${name})`;
}

export interface FooterCounts {
  /** Repeats of this message's own key folded into it. */
  readonly suppressed: number;
  /** Routine messages the shared bucket dropped. */
  readonly dropped: number;
  /** Distinct alerts evicted from a full queue. */
  readonly lost: number;
}

/**
 * The footer's count notes. `suppressed` is a fact about this message;
 * `dropped` and `lost` are facts about the channel, labelled apart so a
 * session-swap warn cannot be misread as having itself dropped three things.
 */
export function footerNotes(counts: FooterCounts): string {
  const channel = [
    counts.dropped > 0 ? `일반 ${counts.dropped}건 버림` : '',
    counts.lost > 0 ? `경보 ${counts.lost}건 손실` : '',
  ].filter((part) => part.length > 0);
  const parts = [
    counts.suppressed > 0 ? `+${counts.suppressed}건 생략` : '',
    channel.length > 0 ? `채널: ${channel.join(', ')}` : '',
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}
