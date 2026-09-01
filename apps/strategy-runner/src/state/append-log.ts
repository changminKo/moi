import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { DomainError } from '@moi/trading-core';

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

    // Encoded before the write so a record that cannot be represented fails
    // without having put half of itself in the file.
    const line = encode(record);

    writeSync(this.#fd, line);

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
  // string. Anything else there is a record whose bytes did not all land — the
  // torn tail — and it is dropped whether or not it happens to parse, because
  // an fsynced record is always followed by its newline.
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

  // A file whose final record has no trailing newline: it either survived
  // whole — a writer that was killed between the record and its newline cannot
  // happen, the two go in one `write` — or it is torn. Parsing decides which,
  // and only here, where a failure means the tail rather than the middle.
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
      // A torn tail. Discarded, as documented above.
    }
  }

  return Object.freeze(records);
}
