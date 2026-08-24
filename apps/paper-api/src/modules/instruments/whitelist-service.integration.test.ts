import { describe, expect, it } from 'vitest';
import { WhitelistService } from './whitelist-service.js';

describe('whitelist publication', () => {
  it('keeps a removed symbol cancel-only while active legs remain', async () => {
    const service = new WhitelistService({
      version: 'v1',
      markets: { KR: ['005930'], US: ['AAPL'] },
    });
    service.markActiveLeg('US', 'AAPL');
    await expect(
      service.publish({ version: 'v2', markets: { KR: ['005930'], US: [] } }),
    ).rejects.toMatchObject({ code: 'CANCEL_ONLY' });
    expect(service.isTradable('US', 'AAPL')).toBe(false);
  });
});
