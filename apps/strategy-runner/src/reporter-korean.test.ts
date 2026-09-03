import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localizeMessage } from '@moi/strategy-reporter';
import { describe, expect, it } from 'vitest';

const src = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/**
 * Every fixed message the runner reports has a Korean line in
 * `@moi/strategy-reporter`'s table, so a new `report(...)` call cannot land in
 * the channel as the one English embed among Korean ones. Messages with a
 * variable part are template literals and are matched by pattern; the
 * patterns are pinned in the reporter package's own `korean.test.ts`.
 */
describe('the runner’s report messages', () => {
  it('each have a Korean line in the Discord reporter', () => {
    const literals = sources(src)
      .map((file) => readFileSync(file, 'utf8'))
      .flatMap((text) => [
        ...text.matchAll(/\.report\(\s*'(?:info|warn|error)',\s*'([^']+)'/g),
      ])
      .map(([, message]) => message ?? '');

    expect(literals.length).toBeGreaterThan(20);
    const untranslated = literals.filter(
      (message) => localizeMessage(message) === undefined,
    );
    expect(untranslated).toStrictEqual([]);
  });
});
