import { closeSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { DomainError } from '@moi/trading-core';
import { writeAll } from './write-all.js';

/**
 * The append-only half of the state store (design §3, §8.1).
 *
 * Two properties matter and neither is about speed.
 *
 * **Ordering.** Every record goes through one descriptor opened `'a'`, so the
 * bytes reach the file in the order they were appended and a crash can only
 * truncate the *end*. That is what makes discarding a torn trailing line safe
 * and a damaged line anywhere else a fail-closed error: the first is a crash,
 * the second is something having edited the file.
 *
 * **Durability on demand.** `durable: true` fsyncs before returning, so the
 * record is on the platter before the caller does anything the outside world
 * can see. The `OrderGateway` appends a decision durably and only then submits
 * it, which is the whole of the restart-idempotency argument: if the decision
 * survived, the key is recomputable from it; if it did not, no order was placed
 * under it either.
 *
 * A `noop` decision is written without the fsync. It leads to no submission, so
 * losing the tail of "why the strategy stood still" across a power cut costs
 * audit detail and no correctness — and paying an fsync per tick to keep it
 * would put the cost somewhere the argument does not need it.
 *
 * **Completeness.** Both properties above assume a record reaches the file whole,
 * and `fs.writeSync` does not promise that — see `writeAll`. Every record is
 * therefore written to completion, and a record that *cannot* be completed
 * closes the log to further appends. That last part matters as much as the
 * loop: `O_APPEND` puts the next write straight after whatever landed, so
 * appending onto a fragment would splice two records into one unparseable line.
 * Where that line falls decides how badly it ends — in the middle of the file
 * it fails closed on the next read, but as the final line it is
 * indistinguishable from an ordinary torn tail and is discarded, taking a
 * durable decision with it. Refusing to append is how that is kept impossible
 * rather than merely unlikely.
 */

/** A parsed record. The reader guarantees an object; the shape is the caller's. */
export type LogRecord = Readonly<Record<string, unknown>>;

export interface AppendOptions {
  /** Fsync before returning. Required before anything observable follows. */
  readonly durable?: boolean;
}

function invalid(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function encode(record: unknown): string {
  const line = JSON.stringify(record);

  // `undefined`, a function, and a `toJSON` returning one all stringify to
  // `undefined` rather than to text.
  if (typeof line !== 'string') {
    invalid('an append-log record must serialise to JSON');
  }

  if (!line.startsWith('{')) {
    invalid('an append-log record must be a JSON object');
  }

  // `JSON.stringify` escapes a newline inside a string, so reaching this needs a
  // `toJSON` that returned pre-formatted text. Cheap to check, and the failure
  // it prevents is one record reading back as two.
  if (line.includes('\n')) {
    invalid('an append-log record must not span more than one line');
  }

  return `${line}\n`;
}

export class AppendLog {
  readonly #fd: number;
  #closed = false;
  /** Set when a record was left half-written. No further append is allowed. */
  #incomplete = false;

  private constructor(fd: number) {
    this.#fd = fd;
  }

  /** Opens — creating if absent — and positions at the end. */
  static open(path: string): AppendLog {
    return new AppendLog(openSync(path, 'a'));
  }

  append(record: LogRecord, options: AppendOptions = {}): void {
    if (this.#closed) {
      invalid('an append-log record cannot be written after close');
    }

    if (this.#incomplete) {
      invalid(
        'this append log ends in an incomplete record and cannot be appended to; the next write would splice two records into one line',
      );
    }

    // Encoded before the write so a record that cannot be represented fails
    // without having put half of itself in the file.
    const bytes = Buffer.from(encode(record), 'utf8');
    let landed = 0;

    try {
      writeAll(this.#fd, bytes, (written) => {
        landed = written;
      });
    } catch (error) {
      // Nothing landed: the file is exactly as it was, so the log is still
      // consistent and a transient failure does not have to end the run. A
      // fragment landed: it does not, and nothing may be appended after it.
      this.#incomplete = landed > 0;

      throw error;
    }

    if (options.durable === true) {
      fsyncSync(this.#fd);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    closeSync(this.#fd);
  }
}

/**
 * Reads a log back, discarding a torn trailing record and failing closed on any
 * other damage. A missing file is an empty log — the first run has not written
 * one yet, and inventing that distinction would make every caller handle it.
 */
export function readAppendLog(path: string): readonly LogRecord[] {
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Object.freeze([]);
    }

    throw error;
  }

  const lines = text.split('\n');

  // A complete record ends in a newline, so the final element is the empty
  // string. Anything else there is the tail, and whether it is a whole record
  // that lost only its newline or a fragment is decided below by parsing it —
  // not here. (This comment used to claim the tail was dropped "whether or not
  // it happens to parse", which the code below has never done and should not:
  // a record whose bytes all landed is still that record, and discarding it
  // would throw away a decision the gateway may already have submitted.)
  const last = lines.pop();
  const records: LogRecord[] = [];

  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      invalid(`the append log ${path} is damaged: line ${index + 1} is empty`);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      invalid(
        `the append log ${path} is damaged: line ${index + 1} is not JSON`,
      );
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      invalid(
        `the append log ${path} is damaged: line ${index + 1} is not a JSON object`,
      );
    }

    records.push(Object.freeze(parsed as Record<string, unknown>));
  }

  // A file whose final record has no trailing newline either survived whole or
  // is torn, and **parsing is what decides which**. It is a sound
  // discriminator: a fragment is cut at an arbitrary byte, so it parses as a
  // whole JSON object only by an accident that `encode`'s one-line-per-record
  // rule makes vanishingly unlikely.
  //
  // Keeping a tail that parses is the safe direction. Losing the newline alone
  // costs nothing — the record is complete — while discarding it would drop a
  // `place` decision that `append()` already fsynced and returned from, which
  // is exactly the order the gateway may have submitted on the strength of that
  // return. Failing closed belongs in the *middle* of the file, where damage
  // cannot be a crash; here it would manufacture the loss it is guarding
  // against.
  if (last !== undefined && last.length > 0) {
    try {
      const parsed: unknown = JSON.parse(last);

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        records.push(Object.freeze(parsed as Record<string, unknown>));
      }
    } catch {
      // A fragment: it did not parse, so it is not a record. Discarded.
    }
  }

  return Object.freeze(records);
}
