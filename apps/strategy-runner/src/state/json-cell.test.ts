import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DomainError } from '@moi/trading-core';
import { describe, expect, it } from 'vitest';
import { JsonCell } from './json-cell.js';

const scratch = (): string => mkdtempSync(join(tmpdir(), 'moi-json-cell-'));

describe('JsonCell', () => {
  it('reads an absent cell as null', () => {
    expect(new JsonCell(join(scratch(), 'session.json')).read()).toBeNull();
  });

  it('writes and reads back a value', () => {
    const cell = new JsonCell(join(scratch(), 'session.json'));

    cell.write({ sessionId: 's-1' });

    expect(cell.read()).toStrictEqual({ sessionId: 's-1' });
  });

  it('replaces a value rather than accumulating one', () => {
    const cell = new JsonCell(join(scratch(), 'session.json'));

    cell.write({ sessionId: 's-1' });
    cell.write({ sessionId: 's-2' });

    expect(cell.read()).toStrictEqual({ sessionId: 's-2' });
  });

  /**
   * §7.4: the file holding the session cookie and the CSRF token is 0600. The
   * mode is set when the temporary file is created, not after the rename, so
   * the secret is never readable by anyone else even for an instant.
   */
  it('creates a restricted cell readable only by its owner', () => {
    const directory = scratch();
    const path = join(directory, 'session.json');

    new JsonCell(path, { mode: 0o600 }).write({ cookie: 'moi_session=x' });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /**
   * A rename is atomic, so a crash leaves either the old cell or the new one and
   * never a half-written cell that then drives real orders. Writing in place
   * would make a torn `session.json` indistinguishable from a corrupt one.
   */
  it('leaves no temporary file behind after a successful write', () => {
    const directory = scratch();

    new JsonCell(join(directory, 'session.json')).write({ sessionId: 's-1' });

    expect(readdirSync(directory)).toStrictEqual(['session.json']);
  });

  it('fails closed on a cell that is not a JSON object', () => {
    const path = join(scratch(), 'session.json');

    writeFileSync(path, 'not json');

    expect(() => new JsonCell(path).read()).toThrow(DomainError);

    writeFileSync(path, '[1,2]');

    expect(() => new JsonCell(path).read()).toThrow(DomainError);
  });

  it('refuses to write a value that is not a JSON object', () => {
    const cell = new JsonCell(join(scratch(), 'session.json'));

    expect(() => cell.write([1, 2] as never)).toThrow(DomainError);
  });
});
