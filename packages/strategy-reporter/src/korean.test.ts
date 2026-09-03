import { describe, expect, it } from 'vitest';
import {
  fieldLabel,
  footerNotes,
  KOREAN_FIELD_LABELS,
  KOREAN_MESSAGES,
  localizeMessage,
  withOriginal,
} from './korean.js';

describe('localizeMessage', () => {
  it('translates a fixed runner message', () => {
    expect(localizeMessage('the strategy runner is starting')).toBe(
      '전략 러너를 시작합니다',
    );
  });

  it('translates the templated order-gateway messages for both decision kinds', () => {
    expect(localizeMessage('the place was accepted')).toBe(
      '주문이 접수되었습니다',
    );
    expect(localizeMessage('the cancel was rejected')).toBe(
      '취소 주문이 거부되었습니다',
    );
    expect(localizeMessage('the place will be retried')).toBe(
      '주문을 다시 시도합니다',
    );
    expect(localizeMessage('the cancel was halted by the kill switch')).toBe(
      '취소 주문이 킬 스위치에 막혔습니다',
    );
    expect(
      localizeMessage(
        'the place could not be submitted and is left pending for the next start',
      ),
    ).toBe('주문을 제출하지 못해 다음 시작까지 보류합니다');
  });

  it('carries the variable part of a templated message across', () => {
    expect(
      localizeMessage(
        'a strategy threw on 3 consecutive calls and is quarantined; its open orders and position are untouched and need a person',
      ),
    ).toBe(
      '전략이 3회 연속 예외를 던져 격리되었습니다. 미체결 주문과 포지션은 그대로이며 사람이 확인해야 합니다',
    );
    expect(localizeMessage('a strategy threw on a tick')).toBe(
      '전략이 틱 처리 중 예외를 던졌습니다',
    );
    expect(localizeMessage('a strategy threw on a fill')).toBe(
      '전략이 체결 처리 중 예외를 던졌습니다',
    );
    expect(
      localizeMessage(
        'the kill switch is still engaged from a previous run; delete kill-switch.json and restart to resume trading',
      ),
    ).toBe(
      '이전 실행의 킬 스위치가 아직 걸려 있습니다. 매매를 재개하려면 kill-switch.json 을 삭제하고 재시작하세요',
    );
  });

  it('leaves a message it does not know alone', () => {
    expect(localizeMessage('boom')).toBeUndefined();
    expect(localizeMessage('')).toBeUndefined();
  });

  it('has a Korean line for every message in the table and never echoes English', () => {
    for (const [english, korean] of Object.entries(KOREAN_MESSAGES)) {
      expect(korean).not.toBe(english);
      expect(korean).toMatch(/[가-힣]/);
    }
  });
});

describe('withOriginal', () => {
  it('folds the original behind a Discord spoiler so it reads as 펼쳐보기', () => {
    expect(withOriginal('the strategy runner is starting')).toBe(
      '||the strategy runner is starting||',
    );
  });

  it('keeps the spoiler on one line — Discord does not span one across newlines', () => {
    expect(withOriginal('a\nb')).toBe('||a b||');
  });
});

describe('fieldLabel', () => {
  it('labels a known field in Korean and keeps the original beside it', () => {
    expect(fieldLabel('reason')).toBe('사유 (reason)');
    expect(fieldLabel('sessionId')).toBe('세션 ID (sessionId)');
  });

  it('keeps an unknown field name as it is', () => {
    expect(fieldLabel('tick')).toBe('tick');
  });

  it('never labels a field with its own name', () => {
    for (const [name, label] of Object.entries(KOREAN_FIELD_LABELS)) {
      expect(label).not.toBe(name);
      expect(label).toMatch(/[가-힣]/);
    }
  });
});

describe('footerNotes', () => {
  it('says nothing when nothing was folded or lost', () => {
    expect(footerNotes({ suppressed: 0, dropped: 0, lost: 0 })).toBe('');
  });

  it('renders the counts in Korean, channel facts apart from the message’s own', () => {
    expect(footerNotes({ suppressed: 49, dropped: 0, lost: 0 })).toBe(
      ' · +49건 생략',
    );
    expect(footerNotes({ suppressed: 0, dropped: 2, lost: 1 })).toBe(
      ' · 채널: 일반 2건 버림, 경보 1건 손실',
    );
    expect(footerNotes({ suppressed: 3, dropped: 2, lost: 0 })).toBe(
      ' · +3건 생략 · 채널: 일반 2건 버림',
    );
  });
});
