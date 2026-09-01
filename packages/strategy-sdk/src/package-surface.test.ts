import { describe, expect, it } from 'vitest';
import biomeConfig from '../../../biome.json' with { type: 'json' };
import manifest from '../package.json' with { type: 'json' };
import buildConfig from '../tsconfig.json' with { type: 'json' };

describe('published surface', () => {
  it('publishes the reusable contract suite through a subpath export', () => {
    expect(manifest.exports).toMatchObject({
      '.': { default: './dist/index.js' },
      './testing': { default: './dist/broker-contract.js' },
    });
  });

  // The strategy contract is a separate subpath rather than part of `.`: a
  // strategy author needs `Strategy`, `Tick` and the parameter kit and has no
  // business reaching `PaperBroker`, and the runner imports both halves
  // explicitly. Folding them together would make one surface out of two
  // audiences.
  it('publishes the strategy contract and each strategy behind their own subpaths', () => {
    expect(manifest.exports).toMatchObject({
      './strategy': { default: './dist/strategy.js' },
      './strategies/sma-crossover': {
        default: './dist/strategies/sma-crossover.js',
      },
    });
  });

  it('keeps the broker entry and the strategy entry disjoint', async () => {
    const contract = await import('./strategy.js');

    expect(Object.keys(contract).sort()).toStrictEqual([
      'GATEWAY_FIELDS',
      'ORDER_INTENT_PRICE_RULES',
      'defineParameterSchema',
      'enumParameter',
      'integerParameter',
      'quantityParameter',
      'readOrderIntent',
      'readStrategyDecisions',
      'symbolParameter',
    ]);
  });

  /**
   * Design §3: the bot may reach `@moi/strategy-sdk` and `@moi/trading-core`,
   * and nothing else — importing `@moi/paper-api` or `@moi/market-data` would
   * put the ledger's internals, or a live provider adapter, inside the decision
   * path. The manifest is where that is decided: pnpm's isolated
   * `node_modules` makes an undeclared workspace package unresolvable, so a
   * strategy cannot import one however it is written.
   *
   * This package also declares no `@types/node` and reaches no Node built-in,
   * which is what keeps a strategy replayable in a backtest and testable in a
   * browser. The per-strategy import rule that closes the rest — `node:*` and
   * the two forbidden packages inside `src/strategies/**` — is the lint
   * override pinned below.
   */
  it('depends on trading-core and nothing else at runtime', () => {
    expect(Object.keys(manifest.dependencies)).toStrictEqual([
      '@moi/trading-core',
    ]);
    expect(Object.keys(manifest.devDependencies)).toStrictEqual(['vitest']);
  });

  /**
   * §6.1 asks for `onTick`'s purity to be enforced by a lint rule, not merely
   * documented. This is that rule: the globals a strategy would reach for to
   * read a clock, draw a random number, or perform I/O are denied inside
   * `src/strategies/**`, and so are the module groups §3 excludes.
   */
  it('denies the impure globals and forbidden imports inside every strategy', () => {
    const override = biomeConfig.overrides.find((entry) =>
      entry.includes.includes('packages/strategy-sdk/src/strategies/**'),
    );
    const rules = override?.linter.rules.style;

    expect(override?.includes).toContain(
      '!packages/strategy-sdk/src/strategies/**/*.test.ts',
    );
    expect(rules?.noRestrictedGlobals.level).toBe('error');
    expect(
      Object.keys(rules?.noRestrictedGlobals.options.deniedGlobals ?? {}),
    ).toStrictEqual(
      expect.arrayContaining([
        'Date',
        'Math',
        'crypto',
        'fetch',
        'globalThis',
        'performance',
        'process',
        'setTimeout',
      ]),
    );
    expect(rules?.noRestrictedImports.level).toBe('error');
    expect(rules?.noRestrictedImports.options.patterns[0]?.group).toStrictEqual(
      expect.arrayContaining(['@moi/market-data', '@moi/paper-api', 'node:*']),
    );
  });

  // The contract property `runBrokerContract` asserts — act on the snapshot,
  // never on a second read of the caller's object — is only satisfiable by an
  // implementation that can take the snapshot. The readers are therefore part of
  // the published contract, not an internal detail, and they belong on the main
  // entry rather than behind `./testing`: `./testing` imports a test runner, and
  // a third-party `Broker` needs them at runtime.
  it('publishes the boundary snapshot readers the contract property needs', async () => {
    const entry = await import('./index.js');

    expect(Object.keys(entry).sort()).toStrictEqual([
      'PaperBroker',
      'assertPlaceOrderCommand',
      'readCancelOrderCommand',
      'readExchangeCommand',
      'readPlaceOrderCommand',
    ]);
  });

  it('keeps the contract suite reachable as a source module, not a test file', async () => {
    const suite = await import('./broker-contract.js');

    expect(typeof suite.runBrokerContract).toBe('function');
    expect(suite.runBrokerContract.length).toBe(1);
    expect(typeof suite.createPaperAccountFake).toBe('function');
    expect(typeof suite.createFakeBroker).toBe('function');
  });

  it('declares every module the published build imports at runtime', () => {
    const declared = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ];

    // `broker-contract.ts` is published, and it drives a test runner, so the
    // runner has to be a declared dependency rather than an ambient root hoist.
    expect(declared).toContain('vitest');
    expect(declared).toContain('@moi/trading-core');
  });

  it('keeps compiled test files out of the build', () => {
    expect(buildConfig.exclude).toContain('src/**/*.test.ts');
  });
});
