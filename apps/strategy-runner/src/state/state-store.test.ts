import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type DecisionRecord, StateStore, utcDay } from './state-store.js';

const opened: StateStore[] = [];

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-state-'));

function store(directory: string): StateStore {
  const opened_ = StateStore.open({ directory });

  opened.push(opened_);

  return opened_;
}

afterEach(() => {
  for (const each of opened.splice(0)) {
    each.close();
  }
});

const INTENT = {
  market: 'KR',
  symbol: '005930',
  side: 'BUY',
  type: 'MARKET',
  quantity: '1',
} as const;

const decision = (
  decisionId: string,
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord => ({
  decisionId,
  at: '2026-09-02T01:00:00.000Z',
  strategy: 'samsung',
  kind: 'place',
  reason: 'golden-cross',
  intent: INTENT,
  notional: '70000',
  ...overrides,
});

describe('StateStore decisions', () => {
  it('creates its directory and starts empty', () => {
    const directory = join(scratch(), 'nested', 'state');

    expect(store(directory).pendingDecisions()).toStrictEqual([]);
  });

  it('records a decision and reports it as pending until it settles', () => {
    const state = store(scratch());

    state.appendDecision(decision('d-1'));

    expect(
      state.pendingDecisions().map((each) => each.decisionId),
    ).toStrictEqual(['d-1']);

    state.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'accepted',
      orderId: 'o-1',
      status: 'OPEN',
    });

    expect(state.pendingDecisions()).toStrictEqual([]);
  });

  /** A rejection is an outcome. The decision is finished, not retried forever. */
  it('treats a rejection as settled', () => {
    const state = store(scratch());

    state.appendDecision(decision('d-1'));
    state.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'rejected',
      code: 'INSUFFICIENT_AVAILABLE_CASH',
    });

    expect(state.pendingDecisions()).toStrictEqual([]);
  });

  /**
   * The kill switch's verdict. A decision the barrier refused is finished: the
   * operator who clears the latch and restarts must not have yesterday's entry
   * resubmitted at them. So it settles, and it survives a reopen as settled.
   */
  it('treats a halted submission as settled, across a reopen', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendDecision(decision('d-1'));
    first.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'halted',
      code: 'KILL_SWITCH',
    });

    expect(first.pendingDecisions()).toStrictEqual([]);

    first.close();

    expect(store(directory).pendingDecisions()).toStrictEqual([]);
  });

  it('exposes the kill-switch cell at a fixed name in the state directory', () => {
    const directory = scratch();

    expect(store(directory).killSwitch.path).toBe(
      join(directory, 'kill-switch.json'),
    );
  });

  /**
   * The restart the criterion is about. A decision that was written down and
   * never submitted comes back, with its `decisionId` intact — which is the only
   * input the idempotency key needs.
   */
  it('recovers an unsubmitted decision across a reopen', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendDecision(decision('d-1'));
    first.appendDecision(decision('d-2'));
    first.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'accepted',
      orderId: 'o-1',
    });
    first.close();

    const recovered = store(directory).pendingDecisions();

    expect(recovered).toHaveLength(1);
    // `toEqual`, not `toStrictEqual`: the recovered intent came back through the
    // SDK's `readOrderIntent`, which builds its snapshot on a null prototype.
    // That is the SDK's own boundary discipline and not a difference in value.
    expect(recovered[0]).toEqual(decision('d-2'));
    expect(Object.getPrototypeOf(recovered[0]?.intent)).toBeNull();
  });

  /** §6.2's step 1: the decision is on disk before anything is submitted. */
  it('makes a decision readable from the file before appendDecision returns', () => {
    const directory = scratch();

    store(directory).appendDecision(decision('d-1'));

    expect(readFileSync(join(directory, 'decisions.ndjson'), 'utf8')).toContain(
      '"decisionId":"d-1"',
    );
  });

  it('records a cancel decision with the order it cancels', () => {
    const directory = scratch();
    const cancel: DecisionRecord = {
      decisionId: 'd-3',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'cancel',
      reason: 'risk-stop',
      orderId: 'o-9',
    };

    store(directory).appendDecision(cancel);
    opened.at(-1)?.close();

    expect(store(directory).pendingDecisions()).toStrictEqual([cancel]);
  });

  /**
   * A `noop` authorises nothing, so it is not a pending decision and nothing
   * waits on it reaching the platter. It is still written: "the strategy stood
   * still and here is why" is what makes the log reviewable.
   */
  it('writes a noop to the log without making it pending', () => {
    const directory = scratch();
    const state = store(directory);

    state.appendNoop({
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      reason: 'warming-up',
    });
    state.appendDecision(decision('d-1'));

    expect(
      state.pendingDecisions().map((each) => each.decisionId),
    ).toStrictEqual(['d-1']);
    expect(readFileSync(join(directory, 'decisions.ndjson'), 'utf8')).toContain(
      '"reason":"warming-up"',
    );
  });

  /**
   * The log holds noops as well as decisions, so reopening has to read past
   * them. Getting this wrong makes the runner unable to start the moment a
   * strategy has stood still once, which is every real run.
   */
  it('reopens a log that holds noops alongside decisions', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendNoop({
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      reason: 'warming-up',
    });
    first.appendDecision(decision('d-1'));
    first.appendNoop({
      at: '2026-09-02T01:00:02.000Z',
      strategy: 'samsung',
      reason: 'no-cross',
    });
    first.close();

    const reopened = store(directory);

    expect(
      reopened.pendingDecisions().map((each) => each.decisionId),
    ).toStrictEqual(['d-1']);
    expect(reopened.dailyEntryNotional('2026-09-02')).toBe('70000');
  });

  it('reopens a log that holds risk refusals', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendRefusal({
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      reason: 'golden-cross',
      refusal: 'KR:005930 is not on the symbol allow-list',
    });
    first.close();

    expect(store(directory).pendingDecisions()).toStrictEqual([]);
  });

  it('fails closed on a decision log holding something that is not a decision', () => {
    const directory = scratch();
    const state = store(directory);

    state.appendDecision(decision('d-1'));
    state.close();

    // A hand-edited log, or one from an incompatible build. Either way the
    // runner must not guess what it meant.
    const path = join(directory, 'decisions.ndjson');
    const damaged = `${readFileSync(path, 'utf8')}{"kind":"place","decisionId":"d-2"}\n`;

    writeFileSync(path, damaged);

    expect(() => StateStore.open({ directory })).toThrow(DomainError);
  });

  /**
   * The intent is read back through the SDK's own reader, so a log entry that
   * would not be a legal intent cannot become one the gateway promotes.
   */
  it('fails closed on a recorded intent that carries a gateway field', () => {
    const directory = scratch();
    const path = join(directory, 'decisions.ndjson');

    store(directory).close();
    writeFileSync(
      path,
      `${JSON.stringify({
        decisionId: 'd-1',
        at: '2026-09-02T01:00:00.000Z',
        strategy: 'samsung',
        kind: 'place',
        reason: 'golden-cross',
        intent: { ...INTENT, idempotencyKey: 'chosen-by-hand' },
      })}\n`,
    );

    expect(() => StateStore.open({ directory })).toThrow(
      /cannot carry idempotencyKey/u,
    );
  });
});

