import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKED = [
  '.nvmrc',
  'package.json',
  '.dockerignore',
  '.github',
  'apps/paper-api/Dockerfile',
  'apps/web/Dockerfile',
  'apps/web/server.mjs',
  'apps/web/server.test.mjs',
  'apps/paper-api/src/lifecycle/shutdown-coordinator.ts',
  'infra',
  'docs/runbooks',
  'docs/operations',
  'scripts/check-deployment-contract.mjs',
  'packages/market-data/contracts',
  'packages/market-data/src/toss',
  'apps/paper-api/src/config.ts',
  'apps/paper-api/src/config.test.ts',
];

function copyRepo(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'moi-contract-'));
  for (const entry of TRACKED)
    cpSync(join(root, entry), join(dir, entry), { recursive: true });
  cpSync(
    join(root, 'node_modules', 'yaml'),
    join(dir, 'node_modules', 'yaml'),
    { recursive: true, dereference: true },
  );
  mutate?.(dir);
  return dir;
}
function run(dir) {
  return spawnSync(
    process.execPath,
    [join(dir, 'scripts/check-deployment-contract.mjs')],
    { encoding: 'utf8' },
  );
}

describe('check-deployment-contract (A8)', () => {
  it('passes on the committed repository', () => {
    const dir = copyRepo();
    try {
      const result = run(dir);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const [label, replacement] of [
    ['removed', ''],
    [
      'interpolated',
      `MARKET_DATA_ADAPTER: "$${'{'}MARKET_DATA_ADAPTER:?adapter}"`,
    ],
    ['fake', 'MARKET_DATA_ADAPTER: fake'],
  ]) {
    it(`fails when the compose adapter literal is ${label}`, () => {
      const dir = copyRepo((d) => {
        const file = join(d, 'infra/compose.yaml');
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(
            'MARKET_DATA_ADAPTER: toss',
            replacement,
          ),
        );
      });
      try {
        const result = run(dir);
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          /MARKET_DATA_ADAPTER must be the literal toss/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  it('fails when a Toss secret is not a required interpolation', () => {
    const dir = copyRepo((d) => {
      const file = join(d, 'infra/compose.yaml');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /TOSS_CLIENT_SECRET: "\$\{[^}]+\}"/,
          'TOSS_CLIENT_SECRET: literal-secret-value-1234',
        ),
      );
    });
    try {
      const result = run(dir);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /TOSS_/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
