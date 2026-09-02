/**
 * What the cursor does when the write that carries it does not land.
 *
 * `AppendLog` gained a short-write guard (codex HIGH, phase B): a record that
 * cannot be finished leaves a fragment, and the log then refuses every later
 * append rather than splicing onto it. That guard is what makes the fill
 * journal's atomicity claim true rather than merely likely — the claim is that
 * one event's whole outcome reaches the file as one record or not at all, and a
 * half-written record is precisely the case that would break it.
 *
 * So the question this file answers is the one the guard raises: **when the
 * append fails, does the cursor stay where the disk says it is?** An in-memory
 * cursor that advanced past a commit the file never took would be worse than the
 * short write itself — it would mean an event the runner believes it processed,
 * whose fill nobody delivered.
 *
 * `node:fs` is mocked here for the reason `append-log.partial-write.test.ts`
 * gives: a short write cannot be forced deterministically against a real
 * filesystem. The rest of the state suite runs against real files.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, so it does not pull the module in ahead of the mock.
import type { FillCommit } from './fill-journal.js';

const control = vi.hoisted(() => ({
  /** Bytes the next `writeSync` will accept. `Infinity` writes everything. */
  maxBytes: Number.POSITIVE_INFINITY,
  /** The 1-based call on which `writeSync` throws instead of writing. */
  throwOnCall: Number.POSITIVE_INFINITY,
  calls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();

  return {
    ...actual,
    default: actual,
    writeSync: (
      fd: number,
      data: string | NodeJS.ArrayBufferView,
      offset?: number,
      length?: number,
    ): number => {
      control.calls += 1;

      if (control.calls >= control.throwOnCall) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      }

      if (typeof data === 'string') {
        return actual.writeSync(fd, data.slice(0, control.maxBytes));
      }

      const buffer = data as Buffer;
      const start = offset ?? 0;
      const requested = length ?? buffer.length - start;

      return actual.writeSync(
        fd,
        buffer,
        start,
        Math.min(requested, control.maxBytes),
      );
    },
  };
});

const { FillJournal } = await import('./fill-journal.js');

const scratch = (): string =>
  join(mkdtempSync(join(tmpdir(), 'moi-fills-partial-')), 'fills.ndjson');

function commit(sequence: string, fillId: string): FillCommit {
  return {
    accountSequence: sequence,
    at: '2026-09-02T01:00:00.000Z',
    eventId: `event-${sequence}`,
    eventType: 'ORDER_FILLED',
    fills: [
      {
        fillId,
        orderId: `order-${sequence}`,
        market: 'KR',
        symbol: '005930',
        side: 'BUY',
        quantity: '10',
        price: '1000',
        fee: '0',
        realizedDelta: '0',
      },
    ],
    positions: {
      'KR:005930': {
        symbol: '005930',
        quantity: '10',
        totalCost: '10000',
        realizedPnl: '0',
      },
    },
    decisions: [`fill:${sequence}:echo:0`],
  };
}

beforeEach(() => {
  control.maxBytes = Number.POSITIVE_INFINITY;
  control.throwOnCall = Number.POSITIVE_INFINITY;
  control.calls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a commit that needs more than one write', () => {
  /**
   * The ordinary short write, which `writeAll` finishes. A commit record is far
   * longer than a decision line — it carries the fills, the positions and the
   * decision ids — so it is the record most likely to need several writes on a
   * filesystem under pressure, and it must still arrive as one line.
   */
  it('still reaches the file as exactly one record', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    control.maxBytes = 8;
    journal.commit(commit('12', 'fill-1'));
    journal.close();

    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(FillJournal.open(path).cursor).toBe('12');
    expect(FillJournal.open(path).hasFill('fill-1')).toBe(true);
  });
});

