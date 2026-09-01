import { writeSync } from 'node:fs';
import { DomainError } from '@moi/trading-core';

/**
 * Writes every byte, or reports how far it got.
 *
 * `fs.writeSync` does not promise to write everything it was given. On a full
 * disk or an interrupted syscall it returns a **short count** rather than
 * throwing, so the single call it looks like is really "write up to n bytes".
 * A caller that ignores the return value has truncated a record and then
 * reported success — and for the decision log that is the difference between
 * an order the runner can recognise after a crash and one it cannot.
 *
 * `onProgress` is called after each accepted chunk, because how many bytes
 * landed before a failure is the only thing that tells the caller whether its
 * file is still consistent: nothing written leaves the file exactly as it was,
 * while a fragment leaves it positioned mid-record.
 *
 * A write that accepts zero bytes without throwing would spin forever, so it is
 * treated as a failure rather than retried.
 */
export function writeAll(
  fd: number,
  bytes: Buffer,
  onProgress?: (bytesWritten: number) => void,
): void {
  let offset = 0;

  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);

    if (written <= 0) {
      throw new DomainError(
        'INVARIANT_VIOLATION',
        `a write accepted ${written} of ${bytes.length - offset} remaining bytes`,
      );
    }

    offset += written;
    onProgress?.(offset);
  }
}
