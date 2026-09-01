import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import buildConfig from '../tsconfig.json' with { type: 'json' };

const src = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('published surface', () => {
  /**
   * Design §3 keeps the bot's dependency surface to `@moi/strategy-sdk` and
   * `@moi/trading-core`. A reporter that pulled in an HTTP client, a Discord
   * library or the ledger's internals would widen it for everyone downstream,
   * so this package has no runtime dependency at all: it posts with the
   * platform `fetch` and formats nothing that needs money arithmetic — a
   * caller formats decimals with `@moi/trading-core` before they become a
   * field (AGENTS.md hard rule 5).
   */
  it('has no runtime dependency', () => {
    expect(Object.keys(manifest)).not.toContain('dependencies');
    expect(Object.keys(manifest.devDependencies)).toStrictEqual([
      '@types/node',
      'vitest',
    ]);
  });

  it('publishes the reporter and keeps the loopback fake behind ./testing', () => {
    expect(manifest.exports).toMatchObject({
      '.': { default: './dist/index.js' },
      './testing': {
        default: './dist/testing/fake-discord-server.js',
      },
    });
  });

  it('keeps compiled test files out of the build', () => {
    expect(buildConfig.exclude).toContain('src/**/*.test.ts');
  });

  /**
   * AGENTS.md hard rule 1, held for Discord the way `live-guard.ts` holds it
   * for Toss: nothing in this package's tests may reach the real service.
   * `discord.com` appears in the tests only as masker input and as config
   * input — never as somewhere a payload is posted. This asserts the precise
   * property: every webhook a test hands to the transport or the reporter is
   * the loopback fake, or the empty string that disables posting.
   */
  it('gives the transport nothing but the loopback fake to post to', () => {
    const posting = sources(src)
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => readFileSync(file, 'utf8'))
      .filter((text) =>
        /from '\.\/(reporter|discord-transport)\.js'/.test(text),
      );
    const assigned = posting
      .flatMap((text) => [...text.matchAll(/webhookUrl:\s*([^,\n]+)/g)])
      .map(([, value]) => (value ?? '').replace(/[\s})\];]+$/, ''));

    expect(assigned.length).toBeGreaterThan(0);
    for (const value of assigned)
      expect(['discord.webhookUrl', "''"]).toContain(value);
  });
});