describe('a commit that cannot be finished', () => {
  /**
   * The property everything else rests on. The append throws, and the journal's
   * own cursor, fill index and position map are left exactly as the file has
   * them — because `commit` mutates none of them until the append has returned.
   *
   * If it advanced first, the runner would skip an event on the next connect
   * (the stream replays from the cursor) and the fill it announced would reach
   * no strategy, ever. That is the "lost fill" half of the phase's criterion,
   * and a half-written line is the cheapest way to cause it.
   */
  it('leaves the cursor where the file left it', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit('12', 'fill-1'));

    // The counter is cumulative, and the commit above already used a call.
    // Without this reset `throwOnCall` would fire on the *first* write of the
    // next record, which is the zero-progress path — a different case, tested
    // last, and one that would let this test pass for the wrong reason.
    control.calls = 0;
    control.maxBytes = 8;
    control.throwOnCall = 2;

    expect(() => journal.commit(commit('13', 'fill-2'))).toThrow(/ENOSPC/u);

    expect(journal.cursor).toBe('12');
    expect(journal.hasEvent('event-13')).toBe(false);
    expect(journal.hasFill('fill-2')).toBe(false);
    expect(journal.position('KR:005930')?.quantity).toBe('10');
  });

  /**
   * And it refuses to carry on, because `AppendLog` does. Failing closed is the
   * right answer here: the alternative is a later commit spliced onto the
   * fragment, which as the final line of the file is indistinguishable from a
   * torn tail and would be discarded along with the cursor it carried.
   *
   * The runner survives this as a loud, non-progressing loop rather than as a
   * crash — `FillProcessor.process` throws, `StreamClient` contains it and
   * reports, the cursor never moves, and every event is replayed on the next
   * connect. No order is duplicated, because the decision ids are still derived
   * from the account sequence. It needs a person, and it says so every time.
   */
  it('refuses every later commit rather than writing onto the fragment', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit('12', 'fill-1'));

    // The counter is cumulative, and the commit above already used a call.
    // Without this reset `throwOnCall` would fire on the *first* write of the
    // next record, which is the zero-progress path — a different case, tested
    // last, and one that would let this test pass for the wrong reason.
    control.calls = 0;
    control.maxBytes = 8;
    control.throwOnCall = 2;

    expect(() => journal.commit(commit('13', 'fill-2'))).toThrow(/ENOSPC/u);

    control.maxBytes = Number.POSITIVE_INFINITY;
    control.throwOnCall = Number.POSITIVE_INFINITY;

    expect(() => journal.commit(commit('14', 'fill-3'))).toThrow(DomainError);
    expect(() => journal.commit(commit('14', 'fill-3'))).toThrow(
      /incomplete record/u,
    );
    expect(journal.cursor).toBe('12');
  });

  /**
   * And a restart reads what the file really holds: the fragment is the last
   * thing in it and has no newline, so it is discarded as the torn tail it is.
   * The event that produced it is therefore *not* committed, the stream replays
   * it from the surviving cursor, and the fill is delivered — once.
   */
  it('replays the event whose commit was lost, and only that one', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit('12', 'fill-1'));

    // The counter is cumulative, and the commit above already used a call.
    // Without this reset `throwOnCall` would fire on the *first* write of the
    // next record, which is the zero-progress path — a different case, tested
    // last, and one that would let this test pass for the wrong reason.
    control.calls = 0;
    control.maxBytes = 8;
    control.throwOnCall = 2;

    expect(() => journal.commit(commit('13', 'fill-2'))).toThrow(/ENOSPC/u);

    journal.close();

    control.maxBytes = Number.POSITIVE_INFINITY;
    control.throwOnCall = Number.POSITIVE_INFINITY;

    const restarted = FillJournal.open(path);

    expect(restarted.cursor).toBe('12');
    expect(restarted.hasEvent('event-13')).toBe(false);
    expect(restarted.hasFill('fill-2')).toBe(false);

    // The replay lands, and the journal is whole again.
    restarted.commit(commit('13', 'fill-2'));

    expect(restarted.cursor).toBe('13');
    expect(restarted.hasFill('fill-2')).toBe(true);
    expect(restarted.realizedPnl()).toBe('0');
  });

  /**
   * A write that failed before any byte landed left the file exactly as it was,
   * so the journal is still consistent and keeps working. Poisoning the cursor
   * on a transient `ENOSPC` that moved nothing would turn a passing disk-full
   * blip into a runner that never commits another fill.
   */
  it('keeps committing when the failed write moved nothing', () => {
    const path = scratch();
    const journal = FillJournal.open(path);

    journal.commit(commit('12', 'fill-1'));

    // Throws on the very first write of the record, so nothing lands.
    control.calls = 0;
    control.throwOnCall = 1;

    expect(() => journal.commit(commit('13', 'fill-2'))).toThrow(/ENOSPC/u);
    expect(journal.cursor).toBe('12');

    control.throwOnCall = Number.POSITIVE_INFINITY;
    control.calls = 0;

    journal.commit(commit('13', 'fill-2'));
    journal.close();

    const restarted = FillJournal.open(path);

    expect(restarted.cursor).toBe('13');
    expect(restarted.hasFill('fill-2')).toBe(true);
    // One record for the failed attempt and one for the retry would be two
    // deliveries of the same fill. There is one.
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(2);
  });
});
