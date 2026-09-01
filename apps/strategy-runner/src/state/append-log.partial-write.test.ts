/**
 * `fs.writeSync` does not promise to write everything. On a full disk or an
 * interrupted syscall it returns a **short count** instead of throwing, and a
 * writer that ignores the return value has silently truncated a record it then
 * reports as written.
 *
 * That is worse here than losing one line. `append()` fsyncs a `place` decision
 * and returns, and `OrderGateway` submits the order on the strength of that
 * return. If the record on disk is a fragment, the restart that follows a crash
 * finds a torn tail, discards it, and the runner no longer knows about an order
 * the ledger is holding — so the next tick decides again under a new key and the
 * position doubles. It is exactly the failure the idempotency argument in
 * `order-gateway.ts` claims cannot happen.
 *
 * It cannot be forced deterministically against a real filesystem, so `node:fs`
 * is mocked here and only here — the rest of the state suite runs against real
 * files.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

      // Every record in this file is ASCII, so a character cap is a byte cap.
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

const { AppendLog, readAppendLog } = await import('./append-log.js');
const { JsonCell } = await import('./json-cell.js');

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-partial-'));

beforeEach(() => {
  control.maxBytes = Number.POSITIVE_INFINITY;
  control.throwOnCall = Number.POSITIVE_INFINITY;
  control.calls = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppendLog under a short write', () => {
  it('finishes the record instead of leaving a fragment on disk', () => {
    const path = join(scratch(), 'records.ndjson');
    const log = AppendLog.open(path);

    // Four bytes at a time: `{"n":1}\n` takes two writes.
    control.maxBytes = 4;
    log.append({ n: 1 }, { durable: true });
    log.close();

    expect(readFileSync(path, 'utf8')).toBe('{"n":1}\n');
    expect(readAppendLog(path)).toStrictEqual([{ n: 1 }]);
  });

  /**
   * The record that follows a fragment is the sharp case: it appends straight
   * onto the fragment, because `O_APPEND` puts the file position after whatever
   * actually landed, and the two become one unparseable line.
   */
  it('does not let the next record merge onto a truncated one', () => {
    const path = join(scratch(), 'records.ndjson');
    const log = AppendLog.open(path);

    control.maxBytes = 4;
    log.append({ n: 1 }, { durable: true });
    control.maxBytes = Number.POSITIVE_INFINITY;
    log.append({ m: 2 }, { durable: true });
    log.close();

    expect(readAppendLog(path)).toStrictEqual([{ n: 1 }, { m: 2 }]);
  });

  it('finishes a record that needs many writes', () => {
    const path = join(scratch(), 'records.ndjson');
    const log = AppendLog.open(path);

    control.maxBytes = 1;
    log.append({ decisionId: 'd-1', kind: 'place' }, { durable: true });
    log.close();

    expect(readAppendLog(path)).toStrictEqual([
      { decisionId: 'd-1', kind: 'place' },
    ]);
  });
});

describe('AppendLog when a record cannot be finished', () => {
  /**
   * A fragment is on disk and the rest cannot be written. The append fails, as
   * it must — but the log is now positioned mid-record, so it also refuses every
   * later append rather than concatenating onto the fragment. Failing closed
   * beats producing a file whose damage is indistinguishable from a torn tail.
   */
  it('refuses every later append rather than writing onto the fragment', () => {
    const path = join(scratch(), 'records.ndjson');
    const log = AppendLog.open(path);

    control.maxBytes = 4;
    control.throwOnCall = 2;

    expect(() => log.append({ n: 1 }, { durable: true })).toThrow(/ENOSPC/u);

    control.maxBytes = Number.POSITIVE_INFINITY;
    control.throwOnCall = Number.POSITIVE_INFINITY;

    expect(() => log.append({ m: 2 }, { durable: true })).toThrow(DomainError);
    expect(() => log.append({ m: 2 }, { durable: true })).toThrow(
      /incomplete record/u,
    );

    log.close();

    // The fragment is the last thing in the file and has no newline, so it is
    // discarded as a torn tail — which is now the truth about it.
    expect(readAppendLog(path)).toStrictEqual([]);
  });

  /**
   * A write that failed before any byte landed leaves the file exactly as it
   * was, so the log is still consistent and may keep being used. Poisoning it
   * here would turn a transient error into a dead runner.
   */
  it('stays usable when the failed write moved nothing', () => {
    const path = join(scratch(), 'records.ndjson');
    const log = AppendLog.open(path);

    log.append({ n: 1 }, { durable: true });
    control.throwOnCall = 1;

    expect(() => log.append({ n: 2 }, { durable: true })).toThrow(/ENOSPC/u);

    control.throwOnCall = Number.POSITIVE_INFINITY;
    control.calls = 0;
    log.append({ n: 3 }, { durable: true });
    log.close();

    expect(readAppendLog(path)).toStrictEqual([{ n: 1 }, { n: 3 }]);
  });
});

/**
 * The cell has the same hazard with a worse-looking symptom: a short write
 * truncates the temporary file, and the rename then promotes that truncation
 * over a cell that was perfectly good.
 */
describe('JsonCell under a short write', () => {
  it('writes the whole value rather than renaming a truncated one over it', () => {
    const cell = new JsonCell(join(scratch(), 'session.json'));

    control.maxBytes = 3;
    cell.write({ sessionId: 's-1', cookie: 'moi_session=x' });

    expect(cell.read()).toStrictEqual({
      sessionId: 's-1',
      cookie: 'moi_session=x',
    });
  });

  it('leaves the previous value in place when the write cannot finish', () => {
    const directory = scratch();
    const cell = new JsonCell(join(directory, 'session.json'));

    cell.write({ sessionId: 's-1' });
    control.maxBytes = 3;
    control.throwOnCall = 3;

    expect(() => cell.write({ sessionId: 's-2' })).toThrow(/ENOSPC/u);

    control.maxBytes = Number.POSITIVE_INFINITY;
    control.throwOnCall = Number.POSITIVE_INFINITY;

    // The old cell is intact and the fragment is gone, so nothing downstream
    // has to reason about a half-written temporary file.
    expect(cell.read()).toStrictEqual({ sessionId: 's-1' });
    expect(existsSync(join(directory, 'session.json.tmp'))).toBe(false);
  });
});
