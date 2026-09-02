import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FillCommit, FillJournal } from './fill-journal.js';

const scratch = (): string =>
  join(mkdtempSync(join(tmpdir(), 'moi-fills-')), 'fills.ndjson');

function commit(
  overrides: Partial<FillCommit> & { readonly accountSequence: string },
): FillCommit {
  return {
    at: '2026-09-02T01:00:00.000Z',
    eventId: `event-${overrides.accountSequence}`,
    eventType: 'ORDER_FILLED',
    fills: [],
    positions: {},
    decisions: [],
    ...overrides,
  };
}

function buy(
  fillId: string,
  quantity = '10',
  price = '1000',
): FillCommit['fills'][number] {
  return {
    fillId,
    orderId: `order-${fillId}`,
    market: 'KR',
    symbol: '005930',
    side: 'BUY',
    quantity,
    price,
    fee: '0',
    realizedDelta: '0',
  };
}

function sell(
  fillId: string,
  realizedDelta: string,
  quantity = '10',
  price = '1100',
): FillCommit['fills'][number] {
  return {
    fillId,
    orderId: `order-${fillId}`,
    market: 'KR',
    symbol: '005930',
    side: 'SELL',
    quantity,
    price,
    fee: '0',
    realizedDelta,
  };
}

describe('the cursor', () => {
  it('is null until something has been committed', () => {
    const journal = FillJournal.open(scratch());

    expect(journal.cursor).toBeNull();
  });

  /**
   * The cursor is a fold over the journal, not a cell beside it. §8.1 lists a
   * `cursor.json`; a second file holding a fact the first already holds is a
   * second file that can disagree with the first after a crash, and there is
   * nothing to reconcile when there is nothing second.
   */
  it('is the highest sequence the journal holds', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit({ accountSequence: '4' }));
    journal.commit(commit({ accountSequence: '9' }));

    expect(journal.cursor).toBe('9');
    expect(FillJournal.open(path).cursor).toBe('9');
  });

  it('compares sequences as numbers, not as text', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(commit({ accountSequence: '9' }));
    journal.commit(commit({ accountSequence: '10' }));

    expect(journal.cursor).toBe('10');
  });

  it('knows which events and fills it has already committed', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(commit({ accountSequence: '4', fills: [buy('f1')] }));

    expect(journal.hasEvent('event-4')).toBe(true);
    expect(journal.hasEvent('event-5')).toBe(false);
    expect(journal.hasFill('f1')).toBe(true);
    expect(journal.hasFill('f2')).toBe(false);
  });
});

/**
 * The whole of what "the event processing and the cursor advance happen in the
 * same transaction" (§6.4) can mean on an append-only substrate: **the same
 * line**. One `write`, one `fsync`, and a reader that discards a torn trailing
 * record — so a crash leaves the step whole or leaves no trace of it.
 */
describe('one line is the transaction', () => {
  it('writes a commit as exactly one durable record', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(
      commit({
        accountSequence: '4',
        fills: [buy('f1')],
        positions: {
          'KR:005930': {
            symbol: '005930',
            quantity: '10',
            totalCost: '10000',
            realizedPnl: '0',
          },
        },
        decisions: ['d1'],
      }),
    );

    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });

  it('discards a commit whose bytes did not all land', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit({ accountSequence: '4', fills: [buy('f1')] }));
    journal.close();

    const whole = readFileSync(path, 'utf8');
    const torn = commit({ accountSequence: '5', fills: [buy('f2')] });

    // A power cut between the record and its newline, byte for byte.
    appendFileSync(path, JSON.stringify(torn).slice(0, -12));

    const reopened = FillJournal.open(path);

    expect(reopened.cursor).toBe('4');
    expect(reopened.hasFill('f2')).toBe(false);
    expect(whole.length).toBeGreaterThan(0);
  });

  /**
   * Damage anywhere but the tail is not a crash — a crash can only truncate the
   * end of a file written through one append descriptor — so it is something
   * having edited the journal, and the runner refuses to reason about a ledger
   * cursor it cannot trust.
   */
  it('fails closed on damage that is not a torn tail', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit({ accountSequence: '4' }));
    journal.commit(commit({ accountSequence: '5' }));
    journal.close();

    const lines = readFileSync(path, 'utf8').split('\n');

    lines[0] = '{ not json';
    writeFileSync(path, lines.join('\n'));

    expect(() => FillJournal.open(path)).toThrow(/damaged/u);
  });

  it('refuses a commit that goes backwards', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(commit({ accountSequence: '7' }));

    expect(() => journal.commit(commit({ accountSequence: '6' }))).toThrow(
      /must advance the cursor/u,
    );
    expect(() => journal.commit(commit({ accountSequence: '7' }))).toThrow(
      /must advance the cursor/u,
    );
  });

  it('refuses a record it cannot read back', () => {
    const path = scratch();

    writeFileSync(
      path,
      `${JSON.stringify({ accountSequence: 'not-a-number' })}\n`,
    );

    expect(() => FillJournal.open(path)).toThrow(/accountSequence/u);
  });
});

