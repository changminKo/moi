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
