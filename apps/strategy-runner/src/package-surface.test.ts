import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import buildConfig from '../tsconfig.json' with { type: 'json' };

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(full);
    }

    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Design §3: the bot may reach `@moi/strategy-sdk` and `@moi/trading-core` —
 * and, since phase D, `@moi/strategy-reporter` (§16.49): a pure text/HTTP
 * adapter with no dependencies of its own, which reaches neither the ledger
 * nor a provider. Nothing else. Importing `@moi/paper-api` would put the ledger's internals in
 * the decision path, `@moi/market-data` would put a live provider adapter there,
 * and a database driver would let the runner write to the ledger behind the
 * API's own invariants.
 *
 * Two guards, because they close different holes. The manifest is the one that
 * actually stops it — pnpm's isolated `node_modules` makes an undeclared
 * workspace package unresolvable, so the import cannot resolve however it is
 * written. The source scan is the one that reads as a rule: it names the
 * forbidden modules, so a reviewer sees the boundary without inferring it from
 * an absence, and it fires on the first line of the offending import rather
 * than on a resolution error somewhere downstream.
 */
describe('dependency boundary', () => {
  it('depends on the strategy SDK and trading-core, and nothing else', () => {
    expect(Object.keys(manifest.dependencies).sort()).toStrictEqual([
      '@moi/strategy-reporter',
      '@moi/strategy-sdk',
      '@moi/trading-core',
    ]);
  });

  /**
   * Unlike the SDK, this package is a Node process and reaches `node:fs`,
   * `node:crypto` and the global `fetch`, so it declares the Node types. That
   * is the whole of the difference: the SDK stays runnable in a browser and in
   * a backtest, the runner does not have to be.
   */
  it('takes only the Node types and a test runner as tooling', () => {
    expect(Object.keys(manifest.devDependencies).sort()).toStrictEqual([
      '@types/node',
      'vitest',
    ]);
  });

  it('imports neither the paper API, the market-data package, nor a database driver', () => {
    const forbidden =
      /from '(@moi\/paper-api|@moi\/market-data|pg|kysely|postgres)(\/|')/u;
    const offenders = sourceFiles(SOURCE_ROOT).filter((file) =>
      forbidden.test(readFileSync(file, 'utf8')),
    );

    expect(offenders).toStrictEqual([]);
  });

  it('keeps compiled test files out of the build', () => {
    expect(buildConfig.exclude).toContain('src/**/*.test.ts');
  });

  /**
   * Stated rather than left to TypeScript's automatic `@types` inclusion, which
   * does not fire here: this is the first package in the repository that reaches
   * Node's built-ins without a dependency that already drags their types along.
   * `apps/paper-api` gets them free from `pg` and `ws`; `@moi/strategy-sdk`
   * deliberately declares none, so it has nothing to pass down. Naming the one
   * type package this app uses is also the honest statement of its ambient
   * surface — `types: ["node"]` means nothing else is ambient either.
   */
  it('declares the Node types explicitly, and only those', () => {
    expect(buildConfig.compilerOptions.types).toStrictEqual(['node']);
  });
});