describe('the position each commit carries', () => {
  /**
   * The position and the cursor move together because they are the same record.
   * A position cell beside the journal could be a fill ahead of the cursor —
   * so a replay would apply that fill to a position that already had it.
   */
  it('is the value as of the highest commit that named it', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(
      commit({
        accountSequence: '1',
        positions: {
          'KR:005930': {
            symbol: '005930',
            quantity: '10',
            totalCost: '10000',
            realizedPnl: '0',
          },
        },
      }),
    );
    journal.commit(
      commit({
        accountSequence: '2',
        positions: {
          'KR:005930': {
            symbol: '005930',
            quantity: '20',
            totalCost: '21000',
            realizedPnl: '0',
          },
          'US:AAPL': {
            symbol: 'AAPL',
            quantity: '1',
            totalCost: '300',
            realizedPnl: '0',
          },
        },
      }),
    );
    journal.commit(commit({ accountSequence: '3' }));
    journal.close();

    const reopened = FillJournal.open(path);

    expect(reopened.position('KR:005930')).toStrictEqual({
      symbol: '005930',
      quantity: '20',
      totalCost: '21000',
      realizedPnl: '0',
    });
    expect(reopened.position('US:AAPL')?.quantity).toBe('1');
    expect(reopened.position('KR:000660')).toBeNull();
  });
});

describe('realised PnL', () => {
  it('is the sum of every committed fill delta', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit({ accountSequence: '1', fills: [buy('f1')] }));
    journal.commit(
      commit({ accountSequence: '2', fills: [sell('f2', '1000')] }),
    );
    journal.commit(
      commit({ accountSequence: '3', fills: [sell('f3', '-400')] }),
    );

    expect(journal.realizedPnl()).toBe('600');
    expect(FillJournal.open(path).realizedPnl()).toBe('600');
  });

  it('totals a UTC day on its own', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(
      commit({
        accountSequence: '1',
        at: '2026-09-01T23:00:00.000Z',
        fills: [sell('f1', '-500')],
      }),
    );
    journal.commit(
      commit({
        accountSequence: '2',
        at: '2026-09-02T01:00:00.000Z',
        fills: [sell('f2', '-300')],
      }),
    );

    expect(journal.realizedPnlOn('2026-09-02')).toBe('-300');
    expect(journal.realizedPnlOn('2026-09-01')).toBe('-500');
    expect(journal.realizedPnlOn('2026-09-03')).toBe('0');
  });

  /**
   * A loss is a *closing* fill that realised less than it cost. A buy realises
   * nothing, so it neither breaks a run nor extends one — counting it either
   * way would make the limit a function of how an entry happened to be sliced.
   */
  it('counts a run of closing fills that lost', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(
      commit({ accountSequence: '1', fills: [sell('f1', '-100')] }),
    );
    journal.commit(commit({ accountSequence: '2', fills: [buy('f2')] }));
    journal.commit(
      commit({ accountSequence: '3', fills: [sell('f3', '-100')] }),
    );

    expect(journal.consecutiveLosses()).toBe(2);
  });

  it('resets the run on a closing fill that made money', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(
      commit({ accountSequence: '1', fills: [sell('f1', '-100')] }),
    );
    journal.commit(
      commit({ accountSequence: '2', fills: [sell('f2', '-100')] }),
    );
    journal.commit(commit({ accountSequence: '3', fills: [sell('f3', '5')] }));

    expect(journal.consecutiveLosses()).toBe(0);
  });

  it('treats a break-even close as not a loss', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(commit({ accountSequence: '1', fills: [sell('f1', '0')] }));

    expect(journal.consecutiveLosses()).toBe(0);
  });

  it('survives a restart', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(
      commit({ accountSequence: '1', fills: [sell('f1', '-100')] }),
    );
    journal.commit(
      commit({ accountSequence: '2', fills: [sell('f2', '-100')] }),
    );
    journal.close();

    expect(FillJournal.open(path).consecutiveLosses()).toBe(2);
  });
});

/**
 * A resync is the one commit that does not describe fills: the server refused
 * the replay the runner asked for, so the cursor jumps over events that were
 * never delivered. The jump is recorded rather than performed silently, because
 * every PnL number after it is missing whatever was in the hole.
 */
describe('a resync commit', () => {
  it('adopts a cursor without claiming the fills it skipped', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(
      commit({ accountSequence: '1', fills: [sell('f1', '-100')] }),
    );
    journal.commit(
      commit({
        accountSequence: '500',
        eventId: 'resync-500',
        eventType: 'RESYNC',
        resync: 'OUTBOX_GAP',
      }),
    );
    journal.close();

    const reopened = FillJournal.open(path);

    expect(reopened.cursor).toBe('500');
    expect(reopened.realizedPnl()).toBe('-100');
    expect(reopened.resynced).toBe(true);
  });

  it('is not claimed by a journal that never skipped anything', () => {
    const journal = FillJournal.open(scratch());

    journal.commit(commit({ accountSequence: '1' }));

    expect(journal.resynced).toBe(false);
  });
});