describe('StateStore daily entry notional', () => {
  it('is zero on a day with nothing recorded', () => {
    expect(store(scratch()).dailyEntryNotional('2026-09-02')).toBe('0');
  });

  it('sums exactly, over pending and settled decisions alike', () => {
    const state = store(scratch());

    state.appendDecision(decision('d-1', { notional: '70000.5' }));
    state.appendDecision(decision('d-2', { notional: '0.25' }));
    state.appendSubmission({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:01.000Z',
      outcome: 'accepted',
    });

    expect(state.dailyEntryNotional('2026-09-02')).toBe('70000.75');
  });

  it('counts only the day asked for', () => {
    const state = store(scratch());

    state.appendDecision(decision('d-1', { notional: '100' }));
    state.appendDecision(
      decision('d-2', { at: '2026-09-03T01:00:00.000Z', notional: '200' }),
    );

    expect(state.dailyEntryNotional('2026-09-02')).toBe('100');
    expect(state.dailyEntryNotional('2026-09-03')).toBe('200');
  });

  it('survives a restart, which is the whole reason it is on disk', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendDecision(decision('d-1', { notional: '70000' }));
    first.close();

    expect(store(directory).dailyEntryNotional('2026-09-02')).toBe('70000');
  });

  /**
   * The limit this feeds governs *entries* — `risk-gate.ts` checks it only for a
   * `BUY`, because a limit that refuses an exit does not cap exposure, it traps
   * it. Summing both sides therefore charged a round trip twice against a budget
   * only one side of it can ever spend: enter at the limit, exit the whole
   * position, and every legitimate re-entry for the rest of the day is refused
   * on a budget that was never actually used.
   */
  it('counts entries only, not the exits that close them', () => {
    const state = store(scratch());

    state.appendDecision(decision('d-1', { notional: '1000000' }));
    state.appendDecision(
      decision('d-2', {
        notional: '1000000',
        intent: { ...INTENT, side: 'SELL' },
      }),
    );

    expect(state.dailyEntryNotional('2026-09-02')).toBe('1000000');
  });

  it('counts entries only after a restart too', () => {
    const directory = scratch();
    const first = store(directory);

    first.appendDecision(decision('d-1', { notional: '1000000' }));
    first.appendDecision(
      decision('d-2', {
        notional: '1000000',
        intent: { ...INTENT, side: 'SELL' },
      }),
    );
    first.close();

    expect(store(directory).dailyEntryNotional('2026-09-02')).toBe('1000000');
  });

  it('ignores a cancel, which commits no notional', () => {
    const state = store(scratch());

    state.appendDecision({
      decisionId: 'd-1',
      at: '2026-09-02T01:00:00.000Z',
      strategy: 'samsung',
      kind: 'cancel',
      reason: 'risk-stop',
      orderId: 'o-1',
    });

    expect(state.dailyEntryNotional('2026-09-02')).toBe('0');
  });

  it('reads the UTC day out of a recorded instant', () => {
    expect(utcDay('2026-09-02T23:59:59.999Z')).toBe('2026-09-02');
  });
});

describe('StateStore cells', () => {
  it('keeps the session cell owner-only and the runtime cell beside it', () => {
    const directory = scratch();
    const state = store(directory);

    state.session.write({ sessionId: 's-1' });
    state.runtime.write({ cursors: {} });

    expect(state.session.path).toBe(join(directory, 'session.json'));
    expect(state.runtime.path).toBe(join(directory, 'runtime.json'));
    expect(statSync(state.session.path).mode & 0o777).toBe(0o600);
  });
});
