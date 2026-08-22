import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };
import buildConfig from '../tsconfig.json' with { type: 'json' };

describe('published surface', () => {
  it('publishes the reusable contract suite through a subpath export', () => {
    expect(manifest.exports).toMatchObject({
      '.': { default: './dist/index.js' },
      './testing': { default: './dist/broker-contract.js' },
    });
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
    expect(declared).toContain('@skipjack/trading-core');
  });

  it('keeps compiled test files out of the build', () => {
    expect(buildConfig.exclude).toContain('src/**/*.test.ts');
  });
});
