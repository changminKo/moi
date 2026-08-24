import { describe, expect, it } from 'vitest';
import { GateLocks } from './gate-locks.js';

describe('GateLocks', () => {
  it('waits for shared work before an exclusive activation and denies later orders', async () => {
    const locks = new GateLocks();
    const shared = await locks.acquireShared({ market: 'KR', symbol: '005930' });
    let exclusiveAcquired = false;
    const exclusive = locks.acquireExclusive({ market: 'KR', symbol: '005930' }).then((release) => {
      exclusiveAcquired = true;
      return release;
    });
    await Promise.resolve();
    expect(exclusiveAcquired).toBe(false);
    shared.release();
    const release = await exclusive;
    expect(exclusiveAcquired).toBe(true);
    expect(locks.isExclusive({ market: 'KR', symbol: '005930' })).toBe(true);
    release.release();
  });
});
