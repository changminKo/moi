import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { afterEach, describe, expect, it } from 'vitest';
import { AppendLog, readAppendLog } from './append-log.js';

const open: AppendLog[] = [];

function logIn(directory: string, name = 'records.ndjson'): AppendLog {
  const log = AppendLog.open(join(directory, name));

  open.push(log);

  return log;
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-append-log-'));

afterEach(() => {
  for (const log of open.splice(0)) {
    log.close();
  }
});

describe('AppendLog', () => {
  it('creates the file on open and reads back an empty log', () => {
    const directory = scratch();

    logIn(directory);

    expect(readAppendLog(join(directory, 'records.ndjson'))).toStrictEqual([]);
  });

  it('reads a missing file as an empty log', () => {
    expect(
      readAppendLog(join(scratch(), 'never-written.ndjson')),
    ).toStrictEqual([]);
  });

  it('appends one JSON object per line, in order', () => {
    const directory = scratch();
    const log = logIn(directory);

    log.append({ kind: 'first' });
    log.append({ kind: 'second' });

    expect(readFileSync(join(directory, 'records.ndjson'), 'utf8')).toBe(
      '{"kind":"first"}\n{"kind":"second"}\n',
    );
    expect(readAppendLog(join(directory, 'records.ndjson'))).toStrictEqual([
      { kind: 'first' },
      { kind: 'second' },
    ]);
  });

  /**
   * The property the whole durability argument rests on: a durable append is on
   * disk — readable by a process that did not do the writing — before the call
   * returns. The gateway appends a decision durably and only then submits it, so
   * this is what makes "a crash anywhere recomputes the same key" true rather
   * than merely likely.
   */
  it('makes a durable record readable by an independent reader before returning', () => {
    const directory = scratch();
    const log = logIn(directory);

    log.append({ decisionId: 'd-1' }, { durable: true });

    expect(readAppendLog(join(directory, 'records.ndjson'))).toStrictEqual([
      { decisionId: 'd-1' },
    ]);
  });

  it('reopens an existing log and appends after what is already there', () => {
    const directory = scratch();
    const first = logIn(directory);

    first.append({ n: 1 });
    first.close();

    logIn(directory).append({ n: 2 });

    expect(readAppendLog(join(directory, 'records.ndjson'))).toStrictEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  /**
   * A crash can tear the last record: the bytes of one `write` need not all
   * reach the platter, and an unallocated tail can read back as zeroes. That
   * record is discarded, and discarding it is *safe* rather than merely
   * convenient — a decision is fsynced before it is submitted, so a decision
   * whose bytes did not survive is a decision that was never submitted either.
   */
  it('discards a torn trailing record', () => {
    const directory = scratch();
    const path = join(directory, 'records.ndjson');

    logIn(directory).append({ n: 1 }, { durable: true });
    appendFileSync(path, '{"n":2');

    expect(readAppendLog(path)).toStrictEqual([{ n: 1 }]);
  });

  it('discards a trailing record that a short write left as NUL bytes', () => {
    const directory = scratch();
    const path = join(directory, 'records.ndjson');

    logIn(directory).append({ n: 1 }, { durable: true });
    appendFileSync(path, '\0\0\0\0');

    expect(readAppendLog(path)).toStrictEqual([{ n: 1 }]);
  });

  /**
   * Corruption anywhere but the tail is not a torn write — writes go through one
   * descriptor in order, so a crash can only truncate the end. A bad line in the
   * middle means the file was edited or damaged by something else, and a log
   * that drives real orders fails closed on that (AGENTS.md rule 6) rather than
   * silently skipping a decision.
   */
  it('fails closed on a damaged record that is not the last one', () => {
    const directory = scratch();
    const path = join(directory, 'records.ndjson');

    writeFileSync(path, '{"n":1}\nnot json\n{"n":3}\n');

    expect(() => readAppendLog(path)).toThrow(DomainError);
    expect(() => readAppendLog(path)).toThrow(/line 2/u);
  });

  /**
   * What a spliced line does, pinned because it is easy to assume the worst
   * about it. Two records run together end with the second one's newline, so the
   * damage sits in `lines` and takes the strict path — it fails closed, it is
   * not mistaken for a torn tail. The tail rule only reaches a final line with
   * no newline at all.
   *
   * This is a property of the reader, not a licence for the writer: a spliced
   * line that happens to land last *would* be discarded, which is why
   * `AppendLog` refuses to append after an incomplete record rather than relying
   * on where the damage falls.
   */
  it('fails closed on two records spliced into one line', () => {
    const path = join(scratch(), 'records.ndjson');

    writeFileSync(path, '{"n":1}\n{"n":2{"n":3}\n');

    expect(() => readAppendLog(path)).toThrow(DomainError);
    expect(() => readAppendLog(path)).toThrow(/line 2/u);
  });

  it('rejects a record that is not a JSON object, on both sides', () => {
    const directory = scratch();
    const path = join(directory, 'records.ndjson');

    expect(() => logIn(directory).append([1, 2] as never)).toThrow(DomainError);

    writeFileSync(path, '[1,2]\n"a"\n');

    expect(() => readAppendLog(path)).toThrow(DomainError);
  });

  it('refuses a record whose JSON would span more than one line', () => {
    // `JSON.stringify` escapes a newline inside a string, so this can only come
    // from a replacer or a `toJSON`; the guard is cheap and the alternative is a
    // record that reads back as two.
    const log = logIn(scratch());
    const record = { note: 'a', toJSON: () => 'line\none' };

    expect(() => log.append(record as never)).toThrow(DomainError);
  });

  it('tolerates a trailing newline being absent from the last complete record', () => {
    const directory = scratch();
    const path = join(directory, 'records.ndjson');

    writeFileSync(path, '{"n":1}\n{"n":2}');

    expect(readAppendLog(path)).toStrictEqual([{ n: 1 }, { n: 2 }]);
  });
});
