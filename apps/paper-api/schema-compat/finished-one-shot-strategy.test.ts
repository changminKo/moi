import { describe, expect, it } from 'vitest';
import { FinishedOneShotStrategy } from './previous-release-scenario.js';

const DOCKER_TIMESTAMP_ZERO = '0001-01-01T00:00:00Z';

function dockerClientReporting(state: {
  Running?: boolean;
  Paused?: boolean;
  FinishedAt?: string;
  ExitCode?: number;
}) {
  const State = {
    Running: false,
    Paused: false,
    StartedAt: '2026-09-04T00:00:00Z',
    FinishedAt: DOCKER_TIMESTAMP_ZERO,
    ExitCode: 0,
    ...state,
  };
  return {
    getContainer: () => ({ inspect: async () => ({ State }) }),
  } as unknown as Parameters<FinishedOneShotStrategy['checkStartupState']>[0];
}

/**
 * Codex HIGH (#46 review): a strategy that answers FAIL makes
 * `GenericContainer.start()` reject before a `StartedTestContainer` exists, so
 * the harness never gets to stop the container itself. The strategy therefore
 * only waits for the process to finish and records how it ended; the verdict
 * belongs to `runPreviousImage`, which always holds a started container.
 */
describe('FinishedOneShotStrategy', () => {
  it('keeps waiting while the container runs', async () => {
    const strategy = new FinishedOneShotStrategy();
    await expect(
      strategy.checkStartupState(
        dockerClientReporting({ Running: true }),
        'c1',
      ),
    ).resolves.toBe('PENDING');
    expect(strategy.exitCode).toBeUndefined();
  });

  it('keeps waiting until Docker has stamped the finish time', async () => {
    const strategy = new FinishedOneShotStrategy();
    await expect(
      strategy.checkStartupState(
        dockerClientReporting({ FinishedAt: DOCKER_TIMESTAMP_ZERO }),
        'c1',
      ),
    ).resolves.toBe('PENDING');
  });

  it('reports a finished container as started and records exit code 0', async () => {
    const strategy = new FinishedOneShotStrategy();
    await expect(
      strategy.checkStartupState(
        dockerClientReporting({ FinishedAt: '2026-09-04T00:00:03Z' }),
        'c1',
      ),
    ).resolves.toBe('SUCCESS');
    expect(strategy.exitCode).toBe(0);
  });

  it('reports a failed container as started too, so the caller can stop it, and records its exit code', async () => {
    const strategy = new FinishedOneShotStrategy();
    await expect(
      strategy.checkStartupState(
        dockerClientReporting({
          FinishedAt: '2026-09-04T00:00:03Z',
          ExitCode: 1,
        }),
        'c1',
      ),
    ).resolves.toBe('SUCCESS');
    expect(strategy.exitCode).toBe(1);
  });
});
