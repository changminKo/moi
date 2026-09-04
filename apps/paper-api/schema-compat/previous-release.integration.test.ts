import { getContainerRuntimeClient } from 'testcontainers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MISSING_PREVIOUS_IMAGE_MESSAGE,
  PREVIOUS_IMAGE_VARIABLE,
  runPreviousReleaseScenario,
} from './previous-release-scenario.js';

/** Containers created from the previous image that Docker still knows about. */
async function leftoverPreviousContainers(): Promise<readonly string[]> {
  const image = process.env[PREVIOUS_IMAGE_VARIABLE]?.trim();
  if (!image) return [];
  const client = await getContainerRuntimeClient();
  const containers = await client.container.dockerode.listContainers({
    all: true,
    filters: JSON.stringify({ ancestor: [image] }),
  });
  return containers.map((c) => `${c.Id.slice(0, 12)} ${c.Status}`);
}

/**
 * #46 — the exact previous `paper-api` image must still write through the
 * schema the current checkout migrates to.
 *
 * Both halves start from a fresh database migrated by the *current* source.
 * The first is the compatibility proof: the previous release's compiled
 * runtime opens an anonymous session, buys at market and persists the fill.
 * The second is the harness self-test: a deliberately incompatible `NOT NULL`
 * column on `fills` must make that same write fail, so a green first half is
 * known to be a real observation and not a runner that cannot fail.
 */
describe('previous release against the current schema (#46)', () => {
  // Each scenario stops its own one-shot container, the failed one included;
  // nothing may be left for Ryuk or process exit to clean up.
  afterEach(async () => {
    await expect(leftoverPreviousContainers()).resolves.toEqual([]);
  });

  it('refuses to start Docker resources without SCHEMA_COMPAT_PREVIOUS_IMAGE', async () => {
    await expect(
      runPreviousReleaseScenario({ previousImage: '   ' }),
    ).rejects.toThrow(MISSING_PREVIOUS_IMAGE_MESSAGE);
  });

  it('[compatibility proof] the previous image fills a KR market buy on the current schema', async () => {
    await expect(runPreviousReleaseScenario()).resolves.toBeUndefined();
  });

  it('[harness self-test] an incompatible NOT NULL fills column makes the previous image fail', async () => {
    await expect(
      runPreviousReleaseScenario({ addIncompatibleFillColumn: true }),
    ).rejects.toThrow(
      // The failure must be the fill write itself: PostgreSQL names the probe
      // column in the not-null violation the old release could not satisfy.
      /previous image .* exited with code [1-9]\d*[\s\S]*schema_compat_probe[\s\S]*violates not-null constraint/,
    );
  });
});
