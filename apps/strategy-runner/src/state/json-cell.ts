import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { writeAll } from './write-all.js';

/**
 * The mutable half of the state store: one JSON object, last writer wins.
 *
 * Design §8.1 names NDJSON, and for the *event* logs it is right — a decision
 * happened, and an audit record of it should only ever grow. `session.json` and
 * the runtime cell are not events. They are the current value of something, and
 * appending a current value to a log makes "current" a fold over a file that
 * grows for the life of the deployment, for a value nobody ever wants the
 * history of. §8.1 already lists both as their own files rather than as logs;
 * this is the mechanism behind that listing.
 *
 * The write is a create-fsync-rename, so a crash leaves the previous value or
 * the new one and never a torn one. `rename` is atomic on POSIX, and the
 * directory is fsynced after it so the rename itself survives the crash rather
 * than only the bytes it pointed at.
 */

export interface JsonCellOptions {
  /** File mode for the cell. Secrets take 0600 — design §7.4. */
  readonly mode?: number;
}

const DEFAULT_MODE = 0o644;

function invalid(message: string): never {
  throw new DomainError('INVARIANT_VIOLATION', message);
}

function assertJsonObject(
  value: unknown,
  description: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${description} must be a JSON object`);
  }
}

export class JsonCell {
  readonly #path: string;
  readonly #mode: number;

  constructor(path: string, options: JsonCellOptions = {}) {
    this.#path = path;
    this.#mode = options.mode ?? DEFAULT_MODE;
  }

  get path(): string {
    return this.#path;
  }

  /** The stored value, or `null` when nothing has been written yet. */
  read(): Readonly<Record<string, unknown>> | null {
    let text: string;

    try {
      text = readFileSync(this.#path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      throw error;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      invalid(`the state cell ${this.#path} is not JSON`);
    }

    assertJsonObject(parsed, `the state cell ${this.#path}`);

    return Object.freeze(parsed);
  }

  write(value: Readonly<Record<string, unknown>>): void {
    assertJsonObject(value, 'a state cell value');

    const serialised = JSON.stringify(value);

    if (typeof serialised !== 'string') {
      invalid('a state cell value must serialise to JSON');
    }

    const directory = dirname(this.#path);

    mkdirSync(directory, { recursive: true });

    // A fixed suffix rather than a random one: only this process writes this
    // cell, so a leftover from a crashed predecessor is this cell's own
    // temporary file and reusing it is correct. A random name would leak one
    // file per crash into a directory nothing prunes.
    const temporary = `${this.#path}.tmp`;
    // The mode is on the create, so a secret cell is never briefly world-
    // readable. `'w'` truncates a leftover from a crashed write.
    const fd = openSync(temporary, 'w', this.#mode);

    try {
      // To completion: a short write would truncate the temporary file, and the
      // rename below would then promote that truncation over a perfectly good
      // cell. See `writeAll`.
      writeAll(fd, Buffer.from(serialised, 'utf8'));
      fsyncSync(fd);
    } catch (error) {
      closeSync(fd);
      // The temporary file holds a fragment and the real cell is untouched, so
      // the previous value still stands. Removing the fragment keeps the next
      // write from having to reason about what it finds.
      unlinkSync(temporary);

      throw error;
    }

    closeSync(fd);

    try {
      renameSync(temporary, this.#path);
    } catch (error) {
      unlinkSync(temporary);

      throw error;
    }

    // The rename is a directory operation, so fsyncing the file would not make
    // it durable. Opening a directory for reading is not portable to Windows;
    // the runner is a Linux container and a Darwin dev machine, and losing the
    // rename on a platform where this throws is a strictly smaller failure than
    // refusing to write at all.
    try {
      const handle = openSync(directory, 'r');

      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    } catch {
      // Best effort: the bytes are durable either way.
    }
  }
}
