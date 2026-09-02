import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BACKTEST_ROOT = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(directory, entry.name);

      return entry.isDirectory() ? sourceFiles(full) : [full];
    })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
}

const sources = (): readonly {
  readonly file: string;
  readonly text: string;
}[] =>
  sourceFiles(BACKTEST_ROOT).map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
  }));

/**
 * The package-level boundary is pinned by `package-surface.test.ts` — the whole
 * runner may reach `@moi/strategy-sdk` and `@moi/trading-core` and nothing else.
 * This is the *second*, narrower one that phase E needs and the package manifest
 * cannot express: a backtest must reach **no network at all**.
 *
 * The manifest cannot close this because `PaperApiClient`, `SessionClient` and
 * the global `fetch` are all legitimately inside this same package. So the rule
 * is written where it can be checked — over the source of `src/backtest/**` —
 * and it is stated as a list of names rather than inferred from an absence, so
 * a reviewer sees the boundary rather than having to notice it is missing.
 *
 * What it buys: a replay cannot place a real order, cannot read a live quote,
 * and cannot be made to depend on a paper API being up. A backtest that could
 * touch the network is one nobody can run against production data safely, and
 * AGENTS.md rule 1 is the reason the bar is this high — the runner's only
 * outbound host is allow-listed, and the simplest way to keep a research tool
 * out of that argument is for it to have no outbound anything.
 */
describe('the backtest reaches no network', () => {
  it('imports neither the transport, the session client, nor the live feed', () => {
    const forbidden =
      /from '[^']*(transport\/paper-api-client|session\/|feed\/market-session|gateway\/order-gateway|runner\/supervisor)/u;
    const offenders = sources()
      .filter(({ text }) => forbidden.test(text))
      .map(({ file }) => file);

    expect(offenders).toStrictEqual([]);
  });

  it('reaches no networking built-in and no global fetch', () => {
    const forbidden =
      /\b(fetch|WebSocket|XMLHttpRequest)\s*\(|from 'node:(net|http|https|tls|dgram|dns)'/u;
    const offenders = sources()
      .filter(({ text }) => forbidden.test(text))
      .map(({ file }) => file);

    expect(offenders).toStrictEqual([]);
  });

  /**
   * It does reach `../risk`, `../runner` and `../state` — deliberately, because
   * design §8.2 requires the replay to go through the *same* gate and the same
   * strategy host. Naming them here says the coupling is intended rather than
   * leftover, and pins the list so a fourth one is a decision somebody makes.
   */
  it('reaches only the runner modules the replay is meant to share', () => {
    const local = new Set(
      sources().flatMap(({ text }) =>
        [...text.matchAll(/from '\.\.\/([^']+)'/gu)].map(
          (match) => match[1] as string,
        ),
      ),
    );

    expect([...local].sort()).toStrictEqual([
      'config.js',
      'feed/rest-quote-feed.js',
      'registry.js',
      'reporter.js',
      'risk/risk-gate.js',
      'runner/runner-context.js',
      'runner/strategy-host.js',
      'state/append-log.js',
      'state/state-store.js',
    ]);
  });
});
